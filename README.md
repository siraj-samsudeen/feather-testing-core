# feather-testing-core

A readable testing DSL that turns async test boilerplate into fluent, chainable steps.

Part of the [Feather Framework](https://github.com/siraj-samsudeen/feather-framework) ecosystem.

## The Core Idea

This DSL defines a universal vocabulary — `fillIn`, `clickButton`, `assertText`, and more — that can be backed by **any** test framework. Playwright, React Testing Library, and plain HTTP requests are the first three adapters. You write your tests once in a fluent, chainable style; the adapter handles the framework-specific details.

### Before / After — Playwright E2E

**Before (Vanilla Playwright):**
```ts
test("sign up", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Hello, Anonymous!")).toBeVisible();
  await page.getByText("Sign up instead").click();
  await page.getByLabel("Email").fill("e2e@example.com");
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign up" }).click();
  await expect(page.getByText("Hello! You are signed in.")).toBeVisible();
});
```

**After:**
```ts
test("sign up", async ({ session }) => {
  await session
    .visit("/")
    .assertText("Hello, Anonymous!")
    .click("Sign up instead")
    .fillIn("Email", "e2e@example.com")
    .fillIn("Password", "password123")
    .clickButton("Sign up")
    .assertText("Hello! You are signed in.");
});
```

### Before / After — React Testing Library

**Before (Vanilla RTL):**
```ts
test("form submission", async () => {
  render(<App />);
  const user = userEvent.setup();

  await user.type(screen.getByLabelText("Email"), "test@example.com");
  await user.type(screen.getByLabelText("Password"), "password123");
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  expect(await screen.findByText("Hello! You are signed in.")).toBeInTheDocument();
});
```

**After:**
```ts
test("form submission", async () => {
  render(<App />);
  const session = createSession();

  await session
    .fillIn("Email", "test@example.com")
    .fillIn("Password", "password123")
    .clickButton("Sign in")
    .assertText("Hello! You are signed in.");
});
```

### Before / After — Server-rendered app, no browser

**Before (`app.handle` + linkedom by hand):**
```ts
test("adds a todo", async () => {
  const home = parseHTML(await (await app.handle(new Request("http://localhost/"))).text());
  const form = home.document.querySelector("form.new-todo")!;
  const response = await app.handle(
    new Request(new URL(form.getAttribute("action")!, "http://localhost"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ title: "Read the guide on routing" }),
    }),
  );
  expect(response.status).toBe(303);
  const location = response.headers.get("location")!;
  const after = parseHTML(await (await app.handle(new Request(new URL(location, "http://localhost")))).text());
  expect(after.document.querySelector("ul.todo-list")!.children.length).toBe(1);
  expect(after.document.body.textContent).toContain("Read the guide on routing");
});
```

**After:**
```ts
import { createSession } from "feather-testing-core/request";

test("adds a todo", async () => {
  await createSession(app.handle)          // any (Request) => Promise<Response>
    .visit("/")
    .fillIn("What needs to be done?", "Read the guide on routing")
    .clickButton("Add")                    // POSTs the form, follows the 303, parses the new page
    .assertText("Read the guide on routing")
    .assertPath("/");
});
```

The "before" never looked at the form's fields, its method, or whether the label a user reads is the one on the input; the "after" does all three, the way the browser would. See [Request adapter](#request-adapter).

### Same DSL, Any Backend

Notice every example uses the **exact same methods** — `fillIn`, `clickButton`, `assertText`. The DSL is framework-agnostic. Playwright, React Testing Library, and HTTP requests are just the first three adapters. You can implement the `TestDriver` interface for any testing library and get the same fluent syntax.

Inspired by [Phoenix Test](https://hexdocs.pm/phoenix_test/PhoenixTest.html) — Elixir's pipe-chain testing DSL.

### One DSL, two drivers: Playwright and request

A chain written for the request adapter runs unchanged on the Playwright adapter, and the other way round, as long as the page needs no JavaScript. Both entry points take the native handle and the same options:

```ts
import { createSession } from "feather-testing-core/request";        // no browser
// import { createSession } from "feather-testing-core/playwright";  // a real browser

const session = createSession(app.handle /* or a Playwright page */, {
  baseUrl: "http://localhost:3000", // what visit() paths resolve against
  timeout: 4000,                    // budget for anything that waits; 0 = no limit
  onStep: (e) => console.log(e.status, e.name), // started / passed / failed, secrets hidden
  cookies: [{ name: "session", value: token }], // start signed in (optional)
});
```

`tests/contract/` runs one spec of DSL behaviour against both drivers (32 tests each, under `bun test` and vitest). [docs/ADAPTER_PARITY.md](docs/ADAPTER_PARITY.md) lists every surface and behaviour with its status. Here is what differs, and why:

| Behaviour | Playwright | Request | Why |
|-----------|------------|---------|-----|
| JavaScript, CSS, layout (`hover`, `dropFile`, keys other than Enter, `assertComputedStyle`, layout verbs, `javascript:` links) | Runs them | `BrowserOnlyVerbError` | No browser |
| Waiting | Assertions retry until `timeout`; page loads wait up to `navigationTimeout` | Nothing retries (responses arrive complete); only `until` uses `timeout` | Nothing changes on its own |
| Visibility | CSS decides (`display: none` is hidden) | Markup decides (`hidden`, `<template>`, ...) | No stylesheets |
| `debug()` | Saves a screenshot | Prints the HTML, password values hidden | |
| A 204/205 answer to a form | The browser stays, but Playwright 1.64's locators then hang | Stays on the page | Upstream Playwright |
| Name of a wrapping `<label>` with a `<select>` inside | Includes the option texts | Excludes them | Give such labels `for` |
| `target` on a form or link (another window or frame) | This page stays; the other window loads | `BrowserOnlyVerbError`, naming the destination to `visit()` | One page per session |
| Adapter-only options | `navigationTimeout`, `navigationStartWindow`, `replacedNavigationWindow`, the `@playwright/test` fixture | `close()` on the driver | |

## Installation

```bash
npm install feather-testing-core
```

> **Note:** This package is ESM-only (`"type": "module"`). It works with modern bundlers and test runners out of the box. If your project uses CommonJS `require()`, you'll need to update your config to support ESM imports.

All test framework dependencies are optional peers — install only what you use:

```bash
# For Playwright E2E tests with the Playwright Test runner
npm install @playwright/test

# For Playwright as a library under another runner (bun test, vitest, ...)
npm install playwright

# For React Testing Library integration tests
npm install @testing-library/react @testing-library/user-event

# For the request adapter (server-rendered apps, no browser)
npm install happy-dom
```

## Usage

### Playwright E2E

```ts
// e2e/fixtures.ts
import { test as featherTest } from "feather-testing-core/playwright";
export const test = featherTest;
export { expect } from "@playwright/test";
```

```ts
// e2e/auth.spec.ts
import { test } from "./fixtures";

test("full auth lifecycle", async ({ session }) => {
  // Sign up
  await session
    .visit("/")
    .assertText("Hello, Anonymous!")
    .click("Sign up instead")
    .fillIn("Email", "e2e@example.com")
    .fillIn("Password", "password123")
    .clickButton("Sign up")
    .assertText("Hello! You are signed in.");

  // Sign out
  await session
    .clickButton("Sign out")
    .assertText("Hello, Anonymous!");

  // Sign in
  await session
    .fillIn("Email", "e2e@example.com")
    .fillIn("Password", "password123")
    .clickButton("Sign in")
    .assertText("Hello! You are signed in.");
});
```

### Using with bun test

The Playwright adapter does not need the Playwright Test runner. Launch a browser with the `playwright` library, hand `createSession` a raw `Page`, and run the test with `bun test` (or any other runner). Only `playwright` has to be installed (`>=1.64.0`); `@playwright/test` is not needed.

Tested with Playwright 1.64.1, Bun 1.4.2, Node 24.12.0 and vitest 4.0.18.

Browser tests spend time launching Chromium and loading pages, so first raise bun's per-test limit (5000 ms by default) on the command line:

```sh
bun test --timeout 20000
```

Bun 1.4.2 ignores `timeout` under `[test]` in `bunfig.toml`; a test that sleeps 7 s still times out at 5000 ms with it, and passes with `--timeout 20000`. Put the flag in your `package.json` script (`"test": "bun test --timeout 20000"`), or pass a timeout to each test (`test(name, fn, 20_000)`). The fixtures engine passes one for you.

```ts
// todos.test.ts
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { createSession, StepError } from "feather-testing-core/playwright";
import { app } from "./app"; // e.g. an Elysia app

let browser: Browser;
let context: BrowserContext;
let page: Page;
let baseUrl: string;

beforeAll(async () => {
  browser = await chromium.launch(); // one browser for the file
});

afterAll(async () => {
  await browser.close();
});

beforeEach(async () => {
  app.listen(0); // the app on a free port, started in this process
  baseUrl = `http://localhost:${app.server!.port}`;
  context = await browser.newContext(); // fresh cookies and storage per test
  page = await context.newPage();
});

