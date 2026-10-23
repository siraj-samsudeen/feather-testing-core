import { Session } from "../session.js";
import type { SessionOptions } from "../types.js";
import { RTLDriver, type RTLQueries, type RTLStepContext } from "./driver.js";

export { Session } from "../session.js";
export { StepError, BrowserOnlyVerbError } from "../errors.js";
export {
  RTLDriver,
  type RTLQueries,
  type RTLStepContext,
} from "./driver.js";
export type {
  AssertHasOptions,
  AssertionOptions,
  DownloadOptions,
  FillInOptions,
  LayoutAssertionOptions,
  SessionOptions,
  StepEvent,
  TestDriver,
  UntilOptions,
  UntilPredicate,
} from "../types.js";

/**
 * `onStep` works as in the other adapters. The RTL adapter waits through
 * Testing Library's own `findBy` timeouts, so it takes no `timeout` here.
 */
export function createSession(
  options?: Pick<SessionOptions, "onStep">,
): Session<RTLStepContext, RTLQueries> {
  return new Session(new RTLDriver(), { onStep: options?.onStep });
}
