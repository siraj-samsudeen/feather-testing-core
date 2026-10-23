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
  SessionOptions,
  UntilOptions,
  UntilPredicate,
} from "../types.js";
import { DEFAULT_TIMEOUT } from "../types.js";

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
   * deciding the page stays. Default {@link NAVIGATION_START_WINDOW_MS}
   * (500). Raise it on a slow CI machine if submits return too early.
   */
  navigationStartWindow?: number;
  /**
   * After a navigation of the page fails: how long in ms to wait for a newer
   * navigation that replaced it (a script setting `location` cuts a POST
   * short) before ending the wait. Default
   * {@link REPLACED_NAVIGATION_WINDOW_MS} (250).
   */
  replacedNavigationWindow?: number;
}

/**
 * How long a page that signalled it is leaving (a navigating form submission
 * or `beforeunload`) gets to actually start a main-frame navigation before
 * the wait is dropped. Only spent when the signal came but no request did.
 * Overridable with the `navigationStartWindow` session option.
 */
export const NAVIGATION_START_WINDOW_MS = 500;

/**
 * How long after a main-frame navigation fails to wait for a newer one that
 * replaced it, before treating the failure as the end of the navigation.
 * Overridable with the `replacedNavigationWindow` session option.
 */
export const REPLACED_NAVIGATION_WINDOW_MS = 250;

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

