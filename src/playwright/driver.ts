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
  UntilOptions,
  UntilPredicate,
} from "../types.js";

/** Context handed to custom step() callbacks in the Playwright adapter. */
export interface PlaywrightStepContext {
  page: Page;
  /** Current scope: the page, or the container locator inside within(). */
  scope: Page | Locator;
}

/** What onStep() is told about each step of a chain. */
export interface StepEvent {
  /** The step as the chain trace names it, e.g. `fillIn('Email', 'a@b.c')`. */
  name: string;
  status: "started" | "passed" | "failed";
  /** The cause, when status is "failed". */
  error?: unknown;
}

export interface PlaywrightSessionOptions {
  /**
   * Budget in ms for every assertion, every wait (until, assertPath, ...) and
   * every action (fillIn, click, ...) in this session. A per-call timeout,
   * such as `assertHas(sel, { timeout })`, still wins.
   *
   * Default: inside the Playwright Test runner, Playwright's own configured
   * timeouts (expect.timeout, actionTimeout) — unchanged from earlier
   * versions. Outside it (bun test, vitest, a script), 4000 ms
   * ({@link DEFAULT_TIMEOUT_OUTSIDE_RUNNER}), so a failing step reports its
   * chain before bun test's 5000 ms per-test timeout cuts the test off.
   */
  timeout?: number;
  /**
   * Called as each step starts, passes or fails: a stand-in for test.step()
   * when there is no Playwright Test runner, e.g. to log progress. It is also
   * called inside the runner. The name hides a value typed into a password
   * field, a field whose label looks secret, or one marked `sensitive`, in
   * every event: the field is inspected before the step starts.
   */
  onStep?: (event: StepEvent) => void;
}

/** The session timeout used outside the Playwright Test runner. */
export const DEFAULT_TIMEOUT_OUTSIDE_RUNNER = 4000;

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
  ) {}

  /**
   * The session budget: the caller's option, else Playwright's own defaults
   * inside its runner (undefined), else the outside-runner default.
   */
  protected get timeout(): number | undefined {
    if (this.options.timeout !== undefined) {
      return this.options.timeout;
    }
    return insidePlaywrightRunner() ? undefined : DEFAULT_TIMEOUT_OUTSIDE_RUNNER;
  }

  /**
   * Run an action that may submit a form or otherwise leave the page. When it
   * starts a navigation (e.g. POST, then a 303 redirect to a GET), wait until
   * the NEW document has loaded, so the next step never reads the page that
   * was just left. When it starts none (a form handled by JavaScript), return
   * as soon as the action does — nothing is slept.
   *
   * Playwright's actions do not wait for the navigation they start, so the
   * page itself is watched: before the action it is marked, and listeners
   * note a form submission nobody prevented and a `beforeunload`. After the
   * action, a page that is already a new document, or that noted either
   * signal, is waited for. A navigation that ends without a new document — a
   * 204/205 response, a download, or a failed request — ends the wait.
   */
  private async waitingForNewDocument(action: () => Promise<void>): Promise<void> {
    await this.page.evaluate(() => {
      const w = window as MarkedWindow;
      w.__featherDocumentBeforeAction = true;
      w.__featherLeaving = false;
      if (!w.__featherListening) {
        w.__featherListening = true;
        // Window bubble phase: runs after the form's own submit handlers.
        window.addEventListener("submit", (event) => {
          if (!event.defaultPrevented) w.__featherLeaving = true;
        });
        window.addEventListener("beforeunload", () => {
          w.__featherLeaving = true;
        });
      }
    });

    const endings: Array<() => void> = [];
    const navigationEnded = new Promise<void>((resolve) => endings.push(resolve));
    const mainFrameNavigation = (request: Request) =>
      request.isNavigationRequest() && request.frame() === this.page.mainFrame();
    const onFinished = async (request: Request) => {
      if (!mainFrameNavigation(request)) return;
      const response = await request.response().catch(() => null);
      if (!response) return;
      const status = response.status();
      const disposition = await response
        .headerValue("content-disposition")
        .catch(() => null);
      if (
        status === 204 ||
        status === 205 ||
        (disposition !== null && /attachment/i.test(disposition))
      ) {
        endings.forEach((end) => end());
      }
    };
    const onFailed = (request: Request) => {
      if (mainFrameNavigation(request)) endings.forEach((end) => end());
    };
    this.page.on("requestfinished", onFinished);
    this.page.on("requestfailed", onFailed);
    try {
      await action();

      let leaving: boolean;
      try {
        leaving = await this.page.evaluate(() => {
          const w = window as MarkedWindow;
          return !w.__featherDocumentBeforeAction || w.__featherLeaving === true;
        });
      } catch {
        // The old document's context is already gone: a navigation is under way.
        leaving = true;
      }
      if (!leaving) {
        return;
      }

      const timeout = this.timeout;
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
      this.page.off("requestfinished", onFinished);
      this.page.off("requestfailed", onFailed);
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
    await this.page.goto(path, { timeout: this.timeout });
  }

  async reload(): Promise<void> {
    await this.page.reload({ timeout: this.timeout });
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
    await field.fill(value, { timeout: this.timeout });
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

  async fillTargetIsPassword(label: string): Promise<boolean> {
    const field = this.fieldByLabelOrPlaceholder(label);
    await field.first().waitFor({ state: "attached", timeout: this.timeout });
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
    if (opts?.queryParams) {
      const params = new URLSearchParams(opts.queryParams).toString();
      await expect(this.page).toHaveURL(`${path}?${params}`, {
        timeout: this.timeout,
      });
    } else {
      await expect
        .poll(() => new URL(this.page.url()).pathname, {
          message: `assertPath('${path}')`,
          timeout: this.timeout,
        })
        .toBe(path);
    }
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
    return new PlaywrightDriver(this.page, scopedLocator, this.options);
  }

  async debug(): Promise<void> {
    await this.page.screenshot({
      path: `debug-${Date.now()}.png`,
      fullPage: true,
    });
  }

  async wrapStep(
    name: string,
    fn: () => Promise<void>,
    step?: { readonly name: string },
  ): Promise<void> {
    const onStep = this.options.onStep;
    // The name can change while the step runs (a secret value gets hidden),
    // so it is read again when the step ends.
    const currentName = () => step?.name ?? name;
    const run = async () => {
      onStep?.({ name: currentName(), status: "started" });
      try {
        await fn();
      } catch (error) {
        onStep?.({ name: currentName(), status: "failed", error });
        throw error;
      }
      onStep?.({ name: currentName(), status: "passed" });
    };
    // Outside @playwright/test there is no test.step(): run the step directly.
    return insidePlaywrightRunner() ? test.step(name, run) : run();
  }
}
