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
  SessionCookie,
  SessionOptions,
  StepEvent,
  TestDriver,
  UntilOptions,
  UntilPredicate,
} from "../types.js";

/**
 * `onStep` works as in the other adapters. `timeout` is the budget of every
 * Testing Library `findBy` wait in the session (Testing Library's default
 * is 1000 ms). A step's own `{ timeout }` is accepted and ignored here.
 */
export function createSession(
  options?: Pick<SessionOptions, "onStep" | "timeout">,
): Session<RTLStepContext, RTLQueries> {
  return new Session(new RTLDriver(undefined, undefined, options?.timeout), {
    onStep: options?.onStep,
  });
}
