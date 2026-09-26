import { test as base, type Page } from "@playwright/test";
import { Session } from "../session.js";
import { PlaywrightDriver, type PlaywrightStepContext } from "./driver.js";

export { Session } from "../session.js";
export { StepError, BrowserOnlyVerbError } from "../errors.js";
export { PlaywrightDriver, type PlaywrightStepContext } from "./driver.js";
export type {
  AssertExactTextOptions,
  AssertHasOptions,
  AssertPathOptions,
  AssertionOptions,
  DownloadOptions,
  TestDriver,
  UntilOptions,
  UntilPredicate,
} from "../types.js";

export function createSession(
  page: Page,
): Session<PlaywrightStepContext, Page> {
  return new Session(new PlaywrightDriver(page));
}

export const test = base.extend<{
  session: Session<PlaywrightStepContext, Page>;
}>({
  session: async ({ page }, use) => {
    await use(createSession(page));
  },
});

export { expect } from "@playwright/test";
