import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Page, Locator, Request } from "playwright";
import { expect, test } from "playwright/test";
import type {
  AssertHasOptions,
  AssertPathOptions,
  AssertionOptions,
  DownloadOptions,
  LayoutAssertionOptions,
  TestDriver,
  SessionCookie,
  SessionOptions,
  StepOptions,
  UntilOptions,
  UntilPredicate,
} from "../types.js";
import { DEFAULT_TIMEOUT, withinCountMessage } from "../types.js";

/** Context handed to custom step() callbacks in the Playwright adapter. */
export interface PlaywrightStepContext {
  page: Page;
  /** Current scope: the page, or the container locator inside within(). */
  scope: Page | Locator;
}

export type { StepEvent } from "../types.js";

export interface PlaywrightSessionOptions extends SessionOptions {
  /**
   * Budget in ms for every assertion, every wait (until, assertPath, ...) and
   * every action (fillIn, click, ...) in this session; page loads use
   * `navigationTimeout`. A per-call timeout, such as
   * `assertHas(sel, { timeout })`, still wins. 0 means no limit (Playwright's
   * meaning of 0).
   *
   * Default: inside the Playwright Test runner, Playwright's own configured
   * timeouts (expect.timeout, actionTimeout) — unchanged from earlier
   * versions. Outside it (bun test, vitest, a script), 4000 ms
   * ({@link DEFAULT_TIMEOUT_OUTSIDE_RUNNER}), so a failing step reports its
   * chain before bun test's 5000 ms per-test timeout cuts the test off.
   */
  timeout?: number;
  /**
   * Budget in ms for page loads: visit(), reload(), and the new page after a
   * submit or click that navigates. Default: Playwright's own navigation
   * timeout (30 s unless configured), so a slow-starting dev server is not
   * cut short by the shorter `timeout`. 0 means no limit.
   */
  navigationTimeout?: number;
  /**
   * After an action that signalled it is leaving the page (a navigating form
   * submission, a followed link, `beforeunload`) but before any navigation
   * request was seen: how long in ms to wait for one to start before
   * deciding the page stays. Default {@link NAVIGATION_START_TIMEOUT_MS}
   * (500). Raise it on a slow CI machine if submits return too early.
   */
  navigationStartTimeout?: number;
  /**
   * After a navigation of the page fails: how long in ms to wait for a newer
   * navigation that replaced it (a script setting `location` cuts a POST
   * short) before ending the wait. Default
   * {@link REPLACED_NAVIGATION_TIMEOUT_MS} (250).
   */
  replacedNavigationTimeout?: number;
}

/**
 * How long a page that signalled it is leaving (a navigating form submission
 * or `beforeunload`) gets to actually start a main-frame navigation before
 * the wait is dropped. Only spent when the signal came but no request did.
 * Overridable with the `navigationStartTimeout` session option.
 */
export const NAVIGATION_START_TIMEOUT_MS = 500;

/**
 * How long after a main-frame navigation fails to wait for a newer one that
 * replaced it, before treating the failure as the end of the navigation.
 * Overridable with the `replacedNavigationTimeout` session option.
 */
export const REPLACED_NAVIGATION_TIMEOUT_MS = 250;

/** How long to wait for a stopped new-page poll to notice and exit. */
const POLL_STOP_GRACE_MS = 1000;

/** Makes each new-page wait's stop token unique. */
let waitCounter = 0;

/**
 * The page's default navigation timeout (setDefaultNavigationTimeout, the
 * context's, or the runner's navigationTimeout). Playwright has no public
 * getter, so this reads its private timeout settings: only for the wait for
 * the new page after a submit, which has no Playwright call to inherit the
 * default from. Undefined if the private shape is not there; a test pins
 * the shape, so a Playwright rename fails CI instead of passing silently.
 * Set the navigationTimeout option to avoid relying on it.
 */
export function pageDefaultNavigationTimeout(page: Page): number | undefined {
  const settings = (
    page as unknown as {
      _timeoutSettings?: {
        navigationTimeout?: (options: object) => number | { timeout?: number };
      };
    }
  )._timeoutSettings;
  try {
    const value = settings?.navigationTimeout?.({});
    const ms = typeof value === "number" ? value : value?.timeout;
    return typeof ms === "number" ? ms : undefined;
  } catch {
    return undefined; // the shape changed: the pinning test says so
  }
}

/**
 * The lowest Playwright version this adapter works with, and why: the
 * newest API it calls. package.json's peer floor must not be lower (a unit
 * test checks). 1.51: locator.filter({ visible: true }) in assertHas.
 */
export const MIN_PLAYWRIGHT_VERSION = "1.51.0";

/** Playwright's documented default navigation timeout. */
const PLAYWRIGHT_DEFAULT_NAVIGATION_TIMEOUT = 30_000;

/** The session timeout used outside the Playwright Test runner. */
export const DEFAULT_TIMEOUT_OUTSIDE_RUNNER = DEFAULT_TIMEOUT;

/** True while a Playwright Test runner test is executing. */
function insidePlaywrightRunner(): boolean {
  try {
    test.info();
    return true;
  } catch {
    return false;
  }
}

/**
 * What the session keeps in the app's page, under one Symbol-keyed store
 * (window[Symbol.for("feather-testing-core")]): no window globals, no
 * patched prototypes. Besides it, the first navigating action installs four
 * listeners on window — click and keydown (capture: to recognise submit
 * attempts and followed links), submit, invalid (capture: to see a refused
 * submit), and beforeunload — which only record, never prevent or change.
 */
