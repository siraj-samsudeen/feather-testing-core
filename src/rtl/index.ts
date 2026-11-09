import { Session } from "../session.js";
import type { SessionOptions } from "../types.js";
import { RTLDriver, type RTLQueries, type RTLStepContext } from "./driver.js";

export { Session } from "../session.js";
export { StepError, BrowserOnlyVerbError } from "../errors.js";
export {
  RTLDriver,
  type RTLQueries,
  type RTLStepContext,
  type ScopeRoot,
} from "./driver.js";
export type {
  AssertHasOptions,
  AssertionOptions,
  DownloadOptions,
  FillInOptions,
  LayoutAssertionOptions,
  SessionCookie,
  SessionOptions,
  StepEvent,
  TestDriver,
  UntilOptions,
  UntilPredicate,
} from "../types.js";

/**
 * `onStep` works as in the other adapters. `timeout` is the budget of every
 * wait in the session (default: Testing Library's asyncUtilTimeout, 1000 ms;
 * `0` means no limit). A step's own `{ timeout }` wins over it.
 */
export function createSession(
  options?: Pick<SessionOptions, "onStep" | "timeout">,
): Session<RTLStepContext, RTLQueries> {
  return new Session(new RTLDriver(undefined, undefined, options?.timeout), {
    onStep: options?.onStep,
  });
}
