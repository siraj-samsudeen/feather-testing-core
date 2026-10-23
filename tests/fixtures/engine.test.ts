// @vitest-environment node
/**
 * The fixture engine against a recording stand-in runner, so the lifecycle
 * (lazy setup, dependency order, reverse teardown, failures, file scope)
 * can be checked step by step, failing tests included.
 */
import { describe, expect, it } from "vitest";
import { defineTest, destructuredNames, value, type Runner } from "../../src/fixtures/engine.js";

/** A runner that only records: run its tests and afterAll hooks by hand. */
function recordingRunner() {
  const tests: { name: string; fn: () => Promise<void>; timeout?: number }[] = [];
  const afterAlls: (() => Promise<void>)[] = [];
  const runner: Runner = {
    test: (name, fn, timeout) => tests.push({ name, fn, timeout }),
    afterAll: (fn) => afterAlls.push(fn),
  };
  const run = async (name: string) => tests.find((t) => t.name === name)!.fn();
  const endFile = async () => {
    for (const fn of afterAlls.splice(0)) await fn();
  };
  return { runner, tests, run, endFile, hooks: () => afterAlls.length };
}

/** Fixtures that log their setup and teardown. */
function loggingFixtures(log: string[]) {
  return {
    base: "base",
    a: async ({ base }: { base: string }, use: (v: string) => Promise<void>) => {
      log.push("setup a");
      await use(`${base}-a`);
      log.push("teardown a");
    },
    b: async ({ a }: { a: string }, use: (v: string) => Promise<void>) => {
      log.push("setup b");
      await use(`${a}-b`);
      log.push("teardown b");
    },
    unused: async ({}, use: (v: string) => Promise<void>) => {
      log.push("setup unused");
      await use("x");
    },
    shared: [
      async ({}, use: (v: { id: number }) => Promise<void>) => {
        log.push("setup shared");
        await use({ id: Math.random() });
        log.push("teardown shared");
      },
      { scope: "file" as const },
    ],
  };
}

describe("reading destructured names from real code", () => {
  it("handles comments, defaults with commas and braces, renames and quoted keys", () => {
    const withComments = async ({
      // the browser session
      session /* , notAFixture */,
      request = "a,b}" as unknown,
      "baseUrl": renamed,
      other = { nested: [1, 2] },
    }: Record<string, unknown>) => [session, request, renamed, other];
    expect(destructuredNames(withComments)).toEqual(["session", "request", "baseUrl", "other"]);
  });

  it("a test body with no parameter uses no fixtures", async () => {
    const { runner, run } = recordingRunner();
    const test = defineTest(runner, { a: 1 } as never);
    let ran = false;
    test("no fixtures", async () => {
      ran = true;
    });
    test("no fixtures, plain function", function () {
      ran = ran && true;
    });
    await run("no fixtures");
    await run("no fixtures, plain function");
    expect(ran).toBe(true);
  });

  it("reads only the pattern when the parameter has an object default", () => {
    const withDefault = async ({ a }: { a: number } = { a: 1, b: 2 } as never) => a;
    expect(destructuredNames(withDefault)).toEqual(["a"]);
  });

  it("refuses a rest pattern or an undestructured parameter in a test, showing the explicit form", () => {
    const { runner } = recordingRunner();
    const test = defineTest(runner, { a: 1 } as never);
    expect(() => test("rest", async ({ ...all }: Record<string, unknown>) => void all)).toThrow(
      "test(name, ['session', 'request'], fn)",
    );
    expect(() => test("plain", async (all: unknown) => void all)).toThrow(
      "test(name, ['session', 'request'], fn)",
    );
  });

  it("refuses a fixture function whose dependencies it cannot read, showing { deps }", () => {
    const { runner } = recordingRunner();
    expect(() =>
      defineTest(runner, {
        x: async (fixtures: Record<string, unknown>, use: (v: unknown) => Promise<void>) => use(fixtures),
      } as never),
    ).toThrow("[fn, { deps: [");
    expect(() =>
      defineTest(runner, {
        y: async ({ ...all }: Record<string, unknown>, use: (v: unknown) => Promise<void>) => use(all),
      } as never),
    ).toThrow("[fn, { deps: [");
    // An unused first parameter named with a leading underscore means no dependencies.
    expect(() =>
      defineTest(runner, {
        z: async (_: unknown, use: (v: number) => Promise<void>) => use(1),
      } as never),
    ).not.toThrow();
  });
});