afterEach(async () => {
  await context.close();
  await app.stop();
});

test("adds a to-do", async () => {
  await createSession(page)
    .visit(`${baseUrl}/`)
    .fillIn("What needs to be done?", "Buy milk")
    .submit() // waits for the page that the POST redirects to
    .assertHas("li", { text: "Buy milk" });
});

test("a failing chain names the failed step", async () => {
  const chain = createSession(page).visit(`${baseUrl}/`).assertText("Nope");
  await expect(chain.run()).rejects.toThrow(StepError);
});
```

**`createSession(page, options?)`**

| Option | Default | What it does |
|--------|---------|--------------|
| `baseUrl` | The browser context's `baseURL` | What `visit()` paths resolve against, as `new URL(path, baseUrl)`, the same as the request adapter. |
| `timeout` | Inside `@playwright/test`: Playwright's own `expect.timeout` / `actionTimeout`. Elsewhere: `4000` ms | Budget for every assertion, wait and action in the session. A per-call `timeout` (e.g. `assertHas(sel, { timeout })`) still wins. `0` means no limit. |
| `navigationTimeout` | The page's navigation timeout (`setDefaultNavigationTimeout`, the runner's `navigationTimeout`, else 30 s) | Budget for page loads: `visit()`, `reload()`, and the new page after a submit or click that navigates. `0` means no limit. |
| `navigationStartWindow` | `500` ms | After an action signals it is leaving the page but before any request is seen: how long to wait for the navigation to start. Raise it if submits return too early on a slow CI machine. |
| `replacedNavigationWindow` | `250` ms | After a navigation of the page fails: how long to wait for a newer one that replaced it (a script setting `location`) before ending the wait. |
| `cookies` | none | Cookies the session starts with, e.g. a signed-in user's session cookie: `[{ name, value, domain?, path?, expires?, httpOnly?, secure?, sameSite? }]` (`expires` in seconds). Without `domain` a cookie is set for `baseUrl`'s host; `path` defaults to `/`; `secure` is kept as given. Added to the browser context before the first step, by domain and path (a domain without a leading dot is that host only, in both adapters). Both send a `secure` cookie over https, and to `localhost`/`127.0.0.1` over http, as Chromium does. The app's own cookies behave as usual afterwards. |
| (verb) `addCookies(cookies)` | — | Add cookies later in the chain (same shape as `cookies`), e.g. sign in after the first request. The step is named by the cookies' names only. Both adapters. |
| (method) `await session.setCookies(cookies)` | — | Add cookies now, not as a step: in effect for every step that runs afterwards, including steps already queued. Use it when the cookies must take effect at a known moment outside the chain (signing a user in across several clients at once); use `addCookies` for a point in a chain. Both adapters. |
| `onStep` | none | Called with `{ name, status: "started" \| "passed" \| "failed", error? }` for each step — a stand-in for `test.step()`, e.g. to log progress. A value typed into a password or secret-looking field shows as `••••••` in every event. |

**Timeouts.** The 4000 ms session default sits below bun's 5000 ms per-test default, so a failing assertion or action reports its chain (`>>> [FAILED] assertText('Nope')`) instead of a bare "test timed out". Keep the session `timeout` below bun's limit. Page loads keep Playwright's longer navigation timeout, so a dev server that is slow to answer its first request is not cut short. `timeout: 0` (or `navigationTimeout: 0`) removes the limit, leaving only bun's per-test limit, so a failure then shows as "test timed out" without the chain.

Outside the Playwright Test runner the session timeout also bounds actions (fillIn, click, ...), so `page.setDefaultTimeout()` does not apply to session steps — set `timeout` on the session instead.

**What the session puts in your page.** No window globals and no patched prototypes: its page state lives under one Symbol-keyed store (`window[Symbol.for("feather-testing-core")]`). The first action that may navigate installs listeners on `window`: `click` and `keydown` (capture), `submit`, `invalid` (capture) and `beforeunload`. They only record what happens; they never prevent or change it. A page script's own `requestSubmit()` is not watched.

**Waiting for the next page.** `submit()`, `click()`, `clickLink()`, `clickButton()` and `pressKey()` wait for the new document when the action starts a navigation of this page — such as a form POST answered with a redirect — so the next step never reads the page that was just left. When no navigation starts (a form handled by JavaScript, `method="dialog"`, a form or link aimed at another window or an iframe), they return at once. A 204/205 answer, a download or a failed request ends the wait; a navigation replaced by a newer one (a script setting `location`) waits for the newer page.

**`.rejects` needs `run()`.** `await session...` works everywhere. But bun's `expect(...).rejects` / `.resolves` accept only a real Promise, and a session chain is a thenable, so hand them `chain.run()`, which runs the queued steps and returns a real Promise.

**Step names.** There is no `test.step()` outside the Playwright Test runner. Failures still name the failed step in the `StepError` chain; pass `onStep` to see steps as they run.

### Fixtures: `async ({ session }) => …` under any runner

`feather-testing-core/fixtures` brings Playwright Test's fixture style to `bun test` and Vitest. A test destructures what it needs, and only that is set up. Fixtures are torn down in reverse order after the test, even when it fails.

**Before** (bun test, Playwright as a library):

```ts
let app: ReturnType<typeof makeApp>;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let baseUrl: string;

beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser.close(); });
beforeEach(async () => {
  app = makeApp().listen(0);
  baseUrl = `http://localhost:${app.server!.port}`;
  context = await browser.newContext();
  page = await context.newPage();
});
afterEach(async () => { await context.close(); await app.stop(); });

test("adds a to-do", async () => {
  await createSession(page, { baseUrl }).visit("/").fillIn("What needs to be done?", "Buy milk").submit();
});
```

**After:**

```ts
// test/fixtures.ts
import { afterAll, test as bunTest } from "bun:test";
import { defineCoreTest } from "feather-testing-core/fixtures";
import { makeApp } from "../src/app";

export const test = defineCoreTest({ test: bunTest, afterAll }).extend({
  baseUrl: async ({}, use) => {
    const app = makeApp().listen(0);
    await use(`http://localhost:${app.server!.port}`);
    await app.stop();
  },
  handler: [makeApp().handle, { value: true }], // a function used as a value
});

// test/todos.test.ts
test("adds a to-do", async ({ session }) => {
  await session.visit("/").fillIn("What needs to be done?", "Buy milk").submit().assertHas("li", { count: 1 });
});

