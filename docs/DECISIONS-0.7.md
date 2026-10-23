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
- A function supplied as a fixture value is wrapped in `value(fn)` (or `[fn, { value: true }]`), in a definition and in `.with()` alike. An array is read as `[fn, options]` only when its first item is a function and its second a plain object with only option keys; `value(x)` covers any value that would be ambiguous (decided after Codex round 13).

### `addCookies(cookies)`, `SessionCookie` everywhere, and test bodies with no parameter

**Requested by:** `feather-testing-elysia`.

**Decision:** All three are additive.
- `session.addCookies(cookies)`, on both adapters, adds cookies at any point in a chain. Its shape is the same as the `cookies` option. The step is named by the cookies' names, never their values. This lifts the elysia package's "logInAs only before the first request step" limit.
- `SessionCookie` is exported from every entry point.
- In the fixture engine, a test body with no parameter (`async () => …`) uses no fixtures. Only a non-destructured parameter or a rest pattern fails with the explicit-list hint.

### `cookieHeaderFor(cookies, url)` from `/request`

**Requested by:** `feather-testing-elysia`, whose Eden client then reuses it instead of keeping a copy.

**Decision:** Export the request adapter's cookie matching as a function. Given a cookie list (the `cookies` option's shape, or Playwright's `context.cookies()`) and a URL, it returns the `Cookie` header a browser would send, honouring domain, path, secure and expiry, or `null` when no cookie matches. The adapter's own jar applies the same rules. This is additive.

### `addCookiesNow(cookies)`: cookies now, not as a step

**Requested by:** `feather-testing-elysia`. Its `logInAs` must take effect at the same moment in every client. Until now the browser applied cookies at once, but the request session only from its next queued step.

**Decision:** Add `await session.addCookiesNow(cookies)` on both adapters (named `setCookies` at first, renamed by the author: `addCookies` is the step in the chain, `addCookiesNow` applies at once, even to steps already queued). It applies the cookies immediately, outside the step queue. It is additive, and the queued `addCookies` stays as it is. On Playwright, the `cookies` option's own cookies are applied first, so later ones win where they overlap.

### `feather-testing-core/cookies`: cookie matching without happy-dom

**Requested by:** `feather-testing-elysia`. Its `api`/`logInAs` must work in projects without happy-dom.

**Decision:** Export `cookieHeaderFor` and the `CookieLike` and `SessionCookie` types from a new `/cookies` subpath, which imports no package at all, and from the root entry. The `/request` re-export stays. A test walks the import graph of both entries to keep it that way.

### From the PR #17 review (Fable)

- **Nothing of ours in the app's page.** The Playwright adapter keeps its page state under one Symbol-keyed store. It patches no prototypes and installs five listeners on `window` that only record. A refused submit is recognised from the `invalid` events of a submit attempt seen through `click` and `keydown`; a page script's own `requestSubmit()` is not watched.
- **Public navigation defaults first.** Without `navigationTimeout`, `visit()` and `reload()` pass no timeout, so Playwright's default applies. Only the post-submit wait reads the page default from a private field. A test pins that field's shape, so a rename fails CI instead of silently becoming 30 s.
- **One teardown hook where it is needed.** Only tests that use a file-scoped fixture register a hook, and only once per suite when the runner names the suite (`currentSuite`, e.g. Vitest's `getCurrentSuite`).
- **`fillIn` and `assertValue` never forward a driver's message**, on any path (lookup failures included) and whether or not the field is secret. Decided after Codex rounds 13 and 15: a normalized copy of a value escapes exact hiding, and a lookup failure can dump the page with every value in it. Their errors are built from the session's own facts: the step, the label, the match count, and a `debug()` hint. For a field that is not secret they also give its state, which the session reads through the driver's optional `fieldState(label)` and words itself: the value found for `assertValue`, and disabled / read-only / not visible / not a text field for `fillIn` (Fable review of 00496b2). The driver's message and error are still never forwarded or attached as `cause`. `fieldState` decides secrecy on the element it reads, in the same read, and returns only `{ secret: true }` for a password field; the session shows a value only when it got `secret: false`, and hides the step when the field turned secret during the wait (Codex round 16). The RTL driver reads the element its own, overridable `findField()` resolved for the step.
- **`fillIn` and `assertValue` never show their value in a step name** (Codex round 17). A field can turn secret after the pre-step check, and the `started` event and `test.step()` title go out before the action; Playwright's `fill()` and `toHaveValue()` resolve the field themselves, so no later check can be sure it read the element used. So the value is always `'••••••'` (`''` when empty), secret or not, and the failure message says "found 'Bob'" without repeating the expected value. Readability gives way to never leaking. Richer secret diagnostics belong to issue #16.
- **What 0.7 guarantees about secrets** (after Codex round 18). *Protected:* feather's own outputs never show a `fillIn`/`assertValue` value (step names, the chain, `onStep` events, `test.step()` titles), and a secret field's value never appears in a `fillIn`/`assertValue` error. *Not yet protected ([issue #16](https://github.com/siraj-samsudeen/feather-testing-core/issues/16)):* errors from other verbs can include driver text, such as Testing Library DOM dumps with input `value` attributes; Playwright's own trace and HTML report record `fill()`/`expect` values. If you record traces or reports, don't use real credentials in tests — good practice anyway. The README's secrets section says the same.
- **One field wait.** `fillIn` and `assertValue` wait for their field the same way, within an assertion budget.
- **Fixture details.**
  - `.with()` refuses unknown names and treats functions like a definition does.
  - `[value, options]` is recognised only by its option keys.
  - The explicit-list hint is copy-pasteable.
  - `session` needs no `baseUrl` fixture when the context has a `baseURL`.

### Consumer-supplied core fixtures have runtime definitions

**Decision:** `handler` (and `baseUrl`, which defaults to none) are defined by core, so `defineCoreTest(runner).with({ handler: value(app.handle) })` works. Used without being supplied, `handler` fails with how to supply it. This was decided after Codex round 13.

### `session.discard()`

**Requested by:** `feather-testing-elysia`. It refuses steps started during `logInAs` and used to clear the private `Session.steps` to drop them.

**Decision:** Add a public `discard()` that drops queued steps that have not started and returns how many were dropped. A running chain is untouched. It works on every adapter's sessions and on scoped sessions. It is additive.

### Playwright peer range: `>=1.51.0`

**Decided by:** the coordinator, for the author, who may veto.

**Decision:** The floor is raised from 1.40.0 to 1.51.0, because `assertHas` needs `locator.filter({ visible })`. The range stays broad, as the author chose, instead of being pinned to the tested version. It is tested on 1.64.1.

The earlier history:
1. The floor was `>=1.64.0`, the version tested.
2. The author widened it to `>=1.40.0`.
3. A check then found that 1.51 is the lowest version the code works with.

`MIN_PLAYWRIGHT_VERSION` in the Playwright driver records that minimum and why. A unit test fails if the package.json floor drops below it.

### Navigation wait options renamed to `…Timeout`

**Decided by:** the author.

**Decision:** The Playwright session options `navigationStartWindow` and `replacedNavigationWindow` are now `navigationStartTimeout` and `replacedNavigationTimeout`, with the same defaults (500 ms and 250 ms). The exported defaults are now `NAVIGATION_START_TIMEOUT_MS` and `REPLACED_NAVIGATION_TIMEOUT_MS`. There are no aliases, since 0.7 is an unreleased beta. `feather-testing-elysia` does not use them.

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
