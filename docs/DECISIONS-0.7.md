# Decisions for 0.7

These are the design decisions taken for 0.7.0. Each has a short entry with its reasoning. They follow the parity matrix in [ADAPTER_PARITY.md](ADAPTER_PARITY.md). The author can veto any of them before 0.7.0 leaves beta.

## Decided and built

### D1. `within(selector)` matches exactly one element

**Adapters:** Playwright and request.

**Decision:** If the selector matches no element, or several, the `within()` step fails. The error names the count and says how to narrow the selector.

**Why:** A scope that matches several containers is almost always a mistake. Under it, every step inside is ambiguous, and in Playwright it fails later and further from the cause. The request adapter already worked this way, so making Playwright match removes a difference a shared spec would trip over.

**Cost:** This breaks 0.6 Playwright specs whose scope matched several elements. The upgrade note gives the fix: narrow the selector, or use `:first-of-type` if the first one is really meant. The RTL adapter keeps "the first match", noted in the parity doc (accepted).

### D2. An empty required field fails the submit loudly; `assertSubmitBlocked(label)` covers the deliberate case

**Adapters:** both.

**Decision:** A submit the browser refuses fails the step, naming the field: "form not sent: 'Title' is required". The Playwright adapter learns of a refusal from the browser's own constraint-validation (`invalid`) events during the action. So it fails on any invalid field ("form not sent: 'X' is invalid: …"), not just an empty required one. The request adapter checks `required` only, as it does no other validation (accepted). In Playwright this is a click, Enter or `submit()` on a form held back by constraint validation. The new verb `assertSubmitBlocked(label)` submits the field's form, the way Enter in that field would. It passes only if the form is held back because that required field is empty, and fails if the form is sent or is held back by another field.

**Why:** A silently refused submit used to pass in Playwright. The failure then surfaced at a later, unrelated assertion. The request adapter already failed on it. Failing loudly in both, and giving the intentional case its own verb, keeps both kinds of spec honest.

**Cost:** This breaks 0.6 Playwright specs that clicked through a refused form. They should use `assertSubmitBlocked` instead. The RTL adapter throws `BrowserOnlyVerbError` for `assertSubmitBlocked`.

### D3. In the request adapter, links and forms aimed at another window throw

**Decision:** A link or form whose `target`, `formtarget` or `<base target>` is anything other than empty, `_self`, `_top` or `_parent` makes the step fail with `BrowserOnlyVerbError`. The message is: "It opens another window (target=…); the request adapter has one page — test the destination with visit('…') or use the Playwright adapter." `_parent` is accepted because at the top level it is the page itself (accepted). Download links and `method="dialog"` forms are unaffected. The Playwright adapter is unchanged.

**Why:** Navigating the session's only page to a destination meant for another window would make the spec pass while testing the wrong thing.

### D4. `assertHas(selector)` passes when any match is visible

**Adapters:** both.

**Decision:** Playwright now uses the first visible match. `count` and `refuteHas` still count every match.

**Why:** "Is there such an element on the page?" should not depend on whether a hidden duplicate comes first in the DOM. The request adapter already behaved this way.

**Cost:** It is more lenient. Specs that failed before may now pass; no spec that passed before now fails.

### B1. Every waiting verb takes `{ timeout }`

**Decision:** The assertions and actions take a last `{ timeout }` argument. The session passes each step's options object to the driver as given, so `fillIn`'s `{ sensitive }` reaches it too (accepted). Precedence is the step's own timeout, then the session's, then the adapter default. The request adapter accepts it and ignores it, because nothing in it waits except `until`. The RTL factory takes `createSession({ timeout })` for Testing Library's waits.

**Why:** A slow step, such as one waiting for a background job, should not force a long timeout on the whole session.

### B2 (part). Unsupported verbs say what to do instead; RTL is in the parity doc

**Decision:** Every verb an adapter cannot run fails with a message naming the adapter, the verb and what to use instead. `docs/ADAPTER_PARITY.md` now covers the RTL adapter too.

### Cookies: `createSession(…, { cookies })` starts a session signed in

**Adapters:** both.

**Decision:** Both entry points take `cookies: [{ name, value, domain?, path?, expires?, httpOnly?, secure?, sameSite? }]`, shaped like Playwright's. The Playwright adapter adds them to the browser context before the session's first step. A cookie without `domain` is host-only for `baseUrl`'s host, and `path` defaults to `/`. The request adapter seeds its private cookie jar the same way.

