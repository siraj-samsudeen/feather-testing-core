/**
 * `feather-testing-core/cookies`: cookie matching without any adapter —
 * no browser, no DOM parser (happy-dom), no other package. The request
 * adapter's jar applies the same rules.
 */
export { cookieHeaderFor, type CookieLike } from "../request/cookies.js";
export type { SessionCookie } from "../types.js";
