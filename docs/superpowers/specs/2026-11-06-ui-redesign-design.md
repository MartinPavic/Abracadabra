# UI redesign: design

Date: 2026-11-06. Status: written without a design review round (you said "just do the best you can"); every choice below is mine. Project 3 of 3.

## Intent

The app works but looks unfinished: one grey palette, no accent, text-only navigation, every screen styling its own buttons and inputs, and a run page that is one long scroll. The goal is a coherent, modern, compact look that a stranger would take for a finished product, and a run page where the thing that needs the user's decision is the first thing they see.

## Goals

- One visual foundation: tokens (font, accent, radius, spacing), shared primitives and an icon set, used by every screen.
- A restyled app shell, task list, settings and setup wizard on that foundation.
- A run page split into **Overview**, **Changes** and **Activity** tabs, opening on the tab that matches what the run needs (Changes while it awaits approval or is working; Overview otherwise).
- Light and dark mode both first-class.
- No behaviour change: every existing feature, label that tests query, keyboard shortcut and data flow stays.

## Non-goals

- New features, new pages, new data. No change to Rust code.
- A custom window chrome or title bar.
- Animations beyond small transitions and a spinner.
- A new component library or icon dependency (see Constraints).

## Anti-goals

- A restyle that silently changes behaviour or drops a setting.
- Colour as the only signal (status must also be readable as text or icon).
- Contrast that fails in dark mode, or controls with no visible focus ring.

## Constraints

- Tailwind v4 (`@import "tailwindcss"`, class-based dark variant already configured in `src/App.css`). No UI library and no icon package: new runtime dependencies need approval, so icons are a small local inline-SVG set.
- The CSP in `tauri.conf.json` blocks remote fonts; use a system font stack.
- The minimum window is 960x600 (set earlier); layouts must hold at that width.
- Existing tests query by role and visible name; keep accessible names stable ("Run", "Plan", "Save", "Yes", etc.) unless a task says otherwise and updates the tests.

## Visual language (the decisions)

- **Palette.** Neutral `zinc` for surfaces and text, one **indigo** accent for primary actions, selection and focus. Status colours: queued/discarded/cancelled zinc; fetching/working/reviewing/committing blue; awaiting approval amber; approved/published green; failed red; planned indigo; handed off violet.
- **Surfaces.** Light: page `zinc-50`, cards `white` with a `zinc-200` border. Dark: page `zinc-950`, cards `zinc-900` with a `zinc-800` border. Cards use `rounded-xl`, controls `rounded-lg`, badges `rounded-full`.
- **Type.** System UI stack, base `text-sm`; page title `text-xl font-semibold tracking-tight`; card title `text-sm font-semibold`; muted text `zinc-500`/`zinc-400`; monospace for commands, branches and diffs.
- **Density.** Compact: controls 32 px high (`sm`) or 36 px (`md`), card padding 16 px, page padding 24-32 px, content capped at `max-w-6xl`.
- **Tokens in one place.** `src/App.css` defines `@theme` entries for the fonts and an `accent` colour scale that aliases indigo, so primitives use `accent-*` and a palette change touches one file.
- **Focus.** Every interactive primitive has a 2 px accent focus ring (`focus-visible`).

## Approaches considered

- **A. Primitives first, then restyle screens (chosen).** One set of components used everywhere; later screens shrink. Costs a refactor of about 25 components.
- B. Restyle each screen in place with copy-pasted classes. Faster to start, but it is exactly how the current inconsistency arose.
- C. Adopt a component library (shadcn/Radix, Headless UI). Best accessibility out of the box, but new dependencies and a larger change than needed.

Run page structure:
- **Tabs (chosen).** Overview, Changes, Activity, each rendered by its own component.
- A single scroll with a sticky action bar. Simpler, but the long page is the main complaint.

## Design

### Foundation (`src/components/ui/`, `src/lib/`)

`Icon`, `Button`, `Card`, `Badge` and `StatusBadge`, `Notice`, `Tabs`, `Input`/`Textarea`/`Select`/`Field`, `PageHeader`, `EmptyState`, `Spinner`. `RunStatusPill` stays exported and delegates to `StatusBadge`.

### Shell

Left sidebar 224 px: logo mark and name, nav items with icons (Tasks, Settings; History stays a tab on the tasks page), the active item shown with an accent tint and a bar, a theme toggle (icon button) pinned at the bottom. The thin top header is removed. Content area scrolls on its own.

### Tasks page

Tabs (Tasks, History) via `Tabs`. Toolbar with search and filters in one row. Tasks as a card list: checkbox, title, project and label chips, the latest run's status badge, and `Plan` (ghost) and `Run` (primary) buttons. Ready banner, orphaned-stash notice and errors use `Notice`. Empty states use `EmptyState`.

### Run page

Header: back link, title, status badge, tests badge, one meta line (project, branch, base, agent time, usage) and the actions (Open in editor, Cancel run). Below it the tab bar.
- **Overview:** notices (reviewer asked for changes, errors, redo error, stash and folder notes, branch conflict, waiting-for, removed files); for approved or handed-off runs the publish card first; worker summary or plan (with the "Run from plan" actions); reviewer notes (with Apply suggestions); test output; diagram.
- **Changes:** the live diff while working, the per-file review while awaiting approval, the diff otherwise.
- **Activity:** the stepper with durations, the console, and Delete run for finished runs.
- Default tab: Changes when the run awaits approval (not a plan run) or is working or reviewing; otherwise Overview. The Changes tab shows an amber dot when approval is pending and Activity a pulsing dot while the run is active.

### Settings and setup

Each settings section is a `Card` with a title and description; fields use the shared form primitives; Basics and Advanced keep their structure. The wizard becomes a centred card with a progress indicator.

### Remaining components

File review, review summary, escape actions, diff viewer, publish actions, diagram, console, stepper, history and prompts are restyled with the primitives; behaviour is untouched.

### Accessibility

Tabs follow the WAI-ARIA tab pattern (`tablist`, `tab`, `tabpanel`, arrow-key navigation). Icon-only buttons have `aria-label`. Status badges carry text. Decorative icons are `aria-hidden`.

### Tests

Each primitive has unit tests (variants, disabled and loading, roles, keyboard for tabs). Restyled screens keep their existing tests green; `TaskRun` tests are extended for the tab behaviour.

## Calls made without the user

- Indigo accent and a compact density.
- Local SVG icons instead of an icon library.
- History stays a tab on the tasks page rather than a sidebar item.
- Three run-page tabs with the default chosen from the run's status.
- I cannot look at the rendered app, so visual quality is checked by reading the markup and running the test suite; you should look at it with `pnpm tauri dev` before merging.

## Left to the builder

Exact class strings, icon drawings, the width of the sidebar and the order of minor elements inside cards.
