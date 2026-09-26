# feather-testing-core

A readable testing DSL that turns async test boilerplate into fluent, chainable steps.

Part of the [Feather Framework](https://github.com/siraj-samsudeen/feather-framework) ecosystem.

## The Core Idea

This DSL defines a universal vocabulary — `fillIn`, `clickButton`, `assertText`, and more — that can be backed by **any** test framework. Playwright and React Testing Library are just the first two adapters. You write your tests once in a fluent, chainable style; the adapter handles the framework-specific details.

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

### Same DSL, Any Backend

Notice both examples use the **exact same methods** — `fillIn`, `clickButton`, `assertText`. The DSL is framework-agnostic. Playwright and React Testing Library are just the first two adapters. You can implement the `TestDriver` interface for any testing library and get the same fluent syntax.

Inspired by [Phoenix Test](https://hexdocs.pm/phoenix_test/PhoenixTest.html) — Elixir's pipe-chain testing DSL.

## Installation

```bash
npm install feather-testing-core
```

> **Note:** This package is ESM-only (`"type": "module"`). It works with modern bundlers and test runners out of the box. If your project uses CommonJS `require()`, you'll need to update your config to support ESM imports.

All test framework dependencies are optional peers — install only what you use:

```bash
# For Playwright E2E tests
npm install @playwright/test

# For React Testing Library integration tests
npm install @testing-library/react @testing-library/user-event
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

## API

Every method returns `this` for chaining. A single `await` at the start of the chain executes all steps sequentially.

### Navigation

| Method | Description |
|--------|-------------|
| `visit(path)` | Navigate to URL (Playwright only) |
| `reload()` | Reload the current document while preserving its full URL and browser state (Playwright only) |

`reload()` waits for the browser's load event, like Playwright's native reload. Inside `within()`, it still reloads the whole page; the existing scope is a locator recipe rather than a retained element handle, so subsequent scoped steps resolve against the new document. RTL throws `BrowserOnlyVerbError` because JSDOM has no document-navigation lifecycle.

### Interactions

| Method | Description |
|--------|-------------|
| `click(text)` | Find any element by text and click it |
| `clickLink(text)` | Click `<a>` by accessible name |
| `clickButton(text)` | Click `<button>` by accessible name |
| `fillIn(label, value)` | Fill input by label or placeholder |
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
| `assertHas(selector, opts?)` / `refuteHas(...)` | Assert element exists (Playwright only, see options below) |
| `assertPath(path, opts?)` / `refutePath(path)` | Assert URL path (Playwright only, see options below) |
| `assertDownload(filename, trigger, opts?)` | Assert `trigger` starts a download with this filename (Playwright only) |

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

The predicate receives the adapter context — `{ page, scope }` for Playwright, `{ user, container }` for RTL — and may be sync or async. `opts` takes `{ timeout, interval }` in ms; omit them to inherit the adapter's own budget (Playwright's `expect.poll`, RTL's `waitFor`).

When the budget runs out, the chain trace says what you were waiting for:

```
>>> [FAILED] until: the export job reports done
```

The description is required at the call site, before the chain runs — a blank one throws immediately, because a step named `until: ` teaches a reader nothing. The `feather-testing/no-wait-for-timeout` lint rule (see [Lint plugin](#lint-plugin)) points at this verb, so "no sleeps" stops being a review convention and becomes a check.

### Scoping

| Method | Description |
|--------|-------------|
| `within(selector, fn)` | Scope actions to a container element |

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

When you need something the DSL doesn't cover, queue a named custom step instead of abandoning the chain. The callback receives the adapter's context — `{ page, scope }` for Playwright, `{ user, container }` for RTL — and the name shows up in `StepError` output like any built-in step:

```ts
await session
  .visit("/board")
  .step("drag card to Done column", async ({ page }) => {
    await page.getByText("My card").dragTo(page.locator("#done"));
  })
  .assertText("Done (1)");
```

`raw(label, fn)` goes one level lower: it hands over the driver itself — Playwright's `page`, RTL's scoped query object — with no context wrapper. Use it when you want the native API and nothing else:

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
| `debug()` | Playwright: saves a full-page screenshot to `debug-{timestamp}.png` in the CWD. RTL: calls `screen.debug()` to log the current DOM to the console. |

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
    [skipped] fillIn('Password', 'password123')
    [skipped] assertText('Hello! You are signed in.')
```

The session keeps a history of executed steps, so when you break a flow into multiple chains (multiple `await`s), the `StepError` still shows the full walk — steps from earlier chains appear as `[ok]` above the failing chain.

With the Playwright adapter, each queued step is also wrapped in `test.step()`, so chains appear as named steps in the trace viewer and HTML report.

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
| `user`, `root`, `container`, `lastFormElement`, `timeout` | Shared state the built-in verbs read and write |

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

## Exports

```ts
// Core (Session class + types)
import {
  Session,
  StepError,
  BrowserOnlyVerbError,
  type TestDriver,
} from "feather-testing-core";

// Playwright adapter
import { test, createSession, expect } from "feather-testing-core/playwright";

// RTL adapter
import { createSession } from "feather-testing-core/rtl";

// ESLint plugin (see below)
import featherTesting from "feather-testing-core/eslint-plugin";
```

Both adapter subpaths also re-export `Session` and `StepError`, so you can import everything from a single path:

```ts
import { test, Session, StepError } from "feather-testing-core/playwright";
import { createSession, Session, StepError } from "feather-testing-core/rtl";
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

## Upgrading to 0.5.0

Version 0.5.0 extends the required `TestDriver` interface. Custom drivers must implement these new methods before upgrading:

- `reload()`
- `assertExactText(text, opts?)`
- `assertAttribute(name, value?, opts?)` / `refuteAttribute(name, opts?)`
- `assertComputedStyle(property, value, opts?)`
- `assertNoHorizontalOverflow(opts?)` / `assertHorizontalOverflow(opts?)`
- `assertHorizontallyContained(selector, opts?)`
- `scrollToHorizontalEnd(opts?)`

Implement capabilities the adapter can prove, but do not fake browser behavior or silently no-op. For operations the environment cannot support—commonly reload, computed CSS, layout geometry, and scrolling in non-browser adapters—reject with `BrowserOnlyVerbError`, naming the verb and directing the caller to a browser-backed spec. The built-in RTL adapter follows this pattern for JSDOM limitations.

## Releasing

Releases are manual and publish exactly the version committed to `main`:

1. Run `npm version <version> --no-git-tag-version` so `package.json` and `package-lock.json` contain the intended new version.
2. Run `npm run lint` and `npm run test:all`, then commit and merge the version change to `main`.
3. In GitHub Actions, open **Publish to npm**, choose **Run workflow**, select `main`, and run it.

The workflow refuses non-`main` refs, mismatched lockfile versions, versions already present on npm, and registry lookup failures. It never changes or commits a version. Ordinary pushes and merges do not run it.

## Documentation

- [The document set](docs/document-set.md) — the minimal set of documents a project needs, what each one answers, and why hand-maintained cross-reference matrices lose to generated reports plus CI checks.

## License

MIT
