# Adapter parity: Playwright and request

The Playwright adapter (`feather-testing-core/playwright`, "P") and the request adapter (`feather-testing-core/request`, "R") are meant to be one DSL with two drivers: what passes against one should pass against the other, unless the difference is something a browser does that plain HTTP cannot (JavaScript, CSS, layout).

This matrix lists every public surface and behaviour, as of the `bun-port-stacked` branch (0.7.0, unreleased).

## Statuses

| Status | Meaning |
|--------|---------|
| **same** | Same API and same observable behaviour. Covered by `tests/contract/`, which runs one spec against both drivers. |
| **differs** | Both have it, but it behaves differently. The Notes column says whether that is a gap or a choice. |
| **missing in P** / **missing in R** | Only one adapter has it. |
| **n/a** | It cannot mean the same thing without a browser, or it belongs to the native handle. Documented here, not contract-tested. |

## Matrix

### Entry point and options

| # | Surface | Status | Notes |
|---|---------|--------|-------|
| 1 | `createSession(native, options?)` | n/a | The first argument is each driver's native handle: a Playwright `Page`, or a request handler `(Request) => Response`. Everything after it can be shared. |
| 2 | `test` fixture with a `session` (`@playwright/test`) | n/a | R runs under any runner and has no fixture. |
| 3 | `options.timeout` | missing in R | P: the budget for assertions, waits and actions. The default is 4000 ms outside the Playwright runner and Playwright's own timeouts inside it; `0` means no limit. R accepts no options except `baseUrl`, and its `until` budget is fixed at 5000 ms. **Gap: closable.** R would take `timeout` as its `until` budget (it is the only verb in R that waits). |
| 4 | `options.navigationTimeout` | n/a in R | R gets each response complete; nothing loads in the background. |
| 5 | `options.navigationStartWindow`, `options.replacedNavigationWindow` | n/a in R | These tune P's wait for a browser navigation. |
| 6 | `options.onStep` | missing in R | P calls it from `wrapStep`. **Gap: closable.** Move it into `Session`, so every driver (RTL included) gets it. |
| 7 | `options.baseUrl` | missing in P | R resolves `visit()` paths against it. P relies on the browser context's `baseURL`. **Gap: closable.** P would accept `baseUrl` and resolve `visit()` against it. |
| 8 | `Session.run()` | same | It lives in `Session`. |
| 9 | Step names and the `StepError` chain (`[ok]` / `[FAILED]` / `[skipped]`) | same | It lives in `Session`. |
| 10 | `test.step()` reporting | n/a in R | Needs the Playwright runner. |

### Secrets

