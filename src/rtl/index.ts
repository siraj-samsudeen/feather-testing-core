import { Session } from "../session.js";
import { RTLDriver, type RTLQueries, type RTLStepContext } from "./driver.js";

export { Session } from "../session.js";
export { StepError, BrowserOnlyVerbError } from "../errors.js";
export {
  RTLDriver,
  type RTLQueries,
  type RTLStepContext,
} from "./driver.js";
export type {
  AssertExactTextOptions,
  AssertHasOptions,
  DownloadOptions,
  TestDriver,
  UntilOptions,
  UntilPredicate,
} from "../types.js";

export function createSession(): Session<RTLStepContext, RTLQueries> {
  return new Session(new RTLDriver());
}
