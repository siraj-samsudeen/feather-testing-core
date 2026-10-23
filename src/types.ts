export interface AssertHasOptions {
  text?: string;
  count?: number;
  exact?: boolean;
  timeout?: number;
}

export interface AssertionOptions {
  /** Overall budget in ms. Defaults to the adapter's own assertion timeout. */
  timeout?: number;
}

/**
 * Options every waiting verb takes. `timeout` is this step's budget in ms:
 * it wins over the session's `timeout`, which wins over the adapter's
 * default. The request adapter, which never waits, accepts and ignores it.
 */
export type StepOptions = AssertionOptions;

export interface LayoutAssertionOptions extends AssertionOptions {
  /** Allowed rounding difference in CSS pixels. Defaults to 1. */
  tolerance?: number;
}

export interface FillInOptions extends StepOptions {
  /**
   * Show the value as '••••••' in failure reports and step titles. Values
   * typed into a password field, or into a field whose label looks secret,
   * are hidden without it; use this for any other value that must not leak.
   */
  sensitive?: boolean;
}

export interface AssertPathOptions extends StepOptions {
  queryParams?: Record<string, string>;
}

export interface UntilOptions {
  /** Overall budget in ms. Defaults to the adapter's own wait timeout. */
  timeout?: number;
  /** Gap between polls in ms. Defaults to the adapter's own cadence. */
  interval?: number;
}

export interface DownloadOptions {
  /** How long to wait for the download to start, in ms. */
  timeout?: number;
}

/** What onStep() is told about each step of a chain. */
export interface StepEvent {
  /** The step as the chain trace names it, e.g. `fillIn('Email', 'a@b.c')`. */
  name: string;
  status: "started" | "passed" | "failed";
  /** The cause, when status is "failed". */
  error?: unknown;
}

/**
 * A cookie to start a session with, e.g. a signed-in session's cookie.
 * Shaped like Playwright's: `expires` is in seconds since the epoch.
 */
