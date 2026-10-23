# Adapter parity: Playwright and request

The Playwright adapter (`feather-testing-core/playwright`, "P") and the request adapter (`feather-testing-core/request`, "R") are meant to be one DSL with two drivers: what passes against one should pass against the other, unless the difference is something a browser does that plain HTTP cannot (JavaScript, CSS, layout).

This matrix lists every public surface and behaviour, as of the `bun-port-stacked` branch (0.7.0, unreleased), after the parity fixes.

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
| 3 | `options.timeout` | same | The budget for everything that waits; a per-call timeout wins; `0` means no limit. P: assertions, waits and actions, default 4000 ms outside the Playwright runner (Playwright's own timeouts inside it). R: `until`, its only waiting verb, default 4000 ms (was a fixed 5000). Shared type `SessionOptions` and `DEFAULT_TIMEOUT`. |
| 4 | `options.navigationTimeout` | n/a in R | R gets each response complete; nothing loads in the background. |
| 5 | `options.navigationStartTimeout`, `options.replacedNavigationTimeout` | n/a in R | These tune P's wait for a browser navigation. |
| 6 | `options.onStep` | same | Emitted by `Session` for every driver (RTL too); it was P's `wrapStep`. |
| 7 | `options.baseUrl` | same | Both resolve `visit()` paths as `new URL(path, baseUrl)`. Defaults: R `http://localhost`; P the browser context's `baseURL`. The contract harness gives P pages no context `baseURL`, so every contract test uses the option. |
| 7a | `options.cookies` (start signed in) | same | P: `context.addCookies` before the first step; R: seeds the session's cookie jar. Domain defaults to `baseUrl`'s host (host-only), path to `/`. Contract-tested, including the app deleting the cookie later. |
| 7b | `session.addCookies(cookies)` (add cookies mid-chain) | same | P: `context.addCookies`; R: the cookie jar. Named by cookie names only. Contract-tested. RTL: not implemented (no requests). |
| 7c | `await session.addCookiesNow(cookies)` (now, not queued) | same | P: `context.addCookies` at once (after the option's cookies); R: straight into the jar. Contract-tested against an already-queued visit. |
| 8 | `Session.run()` | same | It lives in `Session`. |
| 9 | Step names and the `StepError` chain (`[ok]` / `[FAILED]` / `[skipped]`) | same | It lives in `Session`. |
| 10 | `test.step()` reporting | n/a in R | Needs the Playwright runner. |

### Secrets

| # | Surface | Status | Notes |
|---|---------|--------|-------|
| 11 | Value hidden for a secret-looking label or `{ sensitive: true }` | same | It lives in `Session`. |
| 12 | Value hidden in the failure report for an `<input type=password>` (via `lastFilledFieldIsPassword`) | same | Both drivers implement it. |
| 13 | Value hidden before the step starts (`fieldIsPassword`), so step titles and `onStep` never see it | same | R implements it too. A label matching several fields now hides the value and fails with the same wording in both drivers (#35). |
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
| 22 | A 204/205 answer to a form submission | differs (Playwright limitation) | R now stays on the page, as browsers do (request suite). In Playwright 1.64 the browser stays too, but afterwards every locator waits for the 204 "navigation to finish" and times out, so P cannot pass the same check. Upstream; not contract-tested. |
| 23 | A download answer (`Content-Disposition: attachment`) | same | Both stay on the page. `assertDownload` sees the suggested filename. |
| 24 | `<form method="dialog">` | same | R now closes the enclosing `<dialog>` and sends nothing, as a browser does. |
| 25 | Form or link with `target` / `formtarget` / `<base target>` naming another window or frame | differs (decided, D3) | P: this page stays, the other window loads. R: `BrowserOnlyVerbError` naming the destination to `visit()` — the session has one page. |
| 26 | Links: `href="#"`, `#fragment`, `javascript:`, `mailto:` | differs (choice) | Both stay on the page for `#` and `#fragment` (R updates the URL's hash, as browsers do). For `javascript:`, P runs the script and R throws `BrowserOnlyVerbError`. That is n/a. |
| 27 | Submitting with an empty `required` field | same (D2) | Both fail the step: "form not sent: '<label>' is required" (P checks the browser's constraint validation after the action). The deliberate case is `assertSubmitBlocked(label)`, same on both. |
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
| 35 | Several controls match: the step fails | same | For `fillIn` the wording is shared now ("N fields are labelled '…'. Scope the step with within(...)") and the value is hidden. Other verbs keep each driver's wording. |

### Assertions

| # | Surface | Status | Notes |
|---|---------|--------|-------|
| 36 | `assertText` / `refuteText`: case-insensitive substring | same | |
| 37 | `assertExactText` | same | |
| 38 | `assertHas(selector)` without `count`: which match must be visible | same (D4) | Any visible (P) / rendered (R) match. `count` and `refuteHas` count every match. |
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
| 47 | Default `until` budget | same | The session `timeout` (default 4000 ms) in both. |
| 48 | `timeout: 0` | same | No limit, in both. |
| 49 | The `until` / `step` context | n/a | `{ page, scope }` in P, `{ page, scope, fetch }` in R. It is native. |

### Scoping

| # | Surface | Status | Notes |
|---|---------|--------|-------|
| 50 | `within()` is re-resolved at each step, so it keeps working after a navigation | same | |
| 51 | What `within(selector)` may match | same (D1) | Exactly one element in both; none or several fails, naming the count. |
| 52 | Session options carried into `within()` (timeout, onStep) | same | `Session` passes `onStep` to scoped sessions; R's scoped drivers keep the options. |

### Errors and lifecycle

| # | Surface | Status | Notes |
|---|---------|--------|-------|
| 53 | `StepError` | same | |
| 54 | `BrowserOnlyVerbError` | n/a in P | Thrown by R and RTL for browser-only verbs. |
| 55 | "the page started to navigate, but no new page finished loading", and the closed-page error | n/a in R | Browser-only failure modes. |
| 56 | `step(name, fn)` / `raw(label, fn)` | same | Same contract; the native handle differs. |
| 57 | `close()` | n/a in P | R owns its parser window. In P the caller owns the page. |

## Counts

| Status | Before the parity fixes | After the parity fixes | After the 0.7 decisions |
|--------|------------------------|------------------------|-------------------------|
| same | 27 | 35 | 38 (#27, #38, #51 decided) |
| differs (gap: closable) | 4 | 0 | 0 |
| differs (decision needed) | 4 | 4 | 0 |
| differs (decided / choice / upstream limitation) | 4 | 5 | 6 (#25 decided: D3) |
| missing in R / missing in P | 5 | 0 | 0 |
| n/a | 13 | 13 | 13 |
| **total** | **57** | **57** | **57** |

Also now shared: per-step `{ timeout }` on every waiting verb (B1; the request adapter accepts and ignores it) and `assertSubmitBlocked(label)` (D2).

## The RTL adapter (third driver)

`feather-testing-core/rtl` drives rendered React components with Testing Library. It is not in the contract suite: that suite drives the pages of an HTTP app, and RTL has no pages. Against the matrix:

| Area | RTL |
|------|-----|
| Entry point | `createSession({ onStep?, timeout? })`: no native handle; it works on what is rendered in `document.body`. `timeout` is the budget of Testing Library's `findBy` waits (default 1000 ms); a step's own `{ timeout }` is accepted and ignored. |
| Secrets (#11–#13) | same: label rule, `sensitive`, password fields checked before the step starts (`fieldIsPassword`) and after a fill. |
| `onStep`, `run()`, step names, `StepError` (#6, #8, #9, #53) | same (they live in `Session`). |
| Navigation and pages (`visit`, `reload`, `assertPath`, `refutePath`; #15, #16, #42) | n/a: no pages. `visit`/`assertPath`/`refutePath` say so and what to use instead; `reload` throws `BrowserOnlyVerbError`. |
| Forms (#17–#19, #41) | same verbs on rendered forms; nothing is sent anywhere. |
| `assertSubmitBlocked` (#27) | `BrowserOnlyVerbError`: constraint validation on submit is not modelled. |
| `assertHas` / `refuteHas` (#38, #39) | not available: Testing Library avoids CSS selectors; use `assertText` / `refuteText`. |
| `hover`, `dropFile`, CSS and layout verbs (#31, #43) | `BrowserOnlyVerbError` (layout, CSS); `hover` is simulated by user-event. |
| `within()` (#50, #51) | the first element matching the selector. |
| `until`, `step`, `raw` (#46, #56) | same contract; context `{ user, container }`. |

Every verb an adapter cannot run fails naming the adapter, the verb and what to use instead.

## Decisions for the author

Decided for 0.7; see [DECISIONS-0.7.md](DECISIONS-0.7.md). The options that were laid out:

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
