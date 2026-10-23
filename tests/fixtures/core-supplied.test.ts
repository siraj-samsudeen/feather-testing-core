// @vitest-environment node
/** Consumer-supplied core fixtures (handler, baseUrl) can be given with .with(). */
import { describe, expect, it } from "vitest";
import { defineCoreTest, value, type Runner } from "../../src/fixtures/index.js";
import { createFixtureApp } from "../request/fixture-app.js";

function recordingRunner() {
  const tests = new Map<string, () => Promise<void>>();
  const runner: Runner = {
    test: (name, fn) => void tests.set(name, fn),
    afterAll: () => undefined,
  };
  return { runner, run: (name: string) => tests.get(name)!() };
}

describe("core fixtures the consumer supplies", () => {
  it(".with({ handler: value(app.handle) }) is accepted, and request uses it", async () => {
    const { runner, run } = recordingRunner();
    const app = createFixtureApp();
    const test = defineCoreTest(runner).with({ handler: value(app.handle), baseUrl: "http://localhost" });
    test("about", async ({ request }) => {
      await request.visit("/about").assertText("About");
    });
    await run("about");
  });

  it("a test that needs handler without one says how to supply it", async () => {
    const { runner, run } = recordingRunner();
    const test = defineCoreTest(runner);
    test("no handler", async ({ request }) => void request);
    await expect(run("no handler")).rejects.toThrow(
      "the 'handler' fixture is not supplied: give it with .with({ handler: value(app.handle) }) or .extend({ handler: … })",
    );
  });
});
