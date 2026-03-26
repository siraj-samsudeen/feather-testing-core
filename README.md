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

#### How `submit()` finds the submit button

`submit()` tracks the `<form>` element from the last `fillIn`, `selectOption`, `check`, `uncheck`, or `choose` call, then uses this strategy:

1. **By accessible name** — looks for a `<button>` whose name contains "submit" (case-insensitive)
2. **By `type="submit"`** — looks for `<button type="submit">` or `<input type="submit">`
3. **Enter key fallback** — presses Enter on the last form field

If no form was previously interacted with, `submit()` throws an error.

### Assertions

| Method | Description |
|--------|-------------|
| `assertText(text)` / `refuteText(text)` | Assert text is visible / not visible |
| `assertHas(selector, opts?)` / `refuteHas(...)` | Assert element exists (Playwright only, see options below) |
| `assertPath(path, opts?)` / `refutePath(path)` | Assert URL path (Playwright only, see options below) |

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

```ts
// Assert path (ignores query params)
await session.assertPath("/projects");

// Assert path with specific query params
await session.assertPath("/search", { queryParams: { q: "hello", page: "1" } });

// Refute: assert you are NOT on this path
await session.refutePath("/login");
```

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

## RTL Adapter Limitations

The RTL adapter runs in JSDOM, which has no real browser. These methods are not available and will throw:

- `visit()` — render the component directly instead
- `assertPath()` / `refutePath()` — no URL in JSDOM
- `assertHas()` / `refuteHas()` — RTL discourages CSS selectors; use `assertText()` instead

## Exports

```ts
// Core (Session class + types)
import { Session, StepError, type TestDriver } from "feather-testing-core";

// Playwright adapter
import { test, createSession, expect } from "feather-testing-core/playwright";

// RTL adapter
import { createSession } from "feather-testing-core/rtl";
```

Both adapter subpaths also re-export `Session` and `StepError`, so you can import everything from a single path:

```ts
import { test, Session, StepError } from "feather-testing-core/playwright";
import { createSession, Session, StepError } from "feather-testing-core/rtl";
```

## License

MIT