test("the same, without a browser", async ({ request }) => {
  await request.visit("/").fillIn("What needs to be done?", "Buy milk").submit().assertHas("li", { count: 1 });
});
```

Core's fixtures:

| Fixture | Scope | What it is |
|---------|-------|------------|
| `browser` | file | Chromium (option `browserName`), launched the first time a test in the file needs it. `HEADED=1` (option `headed`): a visible browser with `slowMo` 700 and a per-test timeout of 120 s |
| `context` | test | A fresh browser context (cookies, storage). `RECORD=1` (option `record: "on"`): a video of every page in `test-results/videos` and a screenshot of the last page in `test-results/screenshots`; `record: "on-failure"` keeps them only for failed tests; option `outputDir` |
| `page` | test | A page in `context` |
| `session` | test | A Playwright-adapter session on `page`; needs a `baseUrl` fixture |
| `request` | test | A request-adapter session; needs a `handler` fixture. A test that asks only for `request` never loads or launches a browser |
| `rtl` | test | An RTL-adapter session on what is rendered (needs a DOM) |

**Defining your own.**
- A fixture is a plain value, a function `async (fixtures, use, info) => { …; await use(value); …teardown }`, or either with options: `[fn, { scope: "file" }]`, `[aFunction, { value: true }]`.
- Its dependencies are the names its first parameter destructures (or `{ deps: [...] }`).
- `.extend({...})` layers more fixtures on a test function, so other packages can build on core's.
- `.with({ browserName: "firefox" })` gives a file its own option values. `defineTest(runner, fixtures, { overrides })` does the same for every test.
- A file-scoped fixture is shared by the tests that see the same definitions of it and of what it depends on: changing `headed` with `.with()` gets its own browser, changing `record` does not.
- In minified code, name the fixtures explicitly: `test(name, ["session"], fn)`.
- Under Vitest, pass `currentSuite: getCurrentSuite` (from `"vitest/suite"`) with `test` and `afterAll`. Then the hook that tears down file-scoped fixtures is registered once per `describe`; otherwise it is registered once per test that uses one. bun:test has no such API.
- **Timeouts.** A test (setup and body) gets a 30 s budget unless you set one: `defineTest(runner, fixtures, { testTimeout })`, or 120 s when headed. Its fixtures then get a teardown allowance, `teardownTimeout` (10 s), shared by all of them. The runner is handed the sum plus 1 s of slack, so it never gives up while cleanup is running.
  - When the budget is spent, the engine abandons the test: nothing more is set up, the body never starts if it had not yet, and the fixtures are torn down in the exact reverse of the order they became ready.
  - A hung teardown, or a setup still running (test- or file-scoped), is waited for only within the allowance and reported. The rest still run, and a late setup is torn down once, when it finishes.
  - On a timeout, bun:test and Vitest fail the test but leave its body running, which is why the engine keeps its own clock.

### React Testing Library

```ts
import { createSession } from "feather-testing-core/rtl";

test("form submission", async () => {
  render(<App />);
  const session = createSession();

  await session
    .fillIn("Email", "test@example.com")
    .fillIn("Password", "password123")
    .clickButton("Sign in")
    .assertText("Hello! You are signed in.");
});
```

### Request adapter (no browser)

```ts
import { createSession } from "feather-testing-core/request";
import { app } from "../src/app"; // an Elysia app

test("signs in", async () => {
  await createSession(app.handle)
    .visit("/login")
    .fillIn("Email", "ada@example.com")
    .fillIn("Password", "hunter2")
    .clickButton("Sign in")
    .assertPath("/dashboard")
    .assertText("Signed in as ada@example.com");
});
```

See [Request adapter](#request-adapter) for what it does and does not do.

## API

Every method returns `this` for chaining. A single `await` at the start of the chain executes all steps sequentially.


**Per-step timeouts.** Every verb that waits takes a last `{ timeout }` argument: the assertions (`assertText`, `refuteText`, `assertValue`, `assertChecked`, `refuteChecked`, `assertSelected`, `assertOptions`, `assertPath`, `refutePath`, `assertHas`, ...) and the actions (`click`, `clickLink`, `clickButton`, `fillIn`, `selectOption`, `check`, `uncheck`, `choose`, `submit`, `pressKey`, `hover`, `attachFile`). The step's own timeout wins over the session's `timeout`, which wins over the adapter's default. The request adapter never waits, so it accepts and ignores a step timeout (only `until` uses one). The RTL adapter takes a session `timeout` in `createSession({ timeout })` for its Testing Library waits, and ignores a step's own.

```ts
await session.clickButton("Save").assertText("Saved", { timeout: 10_000 });
```

### Navigation

| Method | Description |
|--------|-------------|
| `visit(path)` | Navigate to URL (Playwright, request) |
| `reload()` | Reload the current document while preserving its full URL and browser state (Playwright, request) |

`reload()` waits for the browser's load event, like Playwright's native reload. Inside `within()`, it still reloads the whole page; the existing scope is a locator recipe rather than a retained element handle, so subsequent scoped steps resolve against the new document. RTL throws `BrowserOnlyVerbError` because JSDOM has no document-navigation lifecycle. The request adapter re-sends the request that produced the current page, a POST included, as a browser's reload resubmits.

### Interactions

| Method | Description |
|--------|-------------|
| `click(text)` | Find any element by text and click it |
| `clickLink(text)` | Click `<a>` by accessible name |
| `clickButton(text)` | Click `<button>` by accessible name |
| `fillIn(label, value, opts?)` | Fill input by label or placeholder. Secret values show as `'••••••'` in reports; `{ sensitive: true }` hides any other value (see [Secrets in failure reports](#secrets-in-failure-reports)) |
| `selectOption(label, option)` | Select dropdown option by label |
| `check(label)` / `uncheck(label)` | Toggle checkbox by label |
| `choose(label)` | Select radio button by label |
| `submit()` | Submit the most recently interacted form (see below) |
| `attachFile(label, path)` | Set a file input (found by label) to the file at `path` |
| `dropFile(selector, path)` | Dispatch a `DataTransfer` drop of the file onto a drop area |
| `pressKey(key)` | Press a key on the focused control — `'Enter'`, `'Escape'`, `'Control+A'` |
| `hover(text)` | Hover the element with this text |
| `scrollToHorizontalEnd(opts?)` | Scroll the current scope to its logical horizontal end (Playwright only) |

`upload(label, path)` is the former name of `attachFile` and still works, deprecated.

#### Interactions address controls **exactly**

Every interaction above names the control it wants, and that name is matched in full: `clickButton("Check")` clicks the button named *Check*, never the sidebar chip named *"Checklist Run — checklist"*. Whitespace is still normalized, so multi-line markup and padded labels keep working.

This matters because Playwright's bare-string matchers are case-insensitive *substring* matchers. Left as-is, a verb aimed at one control silently widens to any other control whose name merely contains the same text — and the run dies on a strict-mode violation that only appears when both are on screen at once, which turns a naming collision into an ordering-dependent flake. RTL matches whole strings by default, so with this both adapters answer the same question.

Assertions are the deliberate exception: `assertText` / `refuteText` / `assertHas` ask *"does this text appear"*, so they stay substring matches. An exact `refuteText("Check")` would pass while *Checklist Run* is plainly on the page. Use `within(selector, ...)` with `assertExactText(text)` when equality of an element's complete text is the contract.

To act on a control whose name is genuinely a prefix of another's, scope the lookup rather than loosening it:

```ts
await session.within("main", (s) => s.clickButton("Check"));
```

#### How `submit()` finds the submit button

`submit()` tracks the `<form>` element from the last `fillIn`, `selectOption`, `check`, `uncheck`, or `choose` call, then uses this strategy:

1. **By `type="submit"`** — looks for `<button type="submit">` or `<input type="submit">` (the DOM's ground truth)
2. **By accessible name** — looks for a `<button>` whose name contains "submit" (case-insensitive)
3. **Enter key fallback** — presses Enter on the last form field

If no form was previously interacted with, `submit()` throws an error.

#### File uploads

```ts
// Standard file input, found by its label
await session.attachFile("Avatar", "fixtures/avatar.png");

