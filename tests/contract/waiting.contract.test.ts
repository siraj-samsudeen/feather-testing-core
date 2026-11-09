// @vitest-environment node
/**
 * The waiting contract (tests/contract/waiting.ts) on the request and
 * Playwright drivers, over the fixture app.
 */
import { drivers } from "./drivers.js";
import { defineWaitingContract } from "./waiting.js";

for (const driver of drivers) {
  defineWaitingContract({
    name: driver.name,
    waits: driver.name === "playwright",
    setUp: () => driver.setUp(),
    tearDown: () => driver.tearDown(),
    async open(html) {
      const harness = await driver.open({ "/page": html });
      return {
        start: (options) => harness.session(options).visit("/page"),
        close: () => harness.close(),
      };
    },
  });
}
