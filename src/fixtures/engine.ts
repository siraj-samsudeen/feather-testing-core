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
  afterAll(fn: () => Promise<void>): unknown;
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
   * stops waiting for a hung test a little before it, so the test's
   * fixtures are still torn down.
   */
  testTimeout?: number;
  /** How long each fixture's teardown may take, in ms (default {@link DEFAULT_TEARDOWN_TIMEOUT}). */
  teardownTimeout?: number;
}

/** The per-test timeout the engine hands the runner when none is given. */
export const DEFAULT_TEST_TIMEOUT = 30_000;
/** How long one fixture's teardown may take before it is reported and skipped. */
export const DEFAULT_TEARDOWN_TIMEOUT = 10_000;

/** A promise that rejects with `message` after `ms`, and a way to cancel it. */
function deadline(ms: number, message: string): { reached: Promise<never>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reached = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  reached.catch(() => undefined); // observed by whoever races it
  return { reached, cancel: () => clearTimeout(timer) };
}

/** Run a teardown with a time limit; a hung one is reported, not waited for. */
async function limitedTeardown(name: string, active: Active, ms: number): Promise<void> {
  const limit = deadline(ms, `fixture '${name}': teardown did not finish within ${ms}ms`);
  try {
    await Promise.race([active.teardown(), limit.reached]);
  } finally {
    limit.cancel();
  }
}