// Custom drop area (drag-and-drop upload zones)
await session.dropFile("#dropzone", "fixtures/report.pdf");
```

In Playwright, `dropFile` reads the real file and dispatches a `drop` event with a `DataTransfer`. In RTL (JSDOM has no filesystem), both verbs synthesize an empty `File` named after the path's basename — assert on the file name, not its contents.

#### Keys

`pressKey` names keys the Playwright way on both adapters: a single character types itself, a named key is `'Enter'` / `'Escape'` / `'ArrowDown'`, and modifiers combine with `+` (`'Control+A'`, `'Meta+Enter'`). The RTL adapter translates that to user-event's keyboard syntax, so one spec reads the same in both places. A prefix that is not `Control`, `Shift`, `Alt`, or `Meta` is rejected rather than typed as text.

### Assertions

| Method | Description |
|--------|-------------|
| `assertText(text)` / `refuteText(text)` | Assert text is visible / not visible |
| `assertExactText(text, opts?)` | Assert the current scope's complete text equals `text` |
| `assertAttribute(name, value?, opts?)` | Assert the current scope has an attribute, optionally with an exact value |
| `refuteAttribute(name, opts?)` | Assert the current scope does not have an attribute |
| `assertComputedStyle(property, value, opts?)` | Assert browser-computed CSS on the current scope (Playwright only) |
| `assertNoHorizontalOverflow(opts?)` | Assert the current scope fits horizontally (Playwright only) |
| `assertHorizontalOverflow(opts?)` | Assert content is wider than the current scope (Playwright only) |
| `assertHorizontallyContained(selector, opts?)` | Assert a descendant fits within the scope's horizontal bounds (Playwright only) |
| `assertValue(label, value)` | Assert a field (by label or placeholder) has this value |
| `assertChecked(label)` / `refuteChecked(label)` | Assert a checkbox is checked / not checked |
| `assertSelected(label, optionLabel)` | Assert the select's currently selected option |
| `assertOptions(label, [labels])` | Assert a select offers exactly these options, in order |
| `assertHas(selector, opts?)` / `refuteHas(...)` | Assert element exists (Playwright, request; see options below) |
| `assertPath(path, opts?)` / `refutePath(path)` | Assert URL path (Playwright, request; see options below) |
| `assertDownload(filename, trigger, opts?)` | Assert `trigger` starts a download with this filename (Playwright, request) |

#### Form-state assertions

```ts
await session
  .fillIn("Email", "a@b.com")
  .assertValue("Email", "a@b.com")
  .check("Subscribe")
  .assertChecked("Subscribe")
  .refuteChecked("Receive ads")
  .selectOption("Plan", "Pro")
  .assertSelected("Plan", "Pro")
  .assertOptions("Plan", ["Free", "Pro", "Enterprise"]);
```

In Playwright these are backed by `toHaveValue` / `toBeChecked` / `toHaveText`, so they auto-retry. The RTL adapter polls the DOM with `waitFor` for the same retry semantics.


#### Required fields and `assertSubmitBlocked(label)`

A submit (`clickButton`, `click`, `submit()`, `pressKey("Enter")`) that the browser refuses because a field is invalid fails loudly, naming the field: `form not sent: 'Title' is required`. Both adapters do this; on Playwright the adapter checks after the action that the form was not refused by constraint validation.

When the refusal is what the spec is about, say so with `assertSubmitBlocked(label)`. It submits the form the field belongs to, as Enter in that field would. It passes only if the form is not sent because that field is required and empty. It fails if the form is sent, or held back by another field. The RTL adapter does not model constraint validation and throws `BrowserOnlyVerbError`.

```ts
await session.visit("/todos/new").assertSubmitBlocked("Title").fillIn("Title", "Write tests").clickButton("Add");
```

#### Exact whole-element text

Scope to the element whose complete text matters, then use `assertExactText`:

```ts
await session.within(".total", (total) =>
  total.assertExactText("Total: 1", { timeout: 5000 }),
);
```

This is case-sensitive equality, not substring matching: `Total: 1` rejects both `Total: 10` and `Prefix Total: 1 suffix`. Like Playwright's text assertions and Testing Library's default normalizer, it trims leading/trailing whitespace and collapses internal whitespace runs before comparison. It retries until equality or the optional timeout. `assertHas(..., { exact: true })` retains its existing exact-substring behavior.

#### Attributes and computed style

Attribute assertions also operate on the current scope and retry until the optional timeout:

```ts
await session.within("html", (root) =>
  root
    .assertAttribute("data-palette", "ivory")
    .assertAttribute("data-ready")
    .refuteAttribute("data-loading")
    .assertComputedStyle("--color-brand", "#c15f3c"),
);
```

Omitting the value checks presence regardless of value. Passing `""` requires a present, empty-valued attribute; `refuteAttribute` requires the attribute to be missing. Attribute assertions work in both adapters. `assertComputedStyle` uses the browser's computed CSS value and is Playwright-only; RTL throws `BrowserOnlyVerbError` because JSDOM cannot prove stylesheet rendering.

#### Horizontal layout and inner scrolling

Layout assertions distinguish a page that leaks past the viewport from wider content contained inside an inner region:

```ts
await session
  .assertNoHorizontalOverflow()
  .within("[data-testid='columns-table']", (table) =>
    table.assertHorizontalOverflow().scrollToHorizontalEnd(),
  )
  .within("main", (main) =>
    main.assertHorizontallyContained("a.list-view"),
  );
```

The overflow assertions compare `scrollWidth` with `clientWidth`; they measure content dimensions, not whether CSS permits scrolling. This intentionally also detects clipped content under `overflow: hidden`. Containment requires exactly one matching descendant, then compares its bounding rectangle with the scope. Assertions retry while layout settles and report measured dimensions on failure. `opts.tolerance` defaults to 1 CSS pixel for rounding differences.

`scrollToHorizontalEnd()` separately proves scrollability: it detects LTR/RTL direction, temporarily overrides smooth scrolling with an instant operation, and retries until the actual absolute offset reaches `scrollWidth - clientWidth`. A range of 1 px or less is rejected as no meaningful movement. Unscoped operations measure the document root; scoped operations measure that element. All four operations are Playwright-only and throw `BrowserOnlyVerbError` in RTL because JSDOM has no layout engine.

#### Pair every refute with a positive assertion

`refuteText` / `refuteHas` assert *absence* — and absence also holds when the page failed to render at all. A blank page passes `refuteHas(".delete-button")`. Always pair a refute with a positive assertion on the same region so the test proves the page actually rendered:

```ts
// ❌ Passes even if the action bar never rendered
await session.refuteHas(".action-bar button", { text: "Delete" });

// ✅ The positive complement proves the action bar rendered with exactly [Import]
await session
  .assertHas(".action-bar button", { count: 1 })
  .assertHas(".action-bar button", { text: "Import" })
  .refuteHas(".action-bar button", { text: "Delete" });
```

#### `assertHas` / `refuteHas` options

| Option | Type | Description |
|--------|------|-------------|
| `text` | `string` | Filter elements to those containing this text |
| `count` | `number` | Assert exact number of matching elements |
| `exact` | `boolean` | When `true`, `text` matches as an exact substring. When `false` (default), matches as a regex |
| `timeout` | `number` | Custom timeout in milliseconds (overrides Playwright default) |

```ts
// Assert at least one .card element is visible
await session.assertHas(".card");