| # | Surface | Status | Notes |
|---|---------|--------|-------|
| 11 | Value hidden for a secret-looking label or `{ sensitive: true }` | same | It lives in `Session`. |
| 12 | Value hidden in the failure report for an `<input type=password>` (via `lastFilledFieldIsPassword`) | same | Both drivers implement it. |
| 13 | Value hidden before the step starts (via `fillTargetIsPassword`), so step titles and `onStep` never see it | missing in R | **Gap: closable.** It only matters once R has `onStep` (#6). R can answer at once, because the page is already parsed. |
| 14 | `debug()` | differs (choice) | P saves a screenshot, where the browser masks password fields. R prints the HTML with password values replaced by `••••••`. |

### Navigation, forms and waiting

| # | Surface | Status | Notes |
|---|---------|--------|-------|
| 15 | `visit(path)` | same | |
| 16 | `reload()`: same URL, cookies kept | same | |
| 17 | `click` / `clickLink` / `clickButton`; the next step sees the new page | same | P waits for the new document. R has it the moment the response is parsed. |
| 18 | `submit()` order (explicit `type=submit`, a button named like "submit", then Enter) | same | |
| 19 | `pressKey("Enter")` submits the form (implicit submission) | same | |
| 20 | `pressKey(other keys)` | n/a in R | `BrowserOnlyVerbError`: other keys do nothing without JavaScript. |
| 21 | Following redirects (303 and 302 become GET; 307 keeps the method) | same | |
| 22 | A 204/205 answer to a form submission | differs | P stays on the page, as browsers do. R shows an empty page. **Gap: closable in R** (a browser keeps the page). |
| 23 | A download answer (`Content-Disposition: attachment`) | same | Both stay on the page. `assertDownload` sees the suggested filename. |
| 24 | `<form method="dialog">` | differs | P: the browser closes the dialog and sends nothing. R: throws. **Gap: closable in R.** Closing a dialog is HTML, not JavaScript. |
| 25 | Form or link with `target` / `formtarget` naming another window or an iframe | differs | P: this page stays and the other context loads. R ignores `target` and navigates the session's page. **Decision needed (D3).** |
| 26 | Links: `href="#"`, `#fragment`, `javascript:`, `mailto:` | differs (choice) | Both stay on the page for `#` and `#fragment` (R updates the URL's hash, as browsers do). For `javascript:`, P runs the script and R throws `BrowserOnlyVerbError`. That is n/a. |
| 27 | An empty `required` field when submitting | differs | P: the browser blocks the submission silently, and the step passes. R: the step fails and names the field. **Decision needed (D2).** |
| 28 | Cookies kept across redirects and requests (`Path`, `Max-Age`, deletion) | same | |
| 29 | `Origin` and `Accept` headers on form posts | same | The browser sends them; R adds them. |
| 30 | `attachFile` / `upload`: multipart bytes, file name and type | same | |
| 31 | `dropFile`, `hover` | n/a in R | `BrowserOnlyVerbError`. |
| 32 | `assertDownload(expected, trigger)` | same | |

### Addressing

| # | Surface | Status | Notes |
|---|---------|--------|-------|
| 33 | Exact, whitespace-normalized matching of label, placeholder and accessible name | same | |
| 34 | The name of a wrapping `<label>` that contains a `<select>` | differs (choice) | P includes the option texts in the name; R does not (as Testing Library does). Documented in the README. Give such a label `for` when one spec must run on both. |
| 35 | Several controls match: the step fails | same | Both fail the step. The wording differs (P: Playwright's strict-mode message; R: the match count). |

### Assertions

| # | Surface | Status | Notes |
|---|---------|--------|-------|
| 36 | `assertText` / `refuteText`: case-insensitive substring | same | |
| 37 | `assertExactText` | same | |
| 38 | `assertHas(selector)` without `count`: which match must be visible | differs | P checks the first match only. R accepts any rendered match. **Decision needed (D4).** |
| 39 | `assertHas` with `count` / `text`, and `refuteHas` | same | |
| 40 | `assertAttribute` / `refuteAttribute` | same | |
| 41 | `assertValue`, `assertChecked`, `refuteChecked`, `assertSelected`, `assertOptions` | same | |
| 42 | `assertPath` / `refutePath`, including `queryParams` | same | |
| 43 | `assertComputedStyle` and the layout verbs | n/a in R | No CSS and no layout. |
| 44 | Hidden by CSS (`display: none`) counts as not rendered | n/a in R | R judges visibility from the markup only. |
| 45 | Assertions retry until the timeout | differs (choice) | P retries. R checks once, because its pages never change on their own. n/a. |

### Waiting

| # | Surface | Status | Notes |
|---|---------|--------|-------|
| 46 | `until(description, fn, { timeout, interval })` | same | Same contract: polls until truthy, and on failure names the description. |
| 47 | Default `until` budget | differs | P: the session `timeout` (4000 ms outside the runner). R: 5000 ms. **Gap: closable** with #3. |
| 48 | `timeout: 0` | differs | P: no limit. R has no session timeout. **Gap: closable** with #3. |
| 49 | The `until` / `step` context | n/a | `{ page, scope }` in P, `{ page, scope, fetch }` in R. It is native. |

### Scoping

| # | Surface | Status | Notes |
|---|---------|--------|-------|
| 50 | `within()` is re-resolved at each step, so it keeps working after a navigation | same | |
| 51 | What `within(selector)` may match | differs | P: at least one element (actions inside then fail in strict mode if there are several). R: exactly one. **Decision needed (D1).** |
| 52 | Session options carried into `within()` (timeout, onStep) | missing in R | It follows from #3 and #6. With `onStep` in `Session`, it is shared. |

### Errors and lifecycle

| # | Surface | Status | Notes |
|---|---------|--------|-------|
| 53 | `StepError` | same | |
| 54 | `BrowserOnlyVerbError` | n/a in P | Thrown by R and RTL for browser-only verbs. |
| 55 | "the page started to navigate, but no new page finished loading", and the closed-page error | n/a in R | Browser-only failure modes. |
| 56 | `step(name, fn)` / `raw(label, fn)` | same | Same contract; the native handle differs. |
| 57 | `close()` | n/a in P | R owns its parser window. In P the caller owns the page. |

## Counts

| Status | Rows |
|--------|------|
| same | 27 |
| differs (gap: closable) | 4 (#22, #24, #47, #48) |
| differs (decision needed) | 4 (#25, #27, #38, #51) |
| differs (choice, documented) | 4 (#14, #26, #34, #45) |
| missing in R | 4 (#3, #6, #13, #52) |
| missing in P | 1 (#7) |
| n/a | 13 |
| **total** | **57** |

## Decisions for the author

- **D1. `within()` multiplicity (#51).**
  - Options:
    - (a) Make P require exactly one match. Spec-wise this is clearer, but it is a breaking change for 0.6 users whose scope selector matches several elements and who never act inside it.
    - (b) Relax R to "at least one", and fail inside only when an action is ambiguous.
    - (c) Keep the difference, documented.
  - Recommendation: (a) in 0.7, listed under "Upgrading to 0.7.0". A scope that matches several containers is almost always a mistake.
- **D2. An empty `required` field when submitting (#27).**
  - Options:
    - (a) P fails the step and names the field, as R does. This breaks 0.6 specs that click Save and then assert the browser's validation state.
    - (b) R stays on the page silently, as the browser does.
    - (c) Keep the difference.
  - Recommendation: (b) plus a dedicated assertion later. The DSL's rule is "do what the browser does". Specs that test client-side validation keep working, and both drivers behave the same.
- **D3. `target` on forms and links (#25).**
  - Options:
    - (a) R throws `BrowserOnlyVerbError` ("opens another window or frame").
    - (b) R follows the link in the session's page (today's behaviour).
    - (c) R sends the request and keeps its page, as P does.
  - Recommendation: (a). The other context is invisible to the session in both drivers, and (c) would hide the response.
- **D4. `assertHas` visibility (#38).**
  - Options:
    - (a) P passes when any match is visible, as R does. This only turns failing specs into passing ones.
    - (b) R checks only the first match.
  - Recommendation: (a).