type MarkedWindow = {
  __featherDocumentBeforeAction?: boolean;
  __featherLeaving?: boolean;
  __featherListening?: boolean;
};

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
  ) {}

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
    if (this.options.navigationTimeout !== undefined) {
      return this.options.navigationTimeout;
    }
    const settings = (
      this.page as unknown as {
        _timeoutSettings?: {
          navigationTimeout?: (options: object) => number | { timeout?: number };
        };
      }
    )._timeoutSettings;
    try {
      const value = settings?.navigationTimeout?.({});
      const ms = typeof value === "number" ? value : value?.timeout;
      if (typeof ms === "number") return ms;
    } catch {
      // Fall through to Playwright's default.
    }
    return PLAYWRIGHT_DEFAULT_NAVIGATION_TIMEOUT;
  }

  private insideRunner(): boolean {
    this.insideRunnerCache ??= insidePlaywrightRunner();
    return this.insideRunnerCache;
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
        const w = window as MarkedWindow;
        w.__featherDocumentBeforeAction = true;
        w.__featherLeaving = false;
        if (w.__featherListening) return;
        w.__featherListening = true;
        // Window bubble phase: runs after the form's own submit handlers.
        window.addEventListener("submit", (event) => {
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
          w.__featherLeaving = true;
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
          w.__featherLeaving = true;
        });
        window.addEventListener("beforeunload", () => {
          w.__featherLeaving = true;
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
  private async waitingForNewDocument(action: () => Promise<void>): Promise<void> {
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
        }, this.options.replacedNavigationWindow ?? REPLACED_NAVIGATION_WINDOW_MS),
      );
    };
    this.page.on("request", onRequest);
    this.page.on("requestfinished", onFinished);
    this.page.on("requestfailed", onFailed);
    try {
      await action();

      let state: "new-document" | "leaving" | "staying";
      try {
        state = await this.page.evaluate(() => {
          const w = window as MarkedWindow;
          if (!w.__featherDocumentBeforeAction) return "new-document";
          return w.__featherLeaving ? "leaving" : "staying";
        });
      } catch (error) {
        // The old document's context is already gone: a navigation is under
        // way. Any other failure (e.g. the page was closed) is the real error.
        if (!/execution context was destroyed|navigat/i.test(String(error))) {
          throw error;
        }
        state = "new-document";
      }
      if (state === "staying" && navigations.length === 0) {
        return;
      }
      if (state === "leaving" && navigations.length === 0) {
        // The page signalled it is leaving; make sure a navigation of this
        // page really starts before blocking on it.
        const started = await this.page
          .waitForRequest(isMainFrameNavigation, {
            timeout:
              this.options.navigationStartWindow ?? NAVIGATION_START_WINDOW_MS,
          })
          .then(
            () => true,
            () => false,
          );
        if (!started) {
          return;
        }
      }

      const timeout = this.navigationTimeout();
      // "complete" (the load event) rather than "interactive": it is what
      // visit() waits for (page.goto's default), so a step after a submit
      // sees the page in the same state as a step after a visit, including
      // anything load handlers render.
      const newDocument = this.page.waitForFunction(
        () =>
          !(window as MarkedWindow).__featherDocumentBeforeAction &&
          document.readyState === "complete",
        undefined,
        { timeout },
      );
      // The losing branch must not surface as an unhandled rejection.
      newDocument.catch(() => {});
      try {
        await Promise.race([newDocument, navigationEnded]);
      } catch (error) {
        throw new Error(
          `the page started to navigate, but no new page finished loading` +
            `${timeout === undefined ? "" : ` within ${timeout}ms`}: ` +
            (error instanceof Error ? error.message.split("\n")[0] : String(error)),
        );
      }
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
    // With baseUrl, paths resolve as in the request adapter; without it,
    // Playwright resolves them against the browser context's baseURL.
    const url =
      this.options.baseUrl === undefined
        ? path
        : new URL(path, this.options.baseUrl).href;
    await this.page.goto(url, { timeout: this.navigationTimeout() });
  }

  async reload(): Promise<void> {
    await this.page.reload({ timeout: this.navigationTimeout() });
  }

  async click(text: string): Promise<void> {
    await this.waitingForNewDocument(() =>
      this.scope.getByText(text, EXACT).click({ timeout: this.timeout }),
    );
  }

  async clickLink(text: string): Promise<void> {
    await this.waitingForNewDocument(() =>
      this.scope
        .getByRole("link", { name: text, ...EXACT })
        .click({ timeout: this.timeout }),
    );
  }

  async clickButton(text: string): Promise<void> {
    await this.waitingForNewDocument(() =>
      this.scope
        .getByRole("button", { name: text, ...EXACT })
        .click({ timeout: this.timeout }),
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

  async fillIn(label: string, value: string): Promise<void> {
    const field = this.fieldByLabelOrPlaceholder(label);
    this.lastFilledField = field;
    await field.fill(value, { timeout: this.fillTimeout(label) });
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
   * The step's budget minus what fillTargetIsPassword() already spent on the
   * same field, so finding the field and filling it share one `timeout`
   * instead of taking up to twice as long.
   */
  private fillTimeout(label: string): number | undefined {
    const probe = this.fillProbe;
    this.fillProbe = null;
    const timeout = this.timeout;
    if (!probe || probe.label !== label || !timeout) {
      return timeout; // undefined: Playwright's own; 0: no limit
    }
    return Math.max(1, timeout - (Date.now() - probe.startedAt));
  }

  /** When fillTargetIsPassword() began looking for a field, and which. */
  private fillProbe: { label: string; startedAt: number } | null = null;

  async fillTargetIsPassword(label: string): Promise<boolean> {
    this.fillProbe = { label, startedAt: Date.now() };
    const field = this.fieldByLabelOrPlaceholder(label);
    await field.first().waitFor({ state: "attached", timeout: this.timeout });
    // Several matches: fill() would fail on strict mode, and which field the
    // value was meant for is unknown, so say so now (the value stays hidden,
    // as in the request adapter).
    const count = await field.count();
    if (count > 1) {
      throw new Error(
        `fillIn('${label}'): ${count} fields are labelled '${label}'. ` +
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

  async selectOption(label: string, option: string): Promise<void> {
    const select = this.labelled(label);
    await select.selectOption({ label: option }, { timeout: this.timeout });
    this.lastFormLocator = this.scope.locator("form", { has: select });
  }

  async check(label: string): Promise<void> {
    const checkbox = this.labelled(label);
    await checkbox.check({ timeout: this.timeout });
    this.lastFormLocator = this.scope.locator("form", { has: checkbox });
  }

  async uncheck(label: string): Promise<void> {
    const checkbox = this.labelled(label);
    await checkbox.uncheck({ timeout: this.timeout });
    this.lastFormLocator = this.scope.locator("form", { has: checkbox });
  }

  async choose(label: string): Promise<void> {
    const radio = this.scope.getByRole("radio", { name: label, ...EXACT });
    await radio.check({ timeout: this.timeout });
    this.lastFormLocator = this.scope.locator("form", { has: radio });
  }

  async submit(): Promise<void> {
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
      await this.waitingForNewDocument(() =>
        submitBtn.first().click({ timeout: this.timeout }),
      );
      return;
    }
    // Second try: a button whose accessible name contains "submit"
    const byRole = this.lastFormLocator.getByRole("button", {
      name: /submit/i,
    });
    if ((await byRole.count()) > 0) {
      await this.waitingForNewDocument(() =>
        byRole.first().click({ timeout: this.timeout }),
      );
    } else {
      // Last resort: press Enter on the last form field
      const lastField = this.lastFormLocator
        .locator("input, textarea, select")
        .last();
      await this.waitingForNewDocument(() =>
        lastField.press("Enter", { timeout: this.timeout }),
      );
    }
  }

  async attachFile(label: string, path: string): Promise<void> {
    const input = this.labelled(label);
    await input.setInputFiles(path, { timeout: this.timeout });
    this.lastFormLocator = this.scope.locator("form", { has: input });
  }

  /** @deprecated Older name for {@link PlaywrightDriver.attachFile}. */
  async upload(label: string, path: string): Promise<void> {
    await this.attachFile(label, path);
  }

  async pressKey(key: string): Promise<void> {
    await this.waitingForNewDocument(() => this.page.keyboard.press(key));
  }

  async hover(text: string): Promise<void> {
    await this.scope.getByText(text, EXACT).hover({ timeout: this.timeout });
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
      await expect(locator.first()).toBeVisible({ timeout: opts?.timeout ?? this.timeout });
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

  async assertText(text: string): Promise<void> {
    await expect(this.scope.getByText(text).first()).toBeVisible({
      timeout: this.timeout,
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

  async refuteText(text: string): Promise<void> {
    await expect(this.scope.getByText(text)).toHaveCount(0, {
      timeout: this.timeout,
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

  async assertValue(label: string, value: string): Promise<void> {
    await expect(this.fieldByLabelOrPlaceholder(label)).toHaveValue(value, {
      timeout: this.timeout,
    });
  }

  async assertChecked(label: string): Promise<void> {
    await expect(this.labelled(label)).toBeChecked({ timeout: this.timeout });
  }

  async refuteChecked(label: string): Promise<void> {
    await expect(this.labelled(label)).not.toBeChecked({
      timeout: this.timeout,
    });
  }

  async assertSelected(label: string, optionLabel: string): Promise<void> {
    const select = this.labelled(label);
    await expect(select.locator("option:checked")).toHaveText(optionLabel, {
      timeout: this.timeout,
    });
  }

  async assertOptions(label: string, optionLabels: string[]): Promise<void> {
    const select = this.labelled(label);
    await expect(select.locator("option")).toHaveText(optionLabels, {
      timeout: this.timeout,
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
        { message: `assertPath('${path}')`, timeout: this.timeout },
      )
      .toBe(query === null ? path : path + query);
  }

  async refutePath(path: string): Promise<void> {
    await expect
      .poll(() => new URL(this.page.url()).pathname, {
        message: `refutePath('${path}')`,
        timeout: this.timeout,
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
    await expect(scopedLocator).toBeAttached({ timeout: this.timeout });
    return new PlaywrightDriver(
      this.page,
      scopedLocator,
      this.options,
      this.insideRunner(),
    );
  }

  async debug(): Promise<void> {
    await this.page.screenshot({
      path: `debug-${Date.now()}.png`,
      fullPage: true,
    });
  }

  async wrapStep(name: string, fn: () => Promise<void>): Promise<void> {
    // Outside @playwright/test there is no test.step(): run the step directly.
    return this.insideRunner() ? test.step(name, fn) : fn();
  }
}