/** What a function's first parameter looks like, as far as fixtures care. */
type FirstParam =
  | { kind: "none" }
  | { kind: "destructured"; names: string[] }
  | { kind: "identifier"; name: string }
  | { kind: "unsupported"; why: string };

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
  // The object pattern, without its braces (and without a default after it).
  const close = first.lastIndexOf("}");
  const names: string[] = [];
  for (const entry of splitTopLevel(first.slice(1, close))) {
    if (entry.startsWith("...")) return { kind: "unsupported", why: `a rest pattern (${entry})` };
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

function normalize(name: string, def: unknown): Definition {
  let body = def;
  let options: FixtureOptions = {};
  if (
    Array.isArray(def) &&
    def.length === 2 &&
    def[1] !== null &&
    typeof def[1] === "object" &&
    !Array.isArray(def[1])
  ) {
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

class FileScope {
  /**
   * Setups in progress or done, by key. The promise is stored before it is
   * awaited, so tests running at the same time share one setup.
   */
  values = new Map<string, Promise<Active>>();
  order: string[] = [];

  constructor(private teardownTimeout: number) {}

  async teardown(): Promise<void> {
    const errors: unknown[] = [];
    // Only what exists now; each key is removed as it is torn down, so a
    // later hook (another block's) does not tear it down twice.
    for (const name of [...this.order].reverse()) {
      const pending = this.values.get(name);
      this.values.delete(name);
      const at = this.order.indexOf(name);
      if (at >= 0) this.order.splice(at, 1);
      try {
        const active = await pending?.catch(() => null);
        if (active) await limitedTeardown(name.split("#")[0]!, active, this.teardownTimeout);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw errors[0];
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

  const register = (name: string, uses: string[] | null, body: TestBody<F>) => {
    let wanted = uses;
    if (!wanted) {
      const param = firstParam(body as (...args: never[]) => unknown);
      if (param.kind === "destructured") wanted = param.names;
      else if (param.kind === "none") wanted = [];
      else {
        throw new Error(
          `test '${name}': cannot see which fixtures the test uses ` +
            `(${param.kind === "unsupported" ? param.why : `the parameter '${param.name}'`}) — ` +
            "destructure them (async ({ session, request }) => …) or name them: " +
            "test(name, ['session', 'request'], fn).",
        );
      }
    }
    // Every test registers the teardown in the suite it is collected in
    // (the file, or its describe): at the end of each block whatever
    // file-scoped fixtures exist are torn down, once — later hooks find
    // nothing left. A flag here would register only in the first block.
    runner.afterAll(() => fileScope.teardown());
    const timeout = settings.timeout?.(optionValues()) ?? settings.testTimeout ?? DEFAULT_TEST_TIMEOUT;
    const teardownTimeout = settings.teardownTimeout ?? DEFAULT_TEARDOWN_TIMEOUT;
    // Stop waiting a little before the runner gives up, to tear down in time.
    const engineDeadline = timeout > 0 ? Math.max(1, timeout - Math.min(1000, timeout / 10)) : 0;
    runner.test(
      name,
      async () => {
        const info: TestInfo = { title: name, status: "running" };
        let abandoned = false;
        /** Test-scoped fixtures whose setup has finished. */
        const done = new Map<string, Active>();
        const active = new Map<string, Promise<Active>>();
        const order: string[] = [];
        // Boxed results: a fixture value can be a thenable (a session), and
        // an async function would await it on return.
        const setUp = async (fixture: string, chain: string[]): Promise<{ value: unknown }> => {
          if (chain.includes(fixture)) {
            throw new Error(`fixtures depend on each other in a cycle: ${[...chain, fixture].join(" → ")}`);
          }
          const def = resolveName(fixture, chain);
          const key = def.scope === "file" ? fileKey(fixture) : fixture;
          const store = def.scope === "file" ? fileScope.values : active;
          const keys = def.scope === "file" ? fileScope.order : order;
          let pending = store.get(key);
          if (!pending) {
            pending = (async () => {
              const deps: Record<string, unknown> = {};
              for (const dep of def.deps) {
                const depDef = resolveName(dep, [...chain, fixture]);
                // A plain value has no lifetime; a test-scoped fixture function
                // would be torn down under the file-scoped one.
                if (def.scope === "file" && depDef.fn && depDef.scope === "test") {
                  throw new Error(
                    `file-scoped fixture '${fixture}' cannot depend on test-scoped fixture '${dep}'.`,
                  );
                }
                deps[dep] = (await setUp(dep, [...chain, fixture])).value;
              }
              const started = await start(fixture, def, deps, info);
              if (abandoned && def.scope === "test") {
                // The test was given up on while this was setting up.
                await limitedTeardown(fixture, started, teardownTimeout).catch(() => undefined); // nothing left to report to
                throw new Error(`fixture '${fixture}' finished setting up after the test was abandoned`);
              }
              if (def.scope === "test") done.set(key, started);
              return started;
            })();
            // Cached before it is awaited, so concurrent tests share it;
            // dropped if it fails, so the next test tries again.
            store.set(key, pending);
            keys.push(key);
            const settled = pending;
            settled.catch(() => {
              if (store.get(key) === settled) store.delete(key);
              const at = keys.indexOf(key);
              if (at >= 0) keys.splice(at, 1);
            });
          }
          const started = await pending;
          return { value: started.value };
        };
        let failure: unknown;
        let failed = false;
        const run = (async () => {
          const fixtures: Record<string, unknown> = {};
          for (const fixture of wanted) {
            fixtures[fixture] = (await setUp(fixture, [])).value;
          }
          await body(fixtures as F);
        })();
        const limit =
          engineDeadline > 0
            ? deadline(
                engineDeadline,
                `test '${name}' did not finish within ${timeout}ms; its fixtures were torn down ` +
                  `(the engine stopped waiting at ${Math.round(engineDeadline)}ms).`,
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
          // Abandoned or failed: anything still setting up is torn down when
          // it finishes, instead of being left running.
          abandoned = true;
          run.catch(() => undefined); // its failure is reported above, or not at all
        }
        info.status = failed ? "failed" : "passed";
        if (failed) info.error = failure;
        // Teardown in reverse order of setup, every one even if some fail,
        // each within its time limit. A setup still running is not waited
        // for here: it is torn down when it finishes (see setUp).
        let teardownError: unknown;
        for (const fixture of [...order].reverse()) {
          const ready = done.get(fixture);
          if (!ready) continue; // failed, or still setting up
          try {
            await limitedTeardown(fixture, ready, teardownTimeout);
          } catch (error) {
            teardownError ??= error;
          }
        }
        if (failed) throw failure;
        if (teardownError !== undefined) throw teardownError;
      },
      timeout,
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
      next.set(name, { fn: null, value, scope: current?.scope ?? "test", deps: [] });
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