type PageState = {
  documentBeforeAction?: boolean;
  /** Tokens of new-page waits settled from outside, one per wait. */
  stoppedWaits?: Set<string>;
  leaving?: boolean;
  listening?: boolean;
  /** The first control that blocked a submission during the action. */
  invalid?: BlockedSubmit | null;
  invalidEl?: Element | null;
  /** The form a submit was attempted on during the action, if any. */
  submitAttempt?: HTMLFormElement | null;
  /** Whether a submit event fired during the action. */
  submitted?: boolean;
};

/** What happened to a form during an action. */
interface ActionOutcome {
  /** The browser refused a submit attempt because of this control. */
  blocked: BlockedSubmit | null;
  /** A form was submitted (a submit event fired, or the page was replaced). */
  submitted: boolean;
}

/** A submission the browser refused because a control was invalid. */
interface BlockedSubmit {
  label: string;
  valueMissing: boolean;
  message: string;
}

/** What a submit that the browser refused fails with (same wording as the request adapter). */
function blockedSubmitMessage(blocked: BlockedSubmit): string {
  return blocked.valueMissing
    ? `form not sent: '${blocked.label}' is required (a browser does not send a form with an empty required field).`
    : `form not sent: '${blocked.label}' is invalid: ${blocked.message}`;
}

/**
 * Playwright matches a bare string name/label/text as a case-insensitive
 * SUBSTRING. That makes every text-addressed verb ambient: `clickButton('Check')`
 * also matches an unrelated "Checklist Run — checklist" control that happens to
 * be on the page, and the run dies on a strict-mode violation whose appearance
 * depends on what else rendered. When a spec names a control it means *that*
 * control, so every addressing matcher here passes `exact: true`. Playwright
 * still normalizes whitespace under exact matching, so multi-line markup and
 * padded labels keep working.
 *
 * Assertions (assertText/refuteText/assertHas) deliberately stay substring:
 * they ask "does this text appear", and an exact `refuteText` would pass while
 * the text is plainly on the page inside a longer string.
 */
const EXACT = { exact: true } as const;