// Assert a .card containing specific text
await session.assertHas(".card", { text: "Overdue" });

// Assert exact count
await session.assertHas("li.todo-item", { count: 3 });

// Assert with custom timeout
await session.assertHas(".loaded", { timeout: 10000 });

// Refute: assert no matching elements exist
await session.refuteHas(".spinner");
await session.refuteHas(".card", { text: "Deleted Item" });
```

#### `assertPath` / `refutePath` options

The path is compared against the URL's parsed `pathname` exactly — `assertPath("/import")` does **not** pass on `/re/import`.

```ts
// Assert path (ignores query params)
await session.assertPath("/projects");

// Assert path with specific query params
await session.assertPath("/search", { queryParams: { q: "hello", page: "1" } });

// Refute: assert you are NOT on this path
await session.refutePath("/login");
```

#### Downloads

The wait has to be armed before the click that starts the download, so the triggering steps go in a callback — the same shape as `within()`:

```ts
await session
  .visit("/exports")
  .assertDownload("report.csv", (s) => s.clickButton("Export"))
  .assertText("Export complete");
```

`filename` is matched against the browser's suggested filename, exactly for a string or by `test()` for a `RegExp`. `opts.timeout` bounds the wait for the download to start. This is browser-only: the RTL adapter throws a `BrowserOnlyVerbError`, wrapped by the chain into a `StepError` that names the step.

### Waiting: `until(description, fn)`

| Method | Description |
|--------|-------------|
| `until(description, fn, opts?)` | Poll `fn` until it returns something truthy, then continue |

Tests wait for conditions, not for clocks. `until()` is the honest alternative to a sleep: it polls a predicate you write, and the **mandatory** description is what the trace prints, so a timeout names the thing you were waiting for instead of the mechanism you waited with.

```ts
await session
  .visit("/exports")
  .clickButton("Export")
  .until("the export job reports done", ({ page }) =>
    page.evaluate(() => window.__exportDone),
  )
  .assertText("Download ready");
```

The predicate receives the adapter context — `{ page, scope }` for Playwright, `{ user, container }` for RTL, `{ page, scope, fetch }` for the request adapter — and may be sync or async. `opts` takes `{ timeout, interval }` in ms; omit them to inherit the adapter's own budget (Playwright's `expect.poll`, RTL's `waitFor`).

When the budget runs out, the chain trace says what you were waiting for:

```
>>> [FAILED] until: the export job reports done
```

The description is required at the call site, before the chain runs — a blank one throws immediately, because a step named `until: ` teaches a reader nothing. The `feather-testing/no-wait-for-timeout` lint rule (see [Lint plugin](#lint-plugin)) points at this verb, so "no sleeps" stops being a review convention and becomes a check.

### Scoping

| Method | Description |
|--------|-------------|
| `within(selector, fn)` | Scope actions to a container element. The selector must match exactly one element; none or several fails the step, naming the count |

```ts
// All actions inside the callback are scoped to the matched element
await session
  .visit("/dashboard")
  .within(".sidebar", (s) =>
    s.clickLink("Settings").assertText("Preferences")
  )
  .assertText("Dashboard"); // back to full-page scope after within()
```

### Escape hatches: `step(name, fn)` and `raw(label, fn)`

When you need something the DSL doesn't cover, queue a named custom step instead of abandoning the chain. The callback receives the adapter's context — `{ page, scope }` for Playwright, `{ user, container }` for RTL, `{ page, scope, fetch }` for the request adapter — and the name shows up in `StepError` output like any built-in step:

```ts
await session
  .visit("/board")
  .step("drag card to Done column", async ({ page }) => {
    await page.getByText("My card").dragTo(page.locator("#done"));
  })
  .assertText("Done (1)");
```

`raw(label, fn)` goes one level lower: it hands over the driver itself — Playwright's `page`, RTL's scoped query object, the request adapter's current page (`{ document, response, url, body }`) — with no context wrapper. Use it when you want the native API and nothing else:

```ts
await session
  .visit("/board")
  .raw("stub the clipboard", (page) =>
    page.evaluate(() => navigator.clipboard.writeText("copied")),
  )
  .clickButton("Paste")
  .assertText("copied");
```

Both hatches take a **mandatory** label and register as named steps, so a failure inside one still names intent:

```
>>> [FAILED] raw('stub the clipboard')
```

That is the whole point of having them: an untraced raw tail ends the trace at the last DSL verb, and no hatch at all pushes teams to abandon the DSL mid-spec. In Playwright, `raw` always hands over the page, not the `within()` scope — re-scoping is the caller's job once you have left the DSL.

### Debug

| Method | Description |
|--------|-------------|
| `debug()` | Playwright: saves a full-page screenshot to `debug-{timestamp}.png` in the CWD. RTL: calls `screen.debug()` to log the current DOM to the console. Request: logs the current request, URL and status, and the scope's HTML, with password values hidden. |

## How It Works

The `Session` class uses a **thenable action-queue pattern**. Each method pushes an async operation onto an internal queue and returns `this`. The class implements `PromiseLike<void>`, so `await` triggers execution of the entire queue.

```
session.visit("/").fillIn("Name", "x").clickButton("Go")
       ↓              ↓                    ↓
    [push thunk]  [push thunk]        [push thunk]
                                           ↓
                                    await triggers
                                    sequential execution
```

This means you write one `await` per chain, not one per line.

### Breaking chains

If you need conditional logic mid-flow, break into multiple chains:

```ts
await session.visit("/").fillIn("Email", email);

if (isNewUser) {
  await session.click("Sign up instead").clickButton("Sign up");
} else {
  await session.clickButton("Sign in");
}
```

### Composable helpers

Functions that take and return a Session work as reusable steps:

```ts
function signIn(session: Session, email: string, password: string): Session {
  return session
    .fillIn("Email", email)
    .fillIn("Password", password)
    .clickButton("Sign in");
}

test("authenticated flow", async ({ session }) => {
  await signIn(session.visit("/"), "test@example.com", "pass123")
    .assertText("Welcome!");
});
```

## Error Messages

When a step fails, `StepError` shows the full chain with status markers:

```
feather-testing-core: Step 4 of 6 failed

Failed at: clickButton('Sign up')
Cause: locator.click: getByRole('button', { name: 'Sign up' }) resolved to 0 elements

Chain:
    [ok] visit('/')
    [ok] assertText('Hello, Anonymous!')
    [ok] fillIn('Email', 'e2e@example.com')
>>> [FAILED] clickButton('Sign up')
    [skipped] fillIn('Password', '••••••')
    [skipped] assertText('Hello! You are signed in.')
