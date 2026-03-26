# Research: README Restructure for `feather-testing-core`

## Date
2025-01-20

## Problem Statement

The current `feather-testing-core` README opens with:

> **Phoenix Test-inspired fluent testing DSL for Playwright and React Testing Library.**

This has two problems:

1. **Assumes prior knowledge** — "Phoenix Test-inspired" only resonates with Elixir developers. The majority of the target audience (TypeScript/JavaScript developers using Playwright or RTL) have never heard of Phoenix Test.
2. **No before/after contrast** — The hero shows a single "after" snippet, but without seeing the verbose "before" code, the reader can't appreciate what the DSL eliminates. The value proposition is invisible.

The rest of the README is thorough (API tables, error messages, composable helpers, etc.), but by the time a reader reaches it, they've already bounced because the first screenful didn't answer: *"Why should I care?"*

## What We Learned from `feather-testing-convex`

The `feather-testing-convex` repo went through a 3-step README restructure (`docs/6-readme-restructure/`) that dramatically improved the hero section using this pattern:

1. **Comparison table** — instant visual clarity about the testing landscape
2. **Narrative grounding** — short paragraphs explaining each row with a concrete scenario
3. **Name the gap → show the solution** — within the first screenful

For `feather-testing-core`, the comparison table pattern doesn't fit directly (we're not comparing multiple competing libraries). Instead, the analogous structure is **before/after code blocks** — showing vanilla Playwright and vanilla RTL side-by-side with the DSL equivalent.

## Key Insight

The most powerful thing about `feather-testing-core` is that the **same DSL works across both Playwright and RTL**. This isn't obvious from the current README, which shows them in separate "Usage" sections far below the fold. The hero should make this immediately visible:

- Before/After for **Playwright E2E**
- Before/After for **React Testing Library**
- A callout: *"Notice both examples use the exact same methods."*

## Decision

Adopt the 3-step documentation process (research → spec → plan) and restructure the README hero section to lead with before/after contrast, making the value proposition visible within the first screenful.

## Scope

- **In scope:** Everything above `## Installation` in the README (the "hero section")
- **Out of scope:** The rest of the README (Installation, Usage, API, How It Works, etc.) — all existing content is preserved as-is
