import { Session } from "../session.js";
import type { RequestHandler } from "./browser.js";
import {
  RequestDriver,
  type RequestDriverOptions,
  type RequestPage,
  type RequestStepContext,
} from "./driver.js";

export { Session } from "../session.js";
export { StepError, BrowserOnlyVerbError } from "../errors.js";
export { DEFAULT_TIMEOUT } from "../types.js";
export {
  RequestDriver,
  type RequestDriverOptions,
  type RequestPage,
  type RequestStepContext,
} from "./driver.js";
export { cookieHeaderFor } from "./cookies.js";
export {
  RequestBrowser,
  type RequestHandler,
  type Download,
} from "./browser.js";
export type {
  AssertHasOptions,
  AssertPathOptions,
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
 * A session that drives an app through its request handler — Elysia's
 * `app.handle`, Hono's `app.fetch`, or `fetch` against a running server —
 * with no browser: links are followed, forms are submitted and redirects
 * are followed the way a browser would, and each response is parsed.
 */
export function createSession(
  handler: RequestHandler,
  options?: RequestDriverOptions,
): Session<RequestStepContext, RequestPage> {
  return new Session(new RequestDriver(handler, options), {
    onStep: options?.onStep,
  });
}
