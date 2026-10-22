import { test as base } from "@playwright/test";
import { routePages } from "./pages.js";

export { pages } from "./pages.js";

const playwrightTest = base.extend({
  context: async ({ context }, use) => {
    await routePages(context);
    await use(context);
  },
});

/**
 * The same spec runs under two runners. Under `playwright test` it gets the
 * fixture above; under `bun test` there is no Playwright Test runner, so it
 * gets a bun:test stand-in with the same shape (see bun-fixtures.ts).
 */
const bunFixtures = process.versions.bun
  ? await import("./bun-fixtures.js")
  : undefined;

export const test = (bunFixtures?.test ??
  playwrightTest) as unknown as typeof playwrightTest;

// Playwright's expect works outside its runner too; bun's own expect has no
// locator matchers (toHaveText, ...).
export { expect } from "@playwright/test";
