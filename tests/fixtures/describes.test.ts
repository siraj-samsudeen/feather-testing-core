// @vitest-environment node
/** File-scoped fixtures used in several describe blocks, under a real runner. */
import { afterAll, describe, expect, test as runnerTest } from "vitest";
import { defineTest } from "../../src/fixtures/engine.js";

const log: string[] = [];
let instances = 0;

const test = defineTest({ test: runnerTest, afterAll }, {
  server: [
    async ({}, use: (v: number) => Promise<void>) => {
      const id = ++instances;
      log.push(`setup ${id}`);
      await use(id);
      log.push(`teardown ${id}`);
    },
    { scope: "file" },
  ],
} as never);

describe("first block", () => {
  test("uses the server", async ({ server }: { server: number }) => {
    expect(server).toBeGreaterThan(0);
  });
});

describe("second block", () => {
  test("uses the server too", async ({ server }: { server: number }) => {
    expect(server).toBeGreaterThan(0);
  });
});

describe("after both blocks", () => {
  runnerTest("every instance was torn down exactly once", () => {
    const setups = log.filter((l) => l.startsWith("setup")).length;
    expect(log.filter((l) => l.startsWith("teardown")).length).toBe(setups);
    expect(new Set(log).size).toBe(log.length);
  });
});
