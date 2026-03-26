# Spec: README Hero Restructure

## Requirements

### R1: Value proposition visible within first screenful
A developer landing on the README must understand what the library does and why it matters **without scrolling**.

### R2: Before/after contrast for Playwright
Show vanilla Playwright code alongside the DSL equivalent so the reader can see the boilerplate that disappears.

### R3: Before/after contrast for React Testing Library
Show vanilla RTL code alongside the DSL equivalent — same idea, different framework.

### R4: Framework-agnostic DSL callout
Explicitly highlight that both before/after examples use the **exact same methods** (`fillIn`, `clickButton`, `assertText`). This is the key differentiator — the DSL is not Playwright-specific or RTL-specific.

### R5: No assumed prior knowledge
Remove "Phoenix Test-inspired" from the hero. The Elixir lineage can be mentioned later (e.g., in a "Credits" or "Inspiration" section), but it should not be the first thing a reader sees.

### R6: Preserve all existing content below the hero
Everything from `## Installation` onward remains unchanged. The restructure only affects the hero section.

## Acceptance Criteria

- [ ] README opens with a clear one-liner that describes the library without referencing Phoenix Test
- [ ] Two before/after code comparisons are shown (Playwright E2E + RTL)
- [ ] A callout paragraph explicitly names the framework-agnostic nature of the DSL
- [ ] The Phoenix Test inspiration link is preserved but moved below the hero
- [ ] All content from `## Installation` onward is identical to the current README
- [ ] The README renders correctly on GitHub (no broken markdown)
