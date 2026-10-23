import type {
  AssertHasOptions,
  AssertPathOptions,
  AssertionOptions,
  DownloadOptions,
  FillInOptions,
  LayoutAssertionOptions,
  QueuedStep,
  SessionOptions,
  StepEvent,
  TestDriver,
  UntilOptions,
  UntilPredicate,
} from "./types.js";
import { StepError } from "./errors.js";
import { HIDDEN_VALUE, hideValueInError, labelLooksSecret } from "./secrets.js";

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

/**
 * How a step that never ran is reported (skipped in a failed chain, or left
 * unrun by a within()/assertDownload() callback): its name with any typed
 * value hidden. It never reached prepare(), which is what checks whether a
 * value went into a password field. Index is kept, so the chain still marks
 * it as skipped.
 */
/**
 * What a failed step on a secret field reports instead of the driver's
 * error, which can contain the value or part of it.
 */
function withheldError(stepName: string): Error {
  return new Error(
    `${stepName} failed on a secret field. The driver's message is not shown, ` +
      "because it can contain the field's value. Re-run the step on a " +
      "non-secret field, or with debug(), to see why.",
  );
}

function unrunView(step: QueuedStep): QueuedStep {
  return step.nameHidingValue === undefined
    ? step
    : { ...step, name: step.nameHidingValue };
}

