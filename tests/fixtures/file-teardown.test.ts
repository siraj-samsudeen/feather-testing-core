// @vitest-environment node
/**
 * Under a real runner, without --timeout: the file-scoped teardown hook is
 * handed the teardown allowance, so a teardown longer than the runner's
 * default hook timeout (bun: 5 s) still finishes.
 */
import { afterAll, describe, expect, test as runnerTest } from "vitest";
import { defineTest } from "../../src/fixtures/engine.js";

let tornDown = false;
const test = defineTest(
  { test: runnerTest, afterAll },
  {
    slowToClose: [
      async ({}, use: (v: number) => Promise<void>) => {
        await use(1);
        // eslint-disable-next-line feather-testing/no-wait-for-timeout -- a deliberately slow teardown is what is tested
        await new Promise((resolve) => setTimeout(resolve, 5500));
        tornDown = true;
      },
      { scope: "file" },
    ],
  } as never,
  { teardownTimeout: 8000 },
);

describe("a block using the file-scoped fixture", () => {
  test("uses it", async ({ slowToClose }: { slowToClose: number }) => {
    expect(slowToClose).toBe(1);
  });
});

describe("after that block", () => {
  runnerTest("its 5.5 s teardown ran to the end", () => {
    expect(tornDown).toBe(true);
  });
});