**Why:** Clear and additive, so it is decided under the author's rule. A later package (`feather-testing-elysia`) can then offer `logInAs(user)` on top of it, while "how to mint a session for user X" stays the consumer's callback.

### Fixtures in every runner: `feather-testing-core/fixtures`

**Decision:** Add a runner-agnostic fixture engine, `defineTest(runner, fixtures)`, with `.extend()` and `.with()`.
- Tests name the fixtures they need by destructuring them (or in an explicit list); only those are set up.
- Dependencies are resolved, and teardown runs in reverse order even on failure.
- Scopes are test and file (alias worker).

Core provides its own fixtures through `defineCoreTest(runner)`: `browser` (file-scoped, `HEADED=1`), `context` (`RECORD=1`, `record: "on-failure"`), `page`, `session` (needs `baseUrl`), `request` (needs `handler`) and `rtl`. Core has no knowledge of databases or Elysia: layered packages add those with `.extend()`.

**Why:** Clear and additive, so it is decided under the author's rule. The author wants Playwright's fixture experience in every layer. The `beforeAll`/`beforeEach` setup each consumer used to write becomes `async ({ session }) => …`.

**Limits (documented):**
- File scope relies on `afterAll` registered during collection, so the first test that uses a file-scoped fixture inside a `describe` ties its teardown to that `describe`.
- A function supplied as a fixture value needs `{ value: true }`, or `.with()`.

### `addCookies(cookies)`, `SessionCookie` everywhere, and test bodies with no parameter

**Requested by:** `feather-testing-elysia`.

**Decision:** All three are additive.
- `session.addCookies(cookies)`, on both adapters, adds cookies at any point in a chain. Its shape is the same as the `cookies` option. The step is named by the cookies' names, never their values. This lifts the elysia package's "logInAs only before the first request step" limit.
- `SessionCookie` is exported from every entry point.
- In the fixture engine, a test body with no parameter (`async () => …`) uses no fixtures. Only a non-destructured parameter or a rest pattern fails with the explicit-list hint.

### `cookieHeaderFor(cookies, url)` from `/request`

**Requested by:** `feather-testing-elysia`, whose Eden client then reuses it instead of keeping a copy.

**Decision:** Export the request adapter's cookie matching as a function. Given a cookie list (the `cookies` option's shape, or Playwright's `context.cookies()`) and a URL, it returns the `Cookie` header a browser would send, honouring domain, path, secure and expiry, or `null` when no cookie matches. The adapter's own jar applies the same rules. This is additive.

### `setCookies(cookies)`: cookies now, not as a step

**Requested by:** `feather-testing-elysia`. Its `logInAs` must take effect at the same moment in every client. Until now the browser applied cookies at once, but the request session only from its next queued step.

**Decision:** Add `await session.setCookies(cookies)` on both adapters. It applies the cookies immediately, outside the step queue. It is additive, and the queued `addCookies` stays as it is. On Playwright, the `cookies` option's own cookies are applied first, so later ones win where they overlap.

### `feather-testing-core/cookies`: cookie matching without happy-dom

**Requested by:** `feather-testing-elysia`. Its `api`/`logInAs` must work in projects without happy-dom.

**Decision:** Export `cookieHeaderFor` and the `CookieLike` and `SessionCookie` types from a new `/cookies` subpath, which imports no package at all, and from the root entry. The `/request` re-export stays. A test walks the import graph of both entries to keep it that way.

## Deferred

### B2 (rest). A per-driver Session type that rejects unsupported verbs at compile time

**Deferred** to an issue.

**Why:** It changes the public types of every adapter. Today the runtime errors already name the alternative.

### B3. Semantic scopes: `within({ role, text })`

**Deferred** to an issue.

**Why:** It is useful, but it is new API. With D1, the CSS form is now strict enough to stay correct in the meantime.

### B4. Step-event identity (ids on `onStep` events, nesting)

**Deferred** to an issue.

**Why:** No consumer needs it yet. Adding ids later is additive.

### `sensitive` on `assertValue`

**Not added.**

**Why:** Adding the option would be new public API. The secret-scrubbing work (issue #16, branch `secret-scrubbing`) remembers fields that the chain has marked sensitive, and that covers the case. Until it lands, see Known limitations in the README.