export class Session<TContext = unknown, TNative = unknown>
  implements PromiseLike<void>
{
  private steps: QueuedStep[] = [];
  private executedSteps: QueuedStep[] = [];
  private stepIndex = 0;

  /**
   * `options.onStep` is told about every step this session runs, and about
   * the steps of the sessions within() and assertDownload() create from it.
   */
  constructor(
    private driver: TestDriver<TContext, TNative>,
    private options: Pick<SessionOptions, "onStep"> = {},
  ) {}

  /** Tell onStep about a step, by the name it has right now. */
  private report(
    step: QueuedStep,
    status: StepEvent["status"],
    error?: unknown,
  ): void {
    this.options.onStep?.(
      status === "failed"
        ? { name: step.name, status, error }
        : { name: step.name, status },
    );
  }

  then<TResult1 = void, TResult2 = never>(
    onfulfilled?:
      | ((value: void) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?:
      | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
      | null,
  ): Promise<TResult1 | TResult2> {
    return this.run().then(onfulfilled, onrejected);
  }

  /**
   * Run the queued steps and return a real Promise. `await session...` does
   * the same; use run() where a thenable is not enough — bun test's
   * `expect(...).rejects` / `.resolves` only accept a real Promise:
   *
   *   await expect(session.visit("/").assertText("Nope").run()).rejects.toThrow(StepError);
   */
  run(): Promise<void> {
    return this.executeSteps();
  }

  private async executeSteps(): Promise<void> {
    const steps = [...this.steps];
    this.steps = [];

    const wrap: (
      name: string,
      fn: () => Promise<void>,
      step: QueuedStep,
    ) => Promise<void> =
      this.driver.wrapStep?.bind(this.driver) ?? ((_name, fn) => fn());

    for (const [i, step] of steps.entries()) {
      try {
        // prepare() settles the name (a secret value hidden) before anyone
        // hears of the step; the name is read again when it ends.
        await step.prepare?.();
        this.report(step, "started");
        try {
          await wrap(step.name, step.action, step);
        } catch (error) {
          this.report(step, "failed", error);
          throw error;
        }
        this.report(step, "passed");
        this.executedSteps.push(step);
      } catch (error) {
        // Include steps executed in earlier chains so the full walk is
        // visible even when the user broke the chain across multiple awaits.
        throw new StepError(
          step,
          [
            ...this.executedSteps,
            step,
            // Skipped steps never ran prepare(), so whether a typed value
            // was a password was never checked: report them with every
            // typed value hidden.
            ...steps.slice(i + 1).map((skipped) => unrunView(skipped)),
          ],
          error,
        );
      }
    }
  }

  /**
   * Throw if steps were queued on this session but never run — a callback
   * that neither returned the session nor awaited it. Running them now
   * instead would run them after whatever else the callback did.
   */
  private requireNothingLeft(verb: string): void {
    if (this.steps.length === 0) return;
    // These steps never ran, so whether a typed value was a password was
    // never checked: hide every typed value.
    const names = this.steps.map((step) => unrunView(step).name).join(", ");
    const count = this.steps.length;
    this.steps = [];
    throw new Error(
      `${verb}: the callback queued ${names} but never ran ` +
        `${count === 1 ? "it" : "them"}. Return the ` +
        "chain from the callback (s => s.assertText(...)) or await it inside " +
        "(async s => { await s.assertText(...); }).",
    );
  }

  private enqueue(name: string, action: () => Promise<void>): this {
    this.steps.push({ name, action, index: this.stepIndex++ });
    return this;
  }

  // --- Navigation ---

  visit(path: string): this {
    return this.enqueue(`visit('${path}')`, () => this.driver.visit(path));
  }

  /** Reload the current browser document, preserving its full URL and state. */
  reload(): this {
    return this.enqueue("reload()", () => this.driver.reload());
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

  /**
   * Fill a field. The step's name shows the value, which helps debugging,
   * unless the value is a secret: then it shows '••••••' instead.
   *
   * A value counts as secret when `opts.sensitive` is set, when the label
   * looks secret ("Password", "API key", "PIN", ...), or when the driver
   * reports that the field is a password field. A driver that can inspect
   * the field before filling it (fillTargetIsPassword) settles that before
   * the step starts, so the value stays out of test.step titles and onStep
   * events too; if the field never appears, the value is hidden as well.
   */
  fillIn(label: string, value: string, opts?: FillInOptions): this {
    return this.fieldValueStep({
      verb: "fillIn",
      label,
      value,
      knownSecret: opts?.sensitive === true || labelLooksSecret(label),
      run: () => this.driver.fillIn(label, value),
      askAfterRun: true,
    });
  }

  /**
   * A step that carries a field's value: fillIn() and assertValue(). The
   * value is shown in the step's name unless it is secret: `sensitive`, a
   * label that looks secret, or a password field. The driver is asked about
   * the field before the step starts (fieldIsPassword), so a secret value
   * never reaches a step name, test.step title or onStep event; a field the
   * driver cannot find is treated as secret.
   *
   * When a secret step fails, the driver's message is withheld, cause
   * included: it can quote the value typed, the value found in the field
   * (assertValue's mismatch), or a fragment of either (Testing Library's
   * key-syntax errors), and replacing the known value cannot catch those.
   */
  private fieldValueStep(spec: {
    verb: string;
    label: string;
    value: string;
    knownSecret: boolean;
    run: () => Promise<void>;
    /** fillIn: ask lastFilledFieldIsPassword() after running, too. */
    askAfterRun: boolean;
  }): this {
    const { verb, label, value, knownSecret, run, askAfterRun } = spec;
    const nameShowingValue = `${verb}('${label}', '${value}')`;
    // An empty value has nothing to hide: it is always shown as ''.
    const nameHidingValue =
      value === "" ? nameShowingValue : `${verb}('${label}', '${HIDDEN_VALUE}')`;

    let hidden = false;
    let fieldNotFound: Error | undefined;
    const hide = () => {
      hidden = value !== "";
      step.name = nameHidingValue;
    };

    const step: QueuedStep = {
      name: nameShowingValue,
      nameHidingValue,
      index: this.stepIndex++,
      prepare: async () => {
        if (knownSecret) hide();
        if (!this.driver.fieldIsPassword) {
          return;
        }
        // Asked for every value step, secret or not: it also tells a missing
        // field apart from a failing fill or a value mismatch.
        try {
          const purpose = verb === "assertValue" ? "assert" : "fill";
          if (await this.driver.fieldIsPassword(label, purpose)) {
            hide();
          }
        } catch (error) {
          // The field never appeared, so whether it is secret is unknown:
          // hide a non-empty value, and fail saying the field was not found
          // instead of waiting for the same field a second time.
          hide();
          const scrubbed = hideValueInError(error, value);
          // The driver's lookup detail, without a verb prefix of its own.
          const detail = (
            scrubbed instanceof Error ? scrubbed.message : String(scrubbed)
          ).replace(/^\w+\('[^']*'\): /, "");
          const ambiguous = /fields are labelled|multiple elements/i.test(detail);
          fieldNotFound = new Error(
            ambiguous
              ? `${verb}('${label}'): ${detail}`
              : `${verb}('${label}'): no field labelled '${label}' (or with ` +
                  `that placeholder) was found. ${detail}`,
          );
        }
      },
      action: async () => {
        if (fieldNotFound !== undefined) {
          throw fieldNotFound;
        }
        try {
          await run();
        } catch (error) {
          if (askAfterRun && (await this.lastFilledFieldIsPassword())) {
            hide();
          }
          if (hidden) {
            throw withheldError(nameHidingValue);
          }
          throw error;
        }
        if (askAfterRun && (await this.lastFilledFieldIsPassword())) {
          hide();
        }
      },
    };
    if (knownSecret) {
      // Known before the step runs: hidden from the moment it is queued.
      hide();
    }
    this.steps.push(step);
    return this;
  }

  /** Ask the driver whether the field just filled is a password field. */
  private async lastFilledFieldIsPassword(): Promise<boolean> {
    if (!this.driver.lastFilledFieldIsPassword) {
      return false;
    }
    try {
      return await this.driver.lastFilledFieldIsPassword();
    } catch {
      // The driver could not tell, so err on the side of hiding the value.
      return true;
    }
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
  assertExactText(text: string, opts?: AssertionOptions): this {
    return this.enqueue(`assertExactText('${text}')`, () =>
      this.driver.assertExactText(text, opts),
    );
  }

  refuteText(text: string): this {
    return this.enqueue(`refuteText('${text}')`, () =>
      this.driver.refuteText(text),
    );
  }

  /** Assert that the current scope has `name`, optionally with an exact value. */
  assertAttribute(
    name: string,
    value?: string,
    opts?: AssertionOptions,
  ): this {
    const expectation = value === undefined ? "present" : `'${value}'`;
    return this.enqueue(`assertAttribute('${name}', ${expectation})`, () =>
      this.driver.assertAttribute(name, value, opts),
    );
  }

  /** Assert that the current scope does not have attribute `name`. */
  refuteAttribute(name: string, opts?: AssertionOptions): this {
    return this.enqueue(`refuteAttribute('${name}')`, () =>
      this.driver.refuteAttribute(name, opts),
    );
  }

  /** Assert a browser-computed CSS property on the current scope. */
  assertComputedStyle(
    property: string,
    value: string,
    opts?: AssertionOptions,
  ): this {
    return this.enqueue(
      `assertComputedStyle('${property}', '${value}')`,
      () => this.driver.assertComputedStyle(property, value, opts),
    );
  }

  /** Assert that the current scope fits horizontally without overflow. */
  assertNoHorizontalOverflow(opts?: LayoutAssertionOptions): this {
    return this.enqueue("assertNoHorizontalOverflow()", () =>
      this.driver.assertNoHorizontalOverflow(opts),
    );
  }

  /** Assert that content is wider than the current scope. */
  assertHorizontalOverflow(opts?: LayoutAssertionOptions): this {
    return this.enqueue("assertHorizontalOverflow()", () =>
      this.driver.assertHorizontalOverflow(opts),
    );
  }

  /** Assert that a descendant's horizontal bounds fit the current scope. */
  assertHorizontallyContained(
    selector: string,
    opts?: LayoutAssertionOptions,
  ): this {
    return this.enqueue(`assertHorizontallyContained('${selector}')`, () =>
      this.driver.assertHorizontallyContained(selector, opts),
    );
  }

  /** Scroll the current scope to its real horizontal end. */
  scrollToHorizontalEnd(opts?: LayoutAssertionOptions): this {
    return this.enqueue("scrollToHorizontalEnd()", () =>
      this.driver.scrollToHorizontalEnd(opts),
    );
  }

  /** Hides `value` exactly as fillIn() does when the field is secret. */
  assertValue(label: string, value: string): this {
    return this.fieldValueStep({
      verb: "assertValue",
      label,
      value,
      knownSecret: labelLooksSecret(label),
      run: () => this.driver.assertValue(label, value),
      askAfterRun: false,
    });
  }

  /**
   * Submit the form the field labelled `label` belongs to (as Enter in that
   * field would) and pass only if it is not sent because that required field
   * is empty — the deliberate counterpart of the loud failure every other
   * submit gives. Fails if the form is sent, or is held back by another field.
   */
  assertSubmitBlocked(label: string): this {
    return this.enqueue(`assertSubmitBlocked('${label}')`, async () => {
      if (!this.driver.assertSubmitBlocked) {
        throw new Error(
          `assertSubmitBlocked('${label}'): this adapter's driver does not implement it. ` +
            "Use the request or Playwright adapter.",
        );
      }
      await this.driver.assertSubmitBlocked(label);
    });
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
          const scoped = new Session(this.driver, this.options);
          await trigger(scoped);
          scoped.requireNothingLeft(`assertDownload('${describe(expected)}')`);
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
   * An async callback that queues steps without awaiting them type-checks,
   * so a scoped chain with steps left over fails the within() step, naming
   * them, instead of passing without running them.
   */
  within(
    selector: string,
    fn: (
      scoped: Session<TContext, TNative>,
    ) => Session<TContext, TNative> | PromiseLike<unknown>,
  ): this {
    return this.enqueue(`within('${selector}')`, async () => {
      const scopedDriver = await this.driver.within(selector);
      const scopedSession = new Session(scopedDriver, this.options);
      await fn(scopedSession);
      scopedSession.requireNothingLeft(`within('${selector}')`);
    });
  }

  // --- Debug ---

  debug(): this {
    return this.enqueue("debug()", () => this.driver.debug());
  }
}
