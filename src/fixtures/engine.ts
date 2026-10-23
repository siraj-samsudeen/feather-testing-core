/**
 * A runner-agnostic fixture engine in the spirit of Playwright Test's:
 * a test names the fixtures it needs by destructuring them, only those
 * (and what they depend on) are set up, and they are torn down in reverse
 * order after the test, even when it fails.
 *
 *   const test = defineTest({ test: bunTest, afterAll }, {
 *     greeting: "hello",
 *     shout: async ({ greeting }, use) => { await use(greeting.toUpperCase()); },
 *   });
 *   test("shouts", async ({ shout }) => { expect(shout).toBe("HELLO"); });
 */

/** Hand the fixture's value to the test; resolves once the test is done. */
export type Use<T> = (value: T) => Promise<void>;

/** What a fixture function learns about the test it serves. */
export interface TestInfo {
  /** The test's name. */
  title: string;
  /** "running" while the test runs; "passed" or "failed" during teardown. */
  status: "running" | "passed" | "failed";
  /** The test's error, once it has failed. */
  error?: unknown;
}

export type FixtureScope = "test" | "file" | "worker";

export interface FixtureOptions {
  /**
   * "test" (default): set up for each test that needs it. "file" (or its
   * alias "worker"): set up once, the first time a test in the file needs
   * it, and torn down after the file's tests.
   */
  scope?: FixtureScope;
  /** The fixture's dependencies, for code whose parameter names are minified. */
  deps?: string[];
  /** Treat the given function as the fixture's value, not as a fixture function. */
  value?: boolean;
}

/** A fixture function: set up, `use` the value, then tear down. */
export type FixtureFn<T, F> = (
  fixtures: F,
  use: Use<T>,
  info: TestInfo,
) => Promise<void>;

/** One fixture: a plain value, a fixture function, or either with options. */
export type FixtureDef<T, F> =
  | T
  | FixtureFn<T, F>
  | [T | FixtureFn<T, F>, FixtureOptions];

export type FixtureDefs<T, F> = { [K in keyof T]: FixtureDef<T[K], F> };

/** The parts of a test runner the engine uses: bun:test and Vitest both have them. */
export interface Runner {
  test(name: string, fn: () => Promise<void>, timeout?: number): unknown;
  /**
   * The engine passes the teardown allowance (plus slack) as `timeout`, so
   * the runner's own hook timeout (bun: 5 s) does not cut cleanup short;
   * bun:test and Vitest both take it as the second argument.
   */
  afterAll(fn: () => Promise<void>, timeout?: number): unknown;
  /**
   * Optional: the suite being collected right now (Vitest:
   * `getCurrentSuite` from "vitest/suite"). With it, the file-teardown hook
   * is registered once per suite; without it (bun:test has no such API),
   * once per test that uses a file-scoped fixture.
   */
  currentSuite?(): object;
}

export type TestBody<F> = (fixtures: F) => unknown | Promise<unknown>;

export interface TestFn<F> {
  /** A test that gets the fixtures its body destructures. */
  (name: string, body: TestBody<F>): void;
  /** The same, naming the fixtures explicitly (for minified code). */
  (name: string, uses: (keyof F & string)[], body: TestBody<F>): void;
  /** A test function with more fixtures (or new definitions of these). */
  extend<G extends object>(fixtures: FixtureDefs<G, F & G>): TestFn<F & G>;
  /** The same fixtures with some values replaced (options, per file). */
  with(overrides: Partial<F>): TestFn<F>;
}

interface Definition {
  fn: FixtureFn<unknown, Record<string, unknown>> | null;
  value?: unknown;
  scope: "test" | "file";
  deps: string[];
}