```

The session keeps a history of executed steps, so when you break a flow into multiple chains (multiple `await`s), the `StepError` still shows the full walk — steps from earlier chains appear as `[ok]` above the failing chain.

With the Playwright adapter, each queued step is also wrapped in `test.step()`, so chains appear as named steps in the trace viewer and HTML report.

### Secrets in failure reports

The chain prints the value each `fillIn` typed and each `assertValue` expected, because an ordinary value helps you debug. A secret value is shown as `'••••••'` instead — always six dots, so its length is hidden too. An empty value is always shown as `''`. A value counts as secret when:

| Rule | Example |
|------|---------|
| The label looks secret: it contains `password`, `passcode`, `secret`, `token` or `api key` (also `api_key`, `apikey`), or the whole word `pin` or `otp`, in any case | `fillIn('Password:', pw)` |
| You mark it sensitive | `fillIn('Recovery phrase', phrase, { sensitive: true })` |
| The field is a password field (`type="password"`), whatever its label | `fillIn('Login code', code)` |

The driver checks the field before the step starts. So the hidden form is used everywhere the step's name appears: the chain, `Failed at:`, `onStep` events and Playwright `test.step()` titles. Skipped steps and steps a `within()` callback left unrun are always shown with their values hidden. The real value is still typed; only what is printed changes.

When a `fillIn` on a secret field fails, the error keeps the first line of the driver's message (why: disabled, not found, timed out), with the value hidden. The whole message is withheld when it could hold the value:
- `assertValue`, whose message can quote the value found;
- Testing Library's key-syntax errors, which quote fragments.

The RTL and request adapters' `debug()` print password inputs' values as `'••••••'`.

Limits: see [Known limitations](#known-limitations). Secret values can still appear in other steps' error output, such as a Testing Library DOM dump or an error the app throws. Playwright's own trace and HTML report record every action with its arguments. Treat traces and reports from runs that type real credentials as secret.

A custom `TestDriver` takes part in the password rule by implementing the optional `fieldIsPassword(label)` (asked before the step; it may wait for the field, and throws if it never appears) and `lastFilledFieldIsPassword()` (asked after a `fillIn`, at once).

## RTL Adapter Limitations

The RTL adapter runs in JSDOM, which has no real browser. These methods are not available and will throw:

- `visit()` — render the component directly instead
- `assertPath()` / `refutePath()` — no URL in JSDOM
- `assertHas()` / `refuteHas()` — RTL discourages CSS selectors; use `assertText()` instead
- `assertDownload()` — JSDOM has no download machinery; it throws `BrowserOnlyVerbError` naming the verb and pointing at a Playwright spec

The verbs JSDOM *can* honestly do, it does: `attachFile` synthesizes a `File` from the path's basename, `pressKey` translates to user-event's keyboard syntax, `hover` fires real pointer events, and `raw` hands over the scoped query object.

### Extending the RTL adapter

`RTLDriver` is meant to be subclassed when an app's markup needs a different lookup, so that a host harness binds *this* DSL rather than reimplementing it. Everything worth specializing is `protected`:

| Member | Why you'd override it |
|--------|----------------------|
| `findField(label)` | The single label-addressed lookup. Every labelled verb — `fillIn`, `selectOption`, `check`, `uncheck`, `upload`, `assertValue`, `assertChecked`, `assertSelected`, `assertOptions` — goes through it, so one override retargets them all |
| `scoped(element)` | Factory used by `within()`, so a scoped session keeps your driver's behaviour |
| `user`, `root`, `container`, `lastFormElement`, `lastFilledField`, `timeout` | Shared state the built-in verbs read and write |

```ts
class WrapperLabelDriver extends RTLDriver {
  // Labels with no htmlFor, control is a sibling inside a wrapper div
  protected override async findField(label: string): Promise<HTMLElement> {
    for (const l of this.rootElement().querySelectorAll("label")) {
      if (l.textContent?.trim() !== label) continue;
      const control = l.parentElement?.querySelector("input, textarea, select");
      if (control) return control as HTMLElement;
    }
    throw new Error(`no field labelled '${label}'`);
  }

  protected override scoped(element: HTMLElement) {
    return new WrapperLabelDriver(this.user, element, this.timeout);
  }
}
```

The third constructor argument is a per-lookup timeout in ms; omit it to keep RTL's own default.

## Request adapter

`feather-testing-core/request` drives a server-rendered app through its request handler, with no browser — the equivalent of [Phoenix Test](https://hexdocs.pm/phoenix_test/PhoenixTest.html)'s static driver. Links are followed and forms submitted the way a browser does without JavaScript, every response is parsed, and the same chain that drives Playwright runs in-process in milliseconds. Coverage and mutation testing see the server code cheaply; keep the browser for behaviour that needs JavaScript.

### The handler contract

```ts
createSession(handler, { baseUrl?, timeout?, onStep?, cookies? })
```

- `handler` is any `(request: Request) => Response | Promise<Response>`: Elysia's `app.handle`, Hono's `app.fetch`, or `fetch` itself pointed at a running server. Pass a function that keeps its `this` (both of those are already bound). The adapter has no framework dependency.
- `baseUrl` is what `visit()` paths resolve against — an origin, optionally with a base path (`"http://localhost/app/"`). It defaults to `http://localhost`. Every request carries a full URL on that origin.
- `cookies` starts the session with cookies in its jar (a signed-in session cookie, say), as in the Playwright adapter: without `domain` a cookie is host-only for `baseUrl`'s host, `path` defaults to `/`, `expires` is in seconds.
- `timeout` is the budget of `until()`, the one verb that waits here (default 4000 ms, `0` = no limit), and `onStep` reports each step as it starts, passes or fails, as in the Playwright adapter.
- Each request is sent with `redirect: "manual"`; the adapter follows redirects itself.

### What it does, as a browser would

| Behaviour | How |
|-----------|-----|
| Form submission | Per the HTML spec: `method` and `action` (relative to the page or its `<base href>`; missing or empty means the current URL), the submitter's `formaction` / `formmethod` / `formenctype`, successful controls only (named, not disabled, not in a disabled `<fieldset>` outside its first `<legend>`, not in a `<datalist>`), in tree order, including controls outside the form with `form="id"`. Defaults come from the markup; checkboxes and radios send `value` or `"on"` when checked; `<select>` sends every selected option (multiple too); `<textarea>` newlines go out as CRLF; `_charset_` hidden inputs send `UTF-8`; only the clicked submit button's `name`/`value` is sent |
| Encodings | `application/x-www-form-urlencoded`, `multipart/form-data` (files from `attachFile`, with name and a type from the extension; an empty file input sends an empty, nameless file), and `text/plain`. A GET form replaces the action's query string. `method="dialog"` closes its `<dialog>` and sends nothing |
| Validation | A form with an empty `required` control is not sent — the step fails saying which — unless the form has `novalidate` or the submitter `formnovalidate`. Other constraints (`pattern`, `min`, `type="email"`, …) are not checked: the server's validation is what a request test is for |
| Buttons | A submit button submits its form, a reset button restores the defaults. A link styled as a button (`<a role="button" href>`) is followed. A `type="button"` button, any other `role="button"` element, or a button outside any form does nothing without JavaScript, so it throws `BrowserOnlyVerbError` |
| `submit()` / `pressKey("Enter")` | `submit()` uses the same order as the Playwright adapter (explicit `type="submit"`, a button named like "submit", then Enter). Enter is [implicit submission](https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#implicit-submission): the form's first submit button, or with none, the form itself when it has at most one text field. In a `<textarea>` Enter types a newline |
| Links | `clickLink` follows `href` (resolved against `<base href>`); a link to the same page with a `#fragment` only changes the URL. `click(text)` follows a link, presses a button, or activates a label's control (toggling a checkbox, picking a radio), whichever the text belongs to |
| Redirects | 301/302 turn a POST into a GET, 303 turns anything but HEAD into a GET, 307/308 resend the method and body. At most 20 hops |
| Cookies | Kept across requests and redirect hops: host-only and `Domain` cookies, `Path`, `Max-Age` / `Expires` (including deletion), `Secure` (sent over https and to localhost). No public-suffix list |
| Headers | `Accept: text/html,…`, `Cookie`, and `Origin` on every non-GET request, as browsers send for CSRF checks |
| Responses | Any status is shown as a page (a 422 validation page, a 404), except 204 and 205, which leave the session on its page as a browser does. A non-HTML body is shown as text, as a browser shows JSON. A `Content-Disposition: attachment` response, or any response to an `<a download>` link, is a download: the session stays on its page and `assertDownload` sees the suggested filename |
| Current URL | Tracked through redirects for `assertPath` / `refutePath` / `reload` |

Addressing follows the other adapters: interactions match a label, placeholder, or accessible name **exactly** (whitespace-normalized, case-sensitive), and more than one match is an error naming the count — scope with `within()`. Labels are `<label for>`, a wrapping `<label>` (which labels only its first labelable descendant), `aria-labelledby`, and `aria-label`, then the placeholder. A wrapping label is named without the text of controls nested in it (`<select>`, `<textarea>`, `<button>`, `<output>`, `<meter>`, `<progress>`), as Testing Library names it; Playwright keeps that text, so on Playwright `<label>Plan <select>…</select></label>` is called "Plan Free Pro" — give such a label `for` when one spec must run on both. `fillIn` refuses a value the field cannot hold (`"abc"` in a number input, a malformed date) instead of letting it be sent empty, as Playwright's `fill()` does. Text assertions match a case-insensitive substring of the rendered text, like Playwright's `getByText`. "Rendered" is judged from markup alone: `<head>`, `<script>`, `<style>`, `<template>`, `<noscript>`, `hidden` subtrees and hidden inputs are not page text; there is no CSS, so `display: none` is not seen. `assertHas` needs a rendered match (any of them, as on Playwright); its `count`, and `refuteHas`, count every match, as Playwright's `toHaveCount` does. A `within()` scope is a selector recipe, re-resolved against the current page at every step, so it keeps working after a navigation inside it. It must match exactly one element, as in the Playwright adapter: scope with a selector that names one container. Focus is part of the session, so `pressKey("Enter")` after a `fillIn` inside `within()` submits that field's form, as in a browser.

### Waiting

Responses arrive complete, so no verb waits or retries: each looks at the current page once, and the `timeout` options assertions accept are ignored. `until(description, fn, opts)` still polls, because the server's state can change: between checks, a page that came from a GET is fetched again; a page that came from a POST is not re-sent, and the predicate is just evaluated again (it can call the context's `fetch` itself). The budget is the session `timeout` (default 4000 ms, `0` for no limit) unless the call sets one, and the interval defaults to 100 ms.

