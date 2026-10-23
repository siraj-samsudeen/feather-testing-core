// @vitest-environment node
/**
 * Under a real runner (bun:test or Vitest): the runner's timeout includes
 * the teardown allowance, so a teardown slower than the test's own budget
 * finishes before the runner gives up, and the test passes.
 */
import { afterAll, expect, test as runnerTest } from "vitest";
import { defineTest } from "../../src/fixtures/engine.js";

let tornDown = false;
const test = defineTest(
  { test: runnerTest, afterAll },
  {
    slowToClose: async ({}, use: (v: number) => Promise<void>) => {
      await use(1);
      // eslint-disable-next-line feather-testing/no-wait-for-timeout -- a deliberately slow teardown is what is tested
      await new Promise((resolve) => setTimeout(resolve, 700));
      tornDown = true;
    },
  } as never,
  { testTimeout: 300, teardownTimeout: 2000 },
);

test("a 700 ms teardown after a 300 ms test budget completes inside the runner's timeout", async ({
  slowToClose,
}: {
  slowToClose: number;
}) => {
  expect(slowToClose).toBe(1);
});

runnerTest("the slow teardown ran to the end", () => {
  expect(tornDown).toBe(true);
});
