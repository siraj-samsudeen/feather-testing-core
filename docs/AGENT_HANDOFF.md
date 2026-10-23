# Handoff: feather-testing-core — Phoenix Test-inspired Fluent DSL

**Date:** 2025-02-20
**Session scope:** Design, prototype, and package a fluent testing DSL inspired by Elixir's Phoenix Test

---

## What Was Built

A standalone npm package `feather-testing-core` that provides a chainable, Phoenix Test-style DSL for writing readable browser tests in JS/TS.

### Three subpath exports

| Export | Purpose | Peer deps |
|--------|---------|-----------|
| `feather-testing-core` | Core: Session, TestDriver interface, StepError | None |
| `feather-testing-core/playwright` | Playwright adapter + fixture | `playwright` (`@playwright/test` installs it; needed only for the `test` fixture) |
| `feather-testing-core/rtl` | React Testing Library adapter (subset API) | `@testing-library/react`, `@testing-library/user-event` |

### What tests look like now

**Playwright E2E:**
```ts
import { test } from "./fixtures"; // extends feather-testing-core/playwright

test("signup flow", async ({ session }) => {
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

**RTL integration:**
```ts
import { createSession } from "feather-testing-core/rtl";

test("form submission", async () => {
  renderApp({ authenticated: false });
  const session = createSession();

  await session
    .fillIn("Email", "test@example.com")
    .fillIn("Password", "password123")
    .click("Sign in")
    .assertText("Hello! You are signed in.");
});
```

---

## Architecture

```
Session (thenable action-queue, framework-agnostic)
  └── TestDriver interface
        ├── PlaywrightDriver (wraps Page + Locator)
        └── RTLDriver (wraps screen + userEvent) — subset API
```

**Core pattern:** Each Session method pushes a thunk onto an internal queue and returns `this`. The class implements `PromiseLike<void>` via a `then()` method, so `await session.visit("/").fillIn(...)` executes the entire chain. This is the same pattern used by [playwright-fluent](https://github.com/hdorgeval/playwright-fluent).

**Key files in `feather-testing-core/src/`:**

| File | What it does |
|------|-------------|
| `types.ts` | `TestDriver` interface (37 lines) — the contract both adapters implement |
| `errors.ts` | `StepError` — wraps failures with chain trace (ok/FAILED/skipped per step) |
| `session.ts` | `Session` class — thenable chain with all API methods |
| `playwright/driver.ts` | `PlaywrightDriver` — wraps Playwright Page/Locator |
| `playwright/index.ts` | Exports Playwright fixture (`test.extend<{ session }>`) and `createSession(page)` |
| `rtl/driver.ts` | `RTLDriver` — wraps `screen` + `userEvent` |
| `rtl/index.ts` | Exports `createSession()` for RTL |

---

## API Surface

Maps 1:1 to Phoenix Test. Full list:

| Method | Playwright | RTL | Notes |
|--------|-----------|-----|-------|
| `visit(path)` | Yes | Throws | RTL has no URL navigation |
| `click(text)` | Yes | Yes | Generic: finds any element by text, clicks it. Added because Phoenix Test's `click_link`/`click_button` don't cover `<span onClick>` |
| `clickLink(text)` | Yes | Yes | Finds `<a>` by accessible name |
| `clickButton(text)` | Yes | Yes | Finds `<button>` by accessible name |
| `fillIn(label, value)` | Yes | Yes | Tries `getByLabel` → `getByPlaceholder` fallback |
| `selectOption(label, option)` | Yes | Yes | |
| `check(label)` / `uncheck(label)` | Yes | Yes | |
| `choose(label)` | Yes | Yes | Radio buttons |
| `submit()` | Yes | Yes | Submits the last-interacted form (tracks `lastFormLocator`/`lastFormElement`) |
| `assertText(text)` / `refuteText(text)` | Yes | Yes | |
| `assertHas(selector, opts)` / `refuteHas(...)` | Yes | Throws | RTL discourages CSS selectors |
| `assertPath(path)` / `refutePath(path)` | Yes | Throws | JSDOM has no URL |
| `within(selector, fn)` | Yes | Yes | Scopes all actions to a container |
| `debug()` | Screenshot | `screen.debug()` | |

### `submit()` behavior

Tracks the form containing the last input interacted with (`fillIn`, `selectOption`, `check`, etc.). On `submit()`:
1. Looks for `button[type="submit"]` or `input[type="submit"]` inside that form
2. Falls back to pressing Enter on the last input (Playwright) or `requestSubmit()` (RTL)

### `fillIn()` label resolution

1. `getByLabel(label)` — proper `<label for>` association
2. `getByPlaceholder(label)` — fallback for unlabeled inputs (common in starter apps)

---

## Design Decisions

### Why `click()` was added (not in Phoenix Test)

Phoenix Test has `click_link` (for `<a>`) and `click_button` (for `<button>`). But the starter-pack app has `<span onClick>` elements ("Sign up instead", "Sign in instead") that are neither links nor buttons. Using `clickLink` failed because Playwright looked for `getByRole('link')` and found nothing.

`click(text)` is a generic "find any element by text and click it" — covers these non-semantic clickable elements. Phoenix Test doesn't need this because LiveView apps typically use proper `<a>` and `<button>` elements.

### Why thenable chain instead of `.run()`

The `@typescript-eslint/no-thenable` rule flags classes with a `then()` method. We override it with an eslint-disable comment because:
- The thenable pattern is THE core design — it's what makes `await session.visit("/").fillIn(...)` work without a trailing `.run()`
- playwright-fluent uses the same pattern
- When extracted to its own package, it'll have its own eslint config

### RTL adapter: subset API

RTL tests run in JSDOM, which has no real URL or browser navigation. Rather than making `visit()` a silent no-op (confusing), these methods throw clear errors: "visit() is not available in the RTL adapter." Same for `assertPath`, `refutePath`, `assertHas`, `refuteHas`.

### Standalone package, not inside convex-test-provider

`feather-testing-core` is framework-agnostic — nothing about it is Convex-specific. Bundling it with `convex-test-provider` would limit reach and muddy purpose. Non-Convex apps can use `feather-testing-core` directly.

---

## Errors Encountered and Resolutions

### 1. `clickLink("Sign up instead")` timeout (Playwright)

**Error:** `locator.click: waiting for getByRole('link', { name: 'Sign up instead' })` — 30s timeout

**Cause:** "Sign up instead" is a `<span>` with `onClick`, not an `<a>` tag. `getByRole('link')` found nothing.

**Fix:** Changed test from `.clickLink("Sign up instead")` to `.click("Sign up instead")`. Added the generic `click(text)` method to both the Session and TestDriver interface.

### 2. Dual Playwright load when using `npm install ../feather-testing`

**Error:** `Requiring @playwright/test second time` — Playwright detected two copies being loaded.

**Cause:** `npm install <local-path>` creates a symlink. Node resolves `@playwright/test` relative to the symlinked package's own `node_modules/`, finding a second copy.

**Fix:** Use `npm pack` to create a tarball, then `npm install feather-testing-0.1.0.tgz`. This installs the package contents (only `dist/`) into the consumer's `node_modules/`, so all peer deps resolve from one place.

**For future:** When published to npm, this won't be an issue. For local development, always use `npm pack` + install tarball.

### 3. `StepError.cause` property not found (TypeScript)

**Error:** `TS2339: Property 'cause' does not exist on type 'StepError'`

**Cause:** TypeScript target was below ES2022, which is when `Error.cause` was added.

**Fix:** Used ES2022 `Error` constructor options: `super(message, { cause })`. Set `tsconfig.json` target to `ES2022`.

### 4. `@typescript-eslint/no-thenable` lint error on Session class

**Error:** `Do not add then to a class.`

**Cause:** The `recommendedTypeChecked` eslint config includes this rule. Our `then()` is intentional.

**Fix:** `// eslint-disable-next-line @typescript-eslint/no-thenable` comment on the `then()` method. The package will have its own eslint config when extracted.