/** Settings defineTest() takes besides the fixtures. */
export interface DefineTestOptions<F> {
  /** Values that replace fixtures (usually options) for every test. */
  overrides?: Partial<F>;
  /** Per-test timeout in ms to hand the runner, given the resolved values of the option fixtures. */
  timeout?: (options: Record<string, unknown>) => number | undefined;
  /**
   * The per-test timeout when `timeout` gives none, in ms (default
   * {@link DEFAULT_TEST_TIMEOUT}). The engine hands it to the runner and
   * stops waiting for a hung test when it is spent, so the test's
   * fixtures are still torn down.
   */
  testTimeout?: number;
  /**
   * The total time the fixtures of one test (or one block's file-scoped
   * fixtures) get to tear down, in ms (default
   * {@link DEFAULT_TEARDOWN_TIMEOUT}). The runner is handed the test's
   * timeout plus this, so it never gives up while cleanup is running.
   */
  teardownTimeout?: number;
}

/** The per-test timeout the engine hands the runner when none is given. */
export const DEFAULT_TEST_TIMEOUT = 30_000;
/** The total teardown allowance of one test (and of one block's file-scoped fixtures). */
export const DEFAULT_TEARDOWN_TIMEOUT = 10_000;
/** Slack between the engine's own deadline and the runner's. */
const RUNNER_MARGIN = 1000;

/** A promise that rejects with `message` after `ms`, and a way to cancel it. */
function deadline(ms: number, message: string): { reached: Promise<never>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reached = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  reached.catch(() => undefined); // observed by whoever races it
  return { reached, cancel: () => clearTimeout(timer) };
}

/**
 * A total time allowance shared by a series of teardowns: each one is
 * waited for only as long as what is left; a hung one is reported and the
 * rest still run, and nothing is ever waited for past the allowance.
 */
class TeardownBudget {
  private readonly ends: number;
  readonly errors: unknown[] = [];

  constructor(private readonly ms: number) {
    this.ends = Date.now() + ms;
  }

  /** Whether the allowance is used up. */
  spent(): boolean {
    return this.left() === 0;
  }

  private left(): number {
    return Math.max(0, this.ends - Date.now());
  }

  /** Wait for `work` within what is left; report it under `name` if it does not finish. */
  async wait<T>(name: string, what: string, work: Promise<T>): Promise<T | undefined> {
    const limit = deadline(
      this.left(),
      `fixture '${name}': ${what} did not finish within the ${this.ms}ms teardown allowance`,
    );
    try {
      return await Promise.race([work, limit.reached]);
    } catch (error) {
      this.errors.push(error);
      return undefined;
    } finally {
      limit.cancel();
    }
  }
}

/** Tear `active` down once, however many times it is asked to. */
function once(active: Active): Active {
  let torn: Promise<void> | null = null;
  return {
    value: active.value,
    teardown: () => (torn ??= active.teardown()),
  };
}

/** What a function's first parameter looks like, as far as fixtures care. */
type FirstParam =
  | { kind: "none" }
  | { kind: "destructured"; names: string[] }
  | { kind: "identifier"; name: string }
  | { kind: "unsupported"; why: string; names?: string[] };