describe("destructuredNames", () => {
  it("reads the names a function's first parameter destructures", () => {
    expect(destructuredNames(async ({ a, b: renamed, c = 1 }: Record<string, number>) => [a, renamed, c])).toEqual(["a", "b", "c"]);
    expect(destructuredNames(async function ({ session }: { session: unknown }) { return session; })).toEqual(["session"]);
    expect(destructuredNames(async ({}) => undefined)).toEqual([]);
    expect(destructuredNames(async (all: unknown) => all)).toBeNull();
  });
});

describe("defineTest", () => {
  it("sets up only what the test destructures, dependencies first, and tears down in reverse", async () => {
    const log: string[] = [];
    const { runner, run } = recordingRunner();
    const test = defineTest(runner, loggingFixtures(log) as never);
    let seen = "";
    test("uses b", async ({ b }: { b: string }) => {
      log.push("body");
      seen = b;
    });
    await run("uses b");
    expect(seen).toBe("base-a-b");
    expect(log).toEqual(["setup a", "setup b", "body", "teardown b", "teardown a"]);
  });

  it("tears down after a failing test, and still reports the failure", async () => {
    const log: string[] = [];
    const { runner, run } = recordingRunner();
    const test = defineTest(runner, loggingFixtures(log) as never);
    test("fails", async ({ b }: { b: string }) => {
      log.push(`body ${b}`);
      throw new Error("boom");
    });
    await expect(run("fails")).rejects.toThrow("boom");
    expect(log).toEqual(["setup a", "setup b", "body base-a-b", "teardown b", "teardown a"]);
  });

  it("tells teardown whether the test failed", async () => {
    const statuses: string[] = [];
    const { runner, run } = recordingRunner();
    const test = defineTest(runner, {
      watched: async ({}, use: (v: number) => Promise<void>, info: { status: string }) => {
        await use(1);
        statuses.push(info.status);
      },
    } as never);
    test("passes", async ({ watched }: { watched: number }) => void watched);
    test("fails", async ({ watched }: { watched: number }) => {
      throw new Error(String(watched));
    });
    await run("passes");
    await run("fails").catch(() => "expected");
    expect(statuses).toEqual(["passed", "failed"]);
  });

  it("reuses a file-scoped fixture across tests and tears it down after the file", async () => {
    const log: string[] = [];
    const { runner, run, endFile } = recordingRunner();
    const test = defineTest(runner, loggingFixtures(log) as never);
    const ids: number[] = [];
    test("one", async ({ shared }: { shared: { id: number } }) => void ids.push(shared.id));
    test("two", async ({ shared }: { shared: { id: number } }) => void ids.push(shared.id));
    await run("one");
    await run("two");
    expect(ids[0]).toBe(ids[1]);
    expect(log).toEqual(["setup shared"]);
    await endFile();
    expect(log).toEqual(["setup shared", "teardown shared"]);
  });

  it("takes an explicit list of fixtures, for minified code", async () => {
    const log: string[] = [];
    const { runner, run } = recordingRunner();
    const test = defineTest(runner, loggingFixtures(log) as never);
    let got: unknown;
    test("explicit", ["a"] as never, async (fixtures: { a: string }) => {
      got = fixtures.a;
    });
    await run("explicit");
    expect(got).toBe("base-a");
  });

  it("refuses a body whose fixtures it cannot see", () => {
    const { runner } = recordingRunner();
    const test = defineTest(runner, { a: 1 } as never);
    expect(() => test("opaque", async (all: unknown) => void all)).toThrow("cannot see which fixtures");
  });

  it("names a missing fixture and who needed it", async () => {
    const { runner, run } = recordingRunner();
    const test = defineTest(runner, {
      session: async ({ baseUrl }: { baseUrl: string }, use: (v: string) => Promise<void>) => use(baseUrl),
    } as never);
    test("needs baseUrl", async ({ session }: { session: string }) => void session);
    await expect(run("needs baseUrl")).rejects.toThrow(
      "fixture 'baseUrl' is not defined (needed by session)",
    );
  });

  it("overrides values at definition, per file with .with(), and layers with .extend()", async () => {
    const { runner, run } = recordingRunner();
    const base = defineTest(
      runner,
      {
        browserName: "chromium",
        label: async ({ browserName }: { browserName: string }, use: (v: string) => Promise<void>) =>
          use(`on ${browserName}`),
      } as never,
      { overrides: { browserName: "firefox" } as never },
    );
    const got: string[] = [];
    base("defined", async ({ label }: { label: string }) => void got.push(label));
    base.with({ browserName: "webkit" })("with", async ({ label }: { label: string }) => void got.push(label));
    base
      .extend({ shout: async ({ label }: { label: string }, use: (v: string) => Promise<void>) => use(label.toUpperCase()) } as never)
      ("extended", async ({ shout }: { shout: string }) => void got.push(shout));
    await run("defined");
    await run("with");
    await run("extended");
    expect(got).toEqual(["on firefox", "on webkit", "ON FIREFOX"]);
  });

  it("passes the per-test timeout computed from the options", () => {
    const { runner, tests } = recordingRunner();
    const test = defineTest(runner, { headed: false } as never, {
      timeout: (o) => (o.headed ? 120_000 : undefined),
    });
    test("plain", async ({}) => undefined);
    test.with({ headed: true })("headed", async ({}) => undefined);
    // The runner gets the test's budget plus the teardown allowance (10 s)
    // plus 1 s of slack; without a timeout, the engine's default is 30 s.
    expect(tests.map((t) => t.timeout)).toEqual([41_000, 131_000]);
  });

  it("a .with() that changes a file-scoped fixture's option gets its own instance; others share it", async () => {
    const { runner, run } = recordingRunner();
    let launches = 0;
    const test = defineTest(runner, {
      headed: false,
      record: "off",
      browser: [
        async ({ headed }: { headed: boolean }, use: (v: string) => Promise<void>) => {
          launches++;
          await use(headed ? "headed" : "headless");
        },
        { scope: "file" },
      ],
    } as never);
    const got: string[] = [];
    test("plain", async ({ browser }: { browser: string }) => void got.push(browser));
    test.with({ record: "on" })("unrelated option", async ({ browser }: { browser: string }) => void got.push(browser));
    test.with({ headed: true })("headed", async ({ browser }: { browser: string }) => void got.push(browser));
    await run("plain");
    await run("unrelated option");
    await run("headed");
    expect(got).toEqual(["headless", "headless", "headed"]);
    expect(launches).toBe(2);
  });

  it("hands a thenable value (a session) to the test as it is", async () => {
    const { runner, run } = recordingRunner();
    const thenable = { then: () => undefined, marker: 1 };
    const test = defineTest(runner, {
      session: async ({}, use: (v: unknown) => Promise<void>) => use(thenable),
    } as never);
    let got: unknown;
    test("thenable", async ({ session }: { session: unknown }) => {
      got = session;
    });
    await run("thenable");
    expect(got).toBe(thenable);
  });

  it("concurrent tests share one file-scoped instance, set up and torn down once", async () => {
    const { runner, run, endFile } = recordingRunner();
    let setups = 0;
    let teardowns = 0;
    // Held open until all three tests have asked for the fixture.
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const test = defineTest(runner, {
      server: [
        async ({}, use: (v: number) => Promise<void>) => {
          setups++;
          await gate;
          await use(setups);
          teardowns++;
        },
        { scope: "file" },
      ],
    } as never);
    const seen: number[] = [];
    test("a", async ({ server }: { server: number }) => void seen.push(server));
    test("b", async ({ server }: { server: number }) => void seen.push(server));
    test("c", async ({ server }: { server: number }) => void seen.push(server));
    const all = Promise.all([run("a"), run("b"), run("c")]);
    open();
    await all;
    expect(seen).toEqual([1, 1, 1]);
    expect(setups).toBe(1);
    await endFile();
    expect(teardowns).toBe(1);
  });

  it("a file-scoped setup that fails is retried by the next test, not cached", async () => {
    const { runner, run } = recordingRunner();
    let attempts = 0;
    const test = defineTest(runner, {
      flaky: [
        async ({}, use: (v: number) => Promise<void>) => {
          attempts++;
          if (attempts === 1) throw new Error("first setup fails");
          await use(attempts);
        },
        { scope: "file" },
      ],
    } as never);
    test("first", async ({ flaky }: { flaky: number }) => void flaky);
    test("second", async ({ flaky }: { flaky: number }) => {
      expect(flaky).toBe(2);
    });
    await expect(run("first")).rejects.toThrow("first setup fails");
    await run("second");
  });

  describe("timeouts", () => {
    /** Resolves after `ms`; for building hung fixtures, not for waiting in tests. */
    // eslint-disable-next-line feather-testing/no-wait-for-timeout -- builds a deliberately slow fixture; no test waits on it
    const after = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    it("a hung test body is abandoned before the runner's timeout, and its fixtures are torn down", async () => {
      const { runner, run } = recordingRunner();
      const log: string[] = [];
      const test = defineTest(
        runner,
        {
          server: async ({}, use: (v: number) => Promise<void>) => {
            await use(1);
            log.push("server torn down");
          },
        } as never,
        { testTimeout: 400 },
      );
      test("hangs", async ({ server }: { server: number }) => {
        void server;
        await new Promise(() => undefined); // never settles
      });
      const started = Date.now();
      await expect(run("hangs")).rejects.toThrow("did not finish within 400ms");
      // The body gets its 400 ms; the runner was handed 400 ms + the
      // teardown allowance + slack, so it is still waiting here.
      expect(Date.now() - started).toBeLessThan(900);
      expect(log).toEqual(["server torn down"]);
    });

    it("a hung teardown is reported and the other teardowns still run", async () => {
      const { runner, run } = recordingRunner();
      const log: string[] = [];
      const test = defineTest(
        runner,
        {
          first: async ({}, use: (v: number) => Promise<void>) => {
            await use(1);
            log.push("first torn down");
          },
          stuck: async ({ first }: { first: number }, use: (v: number) => Promise<void>) => {
            await use(first);
            await new Promise(() => undefined); // teardown never finishes
          },
        } as never,
        { teardownTimeout: 100 },
      );
      test("uses both", async ({ stuck }: { stuck: number }) => void stuck);
      await expect(run("uses both")).rejects.toThrow(
        "fixture 'stuck': teardown did not finish within the 100ms teardown allowance",
      );
      expect(log).toEqual(["first torn down"]);
    });

    it("a setup that finishes after the test was abandoned is torn down when it does", async () => {
      const { runner, run } = recordingRunner();
      const log: string[] = [];
      let tornDown!: () => void;
      const teardownRan = new Promise<void>((resolve) => (tornDown = resolve));
      const test = defineTest(
        runner,
        {
          slow: async ({}, use: (v: number) => Promise<void>) => {
            await after(600);
            log.push("slow set up");
            await use(1);
            log.push("slow torn down");
            tornDown();
          },
        } as never,
        { testTimeout: 300 },
      );
      test("waits for slow", async ({ slow }: { slow: number }) => void slow);
      await expect(run("waits for slow")).rejects.toThrow("did not finish within 300ms");
      await teardownRan; // the test's own timeout fails it if this never happens
      expect(log).toEqual(["slow set up", "slow torn down"]);
    });
  });

  describe("lifecycle ownership", () => {
    // eslint-disable-next-line feather-testing/no-wait-for-timeout -- builds deliberately slow fixtures; no test waits on it
    const after = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    it("tears down in the exact reverse of readiness when a fixture has several dependencies", async () => {
      const { runner, run } = recordingRunner();
      const log: string[] = [];
      const fixture = (name: string) => async (_deps: unknown, use: (v: string) => Promise<void>) => {
        log.push(`ready ${name}`);
        await use(name);
        log.push(`down ${name}`);
      };
      const test = defineTest(runner, {
        a: [fixture("a"), { deps: [] }],
        b: [fixture("b"), { deps: [] }],
        c: [fixture("c"), { deps: ["a", "b"] }],
      } as never);
      test("c", async ({ c }: { c: string }) => void c);
      await run("c");
      expect(log).toEqual(["ready a", "ready b", "ready c", "down c", "down b", "down a"]);
    });

    it("an abandoned test never starts its body after a slow file-scoped setup", async () => {
      const { runner, run, endFile } = recordingRunner();
      let bodyRan = false;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const test = defineTest(
        runner,
        {
          slowServer: [
            async ({}, use: (v: number) => Promise<void>) => {
              await gate;
              await use(1);
            },
            { scope: "file" },
          ],
        } as never,
        { testTimeout: 200, teardownTimeout: 200 },
      );
      test("waits", async ({ slowServer }: { slowServer: number }) => {
        bodyRan = slowServer > 0;
      });
      await expect(run("waits")).rejects.toThrow("did not finish within 200ms");
      release();
      await endFile();
      expect(bodyRan).toBe(false);
    });

    it("all teardowns of a test share one allowance: two hung ones take it once, not twice", async () => {
      const { runner, run } = recordingRunner();
      const hung = async ({}, use: (v: number) => Promise<void>) => {
        await use(1);
        await new Promise(() => undefined);
      };
      const test = defineTest(runner, { h1: hung, h2: hung } as never, { teardownTimeout: 300 });
      test("two hung", async ({ h1, h2 }: { h1: number; h2: number }) => void (h1 + h2));
      const started = Date.now();
      await expect(run("two hung")).rejects.toThrow("teardown did not finish within the 300ms teardown allowance");
      expect(Date.now() - started).toBeLessThan(550);
    });

    it("a hung file-scoped setup does not block the block's teardown", async () => {
      const { runner, run, endFile } = recordingRunner();
      const log: string[] = [];
      const test = defineTest(
        runner,
        {
          fine: [
            async ({}, use: (v: number) => Promise<void>) => {
              await use(1);
              log.push("fine torn down");
            },
            { scope: "file" },
          ],
          stuck: [
            async ({}, use: (v: number) => Promise<void>) => {
              await new Promise(() => undefined); // never finishes setting up
              await use(1);
            },
            { scope: "file" },
          ],
        } as never,
        { testTimeout: 200, teardownTimeout: 200 },
      );
      test("fine", async ({ fine }: { fine: number }) => void fine);
      test("stuck", async ({ stuck }: { stuck: number }) => void stuck);
      await run("fine");
      await expect(run("stuck")).rejects.toThrow("did not finish within 200ms");
      const started = Date.now();
      await expect(endFile()).rejects.toThrow("fixture 'stuck': setup did not finish");
      expect(Date.now() - started).toBeLessThan(450);
      expect(log).toEqual(["fine torn down"]);
    });

    it("a late test-scoped setup is torn down exactly once", async () => {
      const { runner, run } = recordingRunner();
      let teardowns = 0;
      let tornDown!: () => void;
      const done = new Promise<void>((resolve) => (tornDown = resolve));
      const test = defineTest(
        runner,
        {
          late: async ({}, use: (v: number) => Promise<void>) => {
            await after(400);
            await use(1);
            teardowns++;
            tornDown();
          },
        } as never,
        { testTimeout: 150, teardownTimeout: 100 },
      );
      test("late", async ({ late }: { late: number }) => void late);
      await expect(run("late")).rejects.toThrow("did not finish within 150ms");
      await done;
      await after(50);
      expect(teardowns).toBe(1);
    });
  });

  describe("file-level lifecycle", () => {
    // eslint-disable-next-line feather-testing/no-wait-for-timeout -- builds deliberately slow fixtures; no test waits on it
    const after = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    it("a pending file-scoped fixture finishes and is torn down before what it depends on", async () => {
      const { runner, run, endFile } = recordingRunner();
      const log: string[] = [];
      const test = defineTest(
        runner,
        {
          browser: [
            async ({}, use: (v: string) => Promise<void>) => {
              await use("browser");
              log.push("browser down");
            },
            { scope: "file" },
          ],
          app: [
            async ({ browser }: { browser: string }, use: (v: string) => Promise<void>) => {
              await after(300);
              await use(`app on ${browser}`);
              log.push("app down");
            },
            { scope: "file" },
          ],
        } as never,
        { testTimeout: 100, teardownTimeout: 1000 },
      );
      test("needs app", async ({ app }: { app: string }) => void app);
      await expect(run("needs app")).rejects.toThrow("did not finish within 100ms");
      await endFile();
      expect(log).toEqual(["app down", "browser down"]);
    });
  });

  describe("closing the file scope while setups are still running", () => {
    it("tears down every fixture a pending setup goes on to create, exactly once", async () => {
      const { runner, run, endFile } = recordingRunner();
      const log: string[] = [];
      let releaseA!: () => void;
      const aGate = new Promise<void>((resolve) => (releaseA = resolve));
      let aStarted!: () => void;
      const aIsSettingUp = new Promise<void>((resolve) => (aStarted = resolve));
      const fileFixture = (name: string, wait?: Promise<void>, started?: () => void) => [
        async (_: unknown, use: (v: string) => Promise<void>) => {
          started?.();
          if (wait) await wait;
          log.push(`up ${name}`);
          await use(name);
          log.push(`down ${name}`);
        },
        { scope: "file", deps: [] },
      ];
      const test = defineTest(
        runner,
        {
          a: fileFixture("a", aGate, aStarted),
          b: fileFixture("b"),
          app: [
            async ({ a, b }: { a: string; b: string }, use: (v: string) => Promise<void>) => {
              log.push("up app");
              await use(`${a}+${b}`);
              log.push("down app");
            },
            { scope: "file" },
          ],
        } as never,
        { testTimeout: 100, teardownTimeout: 2000 },
      );
      test("needs app", async ({ app }: { app: string }) => void app);
      const attempt = run("needs app");
      await aIsSettingUp;
      await expect(attempt).rejects.toThrow("did not finish within 100ms");
      // The block ends while 'a' (the first of app's two dependencies) is
      // still setting up; 'b' and 'app' do not exist yet.
      const closing = endFile();
      releaseA();
      await closing;
      expect(log.filter((l) => l.startsWith("up")).sort()).toEqual(["up a", "up app", "up b"]);
      expect(log.filter((l) => l.startsWith("down"))).toEqual(["down app", "down b", "down a"]);
    });

    it("a late teardown that fails is reported, never an unhandled rejection", async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => void unhandled.push(reason);
      process.on("unhandledRejection", onUnhandled);
      const reported: string[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => void reported.push(args.map(String).join(" "));
      try {
        const { runner, run, endFile } = recordingRunner();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        let tornDown!: () => void;
        const teardownRan = new Promise<void>((resolve) => (tornDown = resolve));
        const test = defineTest(
          runner,
          {
            late: [
              async ({}, use: (v: number) => Promise<void>) => {
                await gate;
                await use(1);
                tornDown();
                throw new Error("late teardown broke");
              },
              { scope: "file" },
            ],
          } as never,
          { testTimeout: 100, teardownTimeout: 100 },
        );
        test("needs late", async ({ late }: { late: number }) => void late);
        await expect(run("needs late")).rejects.toThrow("did not finish within 100ms");
        await expect(endFile()).rejects.toThrow("fixture 'late': setup did not finish");
        release();
        await teardownRan;
        // Let the rejection (if any) surface.
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        expect(unhandled).toEqual([]);
        expect(reported.filter((line) => line.includes("late teardown broke"))).toHaveLength(1);
      } finally {
        process.off("unhandledRejection", onUnhandled);
        console.error = original;
      }
    });
  });

  it("a test-scoped setup that finishes after its test was abandoned reports a failing teardown, once", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const reported: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void reported.push(args.map(String).join(" "));
    try {
      const { runner, run } = recordingRunner();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let tornDown!: () => void;
      const teardownRan = new Promise<void>((resolve) => (tornDown = resolve));
      const test = defineTest(
        runner,
        {
          late: async ({}, use: (v: number) => Promise<void>) => {
            await gate;
            await use(1);
            tornDown();
            throw new Error("late test-scoped teardown broke");
          },
        } as never,
        { testTimeout: 100, teardownTimeout: 100 },
      );
      test("needs late", async ({ late }: { late: number }) => void late);
      await expect(run("needs late")).rejects.toThrow("did not finish within 100ms");
      release();
      await teardownRan;
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      expect(reported.filter((line) => line.includes("late test-scoped teardown broke"))).toHaveLength(1);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      console.error = original;
    }
  });

  describe("file-teardown hooks", () => {
    const fixtures = {
      plain: 1,
      perTest: async ({}, use: (v: number) => Promise<void>) => use(1),
      shared: [async ({}, use: (v: number) => Promise<void>) => use(2), { scope: "file" }],
      onShared: [async ({ shared }: { shared: number }, use: (v: number) => Promise<void>) => use(shared), { scope: "file" }],
      usesShared: async ({ onShared }: { onShared: number }, use: (v: number) => Promise<void>) => use(onShared),
    };

    it("are registered only by tests that (transitively) use a file-scoped fixture", () => {
      const { runner, hooks } = recordingRunner();
      const test = defineTest(runner, fixtures as never);
      test("none", async ({ plain, perTest }: { plain: number; perTest: number }) => void (plain + perTest));
      test("direct", async ({ shared }: { shared: number }) => void shared);
      test("through a dependency", async ({ usesShared }: { usesShared: number }) => void usesShared);
      expect(hooks()).toBe(2);
    });

    it("are registered once per suite when the runner says which suite is collecting", () => {
      const { runner, hooks } = recordingRunner();
      const suites = [{ name: "file" }, { name: "describe" }];
      let current = suites[0]!;
      const test = defineTest({ ...runner, currentSuite: () => current }, fixtures as never);
      test("one", async ({ shared }: { shared: number }) => void shared);
      test("two", async ({ shared }: { shared: number }) => void shared);
      current = suites[1]!;
      test("three", async ({ shared }: { shared: number }) => void shared);
      test("four", async ({ usesShared }: { usesShared: number }) => void usesShared);
      expect(hooks()).toBe(2);
    });
  });

  describe("overrides and messages", () => {
    it(".with() refuses a fixture that is not defined", () => {
      const { runner } = recordingRunner();
      const test = defineTest(runner, { headed: false } as never);
      expect(() => test.with({ hedaed: true })).toThrow(
        "test.with(): 'hedaed' is not a defined fixture (defined: headed)",
      );
    });

    it(".with() keeps a function a fixture function; [fn, { value: true }] makes it a value", async () => {
      const { runner, run } = recordingRunner();
      const handler = (request: string) => `handled ${request}`;
      const test = defineTest(runner, {
        handler: [() => "default", { value: true }],
        greeting: "hi",
      } as never);
      const got: unknown[] = [];
      test
        .with({ greeting: async ({}, use: (v: string) => Promise<void>) => use("from a fixture function") })
        ("fixture fn", async ({ greeting }: { greeting: string }) => void got.push(greeting));
      test
        .with({ handler: [handler, { value: true }] })
        ("value", async ({ handler: h }: { handler: (r: string) => string }) => void got.push(h("x")));
      await run("fixture fn");
      await run("value");
      expect(got).toEqual(["from a fixture function", "handled x"]);
    });

    it("an array value whose second item is an object is a value, not [fn, options]", async () => {
      const { runner, run } = recordingRunner();
      const cookies = [{ name: "a", value: "1" }, { name: "b", value: "2" }];
      const test = defineTest(runner, { cookies } as never);
      let got: unknown;
      test("cookies", async ({ cookies: c }: { cookies: unknown }) => {
        got = c;
      });
      await run("cookies");
      expect(got).toEqual(cookies);
    });

    it("a test whose fixtures cannot be read gets a copy-pasteable explicit list of the names it uses", () => {
      const { runner } = recordingRunner();
      const test = defineTest(runner, { a: 1, b: 2 } as never);
      expect(() =>
        test("rest", async ({ a, b, ...others }: Record<string, unknown>) => void [a, b, others]),
      ).toThrow(`test("rest", ["a", "b"], async ({ a, b }) => …)`);
    });
  });

  describe("[definition, options] and value()", () => {
    it("an array of two objects is a value, even when they have a 'value' key", async () => {
      const { runner, run } = recordingRunner();
      const rows = [{ value: "first" }, { value: "second" }];
      const test = defineTest(runner, { rows } as never);
      let got: unknown;
      test("rows", async ({ rows: r }: { rows: unknown }) => {
        got = r;
      });
      await run("rows");
      expect(got).toEqual(rows);
    });

    it("[fn, {}] is a fixture function with no options", async () => {
      const { runner, run } = recordingRunner();
      const test = defineTest(runner, {
        made: [async ({}, use: (v: string) => Promise<void>) => use("made"), {}],
      } as never);
      let got: unknown;
      test("made", async ({ made }: { made: unknown }) => {
        got = made;
      });
      await run("made");
      expect(got).toBe("made");
    });

    it("a two-item array is a value unless it is [function, options]: rows, [1, {}], unknown keys", async () => {
      const { runner, run } = recordingRunner();
      const fn = () => "f";
      const defs = {
        rows: [{ id: 1 }, { id: 2 }],
        numberAndEmpty: [1, {}],
        numberAndScope: [1, { scope: "file" }],
        unknownKey: [fn, { scope: "file", limit: 3 }],
        nonPlain: [fn, new Date(0)],
      };
      const test = defineTest(runner, defs as never);
      let got: Record<string, unknown> = {};
      test("whole", async ({ rows, numberAndEmpty, numberAndScope, unknownKey, nonPlain }: Record<string, unknown>) => {
        got = { rows, numberAndEmpty, numberAndScope, unknownKey, nonPlain };
      });
      await run("whole");
      expect(got).toEqual(defs);
      expect((got.rows as unknown[])[1]).toEqual({ id: 2 });
    });

    it("[fn, { scope }] and [fn, { value: true }] are still unwrapped", async () => {
      const { runner, run, endFile } = recordingRunner();
      const handler = (r: string) => `handled ${r}`;
      const test = defineTest(runner, {
        shared: [async ({}, use: (v: string) => Promise<void>) => use("shared"), { scope: "file" }],
        handler: [handler, { value: true }],
      } as never);
      let got: unknown[] = [];
      test("both", async ({ shared, handler: h }: { shared: string; handler: typeof handler }) => {
        got = [shared, h("x")];
      });
      await run("both");
      await endFile();
      expect(got).toEqual(["shared", "handled x"]);
    });

    it("value(x) makes anything a plain value: a function, or an ambiguous array", async () => {
      const { runner, run } = recordingRunner();
      const handler = (request: string) => `handled ${request}`;
      const pair = [handler, {}];
      const test = defineTest(runner, { handler: value(handler), pair: value(pair) } as never);
      const got: unknown[] = [];
      test("values", async ({ handler: h, pair: p }: { handler: typeof handler; pair: unknown }) => {
        got.push(h("x"), p);
      });
      await run("values");
      expect(got).toEqual(["handled x", pair]);
    });
  });
});