export interface SessionCookie {
  name: string;
  value: string;
  /** Default: the host of the session's baseUrl (a host-only cookie). */
  domain?: string;
  /** Default: "/". */
  path?: string;
  /** Seconds since the epoch; -1 or none: a session cookie (as Playwright's context.cookies() gives it). */
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

/**
 * Options every adapter's createSession(native, options) accepts. Adapters
 * add their own (e.g. Playwright's navigationTimeout).
 */
export interface SessionOptions {
  /**
   * Budget in ms for anything the session waits for; each adapter documents
   * what waits in it. A per-call timeout still wins. 0 means no limit.
   * Default: {@link DEFAULT_TIMEOUT} (Playwright: its own configured
   * timeouts while inside the Playwright Test runner).
   */
  timeout?: number;
  /**
   * What visit() paths resolve against, as `new URL(path, baseUrl)`: an
   * origin, optionally with a base path. Each adapter documents its default.
   */
  baseUrl?: string;
  /**
   * Called as each step starts, passes or fails — a stand-in for
   * test.step() that works under any runner, e.g. to log progress. Steps
   * inside within() are reported too, between the within() step's own
   * "started" and "passed". The name hides a value typed into a password
   * field, a field whose label looks secret, or one marked `sensitive`, in
   * every event.
   */
  onStep?: (event: StepEvent) => void;
  /**
   * Cookies the session starts with — e.g. a signed-in user's session
   * cookie, minted by the test — sent from the first request on. Cookies the
   * app sets or deletes later behave as usual.
   */
  cookies?: SessionCookie[];
}

/** The session timeout when none is set (and, for Playwright, outside its runner). */
export const DEFAULT_TIMEOUT = 4000;

/**
 * The message for a within() selector that does not match exactly one
 * element, shared by the adapters so they word it the same way.
 */
export function withinCountMessage(selector: string, count: number, where = ""): string {
  return (
    `within('${selector}'): the selector matched ${count} element${count === 1 ? "" : "s"}` +
    `${where ? ` on ${where}` : ""}; it must match exactly one. Narrow the selector ` +
    "(an id, a class, a data attribute), or use :first-of-type if the first one is really meant."
  );
}

export interface QueuedStep {
  name: string;
  action: () => Promise<void>;
  index: number;
  /**
   * Runs before the step is reported as started (before wrapStep), so it can
   * settle the step's name first — e.g. hide a value typed into a field that
   * turns out to be a password field.
   */
  prepare?: () => Promise<void>;
  /**
   * The name with any typed value hidden, for reporting a step that never
   * ran (and so never learned whether its value was secret).
   */
  nameHidingValue?: string;
}

/** A condition polled by `until()`; may be sync or async. */
export type UntilPredicate<TContext> = (
  context: TContext,
) => unknown | Promise<unknown>;

/**
 * TContext is the adapter-specific context handed to custom step() callbacks
 * (e.g. { page, scope } for Playwright, { user, container } for RTL).
 *
 * TNative is the adapter's own driving handle, handed to raw() callbacks:
 * Playwright's `Page`, RTL's scoped query object.
 */
/**
 * What {@link TestDriver.fieldState} reports about a field: for a password
 * field only that it is secret, decided on the same element in the same
 * read, so no value can come from a field that turned secret meanwhile.
 */
export type FieldState = { secret: true } | PlainFieldState;

/** A field that is not secret, as {@link TestDriver.fieldState} reads it. */
export interface PlainFieldState {
  secret: false;
  /** Its current value. */
  value: string;
  disabled: boolean;
  readOnly: boolean;
  visible: boolean;
  /** Whether text can be typed into it: a textarea, a text-like input, or contenteditable. */
  editable: boolean;
  /** What it is: 'an <input type="number">', 'a <select>'. */
  kind: string;
}

export interface TestDriver<TContext = unknown, TNative = unknown> {
  visit(path: string): Promise<void>;
  reload(): Promise<void>;
  click(text: string, opts?: StepOptions): Promise<void>;
  clickLink(text: string, opts?: StepOptions): Promise<void>;
  clickButton(text: string, opts?: StepOptions): Promise<void>;
  fillIn(label: string, value: string, opts?: StepOptions): Promise<void>;
  /**
   * Optional: whether the field the most recent fillIn() targeted is a
   * password field (type="password"). The session asks right after every
   * fillIn(), whether it passed or failed, and hides the typed value in
   * failure reports when the answer is yes. It must answer at once, without
   * waiting for anything. A driver without it relies on the label check and
   * the `sensitive` option alone.
   */
  lastFilledFieldIsPassword?(): Promise<boolean>;
  /**
   * Optional: wait (within the driver's own budget) until the field that
   * fillIn() or assertValue() would target is present, and say whether it
   * is a password field. The session asks before the step is reported as
   * started, so the value never reaches a step title or step event. Throws
   * when the field never appears.
   */
  fieldIsPassword?(
    label: string,
    /** The step's own timeout, when it set one. */
    timeout?: number,
  ): Promise<boolean>;
  /**
   * Optional: the state of the field fillIn() or assertValue() targets, read
   * at once without waiting, or null when not exactly one field matches.
   * Asked after one of those steps failed on a field that is not secret, so
   * the session can say why in its own words (it never forwards a driver's
   * message for them).
   */
  fieldState?(label: string): Promise<FieldState | null>;
  selectOption(label: string, option: string, opts?: StepOptions): Promise<void>;
  check(label: string, opts?: StepOptions): Promise<void>;
  uncheck(label: string, opts?: StepOptions): Promise<void>;
  choose(label: string, opts?: StepOptions): Promise<void>;
  submit(opts?: StepOptions): Promise<void>;
  attachFile(label: string, path: string, opts?: StepOptions): Promise<void>;
  /** @deprecated The older name for {@link TestDriver.attachFile}. */
  upload?(label: string, path: string): Promise<void>;
  dropFile(selector: string, path: string): Promise<void>;
  pressKey(key: string, opts?: StepOptions): Promise<void>;
  hover(text: string, opts?: StepOptions): Promise<void>;
  assertHas(selector: string, opts?: AssertHasOptions): Promise<void>;
  refuteHas(selector: string, opts?: AssertHasOptions): Promise<void>;
  assertText(text: string, opts?: StepOptions): Promise<void>;
  assertExactText(
    text: string,
    opts?: AssertionOptions,
  ): Promise<void>;
  refuteText(text: string, opts?: StepOptions): Promise<void>;
  assertAttribute(
    name: string,
    value?: string,
    opts?: AssertionOptions,
  ): Promise<void>;
  refuteAttribute(name: string, opts?: AssertionOptions): Promise<void>;
  assertComputedStyle(
    property: string,
    value: string,
    opts?: AssertionOptions,
  ): Promise<void>;
  assertNoHorizontalOverflow(opts?: LayoutAssertionOptions): Promise<void>;
  assertHorizontalOverflow(opts?: LayoutAssertionOptions): Promise<void>;
  assertHorizontallyContained(
    selector: string,
    opts?: LayoutAssertionOptions,
  ): Promise<void>;
  scrollToHorizontalEnd(opts?: LayoutAssertionOptions): Promise<void>;
  assertValue(label: string, value: string, opts?: StepOptions): Promise<void>;
  assertChecked(label: string, opts?: StepOptions): Promise<void>;
  refuteChecked(label: string, opts?: StepOptions): Promise<void>;
  assertSelected(label: string, optionLabel: string, opts?: StepOptions): Promise<void>;
  assertOptions(label: string, optionLabels: string[], opts?: StepOptions): Promise<void>;
  assertPath(path: string, opts?: AssertPathOptions): Promise<void>;
  refutePath(path: string, opts?: StepOptions): Promise<void>;
  /**
   * Run `trigger` and assert the browser offers a download whose suggested
   * filename matches `expected`. Browser-only: the RTL adapter throws.
   */
  assertDownload(
    expected: string | RegExp,
    trigger: () => Promise<void>,
    opts?: DownloadOptions,
  ): Promise<void>;
  /**
   * Poll `predicate` until it returns something truthy, or fail once the
   * timeout is spent. `description` is what the chain trace prints, so it
   * has to say what is being awaited in plain language.
   */
  until(
    description: string,
    predicate: UntilPredicate<TContext>,
    opts?: UntilOptions,
  ): Promise<void>;
  /**
   * Optional: submit the form the field labelled `label` belongs to, and
   * pass only if it is not sent because that field is required and empty.
   * Fail if the form is sent, or held back by another field.
   */
  assertSubmitBlocked?(label: string): Promise<void>;
  /** Optional: add cookies to the session (the `cookies` option, after creation). */
  addCookies?(cookies: readonly SessionCookie[]): Promise<void>;
  step(fn: (context: TContext) => Promise<unknown>): Promise<void>;
  /** Hand the caller the adapter's own driving handle, untyped by the DSL. */
  raw(fn: (native: TNative) => unknown | Promise<unknown>): Promise<void>;
  within(selector: string): Promise<TestDriver<TContext, TNative>>;
  debug(): Promise<void>;
  /**
   * Optional hook: wrap a queued step's execution (e.g. in Playwright's
   * test.step()) so chains appear in trace viewers and reporters.
   */
  wrapStep?(
    name: string,
    fn: () => Promise<void>,
    /**
     * The step itself. Its name can change while it runs (a value found to
     * be secret gets hidden), so read `step.name` again after `fn` settles.
     */
    step?: { readonly name: string },
  ): Promise<void>;
}
