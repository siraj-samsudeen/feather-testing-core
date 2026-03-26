# Plan: README Hero Restructure — Execution

## What Changes

Replace everything **above** `## Installation` in `README.md` with the new hero section.

## New Hero Structure (top → bottom)

### 1. Title + One-liner
```
# feather-testing-core
A readable testing DSL that turns async test boilerplate into fluent, chainable steps.
```

### 2. Ecosystem link
Keep the existing link to the Feather Framework ecosystem.

### 3. The Core Idea
One short paragraph: the DSL defines a universal vocabulary (`fillIn`, `clickButton`, `assertText`, …) that can be backed by any test framework. Playwright and RTL are just the first two adapters.

### 4. Before/After — Playwright E2E
- **Before:** Vanilla Playwright test (~8 lines of `page.getByText`, `page.getByLabel`, etc.)
- **After:** Same test with the DSL (~8 lines of fluent chain)

### 5. Before/After — React Testing Library
- **Before:** Vanilla RTL test (~6 lines of `userEvent`, `screen.getByLabelText`, etc.)
- **After:** Same test with the DSL (~6 lines of fluent chain)

### 6. The Key Point — Same DSL, Any Backend
A callout paragraph: both examples use the **exact same methods**. The DSL is framework-agnostic. You can implement the `TestDriver` interface for any testing library.

### 7. Inspiration credit
One line crediting Phoenix Test with the existing link — moved from the hero position to after the before/after blocks.

## What Stays the Same

Everything from `## Installation` onward is untouched:
- Installation
- Usage (Playwright E2E, RTL)
- API tables
- How It Works
- Error Messages
- RTL Adapter Limitations
- Exports
- License

## Files Modified

| File | Action |
|------|--------|
| `README.md` | Replace hero section (everything before `## Installation`) |