export class PlaywrightDriver
  implements TestDriver<PlaywrightStepContext, Page>
{
  private lastFormLocator: Locator | null = null;
  /** The field the most recent fillIn() targeted, found or not. */
  private lastFilledField: Locator | null = null;

  constructor(
    private page: Page,
    private scope: Page | Locator = page,
    private options: PlaywrightSessionOptions = {},
    /** Whether the Playwright runner is active, when already known (within()). */
    private insideRunnerCache?: boolean,
    /** The session's cookie seeding, shared with within()'s scoped drivers. */
    private cookieSeed: { done: Promise<void> | null } = { done: null },
  ) {}

  /**
   * Add the `cookies` option's cookies to the browser context, once per
   * session, before its first step. A cookie without a domain is set for
   * the session's baseUrl (or the page's current URL) — host-only.
   */
  private seedCookies(): Promise<void> {
    if (this.cookieSeed.done) return this.cookieSeed.done;
    const cookies = this.options.cookies ?? [];
    this.cookieSeed.done = cookies.length === 0 ? Promise.resolve() : this.contextAddCookies(cookies);
    return this.cookieSeed.done;
  }

  /**
   * Add cookies to the browser context, as the `cookies` option does, at
   * any point in the session. A cookie without a domain is set for the
   * session's baseUrl (or the page's current URL), by domain and path.
   */
  async addCookies(cookies: readonly SessionCookie[]): Promise<void> {
    // The option's cookies come first, so these win where they overlap.
    await this.seedCookies();
    await this.contextAddCookies(cookies);
  }

  private async contextAddCookies(cookies: readonly SessionCookie[]): Promise<void> {
    const base = this.options.baseUrl ?? this.page.url();
    const origin = /^https?:/.test(base) ? new URL(base) : null;
    await this.page.context().addCookies(
      cookies.map((c) => {
        const { domain, path, ...rest } = c;
        if (domain !== undefined) {
          return { ...rest, domain, path: path ?? "/" };
        }
        if (!origin) {
          throw new Error(
            `cookies: '${c.name}' has no domain, and the session has no baseUrl ` +
              "to take it from. Pass baseUrl to createSession, or give the cookie a domain.",
          );
        }
        // domain + path, not url: a url makes Playwright take
        // `secure` from its scheme, overriding the cookie's own.
        return { ...rest, domain: origin.hostname, path: path ?? "/" };
      }),
    );
  }


  /**
   * The session budget: the caller's option, else Playwright's own defaults
   * inside its runner (undefined), else the outside-runner default.
   */
  protected get timeout(): number | undefined {
    if (this.options.timeout !== undefined) {
      return this.options.timeout;
    }
    return this.insideRunner() ? undefined : DEFAULT_TIMEOUT_OUTSIDE_RUNNER;
  }

  /**
   * Whether a Playwright Test runner test is running, asked once per driver
   * on first use (a driver lives inside one test).
   */
  /**
   * The budget for page loads, shared by visit(), reload() and the new page
   * after a submit: the navigationTimeout option, else the page's own
   * navigation timeout (setDefaultNavigationTimeout, the runner's
   * navigationTimeout, else Playwright's 30 s). Playwright has no public
   * getter for that, so it is read from the page's timeout settings, with
   * Playwright's documented default if those are not there.
   */
  private navigationTimeout(): number {
    return (
      this.options.navigationTimeout ??
      pageDefaultNavigationTimeout(this.page) ??
      PLAYWRIGHT_DEFAULT_NAVIGATION_TIMEOUT
    );
  }

  private insideRunner(): boolean {
    this.insideRunnerCache ??= insidePlaywrightRunner();
    return this.insideRunnerCache;
  }

  /**
   * Options for an action wrapped in waitingForNewDocument(). The session
   * `timeout` bounds the action itself; noWaitAfter leaves the page it
   * starts to load to waitingForNewDocument(), which gives it the
   * navigation budget. Otherwise Playwright waits for the navigation inside
   * click()/press() and holds it to the (shorter) action timeout.
   */
  private navigatingActionOptions(opts?: StepOptions): {
    timeout?: number;
    noWaitAfter: true;
  } {
    return { timeout: this.budget(opts), noWaitAfter: true };
  }

  /** A step's budget: its own timeout, else the session's (see timeout). */
  private budget(opts?: StepOptions): number | undefined {
    return opts?.timeout ?? this.timeout;
  }

  /**
   * Mark the current document and install the page-side listeners that
   * waitingForNewDocument() reads. A page that is itself still navigating can
   * destroy the evaluation context mid-call; then wait for the new document
   * to be parsed and try once more.
   */
  private async markDocumentBeforeAction(): Promise<void> {
    const mark = () =>
      this.page.evaluate(() => {
        const w = ((window as unknown as Record<symbol, PageState>)[Symbol.for("feather-testing-core")] ??= {});
        w.documentBeforeAction = true;
        w.leaving = false;
        w.invalid = null;
        w.invalidEl = null;
        w.submitAttempt = null;
        w.submitted = false;
        if (w.listening) return;
        w.listening = true;
        // Submit attempts: activating a submit button (Enter's implicit
        // submission clicks the default one) and Enter in a field of a
        // form with no submit button. Only an 'invalid' event on the
        // attempted form counts as a refused submit; a checkValidity() or
        // reportValidity() from a type=button does not. (A page script's
        // own requestSubmit() is not watched: nothing is patched.)
        window.addEventListener(
          "click",
          (event) => {
            const el = (event.target as Element | null)?.closest?.("button, input");
            if (!el) return;
            const isSubmit =
              el instanceof HTMLButtonElement
                ? el.type === "submit"
                : el instanceof HTMLInputElement &&
                  (el.type === "submit" || el.type === "image");
            if (isSubmit && (el as HTMLButtonElement).form) {
              w.submitAttempt = (el as HTMLButtonElement).form;
            }
          },
          true,
        );
        window.addEventListener(
          "keydown",
          (event) => {
            const el = event.target as HTMLInputElement | null;
            if (event.key === "Enter" && el instanceof HTMLInputElement && el.form) {
              w.submitAttempt = el.form;
            }
          },
          true,
        );
        // A submission blocked by constraint validation fires 'invalid' on
        // each invalid control (it does not bubble, so capture); the first
        // is the one the browser reports.
        window.addEventListener(
          "invalid",
          (event) => {
            if (w.invalid) return;
            const el = event.target as HTMLInputElement;
            if (!w.submitAttempt || el.form !== w.submitAttempt) {
              return;
            }
            const label =
              (el.labels?.[0]?.textContent ?? "").replace(/\s+/g, " ").trim() ||
              el.getAttribute("aria-label") ||
              el.getAttribute("placeholder") ||
              el.getAttribute("name") ||
              el.tagName.toLowerCase();
            w.invalid = {
              label,
              valueMissing: el.validity?.valueMissing === true,
              message: el.validationMessage ?? "",
            };
            w.invalidEl = el;
          },
          true,
        );
        // Window bubble phase: runs after the form's own submit handlers.
        window.addEventListener("submit", (event) => {
          w.submitted = true;
          if (event.defaultPrevented) return;
          const form = event.target as HTMLFormElement;
          const submitter = (event as SubmitEvent).submitter;
          const method = (
            submitter?.getAttribute("formmethod") ??
            form.getAttribute("method") ??
            ""
          ).toLowerCase();
          // <form method="dialog"> closes a dialog; it never navigates.
          if (method === "dialog") return;
          const target = (
            submitter?.getAttribute("formtarget") ??
            form.getAttribute("target") ??
            document.querySelector("base[target]")?.getAttribute("target") ??
            ""
          ).toLowerCase();
          // A form aimed at a new window or an iframe leaves this page alone.
          if (target !== "" && target !== "_self" && target !== "_top" && target !== "_parent") {
            return;
          }
          w.leaving = true;
        });
        // A followed link (clicked, or Enter on a focused link).
        window.addEventListener("click", (event) => {
          if (event.defaultPrevented) return;
          const link = (event.target as Element | null)?.closest?.("a[href]");
          if (!link) return;
          const target = (link.getAttribute("target") ?? "").toLowerCase();
          if (target !== "" && target !== "_self" && target !== "_top" && target !== "_parent") {
            return;
          }
          if (link.hasAttribute("download")) return;
          // href="#" or "#section": stays on this page.
          if ((link.getAttribute("href") ?? "").startsWith("#")) return;
          const href = new URL((link as HTMLAnchorElement).href, location.href);
          // javascript:, mailto:, tel:, ... do not load a page here.
          if (href.protocol !== "http:" && href.protocol !== "https:") return;
          const samePage =
            href.origin + href.pathname + href.search ===
            location.origin + location.pathname + location.search;
          // A same-page #fragment link scrolls; it does not load a page.
          if (samePage && href.hash !== "") return;
          w.leaving = true;
        });
        window.addEventListener("beforeunload", () => {
          w.leaving = true;
        });
      });
    try {
      await mark();
    } catch (error) {
      if (!/execution context was destroyed|navigat/i.test(String(error))) {
        throw error;
      }
      await this.page.waitForLoadState("domcontentloaded");
      await mark();
    }
  }

  /**
   * Run an action that may submit a form or otherwise leave the page. When it
   * starts a navigation of this page (e.g. POST, then a 303 redirect to a
   * GET), wait until the NEW document has loaded, so the next step never
   * reads the page that was just left. When it starts none (a form handled by
   * JavaScript, `method="dialog"`, a form aimed at another window or an
   * iframe), return as soon as the action does.
   *
   * Playwright's actions do not always wait for the navigation they start,
   * so the page itself is watched: before the action it is marked, and
   * listeners note a navigating form submission and a `beforeunload`. After
   * the action, a page that is already a new document is waited for. One
   * that noted either signal is waited for once a main-frame navigation
   * request is seen (within {@link NAVIGATION_START_GRACE_MS}). A navigation
   * that ends without a new document — a 204/205 response, a download, or a
   * failed request no newer navigation replaced — ends the wait.
   */
  /**
   * Run an action that may submit a form or leave the page (see
   * waitingForNewDocument), and fail loudly when the browser refused to send
   * the form because a field is invalid — an empty required field above all.
   */
  private async acting(action: () => Promise<void>): Promise<void> {
    const { blocked } = await this.waitingForNewDocument(action);
    if (blocked) {
      throw new Error(blockedSubmitMessage(blocked));
    }
  }

  /** Returns what happened to a form: refused (and why), or submitted. */
  private async waitingForNewDocument(
    action: () => Promise<void>,
  ): Promise<ActionOutcome> {
    await this.markDocumentBeforeAction();

    const navigations: Request[] = [];
    const endings: Array<() => void> = [];
    const navigationEnded = new Promise<void>((resolve) => endings.push(resolve));
    const end = () => endings.forEach((resolve) => resolve());
    const isMainFrameNavigation = (request: Request) =>
      request.isNavigationRequest() && request.frame() === this.page.mainFrame();
    const isLatest = (request: Request) => navigations.at(-1) === request;

    const onRequest = (request: Request) => {
      if (isMainFrameNavigation(request)) navigations.push(request);
    };
    const onFinished = async (request: Request) => {
      if (!isMainFrameNavigation(request)) return;
      const response = await request.response().catch(() => null);
      if (!response) return;
      const status = response.status();
      const disposition = await response
        .headerValue("content-disposition")
        .catch(() => null);
      const noDocument =
        status === 204 ||
        status === 205 ||
        (disposition !== null && /attachment/i.test(disposition));
      if (noDocument && isLatest(request)) end();
    };
    const timers: ReturnType<typeof setTimeout>[] = [];
    const onFailed = (request: Request) => {
      if (!isMainFrameNavigation(request)) return;
      // A navigation that a newer one replaced (e.g. a POST cut short by a
      // script that sets location) is aborted, and Chromium reports that
      // failure just before the newer request. So only a failure that is
      // still the latest navigation a moment later ends the wait.
      timers.push(
        setTimeout(() => {
          if (isLatest(request)) end();
        }, this.options.replacedNavigationTimeout ?? REPLACED_NAVIGATION_TIMEOUT_MS),
      );
    };
    this.page.on("request", onRequest);
    this.page.on("requestfinished", onFinished);
    this.page.on("requestfailed", onFailed);
    try {
      await action();

      let state: "new-document" | "leaving" | "staying";
      let blocked: BlockedSubmit | null = null;
      let submitted = false;
      try {
        [state, blocked, submitted] = await this.page.evaluate(() => {
          const w = ((window as unknown as Record<symbol, PageState>)[Symbol.for("feather-testing-core")] ??= {});
          if (!w.documentBeforeAction) return ["new-document", null, true] as const;
          return [
            w.leaving ? "leaving" : "staying",
            w.invalid ?? null,
            w.submitted === true,
          ] as const;
        });
      } catch (error) {
        // The old document's context is already gone: a navigation is under
        // way. Any other failure (e.g. the page was closed) is the real error.
        if (!/execution context was destroyed|navigat/i.test(String(error))) {
          throw error;
        }
        state = "new-document";
        submitted = true;
      }
      if (state === "staying" && navigations.length === 0) {
        return { blocked, submitted };
      }
      if (state === "leaving" && navigations.length === 0) {
        // The page signalled it is leaving; make sure a navigation of this
        // page really starts before blocking on it.
        const started = await this.page
          .waitForRequest(isMainFrameNavigation, {
            timeout:
              this.options.navigationStartTimeout ?? NAVIGATION_START_TIMEOUT_MS,
          })
          .then(
            () => true,
            () => false,
          );
        if (!started) {
          return { blocked: null, submitted };
        }
      }

      const timeout = this.navigationTimeout();
      // "complete" (the load event) rather than "interactive": it is what
      // visit() waits for (page.goto's default), so a step after a submit
      // sees the page in the same state as a step after a visit, including
      // anything load handlers render.
      // The poll runs in the page until it is true, so when the navigation
      // ends without a new page it is told to stop: its token is set on the
      // window, and the predicate then returns at once.
      const token = `wait-${++waitCounter}`;
      const newDocument = this.page.waitForFunction(
        (stopToken) => {
          const w = ((window as unknown as Record<symbol, PageState>)[Symbol.for("feather-testing-core")] ??= {});
          if (w.stoppedWaits?.delete(stopToken)) return true;
          return (
            !w.documentBeforeAction &&
            document.readyState === "complete"
          );
        },
        token,
        { timeout },
      );
      // Release the handle the poll resolves with; a rejection (timeout,
      // page closed) is reported by the race below or not at all.
      newDocument.then(
        (handle) => handle.dispose(),
        () => undefined,
      );
      let ended = false;
      try {
        await Promise.race([
          newDocument,
          navigationEnded.then(() => {
            ended = true;
          }),
        ]);
        if (ended) {
          // Each wait has its own token, so a later wait cannot overwrite an
          // earlier one's stop signal; the poll removes its token as it
          // stops. Wait (briefly) for it to stop before moving on.
          const stopped = await this.page
            .evaluate((stopToken) => {
              const w = ((window as unknown as Record<symbol, PageState>)[Symbol.for("feather-testing-core")] ??= {});
              (w.stoppedWaits ??= new Set()).add(stopToken);
            }, token)
            .then(
              () => true,
              // The page is gone or navigating: its poll went with it.
              () => false,
            );
          if (stopped) {
            await Promise.race([
              newDocument.then(
                () => undefined,
                () => undefined,
              ),
              new Promise((resolve) => setTimeout(resolve, POLL_STOP_GRACE_MS)),
            ]);
          }
        }
      } catch (error) {
        throw new Error(
          `the page started to navigate, but no new page finished loading` +
            `${timeout === undefined ? "" : ` within ${timeout}ms`}: ` +
            (error instanceof Error ? error.message.split("\n")[0] : String(error)),
        );
      }
      return { blocked: null, submitted: true };
    } finally {
      this.page.off("request", onRequest);
      this.page.off("requestfinished", onFinished);
      this.page.off("requestfailed", onFailed);
      timers.forEach((timer) => clearTimeout(timer));
    }
  }

  /** The element represented by the current scope; an unscoped page means body. */
  private scopeElement(): Locator {
    return this.scope === this.page
      ? this.page.locator("body")
      : (this.scope as Locator);
  }

  /** Page layout is measured on the document root; scopes use their element. */
  private layoutElement(): Locator {
    return this.scope === this.page
      ? this.page.locator("html")
      : (this.scope as Locator);
  }

  private async assertHorizontalOverflowState(
    expected: boolean,
    opts?: LayoutAssertionOptions,
  ): Promise<void> {
    const element = this.layoutElement();
    const tolerance = opts?.tolerance ?? 1;
    await expect
      .poll(
        async () => {
          const { scrollWidth, clientWidth } = await element.evaluate((node) => ({
            scrollWidth: node.scrollWidth,
            clientWidth: node.clientWidth,
          }));
          const overflows = scrollWidth > clientWidth + tolerance;
          return overflows === expected
            ? null
            : `scrollWidth=${scrollWidth}, clientWidth=${clientWidth}, tolerance=${tolerance}`;
        },
        { timeout: opts?.timeout ?? this.timeout },
      )
      .toBeNull();
  }

  async visit(path: string): Promise<void> {
    await this.seedCookies(); // also when the driver is used without a Session
    // With baseUrl, paths resolve as in the request adapter; without it,
    // Playwright resolves them against the browser context's baseURL.
    const url =
      this.options.baseUrl === undefined
        ? path
        : new URL(path, this.options.baseUrl).href;
    // No option: Playwright's own default applies (public path).
    await this.page.goto(url, { timeout: this.options.navigationTimeout });
  }

  async reload(): Promise<void> {
    await this.page.reload({ timeout: this.options.navigationTimeout });
  }

  async click(text: string, opts?: StepOptions): Promise<void> {
    await this.acting(() =>
      this.scope.getByText(text, EXACT).click(this.navigatingActionOptions(opts)),
    );
  }

  async clickLink(text: string, opts?: StepOptions): Promise<void> {
    await this.acting(() =>
      this.scope
        .getByRole("link", { name: text, ...EXACT })
        .click(this.navigatingActionOptions(opts)),
    );
  }

  async clickButton(text: string, opts?: StepOptions): Promise<void> {
    await this.acting(() =>
      this.scope
        .getByRole("button", { name: text, ...EXACT })
        .click(this.navigatingActionOptions(opts)),
    );
  }

  /** The single label-addressed lookup: every labelled verb goes through it. */
  private labelled(label: string): Locator {
    return this.scope.getByLabel(label, EXACT);
  }

  private fieldByLabelOrPlaceholder(label: string): Locator {
    // .or() lets Playwright auto-wait on whichever appears, so
    // async-rendered labeled fields don't fall through to the
    // placeholder branch. Both branches match exactly — substring
    // matching would collide with labels ("Name" vs placeholder
    // "Nickname") and trip strict mode.
    return this.labelled(label).or(this.scope.getByPlaceholder(label, EXACT));
  }

  async fillIn(label: string, value: string, opts?: StepOptions): Promise<void> {
    const field = this.fieldByLabelOrPlaceholder(label);
    this.lastFilledField = field;
    await field.fill(value, { timeout: this.timeoutAfterProbe(label, opts) });
    this.lastFormLocator = this.scope.locator("form", { has: field });
  }

  /**
   * evaluateAll() looks at whatever matches right now and never waits, so a
   * field that was never found simply counts as not a password field.
   */
  async lastFilledFieldIsPassword(): Promise<boolean> {
    if (!this.lastFilledField) {
      return false;
    }
    return this.lastFilledField.evaluateAll((elements) =>
      elements.some(
        (element) =>
          element instanceof HTMLInputElement && element.type === "password",
      ),
    );
  }

  /**
   * The step's budget minus what fieldIsPassword() already spent on the
   * same field, so finding the field and filling it share one `timeout`
   * instead of taking up to twice as long.
   */
  private timeoutAfterProbe(label: string, opts?: StepOptions): number | undefined {
    const probe = this.fillProbe;
    this.fillProbe = null;
    const timeout = this.budget(opts);
    if (!probe || probe.label !== label || !timeout) {
      return timeout; // undefined: Playwright's own; 0: no limit
    }
    return Math.max(1, timeout - (Date.now() - probe.startedAt));
  }

  /** When fieldIsPassword() began looking for a field, and which. */
  private fillProbe: { label: string; startedAt: number } | null = null;

  async fieldIsPassword(
    label: string,
    purpose: "fill" | "assert" = "fill",
    stepTimeout?: number,
  ): Promise<boolean> {
    const timeout = stepTimeout ?? this.timeout;
    this.fillProbe = { label, startedAt: Date.now() };
    const field = this.fieldByLabelOrPlaceholder(label);
    // The same wait for fillIn and assertValue: an assertion's budget — the
    // step's or session's timeout, else (inside Playwright Test) expect's,
    // not the often-unlimited action timeout. The step then gets what is
    // left of a set timeout. `purpose` no longer changes the wait.
    void purpose;
    await expect(field.first()).toBeAttached({ timeout });
    // Several matches: fill() would fail on strict mode, and which field the
    // value was meant for is unknown, so say so now (the value stays hidden,
    // as in the request adapter).
    const count = await field.count();
    if (count > 1) {
      throw new Error(
        `${count} fields are labelled '${label}'. ` +
          "Scope the step with within(selector, ...) to pick one.",
      );
    }
    return field.evaluateAll((elements) =>
      elements.some(
        (element) =>
          element instanceof HTMLInputElement && element.type === "password",
      ),
    );
  }

  async selectOption(label: string, option: string, opts?: StepOptions): Promise<void> {
    const select = this.labelled(label);
    await select.selectOption({ label: option }, { timeout: this.budget(opts) });
    this.lastFormLocator = this.scope.locator("form", { has: select });
  }

  async check(label: string, opts?: StepOptions): Promise<void> {
    const checkbox = this.labelled(label);
    await checkbox.check({ timeout: this.budget(opts) });
    this.lastFormLocator = this.scope.locator("form", { has: checkbox });
  }

  async uncheck(label: string, opts?: StepOptions): Promise<void> {
    const checkbox = this.labelled(label);
    await checkbox.uncheck({ timeout: this.budget(opts) });
    this.lastFormLocator = this.scope.locator("form", { has: checkbox });
  }

  async choose(label: string, opts?: StepOptions): Promise<void> {
    const radio = this.scope.getByRole("radio", { name: label, ...EXACT });
    await radio.check({ timeout: this.budget(opts) });
    this.lastFormLocator = this.scope.locator("form", { has: radio });
  }

  async assertSubmitBlocked(label: string): Promise<void> {
    const verb = `assertSubmitBlocked('${label}')`;
    const field = this.fieldByLabelOrPlaceholder(label).first();
    await field.waitFor({ state: "attached", timeout: this.timeout });
    // Enter in the field: the browser's own implicit submission (the
    // default button's click handlers run; a disabled default button, or
    // several text fields and no button, submit nothing).
    const { blocked, submitted } = await this.waitingForNewDocument(() =>
      field.press("Enter", this.navigatingActionOptions()),
    );
    if (blocked) {
      const byThisField = await field.evaluate(
        (el) => (window as unknown as Record<symbol, PageState>)[Symbol.for("feather-testing-core")]?.invalidEl === el,
      );
      if (!byThisField) {
        throw new Error(`${verb}: the form was blocked by '${blocked.label}', not by '${label}'.`);
      }
      if (!blocked.valueMissing) {
        throw new Error(
          `${verb}: '${label}' blocked the form, but not because it is required: ${blocked.message}`,
        );
      }
      return;
    }
    if (submitted) {
      throw new Error(`${verb}: the form was sent — '${label}' did not stop it.`);
    }
    throw new Error(
      `${verb}: nothing would submit — Enter in '${label}' does not submit its form ` +
        "(its default button is disabled, or it has no submit button and more than one text field).",
    );
  }


  async submit(opts?: StepOptions): Promise<void> {
    if (!this.lastFormLocator) {
      throw new Error(
        "submit() called but no form was previously interacted with. " +
          "Use fillIn(), selectOption(), check(), uncheck(), or choose() first.",
      );
    }
    // First try: an explicit type="submit" element — the DOM's ground truth
    const submitBtn = this.lastFormLocator.locator(
      'button[type="submit"], input[type="submit"]',
    );
    if ((await submitBtn.count()) > 0) {
      await this.acting(() =>
        submitBtn.first().click(this.navigatingActionOptions(opts)),
      );
      return;
    }
    // Second try: a button whose accessible name contains "submit"
    const byRole = this.lastFormLocator.getByRole("button", {
      name: /submit/i,
    });
    if ((await byRole.count()) > 0) {
      await this.acting(() =>
        byRole.first().click(this.navigatingActionOptions(opts)),
      );
    } else {
      // Last resort: press Enter on the last form field
      const lastField = this.lastFormLocator
        .locator("input, textarea, select")
        .last();
      await this.acting(() =>
        lastField.press("Enter", this.navigatingActionOptions(opts)),
      );
    }
  }

  async attachFile(label: string, path: string, opts?: StepOptions): Promise<void> {
    const input = this.labelled(label);
    await input.setInputFiles(path, { timeout: this.budget(opts) });
    this.lastFormLocator = this.scope.locator("form", { has: input });
  }

  /** @deprecated Older name for {@link PlaywrightDriver.attachFile}. */
  async upload(label: string, path: string): Promise<void> {
    await this.attachFile(label, path);
  }

  async pressKey(key: string, opts?: StepOptions): Promise<void> {
    await this.acting(() => this.page.keyboard.press(key));
  }

  async hover(text: string, opts?: StepOptions): Promise<void> {
    await this.scope.getByText(text, EXACT).hover({ timeout: this.budget(opts) });
  }

  async dropFile(selector: string, path: string): Promise<void> {
    const content = await readFile(path);
    const name = basename(path);
    const dataTransfer = await this.page.evaluateHandle(
      ([fileName, base64]) => {
        const dt = new DataTransfer();
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        dt.items.add(new File([bytes], fileName));
        return dt;
      },
      [name, content.toString("base64")] as const,
    );
    await this.scope.locator(selector).dispatchEvent(
      "drop",
      { dataTransfer },
      { timeout: this.timeout },
    );
  }

  async assertHas(selector: string, opts?: AssertHasOptions): Promise<void> {
    let locator = this.scope.locator(selector);
    if (opts?.text) {
      locator = opts.exact
        ? locator.filter({ hasText: opts.text })
        : locator.filter({ hasText: new RegExp(opts.text) });
    }
    if (opts?.count !== undefined) {
      await expect(locator).toHaveCount(opts.count, {
        timeout: opts?.timeout ?? this.timeout,
      });
    } else {
      // Any visible match will do (a hidden first match does not fail it),
      // as in the request adapter; count and refuteHas still count all.
      await expect(locator.filter({ visible: true }).first()).toBeVisible({
        timeout: opts?.timeout ?? this.timeout,
      });
    }
  }

  async refuteHas(selector: string, opts?: AssertHasOptions): Promise<void> {
    let locator = this.scope.locator(selector);
    if (opts?.text) {
      locator = opts.exact
        ? locator.filter({ hasText: opts.text })
        : locator.filter({ hasText: new RegExp(opts.text) });
    }
    await expect(locator).toHaveCount(0, { timeout: opts?.timeout ?? this.timeout });
  }

  async assertText(text: string, opts?: StepOptions): Promise<void> {
    await expect(this.scope.getByText(text).first()).toBeVisible({
      timeout: this.budget(opts),
    });
  }

  async assertExactText(
    text: string,
    opts?: AssertionOptions,
  ): Promise<void> {
    await expect(this.scopeElement()).toHaveText(text, {
      timeout: opts?.timeout ?? this.timeout,
    });
  }

  async refuteText(text: string, opts?: StepOptions): Promise<void> {
    await expect(this.scope.getByText(text)).toHaveCount(0, {
      timeout: this.budget(opts),
    });
  }

  async assertAttribute(
    name: string,
    value?: string,
    opts?: AssertionOptions,
  ): Promise<void> {
    const assertion = expect(this.scopeElement());
    if (value === undefined) {
      await assertion.toHaveAttribute(name, { timeout: opts?.timeout ?? this.timeout });
    } else {
      await assertion.toHaveAttribute(name, value, { timeout: opts?.timeout ?? this.timeout });
    }
  }

  async refuteAttribute(
    name: string,
    opts?: AssertionOptions,
  ): Promise<void> {
    await expect(this.scopeElement()).not.toHaveAttribute(name, {
      timeout: opts?.timeout ?? this.timeout,
    });
  }

  async assertComputedStyle(
    property: string,
    value: string,
    opts?: AssertionOptions,
  ): Promise<void> {
    await expect(this.scopeElement()).toHaveCSS(property, value, {
      timeout: opts?.timeout ?? this.timeout,
    });
  }

  async assertNoHorizontalOverflow(
    opts?: LayoutAssertionOptions,
  ): Promise<void> {
    await this.assertHorizontalOverflowState(false, opts);
  }

  async assertHorizontalOverflow(
    opts?: LayoutAssertionOptions,
  ): Promise<void> {
    await this.assertHorizontalOverflowState(true, opts);
  }

  async assertHorizontallyContained(
    selector: string,
    opts?: LayoutAssertionOptions,
  ): Promise<void> {
    const element = this.layoutElement();
    const tolerance = opts?.tolerance ?? 1;
    await expect
      .poll(
        () =>
          element.evaluate(
            (scope, args) => {
              const children = scope.querySelectorAll(args.selector);
              if (children.length !== 1) {
                return (
                  `expected exactly one descendant '${args.selector}', ` +
                  `but found ${children.length}`
                );
              }
              const child = children[0];
              const scopeBounds = scope.getBoundingClientRect();
              const childBounds = child.getBoundingClientRect();
              const contained =
                childBounds.left >= scopeBounds.left - args.tolerance &&
                childBounds.right <= scopeBounds.right + args.tolerance;
              return contained
                ? null
                : `child left=${childBounds.left}, child right=${childBounds.right}, ` +
                    `scope left=${scopeBounds.left}, scope right=${scopeBounds.right}, ` +
                    `tolerance=${args.tolerance}`;
            },
            { selector, tolerance },
          ),
        { timeout: opts?.timeout ?? this.timeout },
      )
      .toBeNull();
  }

  async scrollToHorizontalEnd(
    opts?: LayoutAssertionOptions,
  ): Promise<void> {
    const element = this.layoutElement();
    const tolerance = opts?.tolerance ?? 1;
    await expect
      .poll(
        () =>
          element.evaluate((node, allowedDifference) => {
            const maximum = node.scrollWidth - node.clientWidth;
            const direction = getComputedStyle(node).direction;
            node.scrollTo({
              left: direction === "rtl" ? -maximum : maximum,
              behavior: "instant",
            });

            const distance = Math.abs(node.scrollLeft);
            if (maximum <= allowedDifference) {
              return (
                `expected horizontal range greater than ${allowedDifference}, but ` +
                `maximum=${maximum}, scrollLeft=${node.scrollLeft}, direction=${direction}`
              );
            }
            return Math.abs(distance - maximum) <= allowedDifference
              ? null
              : `expected horizontal endpoint within ${allowedDifference}px, but ` +
                  `maximum=${maximum}, scrollLeft=${node.scrollLeft}, direction=${direction}`;
          }, tolerance),
        { timeout: opts?.timeout ?? this.timeout },
      )
      .toBeNull();
  }

  async assertValue(label: string, value: string, opts?: StepOptions): Promise<void> {
    await expect(this.fieldByLabelOrPlaceholder(label)).toHaveValue(value, {
      timeout: this.timeoutAfterProbe(label, opts),
    });
  }

  async assertChecked(label: string, opts?: StepOptions): Promise<void> {
    await expect(this.labelled(label)).toBeChecked({ timeout: this.budget(opts) });
  }

  async refuteChecked(label: string, opts?: StepOptions): Promise<void> {
    await expect(this.labelled(label)).not.toBeChecked({
      timeout: this.budget(opts),
    });
  }

  async assertSelected(label: string, optionLabel: string, opts?: StepOptions): Promise<void> {
    const select = this.labelled(label);
    await expect(select.locator("option:checked")).toHaveText(optionLabel, {
      timeout: this.budget(opts),
    });
  }

  async assertOptions(label: string, optionLabels: string[], opts?: StepOptions): Promise<void> {
    const select = this.labelled(label);
    await expect(select.locator("option")).toHaveText(optionLabels, {
      timeout: this.budget(opts),
    });
  }

  async assertPath(path: string, opts?: AssertPathOptions): Promise<void> {
    // Path and query of the current URL, whatever its origin — as the request
    // adapter compares them, and independent of the context's baseURL.
    const query = opts?.queryParams
      ? `?${new URLSearchParams(opts.queryParams).toString()}`
      : null;
    await expect
      .poll(
        () => {
          const url = new URL(this.page.url());
          return query === null ? url.pathname : url.pathname + url.search;
        },
        { message: `assertPath('${path}')`, timeout: this.budget(opts) },
      )
      .toBe(query === null ? path : path + query);
  }

  async refutePath(path: string, opts?: StepOptions): Promise<void> {
    await expect
      .poll(() => new URL(this.page.url()).pathname, {
        message: `refutePath('${path}')`,
        timeout: this.budget(opts),
      })
      .not.toBe(path);
  }

  async assertDownload(
    expected: string | RegExp,
    trigger: () => Promise<void>,
    opts?: DownloadOptions,
  ): Promise<void> {
    // The wait has to be armed before the click that starts the download,
    // which is why the trigger arrives as a callback rather than as an
    // earlier step in the chain.
    const [download] = await Promise.all([
      this.page.waitForEvent("download", { timeout: opts?.timeout ?? this.timeout }),
      trigger(),
    ]);
    const filename = download.suggestedFilename();
    const matched =
      typeof expected === "string"
        ? filename === expected
        : expected.test(filename);
    if (!matched) {
      throw new Error(
        `assertDownload(${typeof expected === "string" ? `'${expected}'` : String(expected)}): ` +
          `the browser offered a download named '${filename}' instead.`,
      );
    }
  }

  async until(
    description: string,
    predicate: UntilPredicate<PlaywrightStepContext>,
    opts?: UntilOptions,
  ): Promise<void> {
    await expect
      .poll(async () => Boolean(await predicate(this.context())), {
        message: `until: ${description}`,
        timeout: opts?.timeout ?? this.timeout,
        intervals: opts?.interval === undefined ? undefined : [opts.interval],
      })
      .toBe(true);
  }

  async step(
    fn: (context: PlaywrightStepContext) => Promise<unknown>,
  ): Promise<void> {
    await fn(this.context());
  }

  /**
   * raw() hands over the page itself, not the within() scope: it exists for
   * the cases the DSL does not model, where re-scoping is the caller's job.
   */
  async raw(fn: (page: Page) => unknown | Promise<unknown>): Promise<void> {
    await fn(this.page);
  }

  /** The adapter context handed to step(), until(), and friends. */
  protected context(): PlaywrightStepContext {
    return { page: this.page, scope: this.scope };
  }

  async within(
    selector: string,
  ): Promise<TestDriver<PlaywrightStepContext, Page>> {
    const scopedLocator = this.scope.locator(selector);
    // Exactly one element, as in the request adapter: wait for the first,
    // then count. Several would leave every step inside ambiguous.
    const appeared = await expect(scopedLocator.first())
      .toBeAttached({ timeout: this.timeout })
      .then(
        () => true,
        () => false,
      );
    const count = appeared ? await scopedLocator.count() : 0;
    if (count !== 1) {
      throw new Error(withinCountMessage(selector, count, this.page.url()));
    }
    return new PlaywrightDriver(
      this.page,
      scopedLocator,
      this.options,
      this.insideRunner(),
      this.cookieSeed,
    );
  }

  async debug(): Promise<void> {
    await this.page.screenshot({
      path: `debug-${Date.now()}.png`,
      fullPage: true,
    });
  }

  async wrapStep(name: string, fn: () => Promise<void>): Promise<void> {
    const run = async () => {
      await this.seedCookies();
      await fn();
    };
    // Outside @playwright/test there is no test.step(): run the step directly.
    return this.insideRunner() ? test.step(name, run) : run();
  }
}
