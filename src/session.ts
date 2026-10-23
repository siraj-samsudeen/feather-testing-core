import type {
  AssertHasOptions,
  AssertPathOptions,
  AssertionOptions,
  DownloadOptions,
  FieldState,
  PlainFieldState,
  FillInOptions,
  LayoutAssertionOptions,
  QueuedStep,
  SessionCookie,
  SessionOptions,
  StepEvent,
  StepOptions,
  TestDriver,
  UntilOptions,
  UntilPredicate,
} from "./types.js";
import { StepError } from "./errors.js";
import { HIDDEN_VALUE, labelLooksSecret } from "./secrets.js";

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
/**
 * fillIn and assertValue never forward a driver's text — on any path,
 * secret field or not: it can quote a field's value (in a form exact
 * hiding misses: trimmed, lower-cased, cut) or dump the page with every
 * value in it. Their errors are built from the session's own facts only.
 * Richer diagnostics for secret fields: issue #16.
 */
function ownFactsError(stepName: string, label: string, secretField: boolean): Error {
  return new Error(
    `${stepName} failed on the field labelled '${label}'${secretField ? " (a secret field)" : ""}. ` +
      "The driver's message is not shown for fillIn and assertValue: it can quote a field's " +
      "value or a dump of the page. Run debug() to see the page.",
  );
}

/**
 * Why fillIn or assertValue failed on a field that is not secret, from the
 * field's state as the driver read it (facts, not its message): the value
 * found for assertValue; for fillIn, whether the field is disabled,
 * read-only, hidden or not a text field.
 */
