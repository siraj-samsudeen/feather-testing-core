import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { type Page, type Locator, expect, test } from "@playwright/test";
import type {
  AssertExactTextOptions,
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

  constructor(
    private page: Page,
    private scope: Page | Locator = page,
  ) {}

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
        { timeout: opts?.timeout },
      )
      .toBeNull();
  }

  async visit(path: string): Promise<void> {
    await this.page.goto(path);
  }

  async reload(): Promise<void> {
    await this.page.reload();
  }

  async click(text: string): Promise<void> {
    await this.scope.getByText(text, EXACT).click();
  }

  async clickLink(text: string): Promise<void> {
    await this.scope.getByRole("link", { name: text, ...EXACT }).click();
  }

  async clickButton(text: string): Promise<void> {
    await this.scope.getByRole("button", { name: text, ...EXACT }).click();
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
    await field.fill(value);
    this.lastFormLocator = this.scope.locator("form", { has: field });
  }

  async selectOption(label: string, option: string): Promise<void> {
    const select = this.labelled(label);
    await select.selectOption({ label: option });
    this.lastFormLocator = this.scope.locator("form", { has: select });
  }

  async check(label: string): Promise<void> {
    const checkbox = this.labelled(label);
    await checkbox.check();
    this.lastFormLocator = this.scope.locator("form", { has: checkbox });
  }

  async uncheck(label: string): Promise<void> {
    const checkbox = this.labelled(label);
    await checkbox.uncheck();
    this.lastFormLocator = this.scope.locator("form", { has: checkbox });
  }

  async choose(label: string): Promise<void> {
    const radio = this.scope.getByRole("radio", { name: label, ...EXACT });
    await radio.check();
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
      await submitBtn.first().click();
      return;
    }
    // Second try: a button whose accessible name contains "submit"
    const byRole = this.lastFormLocator.getByRole("button", {
      name: /submit/i,
    });
    if ((await byRole.count()) > 0) {
      await byRole.first().click();
    } else {
      // Last resort: press Enter on the last form field
      await this.lastFormLocator
        .locator("input, textarea, select")
        .last()
        .press("Enter");
    }
  }

  async attachFile(label: string, path: string): Promise<void> {
    const input = this.labelled(label);
    await input.setInputFiles(path);
    this.lastFormLocator = this.scope.locator("form", { has: input });
  }

  /** @deprecated Older name for {@link PlaywrightDriver.attachFile}. */
  async upload(label: string, path: string): Promise<void> {
    await this.attachFile(label, path);
  }

  async pressKey(key: string): Promise<void> {
    await this.page.keyboard.press(key);
  }

  async hover(text: string): Promise<void> {
    await this.scope.getByText(text, EXACT).hover();
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
    await this.scope.locator(selector).dispatchEvent("drop", { dataTransfer });
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
        timeout: opts?.timeout,
      });
    } else {
      await expect(locator.first()).toBeVisible({ timeout: opts?.timeout });
    }
  }

  async refuteHas(selector: string, opts?: AssertHasOptions): Promise<void> {
    let locator = this.scope.locator(selector);
    if (opts?.text) {
      locator = opts.exact
        ? locator.filter({ hasText: opts.text })
        : locator.filter({ hasText: new RegExp(opts.text) });
    }
    await expect(locator).toHaveCount(0, { timeout: opts?.timeout });
  }

  async assertText(text: string): Promise<void> {
    await expect(this.scope.getByText(text).first()).toBeVisible();
  }

  async assertExactText(
    text: string,
    opts?: AssertExactTextOptions,
  ): Promise<void> {
    await expect(this.scopeElement()).toHaveText(text, {
      timeout: opts?.timeout,
    });
  }

  async refuteText(text: string): Promise<void> {
    await expect(this.scope.getByText(text)).toHaveCount(0);
  }

  async assertAttribute(
    name: string,
    value?: string,
    opts?: AssertionOptions,
  ): Promise<void> {
    const assertion = expect(this.scopeElement());
    if (value === undefined) {
      await assertion.toHaveAttribute(name, { timeout: opts?.timeout });
    } else {
      await assertion.toHaveAttribute(name, value, { timeout: opts?.timeout });
    }
  }

  async refuteAttribute(
    name: string,
    opts?: AssertionOptions,
  ): Promise<void> {
    await expect(this.scopeElement()).not.toHaveAttribute(name, {
      timeout: opts?.timeout,
    });
  }

  async assertComputedStyle(
    property: string,
    value: string,
    opts?: AssertionOptions,
  ): Promise<void> {
    await expect(this.scopeElement()).toHaveCSS(property, value, {
      timeout: opts?.timeout,
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
              const child = scope.querySelector(args.selector);
              if (!child) return `descendant '${args.selector}' not found`;
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
        { timeout: opts?.timeout },
      )
      .toBeNull();
  }

  async scrollToHorizontalEnd(): Promise<void> {
    const measurement = await this.layoutElement().evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
      return {
        scrollLeft: element.scrollLeft,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      };
    });
    if (Math.abs(measurement.scrollLeft) < 1) {
      throw new Error(
        "scrollToHorizontalEnd(): expected nonzero horizontal movement, but " +
          `scrollLeft=${measurement.scrollLeft}, scrollWidth=${measurement.scrollWidth}, ` +
          `clientWidth=${measurement.clientWidth}.`,
      );
    }
  }

  async assertValue(label: string, value: string): Promise<void> {
    await expect(this.fieldByLabelOrPlaceholder(label)).toHaveValue(value);
  }

  async assertChecked(label: string): Promise<void> {
    await expect(this.labelled(label)).toBeChecked();
  }

  async refuteChecked(label: string): Promise<void> {
    await expect(this.labelled(label)).not.toBeChecked();
  }

  async assertSelected(label: string, optionLabel: string): Promise<void> {
    const select = this.labelled(label);
    await expect(select.locator("option:checked")).toHaveText(optionLabel);
  }

  async assertOptions(label: string, optionLabels: string[]): Promise<void> {
    const select = this.labelled(label);
    await expect(select.locator("option")).toHaveText(optionLabels);
  }

  async assertPath(path: string, opts?: AssertPathOptions): Promise<void> {
    if (opts?.queryParams) {
      const params = new URLSearchParams(opts.queryParams).toString();
      await expect(this.page).toHaveURL(`${path}?${params}`);
    } else {
      await expect
        .poll(() => new URL(this.page.url()).pathname, {
          message: `assertPath('${path}')`,
        })
        .toBe(path);
    }
  }

  async refutePath(path: string): Promise<void> {
    await expect
      .poll(() => new URL(this.page.url()).pathname, {
        message: `refutePath('${path}')`,
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
      this.page.waitForEvent("download", { timeout: opts?.timeout }),
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
        timeout: opts?.timeout,
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
    await expect(scopedLocator).toBeAttached();
    return new PlaywrightDriver(this.page, scopedLocator);
  }

  async debug(): Promise<void> {
    await this.page.screenshot({
      path: `debug-${Date.now()}.png`,
      fullPage: true,
    });
  }

  async wrapStep(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      // Throws when not running inside @playwright/test — fall back to
      // executing the step directly.
      test.info();
    } catch {
      return fn();
    }
    return test.step(name, fn);
  }
}
