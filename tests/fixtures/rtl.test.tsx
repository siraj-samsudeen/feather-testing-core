/** Core's rtl fixture (needs a DOM: jsdom under Vitest, happy-dom under bun). */
import React from "react";
import { afterAll, afterEach, expect, test as runnerTest } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { defineCoreTest } from "../../src/fixtures/index.js";

const test = defineCoreTest({ test: runnerTest, afterAll });
afterEach(cleanup);

test("rtl is a session on what is rendered", async ({ rtl }) => {
  render(<p>Hello from a component</p>);
  await rtl.assertText("Hello from a component");
  expect(typeof rtl.fillIn).toBe("function");
});