The step and `until` context is `{ page, scope, fetch }`: the current page as `raw()` gets it, the scope element, and a `fetch(url, init?)` that sends a request with the session's cookies without navigating, as the page's own script would. Unlike a browser's `fetch`, it does not follow redirects: a 3xx comes back as it is, so you can assert on it.

### Cleaning up

Each page is parsed in its own happy-dom window, closed when the next page replaces it. The last one is closed when the session is garbage-collected, so dropping a session is enough; call `await driver.close()` on a `RequestDriver` you hold to release it at once.

### The parser: happy-dom

Pages are parsed with [happy-dom](https://github.com/capricorn86/happy-dom), an optional peer dependency like the other adapters' frameworks. JavaScript, stylesheets, iframes and navigation are all switched off; it is only a parser and a DOM. It was chosen over linkedom after checking what the verbs need:

| Needed for | happy-dom | linkedom |
|-----------|-----------|----------|
| Label → control (`label.control`, `input.labels`) | yes | no |
| A field's live value apart from its `value` attribute | yes | no (setting `value` rewrites the attribute) |
| `checked`, `selectedOptions`, a select's default selection | yes | no |
| `form` owner, `form="id"` association | yes | no |
| `closest`, CSS selectors, `:scope` | yes | yes |

linkedom would have meant reimplementing form-control state by hand; happy-dom has it, works under Bun and Node, and is what Bun's own docs use for DOM tests. The adapter types the document as the standard DOM `Document`, so nothing in your tests depends on the parser.

### Browser-only verbs

These throw `BrowserOnlyVerbError`, which the chain reports as the failed step, with a hint naming what to do instead:

| Verb | Why | Instead |
|------|-----|---------|
| `hover(text)` | Hover only changes a page through CSS or JavaScript | A Playwright spec |
| `dropFile(selector, path)` | A drop zone is JavaScript | `attachFile` on its file input, or a Playwright spec |
| `pressKey(key)`, any key but `Enter` | Only Enter does anything without JavaScript | `fillIn` for text; a Playwright spec for key handling |
| `assertComputedStyle(...)` | No stylesheets are applied | Assert the class or attribute that selects the style, or a Playwright spec |
| `assertNoHorizontalOverflow` / `assertHorizontalOverflow` / `assertHorizontallyContained` / `scrollToHorizontalEnd` | Nothing is laid out | A Playwright spec |
| `clickButton` / `click` on a `type="button"` button, a `role="button"` element that is not a link, or a button outside any form | It does nothing without JavaScript | A Playwright spec |
| `clickLink` on a `javascript:` URL, `click` on text that is no link, button or label | Same | A Playwright spec |
| A link or form aimed at another window or frame (`target`, `formtarget` or `<base target>` other than `_self`, `_top`, `_parent`; a `download` link still downloads) | The session has one page | `visit()` the destination, or a Playwright spec |

Every other verb is implemented, `assertDownload` included (see Responses above).

### Extending the request adapter

`RequestDriver` is meant to be subclassed the same way as `RTLDriver`. `findField(label, verb)` is the single label-addressed lookup every labelled verb goes through; `scoped(selectors)` is the factory `within()` uses; `browser` (the shared tab: current page, cookies, focus, attached files, downloads), `scopeSelectors`, `lastForm` and `lastFilledField` are the state the verbs share.

```ts
class WrapperLabelDriver extends RequestDriver {
  protected override findField(label: string, verb: string): Element {
    for (const l of this.queryRoot().querySelectorAll(".field > .label")) {
      if (l.textContent?.trim() !== label) continue;
      const control = l.parentElement?.querySelector("input, textarea, select");
      if (control) return control;
    }
    return super.findField(label, verb);
  }

  protected override scoped(selectors: readonly string[]) {
    return new WrapperLabelDriver(this.browser, this.options, selectors);
  }
}

const session = new Session(new WrapperLabelDriver(app.handle));
```

## Exports

```ts
// Core (Session class + types)
import {
  Session,
  StepError,
  BrowserOnlyVerbError,
  type TestDriver,
} from "feather-testing-core";

// Playwright adapter (createSession(page, { timeout?, onStep? }) works under any runner;
// test and expect are for @playwright/test users)
import { test, createSession, expect } from "feather-testing-core/playwright";

// RTL adapter
import { createSession } from "feather-testing-core/rtl";

// Request adapter (no browser); cookieHeaderFor(cookies, url) builds a Cookie header by the same rules
import { createSession, RequestDriver, cookieHeaderFor } from "feather-testing-core/request";

// Fixtures for bun:test and Vitest (see Fixtures)
import { defineCoreTest, defineTest } from "feather-testing-core/fixtures";

// Cookie matching without any adapter (no browser, no happy-dom); also from the root
import { cookieHeaderFor, type CookieLike, type SessionCookie } from "feather-testing-core/cookies";

// ESLint plugin (see below)
import featherTesting from "feather-testing-core/eslint-plugin";
```

Every adapter subpath also re-exports `Session` and `StepError`, so you can import everything from a single path:

```ts
import { test, Session, StepError } from "feather-testing-core/playwright";
import { createSession, Session, StepError } from "feather-testing-core/rtl";
import { createSession, Session, StepError } from "feather-testing-core/request";
```

## Lint plugin

The DSL can only offer good habits; a linter can insist on them. This package ships an ESLint plugin whose rules are the defect classes a real suite audit found by expensive reading — each one now a check that runs in a second, with a message that names the fix so whoever hits it (person or agent) learns the alternative from the error alone.

```js
// eslint.config.js — flat config
import featherTesting from "feather-testing-core/eslint-plugin";

export default [
  {
    files: ["tests/**/*.ts", "e2e/**/*.spec.ts"],
    ...featherTesting.configs.recommended,
  },
];
```

Or wire the rules yourself:

```js
import featherTesting from "feather-testing-core/eslint-plugin";

export default [
  {
    files: ["tests/**/*.ts"],
    plugins: { "feather-testing": featherTesting },
    rules: {
      "feather-testing/no-weak-assertions": ["error", { matchers: ["toBeTruthy", "toBeDefined", "toBeFalsy"] }],
    },
  },
];
```

| Rule | Catches | Points at |
|------|---------|-----------|
| `no-wait-for-timeout` | `page.waitForTimeout(...)`, and the `new Promise(r => setTimeout(r, n))` sleep idiom | `session.until(description, fn)`, `expect.poll`, web-first assertions |
| `no-conditional-skip` | `test.skip(cond)`, `test.skip()`, `this.skip()` — a spec that un-tests itself at runtime | making the precondition part of the test, or `test.fixme` so the report names it |
| `no-weak-assertions` | `expect(x).toBeTruthy()` / `.toBeDefined()` (configurable) | asserting the shape you mean |
| `no-swallowed-cleanup-catch` | `.catch(() => {})` and empty `catch {}` blocks | asserting on the error, rethrowing with context, or annotating the deliberate ignore |
| `warn-serial-mode` | `test.describe.serial(...)`, `configure({ mode: "serial" })` — warning, not error | independent tests, or an `eslint-disable` line saying why serial is required |

Deliberate exceptions stay possible and stay visible: an `eslint-disable-next-line` comment with a reason is exactly the annotation these rules are trying to force.

**Why these five.** They are not style preferences. Each one is a way a suite goes green while proving nothing: a sleep passes on a slow machine and fails on a fast one, a conditional skip silently un-tests a spec for its entire life, `toBeTruthy()` accepts almost any value, a swallowed cleanup error surfaces three tests later as something else, and serial mode turns one failure into a wall of red that hides its own cause. `session.until()` exists so the first rule has an honest alternative to point at — see [the document set](docs/document-set.md) for why conventions belong in executable form rather than in a style guide nobody re-reads.

## Known limitations

- Secret values can still appear in some error output (e.g. Testing Library DOM dumps, app-thrown errors) — tracked in an issue; don't run 0.7.0-beta against real credentials.

## Upgrading to 0.7.0 (beta: 0.7.0-beta.1)

0.7.0 is in beta. Install it with `npm install feather-testing-core@0.7.0-beta.1`; see [Known limitations](#known-limitations) first.

- **Breaking (Playwright adapter):** a submit the browser refuses because a field is invalid (an empty `required` field above all) now fails the step: `form not sent: 'Title' is required`. It used to pass silently. Where the refusal is the point of the spec, use the new `assertSubmitBlocked(label)`.
- New: every waiting verb takes `{ timeout }` (step > session > adapter default); `createSession({ timeout })` on the RTL adapter.
- **More lenient (Playwright adapter):** `assertHas(selector)` passes when any matching element is visible; it used to need the first match to be visible. `count` and `refuteHas` still count every match, visible or not.
- **Breaking (Playwright adapter):** `within(selector)` must match exactly one element, as in the request adapter. A selector matching none or several now fails the `within()` step, naming the count. Fix: narrow the selector (an id, a class, a data attribute), or use `:first-of-type` if the first one is really meant.
- The optional peer dependency is now `playwright` (`>=1.64.0`, the version tested) instead of `@playwright/test` (`>=1.40.0`). `@playwright/test` installs `playwright`, so Playwright Test users on 1.64 or later change nothing; library users no longer need `@playwright/test`.
- Without the `navigationTimeout` option, `visit()` and `reload()` simply use Playwright's own default (`setDefaultNavigationTimeout`, or the runner's `navigationTimeout`). Only the wait for the new page after a submit has no Playwright call to inherit it from: it reads the page's default from a private Playwright field (there is no public getter). The test suite pins that field, so a Playwright rename fails CI instead of silently becoming 30 s. Set `navigationTimeout` explicitly to avoid relying on it.
- Projects on Playwright below 1.64 get a peer-dependency warning, or an install error with strict npm (`strict-peer-deps`) or pnpm (`strict-peer-dependencies`) settings, until they upgrade Playwright.
- pnpm with `auto-install-peers=false`, and Yarn Plug'n'Play: add `playwright` to your own `devDependencies`, so the adapter can resolve `playwright/test`.
- `submit()`, `click()`, `clickLink()`, `clickButton()` and `pressKey()` wait for the new page after starting a navigation of this page.
- Outside the Playwright Test runner, assertions and actions default to a 4000 ms budget (`createSession(page, { timeout })` to change it). Inside the runner the configured Playwright timeouts apply, as before. Page loads (`visit()`, `reload()`, the page after a submit) keep Playwright's navigation timeout (30 s), as in 0.6; change it with `navigationTimeout`.
- `fillIn()` waits for its field before the step starts, to hide a password field's value from step titles and `onStep`. A field that never appears fails the step with its value hidden.
- `within()` and `assertDownload()` fail, naming the steps, when their callback queues steps without returning or awaiting them (`async s => { s.assertText(...); }`). Those steps used to be dropped silently. Callbacks that return the chain or await it are unaffected.
- New: `createSession(page, { baseUrl, timeout, navigationTimeout, navigationStartWindow, replacedNavigationWindow, onStep })`, `session.run()`. The request adapter takes `{ baseUrl, timeout, onStep }` and the RTL adapter `{ onStep }`. The shared `SessionOptions` type, `StepEvent` and `DEFAULT_TIMEOUT` are exported from every entry point.
- Playwright `fillIn()` on a label that matches several fields fails at once with "N fields are labelled '…'", and hides the value, as the request adapter does.

## Upgrading to 0.5.0

Version 0.5.0 extends the required `TestDriver` interface. Custom drivers must implement these new methods before upgrading:

- `reload()`
- `assertExactText(text, opts?)`
- `assertAttribute(name, value?, opts?)` / `refuteAttribute(name, opts?)`
- `assertComputedStyle(property, value, opts?)`
- `assertNoHorizontalOverflow(opts?)` / `assertHorizontalOverflow(opts?)`
- `assertHorizontallyContained(selector, opts?)`
- `scrollToHorizontalEnd(opts?)`

Implement capabilities the adapter can prove, but do not fake browser behavior or silently no-op. For operations the environment cannot support—commonly reload, computed CSS, layout geometry, and scrolling in non-browser adapters—reject with `BrowserOnlyVerbError`, naming the verb and directing the caller to a browser-backed spec. The built-in RTL adapter follows this pattern for JSDOM limitations, and the request adapter for what needs a browser; `new BrowserOnlyVerbError(verb, alternative, environment?)` takes an optional third argument naming what your adapter runs on instead (default `"JSDOM"`).

## Releasing

Releases are manual and publish exactly the version committed to `main`:

1. Run `npm version <version> --no-git-tag-version` so `package.json` and `package-lock.json` contain the intended new version.
2. Run `npm run lint`, `npm run test:all` and `npm run test:bun`, then commit and merge the version change to `main`.
3. In GitHub Actions, open **Publish to npm**, choose **Run workflow**, select `main`, and run it.

The workflow refuses non-`main` refs, mismatched lockfile versions, versions already present on npm, and registry lookup failures. It never changes or commits a version. Ordinary pushes and merges do not run it.

## Documentation

- [Decisions for 0.7](docs/DECISIONS-0.7.md) — the design decisions taken for 0.7 (and what was deferred), with their reasoning.
- [Adapter parity](docs/ADAPTER_PARITY.md) — every surface of the Playwright, request and RTL adapters, and where they differ.
- [The document set](docs/document-set.md) — the minimal set of documents a project needs, what each one answers, and why hand-maintained cross-reference matrices lose to generated reports plus CI checks.

## License

MIT
