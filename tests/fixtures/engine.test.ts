// @vitest-environment node
/**
 * The fixture engine against a recording stand-in runner, so the lifecycle
 * (lazy setup, dependency order, reverse teardown, failures, file scope)
 * can be checked step by step, failing tests included.
 */
import { describe, expect, it } from "vitest";
import { defineTest, destructuredNames, type Runner } from "../../src/fixtures/engine.js";

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
  return { runner, tests, run, endFile };
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
    base.with({ browserName: "webkit" } as never)("with", async ({ label }: { label: string }) => void got.push(label));
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
    test.with({ headed: true } as never)("headed", async ({}) => undefined);
    expect(tests.map((t) => t.timeout)).toEqual([undefined, 120_000]);
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
    test.with({ record: "on" } as never)("unrelated option", async ({ browser }: { browser: string }) => void got.push(browser));
    test.with({ headed: true } as never)("headed", async ({ browser }: { browser: string }) => void got.push(browser));
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
});