---

## Project Locations

| Path | What |
|------|------|
| `NonDropBoxProjects/feather-testing/` | The standalone core package (source of truth, npm: `feather-testing-core`) |
| `NonDropBoxProjects/feather-testing-trial/` | Copy of starter-pack using the package (test bed) |
| `NonDropBoxProjects/feather-testing-convex/` | Existing Convex test provider (not yet modified) |
| `NonDropBoxProjects/_archive/benchmark/starter-pack/` | Original starter-pack (untouched) |

### feather-testing-trial dependency

`feather-testing-trial` installs `feather-testing` via tarball:
```json
"feather-testing-core": "file:feather-testing-core-0.1.0.tgz"
```
To update after changes to `feather-testing`:
```bash
cd feather-testing && npm run build && npm pack
cd ../feather-testing-trial && npm install ../feather-testing/feather-testing-core-0.1.0.tgz
```

---

## Next Session: Wrap feather-testing in feather-testing-convex

### Goal

Make `feather-testing-convex` the batteries-included testing package for Convex apps. Users install one package and get both the Convex mock layer AND the fluent DSL from `feather-testing-core`.

### New exports to add to feather-testing-convex

**`feather-testing-convex/playwright`** — Playwright fixture with Convex cleanup baked in:
```ts
import { createConvexTest } from "feather-testing-convex/playwright";
import { api } from "../convex/_generated/api";

export const test = createConvexTest({
  convexUrl: process.env.VITE_CONVEX_URL!,
  clearAll: api.testing.clearAll,
});
```

Under the hood, this extends `feather-testing-core/playwright`'s test fixture with auto-cleanup.

**`feather-testing-convex/rtl`** — Combined render + session:
```ts
import { renderWithSession } from "feather-testing-convex/rtl";

const session = renderWithSession(<App />, client, { authenticated: false });
await session.fillIn("Email", "test@example.com").clickButton("Sign in");
```

Combines `renderWithConvexAuth` + `createSession()` into one call.

### Implementation plan

1. Add `feather-testing-core` as a dependency of `feather-testing-convex`
2. Add new subpath exports: `feather-testing-convex/playwright`, `feather-testing-convex/rtl`
3. The existing exports (`.`, `./vitest-plugin`) remain unchanged
4. Update `feather-testing-trial` to use `feather-testing-convex` instead of importing both packages separately
5. Verify all tests pass

### Key question to resolve

The `createConvexTest` for Playwright needs the Convex API reference and URL. How should these be provided?
- Option A: Pass as function arguments (shown above)
- Option B: Environment variable convention (`VITE_CONVEX_URL` auto-detected)
- Option C: Config file

### Package dependency graph (after integration)

```
feather-testing-convex
  ├── feather-testing-core (dependency)
  ├── convex-test (peer dep)
  ├── playwright (optional peer dep, as in feather-testing-core 0.7; @playwright/test for its fixtures)
  └── @testing-library/* (optional peer dep)
```

---

## Reference: Phoenix Test Inspiration

[PhoenixTest docs](https://hexdocs.pm/phoenix_test/PhoenixTest.html) — the API we modeled after.

Key principles carried over:
- **Pipe-chain readability** — tests read like user stories
- **Label-based targeting** — accessibility-first element selection
- **Assertions in the chain** — no separate `expect()` wrappers
- **Composable helpers** — functions that take/return Session work as reusable steps
