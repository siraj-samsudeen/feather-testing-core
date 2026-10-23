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
  registered = false;

  async teardown(): Promise<void> {
    const errors: unknown[] = [];
    for (const name of [...this.order].reverse()) {
      try {
        const active = await this.values.get(name)!.catch(() => null);
        await active?.teardown();
      } catch (error) {
        errors.push(error);
      }
    }
    this.values.clear();
    this.order = [];
    this.registered = false;
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
    if (!fileScope.registered) {
      fileScope.registered = true;
      runner.afterAll(() => fileScope.teardown());
    }
    const timeout = settings.timeout?.(optionValues());
    runner.test(
      name,
      async () => {
        const info: TestInfo = { title: name, status: "running" };
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
              return start(fixture, def, deps, info);
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
        try {
          const fixtures: Record<string, unknown> = {};
          for (const fixture of wanted) {
            fixtures[fixture] = (await setUp(fixture, [])).value;
          }
          await body(fixtures as F);
        } catch (error) {
          failed = true;
          failure = error;
        }
        info.status = failed ? "failed" : "passed";
        if (failed) info.error = failure;
        // Teardown in reverse order of setup, every one even if some fail.
        let teardownError: unknown;
        for (const fixture of [...order].reverse()) {
          try {
            const started = await active.get(fixture)!.catch(() => null);
            await started?.teardown();
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
  return build<F>(runner, definitions, settings, new FileScope());
}
