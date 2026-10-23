// @vitest-environment node
/**
 * Under a real runner with retries: a file-scoped setup started by an
 * attempt that timed out is not tied to that attempt, so the retry gets it
 * (here the slow part is a dependency of the fixture the test asks for).
 */
import { afterAll, expect, test as runnerTest } from "vitest";
import { defineTest, type Runner } from "../../src/fixtures/engine.js";

/** The runner, with one retry: bun takes options third, Vitest second. */
const withRetry: Runner = {
  test: (name, fn, timeout) =>
    typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
      ? (runnerTest as unknown as (n: string, f: () => Promise<void>, o: object) => void)(name, fn, {
          timeout,
          retry: 1,
        })
      : runnerTest(name, { timeout, retry: 1 }, fn),
  afterAll,
};

let attempts = 0;
let browserSetups = 0;
const test = defineTest(
  withRetry,
  {
    browser: [
      async ({}, use: (v: number) => Promise<void>) => {
        browserSetups++;
        // eslint-disable-next-line feather-testing/no-wait-for-timeout -- a deliberately slow first setup is what is tested
        await new Promise((resolve) => setTimeout(resolve, 500));
        await use(browserSetups);
      },
      { scope: "file" },
    ],
    app: [
      async ({ browser }: { browser: number }, use: (v: string) => Promise<void>) => {
        await use(`app on browser ${browser}`);
      },
      { scope: "file" },
    ],
  } as never,
  { testTimeout: 350, teardownTimeout: 200 },
);

test("the retry gets the file-scoped fixture the timed-out attempt started", async ({ app }: { app: string }) => {
  attempts++;
  expect(app).toBe("app on browser 1");
});

runnerTest("the retry ran the body, and the browser was set up once", () => {
  expect(attempts).toBe(1);
  expect(browserSetups).toBe(1);
});