/**
 * Split `text` at top-level commas, skipping strings, template literals,
 * comments and anything nested in (), [] or {}. Comments are dropped.
 */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const next = text[i + 1];
    if (c === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      i = end < 0 ? text.length : end;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
      current += text.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    if (c === ")" || c === "]" || c === "}") depth--;
    if (c === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

/** The text between the parentheses that open at `open`, comments kept. */
function parenthesised(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const c = source[i]!;
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < source.length && source[j] !== c) j += source[j] === "\\" ? 2 : 1;
      i = j;
      continue;
    }
    if (c === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      i = end < 0 ? source.length : end;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? source.length : end + 1;
      continue;
    }
    if (c === "(") depth++;
    if (c === ")") {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return source.slice(open + 1);
}

/** The index of the brace that closes `text`'s opening one (strings and comments skipped). */
function matchingBrace(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
      i = j;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      i = end < 0 ? text.length : end;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (c === "{" || c === "[" || c === "(") depth++;
    if (c === "}" || c === "]" || c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return text.length;
}

function firstParam(fn: (...args: never[]) => unknown): FirstParam {
  const source = Function.prototype.toString.call(fn);
  const arrow = /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/.exec(source);
  if (arrow) return { kind: "identifier", name: arrow[1]! };
  const open = source.indexOf("(");
  if (open < 0) return { kind: "none" };
  const params = splitTopLevel(parenthesised(source, open));
  const first = params[0];
  if (first === undefined) return { kind: "none" };
  if (first.startsWith("...")) return { kind: "unsupported", why: "a rest parameter" };
  if (!first.startsWith("{")) {
    const name = /^[A-Za-z_$][\w$]*/.exec(first)?.[0] ?? first;
    return { kind: "identifier", name };
  }
  // The object pattern, without its braces: up to the brace that closes
  // the opening one, not a default's (`{ a } = { a: 1, b: 2 }`).
  const close = matchingBrace(first);
  const names: string[] = [];
  for (const entry of splitTopLevel(first.slice(1, close))) {
    if (entry.startsWith("...")) return { kind: "unsupported", why: `a rest pattern (${entry})`, names };
    if (entry.startsWith("[")) return { kind: "unsupported", why: `a computed key (${entry})` };
    const key = /^(?:"([^"]*)"|'([^']*)'|([A-Za-z_$][\w$]*))/.exec(entry);
    if (!key) return { kind: "unsupported", why: `the entry ${entry}` };
    names.push(key[1] ?? key[2] ?? key[3]!);
  }
  return { kind: "destructured", names };
}

/**
 * The names a function's first parameter destructures: `({ a, b: x }) =>`
 * gives ["a", "b"]; no parameter gives []. Null when the parameter is not
 * an object pattern the engine can read (a plain name, a rest pattern).
 */
export function destructuredNames(fn: (...args: never[]) => unknown): string[] | null {
  const param = firstParam(fn);
  if (param.kind === "none") return [];
  return param.kind === "destructured" ? param.names : null;
}

const OPTION_KEYS = new Set(["scope", "deps", "value"]);

/**
 * `[definition, options]`: a two-item array whose second item has only
 * fixture-option keys. Anything else — say two cookies — is a plain value.
 */
function isWithOptions(def: unknown): def is [unknown, FixtureOptions] {
  if (!Array.isArray(def) || def.length !== 2) return false;
  const options = def[1] as unknown;
  if (options === null || typeof options !== "object" || Array.isArray(options)) return false;
  const keys = Object.keys(options);
  return keys.length > 0 && keys.every((key) => OPTION_KEYS.has(key));
}

function normalize(name: string, def: unknown): Definition {
  let body = def;
  let options: FixtureOptions = {};
  if (isWithOptions(def)) {
    body = def[0];
    options = def[1] as FixtureOptions;
  }
  const scope = options.scope === "file" || options.scope === "worker" ? "file" : "test";
  if (typeof body === "function" && !options.value) {
    const fn = body as FixtureFn<unknown, Record<string, unknown>>;
    if (options.deps) return { fn, scope, deps: options.deps };
    const param = firstParam(fn as (...args: never[]) => unknown);
    if (param.kind === "none") return { fn, scope, deps: [] };
    if (param.kind === "destructured") return { fn, scope, deps: param.names };
    // `_` or `_anything`: the fixtures are not used.
    if (param.kind === "identifier" && param.name.startsWith("_")) return { fn, scope, deps: [] };
    throw new Error(
      `fixture '${name}': cannot read its dependencies from ` +
        `${param.kind === "unsupported" ? param.why : `the parameter '${param.name}'`}. ` +
        `Destructure them (async ({ baseUrl }, use) => …), or name them: [fn, { deps: ["baseUrl"] }].`,
    );
  }
  return { fn: null, value: body, scope, deps: [] };
}

/** A fixture set up and waiting for its teardown. */
interface Active {
  value: unknown;
  teardown: () => Promise<void>;
}

/**
 * Start a fixture function: it runs until it calls `use`, which resolves
 * once `teardown` is called; teardown then waits for the function to end.
 */
async function start(
  name: string,
  def: Definition,
  deps: Record<string, unknown>,
  info: TestInfo,
): Promise<Active> {
  if (!def.fn) {
    return { value: def.value, teardown: async () => {} };
  }
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  // Boxed: a value that is itself a thenable (a session is) must not be
  // awaited — that would run it — on its way to the test.
  let provided!: (box: { value: unknown }) => void;
  const valueReady = new Promise<{ value: unknown }>((resolve) => (provided = resolve));
  let used = false;
  const run = def
    .fn(deps, async (value) => {
      used = true;
      provided({ value });
      await released;
    }, info)
    .then(() => {
      if (!used) {
        throw new Error(`fixture '${name}' finished without calling use(value)`);
      }
    });
  // The function may also end (or fail) before calling use.
  const endedFirst = run.then(() => valueReady);
  endedFirst.catch(() => undefined); // reported through the race, or by teardown
  const { value } = await Promise.race([valueReady, endedFirst]);
  return {
    value,
    teardown: async () => {
      release();
      await run;
    },
  };
}

const definitionIds = new WeakMap<Definition, number>();
let nextDefinitionId = 1;
function definitionId(def: Definition): number {
  let id = definitionIds.get(def);
  if (id === undefined) {
    id = nextDefinitionId++;
    definitionIds.set(def, id);
  }
  return id;
}

/** A fixture instance and its setup, as a scope keeps it. */
interface Entry {
  name: string;
  /** The setup, cached before it is awaited so concurrent tests share it. */
  pending: Promise<Active>;
  /** Set once the setup has finished. */
  active?: Active;
  /** When the setup finished, in finishing order: teardown runs in reverse. */
  readyAt?: number;
  /** The setup has finished, either way. */
  settled?: boolean;
  /** A late teardown is already scheduled (so it is reported at most once). */
  lateTeardown?: boolean;
}

let readySequence = 0;

/** Report a teardown failure that happened after the teardown report was made. */
function reportLate(name: string, error: unknown): void {
  console.error(
    `feather-testing-core: fixture '${name}' was torn down late (it finished setting up ` +
      "after its scope had closed) and its teardown failed:",
    error,
  );
}

/** Tear a late setup down once it finishes; a failure is reported, never left unhandled. */
function tearDownWhenReady(entry: Entry): void {
  if (entry.lateTeardown) return;
  entry.lateTeardown = true;
  entry.pending
    .then(
      (active) => active.teardown(),
      () => undefined, // nothing was set up
    )
    .catch((error: unknown) => reportLate(entry.name, error));
}

/**
 * The fixtures a scope keeps. A file's scope closes at the end of a block:
 * setups still running belong to the closing generation, and so does every
 * fixture they go on to create; later tests start a fresh generation.
 */
class Generation {
  readonly values = new Map<string, Entry>();
  /** Set once teardown has built its list: anything that appears now is torn down as it appears. */
  closed = false;
}

/** Cache `pending` under `key` in `store`, recording when (and if) it becomes ready. */
function track(
  store: Map<string, Entry>,
  key: string,
  name: string,
  pending: Promise<Active>,
  closed: () => boolean = () => false,
): Entry {
  const entry: Entry = { name, pending };
  store.set(key, entry);
  pending.then(
    (active) => {
      entry.active = active;
      entry.readyAt = ++readySequence;
      entry.settled = true;
      if (closed()) tearDownWhenReady(entry);
    },
    () => {
      entry.settled = true;
      // Dropped if it fails, so the next test tries again.
      if (store.get(key) === entry) store.delete(key);
    },
  );
  return entry;
}

/**
 * Tear down a scope within `budget`: first wait (within the budget) for
 * setups still running — including the ones they start meanwhile — so a
 * fixture is not torn down while one that sits on it is still being set
 * up; then tear everything that became ready down in the reverse of the
 * order it became ready. A setup still running after that is torn down
 * when it finishes, once; a failure then is reported, not thrown.
 */
async function tearDownEntries(
  values: Map<string, Entry>,
  budget: TeardownBudget,
  close: () => void = () => undefined,
): Promise<void> {
  for (;;) {
    const unsettled = [...values.values()].filter((entry) => !entry.settled);
    if (unsettled.length === 0 || budget.spent()) break;
    for (const entry of unsettled) {
      await budget.wait(
        entry.name,
        "setup",
        entry.pending.then(
          () => undefined,
          () => undefined, // a failed setup has nothing to tear down
        ),
      );
    }
  }
  close();
  const entries = [...values.values()];
  const ready = entries.filter((entry) => entry.active).sort((a, b) => b.readyAt! - a.readyAt!);
  for (const entry of ready) {
    await budget.wait(entry.name, "teardown", entry.active!.teardown());
  }
  for (const entry of entries) {
    if (!entry.active) tearDownWhenReady(entry);
  }
}

class FileScope {
  current = new Generation();
  /** Suites the teardown hook is registered in (when the runner names them). */
  readonly hookedSuites = new WeakSet<object>();
  /** What file-scoped fixture functions learn about "the test": the file. */
  readonly info: TestInfo = { title: "(file-scoped fixtures)", status: "running" };

  constructor(private teardownTimeout: number) {}

  async teardown(): Promise<void> {
    // What exists now closes; later tests start a fresh generation, and a
    // later hook (another block's) finds nothing of this one.
    const closing = this.current;
    this.current = new Generation();
    const budget = new TeardownBudget(this.teardownTimeout);
    await tearDownEntries(closing.values, budget, () => {
      closing.closed = true;
    });
    if (budget.errors.length > 0) throw budget.errors[0];
  }
}

/**
 * Everything one test owns: whether it has been abandoned, and the
 * test-scoped fixtures it set up. File-scoped fixtures are not the test's:
 * they live in the file's own lifecycle, whichever test started them.
 */
class TestLifecycle {
  abandoned = false;
  readonly values = new Map<string, Entry>();

  constructor(private readonly name: string) {}

  /** Throw if the test was given up on: nothing more may start. */
  check(): void {
    if (this.abandoned) {
      throw new Error(`test '${this.name}' was abandoned; nothing more is started`);
    }
  }

  async teardown(allowance: number): Promise<unknown[]> {
    const budget = new TeardownBudget(allowance);
    await tearDownEntries(this.values, budget);
    return budget.errors;
  }
}

function build<F>(
  runner: Runner,
  definitions: Map<string, Definition>,
  settings: DefineTestOptions<F>,
  fileScope: FileScope,
): TestFn<F> {
  const resolveName = (name: string, chain: string[]): Definition => {
    const def = definitions.get(name);
    if (!def) {
      const known = [...definitions.keys()].sort().join(", ");
      throw new Error(
        `fixture '${name}' is not defined${chain.length ? ` (needed by ${chain.join(" → ")})` : ""}. ` +
          `Provide it with test.extend({ ${name}: … }) or test.with({ ${name}: … }). Defined: ${known}.`,
      );
    }
    return def;
  };

  /**
   * A file-scoped fixture is shared by the tests that see the same
   * definitions of it and of everything it depends on: a test.with() that
   * changes one of its options (say `headed`) gets its own instance; one
   * that changes something unrelated shares it.
   */
  const fileKey = (fixture: string): string => {
    const ids: string[] = [];
    const seen = new Set<string>();
    const visit = (name: string) => {
      if (seen.has(name)) return;
      seen.add(name);
      const def = definitions.get(name);
      if (!def) return;
      ids.push(`${name}#${definitionId(def)}`);
      def.deps.forEach(visit);
    };
    visit(fixture);
    return ids.join("|");
  };

  /** Option-like values: every fixture that is a plain value, after overrides. */
  const optionValues = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [name, def] of definitions) if (!def.fn) out[name] = def.value;
    return out;
  };

  /**
   * Set up a file-scoped fixture (and its file-scoped dependencies) in the
   * file's own lifecycle: no test owns it, so a test that is abandoned while
   * it sets up does not abandon it — the next test (a retry) gets it.
   */
  const setUpFile = (
    fixture: string,
    chain: string[],
    generation: Generation = fileScope.current,
  ): Promise<Active> => {
    if (chain.includes(fixture)) {
      throw new Error(`fixtures depend on each other in a cycle: ${[...chain, fixture].join(" → ")}`);
    }
    const def = resolveName(fixture, chain);
    if (!def.fn) return Promise.resolve({ value: def.value, teardown: async () => {} });
    const key = fileKey(fixture);
    const existing = generation.values.get(key);
    if (existing) return existing.pending;
    const pending = (async () => {
      const deps: Record<string, unknown> = {};
      for (const dep of def.deps) {
        const depDef = resolveName(dep, [...chain, fixture]);
        // A plain value has no lifetime; a test-scoped fixture function
        // would be torn down under the file-scoped one.
        if (depDef.fn && depDef.scope === "test") {
          throw new Error(
            `file-scoped fixture '${fixture}' cannot depend on test-scoped fixture '${dep}'.`,
          );
        }
        // In the same generation: if the scope closes meanwhile, what this
        // setup goes on to create closes with it.
        deps[dep] = (await setUpFile(dep, [...chain, fixture], generation)).value;
      }
      return once(await start(fixture, def, deps, fileScope.info));
    })();
    return track(generation.values, key, fixture, pending, () => generation.closed).pending;
  };

  /** Whether any of these fixtures is, or depends on, a file-scoped fixture function. */
  const usesFileScope = (names: string[]): boolean => {
    const seen = new Set<string>();
    const visit = (name: string): boolean => {
      if (seen.has(name)) return false;
      seen.add(name);
      const def = definitions.get(name);
      if (!def) return false;
      if (def.fn && def.scope === "file") return true;
      return def.deps.some(visit);
    };
    return names.some(visit);
  };

  const register = (name: string, uses: string[] | null, body: TestBody<F>) => {
    let wanted = uses;
    if (!wanted) {
      const param = firstParam(body as (...args: never[]) => unknown);
      if (param.kind === "destructured") wanted = param.names;
      else if (param.kind === "none") wanted = [];
      else {
        const found = param.kind === "unsupported" ? (param.names ?? []) : [];
        const example =
          found.length > 0
            ? ` For this test: test(${JSON.stringify(name)}, [${found.map((n) => JSON.stringify(n)).join(", ")}], async ({ ${found.join(", ")} }) => …).`
            : "";
        throw new Error(
          `test '${name}': cannot see which fixtures the test uses ` +
            `(${param.kind === "unsupported" ? param.why : `the parameter '${param.name}'`}) — ` +
            "destructure them (async ({ session, request }) => …) or name them: " +
            `test(name, ['session', 'request'], fn).${example}`,
        );
      }
    }
    // A test that uses a file-scoped fixture registers the teardown in the
    // suite it is collected in (the file, or its describe): at the end of
    // each block whatever file-scoped fixtures exist are torn down, once —
    // later hooks find nothing left. With the runner's current suite, once
    // per suite.
    if (usesFileScope(wanted)) {
      const suite = runner.currentSuite?.();
      if (!suite || !fileScope.hookedSuites.has(suite)) {
        if (suite) fileScope.hookedSuites.add(suite);
        runner.afterAll(
          () => fileScope.teardown(),
          (settings.teardownTimeout ?? DEFAULT_TEARDOWN_TIMEOUT) + RUNNER_MARGIN,
        );
      }
    }
    const timeout = settings.timeout?.(optionValues()) ?? settings.testTimeout ?? DEFAULT_TEST_TIMEOUT;
    const teardownAllowance = settings.teardownTimeout ?? DEFAULT_TEARDOWN_TIMEOUT;
    // One budget: the body gets `timeout`, teardown gets its allowance, and
    // the runner is handed both (plus slack), so it never gives up while the
    // engine is still cleaning up. 0 means no limit, for the runner too.
    const runnerTimeout = timeout > 0 ? timeout + teardownAllowance + RUNNER_MARGIN : 0;
    runner.test(
      name,
      async () => {
        const info: TestInfo = { title: name, status: "running" };
        const life = new TestLifecycle(name);
        // Boxed results: a fixture value can be a thenable (a session), and
        // an async function would await it on return.
        const setUp = async (fixture: string, chain: string[]): Promise<{ value: unknown }> => {
          life.check();
          if (chain.includes(fixture)) {
            throw new Error(`fixtures depend on each other in a cycle: ${[...chain, fixture].join(" → ")}`);
          }
          const def = resolveName(fixture, chain);
          if (def.scope === "file") {
            const active = await setUpFile(fixture, chain);
            life.check(); // handed over only to a test that is still running
            return { value: active.value };
          }
          let entry = life.values.get(fixture);
          if (!entry) {
            const pending = (async () => {
              const deps: Record<string, unknown> = {};
              for (const dep of def.deps) {
                deps[dep] = (await setUp(dep, [...chain, fixture])).value;
                life.check();
              }
              const active = once(await start(fixture, def, deps, info));
              if (life.abandoned) {
                // Finished after the test was given up on: tear it down now.
                // A teardown failure here is the teardown's, not the setup's:
                // reported as such, since no test is left to report it to.
                await active.teardown().catch((error: unknown) => reportLate(fixture, error));
                throw new Error(`fixture '${fixture}' finished setting up after the test was abandoned`);
              }
              return active;
            })();
            entry = track(life.values, fixture, fixture, pending);
          }
          const active = await entry.pending;
          life.check();
          return { value: active.value };
        };

        let failure: unknown;
        let failed = false;
        const run = (async () => {
          const fixtures: Record<string, unknown> = {};
          for (const fixture of wanted) {
            fixtures[fixture] = (await setUp(fixture, [])).value;
          }
          life.check(); // a slow setup must not let an abandoned test start its body
          await body(fixtures as F);
        })();
        const limit =
          timeout > 0
            ? deadline(
                timeout,
                `test '${name}' did not finish within ${timeout}ms; its fixtures were torn down.`,
              )
            : null;
        try {
          await (limit ? Promise.race([run, limit.reached]) : run);
        } catch (error) {
          failed = true;
          failure = error;
        } finally {
          limit?.cancel();
        }
        if (failed) {
          life.abandoned = true;
          run.catch(() => undefined); // its failure is reported above, or not at all
        }
        info.status = failed ? "failed" : "passed";
        if (failed) info.error = failure;
        const teardownErrors = await life.teardown(teardownAllowance);
        if (failed) throw failure;
        if (teardownErrors.length > 0) throw teardownErrors[0];
      },
      runnerTimeout,
    );
  };

  const test = ((name: string, a: unknown, b?: unknown) => {
    if (Array.isArray(a)) register(name, a as string[], b as TestBody<F>);
    else register(name, null, a as TestBody<F>);
  }) as TestFn<F>;

  test.extend = <G extends object>(more: FixtureDefs<G, F & G>) => {
    const next = new Map(definitions);
    for (const [name, def] of Object.entries(more)) next.set(name, normalize(name, def));
    return build<F & G>(runner, next, settings as DefineTestOptions<F & G>, fileScope);
  };

  test.with = (overrides: Partial<F>) => {
    const next = new Map(definitions);
    for (const [name, value] of Object.entries(overrides)) {
      const current = next.get(name);
      if (!current) {
        throw new Error(
          `test.with(): '${name}' is not a defined fixture (defined: ${[...definitions.keys()].sort().join(", ")}). ` +
            `Add it with test.extend({ ${name}: … }).`,
        );
      }
      // Like a definition: a function is a fixture function, unless given
      // as [fn, { value: true }]; the scope stays unless the options say.
      const replaced = normalize(name, value);
      const scopeGiven = isWithOptions(value) && value[1].scope !== undefined;
      next.set(name, scopeGiven ? replaced : { ...replaced, scope: current.scope });
    }
    return build<F>(runner, next, settings, fileScope);
  };

  return test;
}

/**
 * A test function whose tests get the fixtures they destructure. `runner`
 * is the test runner's `{ test, afterAll }` — `import { test, afterAll }
 * from "bun:test"` or from "vitest".
 */
export function defineTest<F extends object>(
  runner: Runner,
  fixtures: FixtureDefs<F, F>,
  settings: DefineTestOptions<F> = {},
): TestFn<F> {
  const definitions = new Map<string, Definition>();
  for (const [name, def] of Object.entries(fixtures)) definitions.set(name, normalize(name, def));
  for (const [name, value] of Object.entries(settings.overrides ?? {})) {
    const current = definitions.get(name);
    definitions.set(name, { fn: null, value, scope: current?.scope ?? "test", deps: [] });
  }
  return build<F>(
    runner,
    definitions,
    settings,
    new FileScope(settings.teardownTimeout ?? DEFAULT_TEARDOWN_TIMEOUT),
  );
}
