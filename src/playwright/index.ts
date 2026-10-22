import type { Page } from "playwright";
import { test as base } from "playwright/test";
import { Session } from "../session.js";
import {
  PlaywrightDriver,
  type PlaywrightSessionOptions,
  type PlaywrightStepContext,
} from "./driver.js";

export { Session } from "../session.js";
export { StepError, BrowserOnlyVerbError } from "../errors.js";
export {
  DEFAULT_TIMEOUT_OUTSIDE_RUNNER,
  PlaywrightDriver,
  type PlaywrightSessionOptions,
  type PlaywrightStepContext,
  type StepEvent,
} from "./driver.js";
export type {
  AssertHasOptions,
  AssertPathOptions,
  AssertionOptions,
  DownloadOptions,
  FillInOptions,
  LayoutAssertionOptions,
  TestDriver,
  UntilOptions,
  UntilPredicate,
} from "../types.js";

/**
 * A session around a Playwright `Page` — from the @playwright/test `page`
 * fixture, or from the `playwright` library (`chromium.launch()` and
 * `browser.newPage()`) under any runner, such as bun test.
 */
export function createSession(
  page: Page,
  options?: PlaywrightSessionOptions,
): Session<PlaywrightStepContext, Page> {
  return new Session(new PlaywrightDriver(page, page, options));
}

export const test = base.extend<{
  session: Session<PlaywrightStepContext, Page>;
}>({
  session: async ({ page }, use) => {
    await use(createSession(page));
  },
});

export { expect } from "playwright/test";
