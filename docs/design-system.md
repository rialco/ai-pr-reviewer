# Design System

This file is the single source of truth for UI and visual design decisions in this project.

Update this document whenever a new design decision becomes part of the product language.

## Principles

- Prefer a minimalist, modern interface.
- Keep layouts calm and high-signal rather than decorative.
- Favor consistency over one-off visual solutions.
- Use contrast carefully: strong enough for clarity, soft enough to avoid visual fatigue.

## Component System

- Prefer shadcn-style primitives in `src/components/ui/` for interactive UI.
- For selects, menus, popovers, dialogs, and similar composite widgets, use the local shadcn/Radix wrapper component before introducing native controls or bespoke implementations.
- When a reusable visual pattern appears more than once, extract it into a shared UI primitive instead of duplicating markup.
- Use `src/components/ui/dialog.tsx` for modal workflows that collect input or show richer detail. Reserve `ConfirmDialog` for simple confirmation-only prompts.
- Use `src/components/ui/popover.tsx` for anchored panels that open from existing layout surfaces, such as footer docks or compact settings cards.

## Section Headers

- Use the shared `src/components/ui/section-header.tsx` component for sectioned cards and panels.
- Section headers should follow the same structure across the app:
  - subtle lightened header bar
  - small colored pip
  - uppercase muted label
  - subdued right-aligned meta/count text
- Avoid ad hoc title bars when an existing section header pattern already fits.

## Color Palette

- Stay within the project’s zinc-based surface palette.
- Reuse existing tokens from `src/index.css` before introducing new neutrals or overlays:
  - `bg-card`
  - `bg-surface`
  - `bg-muted`
  - `border-border`
  - `text-muted-foreground`
- Avoid one-off neutral backgrounds or white-overlay treatments when an existing zinc token can express the same hierarchy.
- Status and semantic accents should remain purposeful and limited:
  - red for critical/failure
  - amber for warning/in-progress
  - blue for informational/secondary emphasis
  - green for success/fixed

## Typography And Text Hierarchy

- Main structural labels can carry stronger emphasis, but overview/detail content should usually render softer than full foreground white.
- Long-form content should be easy on the eyes; prefer slightly muted zinc text for descriptions and metadata-heavy areas.
- Counts, timestamps, and secondary metadata should use subdued muted text rather than competing with primary content.

## Surfaces And Layout

- Surfaces should communicate hierarchy clearly:
  - page background
  - elevated section/card surface
  - muted hover/active surface
- Persistent status monitors should be docked into existing layout surfaces before introducing detached floating chips or badges.
- Avoid stacking multiple heavy dark containers unless that extra separation is necessary.
- Prefer clean card boundaries, restrained borders, and disciplined spacing.

## Interaction Style

- Buttons and controls should feel compact, deliberate, and non-bulky.
- Keep action rows from wrapping when avoidable by giving important controls enough width.
- Use motion sparingly and meaningfully; expand/collapse interactions should feel smooth but unobtrusive.

## Motion

- New UI should not appear or disappear abruptly. Entry and exit motion is part of the project’s polish baseline.
- Preferred default motion: a quick, minimal fade combined with a subtle vertical slide.
- Use short timings, typically in the 160-220ms range, with smooth easing such as `ease-out` or `ease-in-out`.
- Motion distance should stay small, usually 4-8px. Avoid bouncy, theatrical, or overly elastic animation.
- Inline detail panels, popovers, dialogs, dropdowns, toasts, and conditional cards should animate both on enter and on exit.
- If a component conditionally unmounts, keep it mounted long enough for the exit animation to complete instead of snapping it out of the DOM immediately.

## Maintenance Rule

- When a new visual rule, component convention, or palette decision is adopted, update this file in the same change.