function fieldFactsError(
  verb: "fillIn" | "assertValue",
  stepName: string,
  label: string,
  expected: string,
  state: PlainFieldState,
): Error {
  let facts: string;
  if (verb === "assertValue") {
    facts =
      state.value === expected
        ? `: expected '${expected}', which it holds only now, after the step's wait ran out.`
        : `: expected '${expected}', found '${state.value}'.`;
  } else {
    const problems = [
      state.disabled && "disabled",
      state.readOnly && "read-only",
      !state.visible && "not visible",
      !state.editable && `${state.kind}, which cannot be typed into`,
    ].filter((p): p is string => Boolean(p));
    facts =
      problems.length > 0
        ? `: it is ${problems.length > 1 ? `${problems.slice(0, -1).join(", ")} and ${problems.at(-1)}` : problems[0]}.`
        : ` (${state.kind}: enabled, editable and visible). It may not accept that value.`;
  }
  return new Error(`${stepName} failed on the field labelled '${label}'${facts} Run debug() to see the page.`);
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

  /**
   * Drop the steps queued on this session that have not started, and say
   * how many. A chain already running is not touched: it took its steps
   * when it started. Works the same on a within() scoped session, which
   * has its own step counter: discarding there renumbers only its steps.
   */
  discard(): number {
    const dropped = this.steps.length;
    // Rewinding is right only when the queued steps hold the last numbers
    // given out, in order: steps are numbered as they are queued, and a
    // running chain takes its (earlier) steps off the queue when it starts.
    const first = this.stepIndex - dropped;
    if (this.steps.some((step, i) => step.index !== first + i)) {
      throw new Error(
        `feather-testing-core: discard() found queued steps numbered ` +
          `${this.steps.map((s) => s.index).join(", ")}, but the last numbers given out were ` +
          `${this.steps.map((_, i) => first + i).join(", ")}. This is a bug in feather-testing-core.`,
      );
    }
    this.steps = [];
    // The dropped steps were the last numbered; the next ones reuse their
    // numbers, so a failure still reads "Step 1 of 1", not "Step 3 of 1".
    this.stepIndex -= dropped;
    return dropped;
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

  click(text: string, opts?: StepOptions): this {
    return this.enqueue(`click('${text}')`, () => this.driver.click(text, opts));
  }

  clickLink(text: string, opts?: StepOptions): this {
    return this.enqueue(`clickLink('${text}')`, () =>
      this.driver.clickLink(text, opts),
    );
  }

  clickButton(text: string, opts?: StepOptions): this {
    return this.enqueue(`clickButton('${text}')`, () =>
      this.driver.clickButton(text, opts),
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
      timeout: opts?.timeout,
      run: () => this.driver.fillIn(label, value, opts),
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
    verb: "fillIn" | "assertValue";
    label: string;
    value: string;
    knownSecret: boolean;
    /** The step's own timeout, for the field check before it starts. */
    timeout?: number;
    run: () => Promise<void>;
    /** fillIn: ask lastFilledFieldIsPassword() after running, too. */
    askAfterRun: boolean;
  }): this {
    const { verb, label, value, knownSecret, timeout, run, askAfterRun } = spec;
    const nameShowingValue = `${verb}('${label}', '${value}')`;
    // An empty value has nothing to hide: it is always shown as ''.
    const nameHidingValue =
      value === "" ? nameShowingValue : `${verb}('${label}', '${HIDDEN_VALUE}')`;

    // Two things: whether the field is secret (then the driver's message
    // is withheld, whatever the value — an empty expected value does not
    // stop assertValue's message quoting the secret found), and whether the
    // name needs masking (not for an empty value, shown as '').
    let secretField = false;
    let fieldNotFound: Error | undefined;
    const hide = () => {
      secretField = true;
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
          if (await this.driver.fieldIsPassword(label, timeout)) {
            hide();
          }
        } catch (error) {
          // The field never appeared, so whether it is secret is unknown:
          // hide a non-empty value, and fail saying the field was not found
          // instead of waiting for the same field a second time.
          hide();
          // Only our own facts: whether one, none or several matched, and
          // how many when the driver says. Its text (a DOM dump, say) is
          // never forwarded.
          const detail = error instanceof Error ? error.message : String(error);
          const count = /(\d+) fields? (?:are labelled|match)/i.exec(detail)?.[1];
          const several = count !== undefined || /multiple elements/i.test(detail);
          fieldNotFound = new Error(
            several
              ? `${verb}('${label}'): ${count ?? "several"} fields match '${label}' — scope the ` +
                  "step with within(selector, ...) to pick one. Run debug() to see the page."
              : `${verb}('${label}'): no field labelled '${label}' (or with that placeholder) ` +
                  "was found. Run debug() to see the page.",
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
          // Facts only for a field the driver read and reported, in the
          // same read, as not secret; a field reported secret now is hidden.
          const state = secretField ? null : await this.readFieldState(label);
          if (state?.secret === true) hide();
          throw state?.secret === false
            ? fieldFactsError(verb, step.name, label, value, state)
            : ownFactsError(step.name, label, secretField);
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

  /** The driver's fieldState(), or null when it has none, cannot tell, or fails. */
  private async readFieldState(label: string): Promise<FieldState | null> {
    try {
      return (await this.driver.fieldState?.(label)) ?? null;
    } catch {
      return null;
    }
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

  selectOption(label: string, option: string, opts?: StepOptions): this {
    return this.enqueue(`selectOption('${label}', '${option}')`, () =>
      this.driver.selectOption(label, option, opts),
    );
  }

  check(label: string, opts?: StepOptions): this {
    return this.enqueue(`check('${label}')`, () => this.driver.check(label, opts));
  }

  uncheck(label: string, opts?: StepOptions): this {
    return this.enqueue(`uncheck('${label}')`, () =>
      this.driver.uncheck(label, opts),
    );
  }

  choose(label: string, opts?: StepOptions): this {
    return this.enqueue(`choose('${label}')`, () =>
      this.driver.choose(label, opts),
    );
  }

  submit(opts?: StepOptions): this {
    return this.enqueue("submit()", () => this.driver.submit(opts));
  }

  /** Set a file input, found by its label, to the file at `path`. */
  attachFile(label: string, path: string, opts?: StepOptions): this {
    return this.enqueue(`attachFile('${label}', '${path}')`, () =>
      this.driver.attachFile(label, path, opts),
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
  pressKey(key: string, opts?: StepOptions): this {
    return this.enqueue(`pressKey('${key}')`, () => this.driver.pressKey(key, opts));
  }

  /** Hover the element with this text. */
  hover(text: string, opts?: StepOptions): this {
    return this.enqueue(`hover('${text}')`, () => this.driver.hover(text, opts));
  }

  // --- Assertions ---

  assertText(text: string, opts?: StepOptions): this {
    return this.enqueue(`assertText('${text}')`, () =>
      this.driver.assertText(text, opts),
    );
  }

  /** Assert that the current scope's complete normalized text equals `text`. */
  assertExactText(text: string, opts?: AssertionOptions): this {
    return this.enqueue(`assertExactText('${text}')`, () =>
      this.driver.assertExactText(text, opts),
    );
  }

  refuteText(text: string, opts?: StepOptions): this {
    return this.enqueue(`refuteText('${text}')`, () =>
      this.driver.refuteText(text, opts),
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
  assertValue(label: string, value: string, opts?: StepOptions): this {
    return this.fieldValueStep({
      verb: "assertValue",
      label,
      value,
      knownSecret: labelLooksSecret(label),
      timeout: opts?.timeout,
      run: () => this.driver.assertValue(label, value, opts),
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

  /**
   * Add cookies to the session NOW, not as a step: they are in effect for
   * every step that runs after this resolves, including steps already
   * queued. Use it when the cookies must take effect at a known moment
   * outside the chain (signing a user in across several clients at once);
   * use addCookies() to add them at a point in a chain.
   */
  async addCookiesNow(cookies: readonly SessionCookie[]): Promise<void> {
    if (!this.driver.addCookies) {
      throw new Error(
        "addCookiesNow(): this adapter's driver does not implement addCookies. " +
          "Use the request or Playwright adapter.",
      );
    }
    await this.driver.addCookies(cookies);
  }

  /**
   * Add cookies to the session from this point on — e.g. sign a user in
   * after the first request. Same shape as createSession's `cookies`. The
   * step is named by the cookies' names only: their values are secrets.
   */
  addCookies(cookies: readonly SessionCookie[]): this {
    const names = cookies.map((c) => c.name).join(", ");
    return this.enqueue(`addCookies(${names})`, async () => {
      if (!this.driver.addCookies) {
        throw new Error(
          `addCookies(${names}): this adapter's driver does not implement it. ` +
            "Use the request or Playwright adapter.",
        );
      }
      await this.driver.addCookies(cookies);
    });
  }

  assertChecked(label: string, opts?: StepOptions): this {
    return this.enqueue(`assertChecked('${label}')`, () =>
      this.driver.assertChecked(label, opts),
    );
  }

  refuteChecked(label: string, opts?: StepOptions): this {
    return this.enqueue(`refuteChecked('${label}')`, () =>
      this.driver.refuteChecked(label, opts),
    );
  }

  assertSelected(label: string, optionLabel: string, opts?: StepOptions): this {
    return this.enqueue(
      `assertSelected('${label}', '${optionLabel}')`,
      () => this.driver.assertSelected(label, optionLabel, opts),
    );
  }

  assertOptions(label: string, optionLabels: string[], opts?: StepOptions): this {
    const list = optionLabels.map((l) => `'${l}'`).join(", ");
    return this.enqueue(`assertOptions('${label}', [${list}])`, () =>
      this.driver.assertOptions(label, optionLabels, opts),
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

  refutePath(path: string, opts?: StepOptions): this {
    return this.enqueue(`refutePath('${path}')`, () =>
      this.driver.refutePath(path, opts),
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
