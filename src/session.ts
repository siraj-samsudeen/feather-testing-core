import type {
  AssertExactTextOptions,
  AssertHasOptions,
  AssertPathOptions,
  DownloadOptions,
  QueuedStep,
  TestDriver,
  UntilOptions,
  UntilPredicate,
} from "./types.js";
import { StepError } from "./errors.js";

/**
 * Verbs that take a human description exist so a failure names intent rather
 * than mechanics. An empty description defeats that, so it is rejected where
 * the mistake is — at the call site, before the chain runs.
 */
function requireDescription(verb: string, value: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `feather-testing-core: ${verb}() requires a non-empty description as its ` +
        "first argument — it is what the chain trace prints when the step fails.",
    );
  }
}

/** How a string-or-regex expectation reads in the chain trace. */
function describe(expected: string | RegExp): string {
  return typeof expected === "string" ? expected : String(expected);
}

export class Session<TContext = unknown, TNative = unknown>
  implements PromiseLike<void>
{
  private steps: QueuedStep[] = [];
  private executedSteps: QueuedStep[] = [];
  private stepIndex = 0;

  constructor(private driver: TestDriver<TContext, TNative>) {}

  then<TResult1 = void, TResult2 = never>(
    onfulfilled?:
      | ((value: void) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?:
      | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
      | null,
  ): Promise<TResult1 | TResult2> {
    return this.executeSteps().then(onfulfilled, onrejected);
  }

  private async executeSteps(): Promise<void> {
    const steps = [...this.steps];
    this.steps = [];

    const wrap: (name: string, fn: () => Promise<void>) => Promise<void> =
      this.driver.wrapStep?.bind(this.driver) ?? ((_name, fn) => fn());

    for (const [i, step] of steps.entries()) {
      try {
        await wrap(step.name, step.action);
        this.executedSteps.push(step);
      } catch (error) {
        // Include steps executed in earlier chains so the full walk is
        // visible even when the user broke the chain across multiple awaits.
        throw new StepError(
          step,
          [...this.executedSteps, ...steps.slice(i)],
          error,
        );
      }
    }
  }

  private enqueue(name: string, action: () => Promise<void>): this {
    this.steps.push({ name, action, index: this.stepIndex++ });
    return this;
  }

  // --- Navigation ---

  visit(path: string): this {
    return this.enqueue(`visit('${path}')`, () => this.driver.visit(path));
  }

  // --- Interactions ---

  click(text: string): this {
    return this.enqueue(`click('${text}')`, () => this.driver.click(text));
  }

  clickLink(text: string): this {
    return this.enqueue(`clickLink('${text}')`, () =>
      this.driver.clickLink(text),
    );
  }

  clickButton(text: string): this {
    return this.enqueue(`clickButton('${text}')`, () =>
      this.driver.clickButton(text),
    );
  }

  fillIn(label: string, value: string): this {
    return this.enqueue(`fillIn('${label}', '${value}')`, () =>
      this.driver.fillIn(label, value),
    );
  }

  selectOption(label: string, option: string): this {
    return this.enqueue(`selectOption('${label}', '${option}')`, () =>
      this.driver.selectOption(label, option),
    );
  }

  check(label: string): this {
    return this.enqueue(`check('${label}')`, () => this.driver.check(label));
  }

  uncheck(label: string): this {
    return this.enqueue(`uncheck('${label}')`, () =>
      this.driver.uncheck(label),
    );
  }

  choose(label: string): this {
    return this.enqueue(`choose('${label}')`, () =>
      this.driver.choose(label),
    );
  }

  submit(): this {
    return this.enqueue("submit()", () => this.driver.submit());
  }

  /** Set a file input, found by its label, to the file at `path`. */
  attachFile(label: string, path: string): this {
    return this.enqueue(`attachFile('${label}', '${path}')`, () =>
      this.driver.attachFile(label, path),
    );
  }

  /** @deprecated Older name for {@link Session.attachFile}. */
  upload(label: string, path: string): this {
    return this.enqueue(`upload('${label}', '${path}')`, () =>
      this.driver.upload
        ? this.driver.upload(label, path)
        : this.driver.attachFile(label, path),
    );
  }

  dropFile(selector: string, path: string): this {
    return this.enqueue(`dropFile('${selector}', '${path}')`, () =>
      this.driver.dropFile(selector, path),
    );
  }

  /** Press a key on the focused element, e.g. 'Enter' or 'Control+A'. */
  pressKey(key: string): this {
    return this.enqueue(`pressKey('${key}')`, () => this.driver.pressKey(key));
  }

  /** Hover the element with this text. */
  hover(text: string): this {
    return this.enqueue(`hover('${text}')`, () => this.driver.hover(text));
  }

  // --- Assertions ---

  assertText(text: string): this {
    return this.enqueue(`assertText('${text}')`, () =>
      this.driver.assertText(text),
    );
  }

  /** Assert that the current scope's complete normalized text equals `text`. */
  assertExactText(text: string, opts?: AssertExactTextOptions): this {
    return this.enqueue(`assertExactText('${text}')`, () =>
      this.driver.assertExactText(text, opts),
    );
  }

  refuteText(text: string): this {
    return this.enqueue(`refuteText('${text}')`, () =>
      this.driver.refuteText(text),
    );
  }

  assertValue(label: string, value: string): this {
    return this.enqueue(`assertValue('${label}', '${value}')`, () =>
      this.driver.assertValue(label, value),
    );
  }

  assertChecked(label: string): this {
    return this.enqueue(`assertChecked('${label}')`, () =>
      this.driver.assertChecked(label),
    );
  }

  refuteChecked(label: string): this {
    return this.enqueue(`refuteChecked('${label}')`, () =>
      this.driver.refuteChecked(label),
    );
  }

  assertSelected(label: string, optionLabel: string): this {
    return this.enqueue(
      `assertSelected('${label}', '${optionLabel}')`,
      () => this.driver.assertSelected(label, optionLabel),
    );
  }

  assertOptions(label: string, optionLabels: string[]): this {
    const list = optionLabels.map((l) => `'${l}'`).join(", ");
    return this.enqueue(`assertOptions('${label}', [${list}])`, () =>
      this.driver.assertOptions(label, optionLabels),
    );
  }

  assertHas(selector: string, opts?: AssertHasOptions): this {
    const desc = opts?.text
      ? `assertHas('${selector}', text: '${opts.text}')`
      : `assertHas('${selector}')`;
    return this.enqueue(desc, () => this.driver.assertHas(selector, opts));
  }

  refuteHas(selector: string, opts?: AssertHasOptions): this {
    const desc = opts?.text
      ? `refuteHas('${selector}', text: '${opts.text}')`
      : `refuteHas('${selector}')`;
    return this.enqueue(desc, () => this.driver.refuteHas(selector, opts));
  }

  assertPath(path: string, opts?: AssertPathOptions): this {
    return this.enqueue(`assertPath('${path}')`, () =>
      this.driver.assertPath(path, opts),
    );
  }

  refutePath(path: string): this {
    return this.enqueue(`refutePath('${path}')`, () =>
      this.driver.refutePath(path),
    );
  }

  /**
   * Assert that running `trigger` makes the browser offer a download whose
   * suggested filename matches `expected`. The trigger is a callback because
   * the wait has to be armed before the click that starts the download.
   *
   * Browser-only: the RTL adapter throws a BrowserOnlyVerbError.
   */
  assertDownload(
    expected: string | RegExp,
    trigger: (
      scoped: Session<TContext, TNative>,
    ) => Session<TContext, TNative> | PromiseLike<unknown>,
    opts?: DownloadOptions,
  ): this {
    return this.enqueue(`assertDownload('${describe(expected)}')`, () =>
      this.driver.assertDownload(
        expected,
        async () => {
          await trigger(new Session(this.driver));
        },
        opts,
      ),
    );
  }

  // --- Waiting ---

  /**
   * Wait for a condition instead of sleeping. `description` is mandatory: it
   * is what the chain trace prints, so a timeout reads
   * `[FAILED] until: the export finishes` rather than naming a mechanism.
   *
   * The predicate receives the adapter's context ({ page, scope } for
   * Playwright, { user, container } for RTL) and may be sync or async; it
   * is polled until it returns something truthy or the budget is spent.
   */
  until(
    description: string,
    predicate: UntilPredicate<TContext>,
    opts?: UntilOptions,
  ): this {
    requireDescription("until", description);
    return this.enqueue(`until: ${description}`, () =>
      this.driver.until(description, predicate, opts),
    );
  }

  // --- Escape hatch ---

  /**
   * Queue a named custom step. `fn` receives the adapter's context
   * ({ page, scope } for Playwright, { user, container } for RTL), so a
   * missing verb never forces abandoning the chain. The name shows up in
   * StepError output like any built-in step.
   */
  step(name: string, fn: (context: TContext) => Promise<unknown>): this {
    return this.enqueue(`step('${name}')`, () => this.driver.step(fn));
  }

  /**
   * Drop to the driver itself — Playwright's `page`, RTL's scoped queries —
   * without leaving the chain. `label` is mandatory and registers as a named
   * step, so an escape hatch still names intent in the trace instead of
   * ending it: `[FAILED] raw('drag the card to Done')`.
   */
  raw(label: string, fn: (native: TNative) => unknown | Promise<unknown>): this {
    requireDescription("raw", label);
    return this.enqueue(`raw('${label}')`, () => this.driver.raw(fn));
  }

  // --- Scoping ---

  /**
   * `fn` must either return the scoped session — so its queued steps run — or
   * a promise it already awaited. Returning anything else would silently drop
   * the scoped chain, which is why the callback's return type is not `unknown`.
   */
  within(
    selector: string,
    fn: (
      scoped: Session<TContext, TNative>,
    ) => Session<TContext, TNative> | PromiseLike<unknown>,
  ): this {
    return this.enqueue(`within('${selector}')`, async () => {
      const scopedDriver = await this.driver.within(selector);
      const scopedSession = new Session(scopedDriver);
      await fn(scopedSession);
    });
  }

  // --- Debug ---

  debug(): this {
    return this.enqueue("debug()", () => this.driver.debug());
  }
}
