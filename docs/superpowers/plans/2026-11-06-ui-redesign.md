# UI redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A coherent modern look (shared tokens, primitives and icons) applied to the shell, task list, run page, settings and setup, with the run page split into Overview, Changes and Activity tabs.

**Architecture:** Tokens live in `src/App.css` (`@theme`); primitives in `src/components/ui/`; every screen is rebuilt from them. The run page becomes a header plus three tab panels (separate components) that stay mounted while hidden so their state survives tab switches. No Rust changes, no new dependencies.

**Tech Stack:** React 19, TypeScript, Tailwind v4, react-router-dom 7, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-06-ui-redesign-design.md`

## Global Constraints

- No behaviour change: every existing feature, shortcut and data flow stays; no Rust changes.
- No new runtime or dev dependencies; icons are local inline SVG; fonts are a system stack (the CSP blocks remote fonts).
- Primitives use the `accent-*` scale defined in `src/App.css`, never `indigo-*` directly; neutral surfaces are `zinc`.
- Every tone or colour class has a `dark:` counterpart; every interactive primitive has a visible `focus-visible` ring.
- Accessible names that tests query ("Run", "Plan", "Save", "Yes", "Replace", etc.) stay stable unless a task updates the tests that use them.
- Layouts must hold at the 960x600 minimum window: no horizontal overflow, long titles/branches/paths truncate (`min-w-0`, `truncate`).
- Verify with `pnpm test`, `npx tsc --noEmit` and `pnpm build` (Vite build) after every task.

## Review Focus

- Switching run-page tabs does not lose in-progress state (per-file review index and notes, generated diagram, console). Task 6.
- The default tab follows the run's status on first load and while the user has not chosen a tab, and never yanks a user who did choose one. Task 6.
- Tabs are keyboard-operable (arrows, Home, End) with correct roles and `aria-selected`/`aria-controls`. Task 3.
- No status is conveyed by colour alone (badges carry text); icon-only buttons have `aria-label`. Tasks 1, 2, 4.
- At 960 px width the sidebar plus content, long task titles and long branch names do not overflow. Tasks 4, 5, 6.

## File Structure

- `src/App.css`: `@theme` tokens (fonts, `accent` scale).
- `src/components/ui/`: `Icon.tsx`, `Spinner.tsx`, `Button.tsx`, `Card.tsx`, `Badge.tsx`, `Notice.tsx`, `PageHeader.tsx`, `EmptyState.tsx`, `Tabs.tsx`, `Form.tsx` (each with a `.test.tsx`), and `index.ts` re-exporting them.
- `src/components/AppShell.tsx`, `src/views/TasksPage.tsx`, `src/views/TaskList.tsx`, `src/components/RunHistory.tsx`, `src/components/ReadyBanner.tsx`, `src/components/OrphanedStashes.tsx`.
- `src/views/TaskRun.tsx` plus new `src/views/run/RunHeader.tsx`, `OverviewTab.tsx`, `ChangesTab.tsx`, `ActivityTab.tsx`.
- Run components, settings components, `Setup.tsx` (restyled in Tasks 7 and 8).

---

### Task 1: Tokens, Icon, Spinner, Button

**Files:**
- Modify: `src/App.css`
- Create: `src/components/ui/Icon.tsx`, `Spinner.tsx`, `Button.tsx`, their tests, `src/components/ui/index.ts`

**Interfaces:**
- Produces:
  - In `App.css` an `@theme` block: `--font-sans` (Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif), `--font-mono` (ui-monospace, SFMono-Regular, Menlo, monospace) and `--color-accent-50` to `--color-accent-950` each aliasing the matching indigo variable (`var(--color-indigo-N)`); body uses `font-sans`.
  - `type IconName = "tasks" | "history" | "settings" | "sun" | "moon" | "check" | "x" | "alert" | "info" | "play" | "list" | "refresh" | "external" | "copy" | "chevron-right" | "chevron-down" | "branch" | "folder" | "merge" | "search" | "sparkles" | "trash" | "stop" | "edit" | "file"`; `Icon({ name, className = "size-4", title }: { name: IconName; className?: string; title?: string })` renders a 24x24 stroke SVG (`currentColor`, stroke width 1.75), `aria-hidden="true"` unless `title` is given (then `role="img"` and a `<title>`).
  - `Spinner({ className = "size-4" })`: an animated SVG with `role="status"` and `aria-label="Loading"`; animation disabled under `prefers-reduced-motion` (`motion-reduce:animate-none`).
  - `Button` (`forwardRef`): props `variant?: "primary" | "secondary" | "ghost" | "danger"` (default `secondary`), `size?: "sm" | "md"` (default `md`), `loading?: boolean` (disables, shows a `Spinner` before the children, keeps the label), `icon?: IconName` (leading icon), and all native button props; `type` defaults to `"button"`. Also `export function buttonClasses(variant, size): string` for styling links as buttons.
  - `index.ts` exports everything from the ui folder (grows with later tasks).

- [ ] **Step 1: Write failing tests** `Icon is hidden from assistive tech unless it has a title`, `Icon renders every IconName` (loops a list of all names and asserts an `svg` with a path for each), `Spinner has a status role`, `Button defaults to type button and secondary`, `Button variants carry distinct classes and a dark variant`, `a loading Button is disabled and shows the spinner but keeps its label`, `Button forwards onClick and respects disabled`, `buttonClasses can style a link`.
- [ ] **Step 2: Run** `pnpm test src/components/ui`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** the tokens and components. The primary variant is `bg-accent-600 text-white hover:bg-accent-700` with a dark counterpart; secondary is a bordered white/zinc-900 surface; ghost has no border; danger is red; all have `focus-visible:ring-2 ring-accent-500` offsets and disabled styling.
- [ ] **Step 4: Run** `pnpm test`, `npx tsc --noEmit`, `pnpm build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: design tokens, icons and button`.

---

### Task 2: Card, Badge, StatusBadge, Notice, PageHeader, EmptyState

**Files:**
- Create: `src/components/ui/Card.tsx`, `Badge.tsx`, `Notice.tsx`, `PageHeader.tsx`, `EmptyState.tsx` and tests
- Modify: `src/components/RunStatus.tsx` (`RunStatusPill` delegates to `StatusBadge`), `src/components/ui/index.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `Card({ title?, description?, actions?, padded = true, className, children })`: a `<section>` with `rounded-xl border` surface; when `title` is given a header row with an `h2` title (`text-sm font-semibold`), optional description (muted) and `actions` on the right; the body is padded unless `padded` is false.
  - `type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "accent" | "violet"`; `Badge({ tone = "neutral", dot, children })` (`dot?: boolean | "pulse"`, a small coloured dot before the text, `animate-pulse` for `"pulse"` with `motion-reduce:animate-none`); `StatusBadge({ status }: { status: RunStatus })` with the tone map from the spec (queued/discarded/cancelled neutral; cloning/working/reviewing/committing info with a pulsing dot; awaiting_approval warning; approved success; failed danger; planned accent; handed_off violet), text is the status with underscores replaced by spaces.
  - `Notice({ tone = "info", title, actions, children })`: bordered tinted box with a tone icon, `role="alert"` for `danger` and `warning`, `role="status"` otherwise.
  - `PageHeader({ title, description, actions, back }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; back?: { to: string; label: string } })` with `h1` (`text-xl font-semibold tracking-tight`) and a back `Link` (chevron icon) when given.
  - `EmptyState({ icon, title, description, action })`: centred block.
  - `RunStatusPill` keeps its export and props and renders `StatusBadge`; existing `RunStatus.test.ts` stays green.

- [ ] **Step 1: Write failing tests** `Card shows its title as a heading and its actions`, `Card without a title has no header`, `Badge tones all carry dark variants` (assert each tone's class string contains `dark:`), `StatusBadge shows the status as text for every RunStatus`, `active statuses show a pulsing dot`, `Notice uses role alert for danger and warning`, `PageHeader renders a back link`, `EmptyState renders title, description and action`, `RunStatusPill still renders the status text`.
- [ ] **Step 2: Run** `pnpm test src/components`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test`, `npx tsc --noEmit`, `pnpm build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: card, badge, notice and page header`.

---

### Task 3: Tabs and form controls

**Files:**
- Create: `src/components/ui/Tabs.tsx`, `Form.tsx` and tests; modify `index.ts`

**Interfaces:**
- Produces:
  - `Tabs<T extends string>({ tabs, value, onChange, idPrefix = "tabs", label }: { tabs: { id: T; label: string; indicator?: "dot" | "pulse" | null }[]; value: T; onChange: (id: T) => void; idPrefix?: string; label: string })`: `role="tablist"` with `aria-label={label}`; each tab is a `button role="tab"` with `id={`${idPrefix}-tab-${id}`}`, `aria-selected`, `aria-controls={`${idPrefix}-panel-${id}`}`, roving `tabIndex` (selected 0, others -1); Left/Right/Home/End move focus and select (wrapping); `indicator` renders a small amber dot (`pulse` animates, with `motion-reduce` off); the selected tab has an accent underline.
  - `TabPanel({ id, value, idPrefix = "tabs", children })`: `role="tabpanel"`, `id={`${idPrefix}-panel-${id}`}`, `aria-labelledby={`${idPrefix}-tab-${id}`}`, `hidden` when `id !== value`; the children stay mounted while hidden.
  - `controlClasses` string, `Input` (`forwardRef`, props: native input props and `mono?: boolean`), `Textarea` (same), `Select` (native `<select>` styled), `Field({ label, htmlFor, hint, error, children })` (label above, optional hint and error text, `aria-describedby` wiring is the caller's `id` convention: `Field` renders hint/error with ids `${htmlFor}-hint` and `${htmlFor}-error`).

- [ ] **Step 1: Write failing tests** `Tabs exposes tablist, tab and tabpanel roles with aria wiring`, `clicking a tab calls onChange`, `arrow keys, Home and End move the selection and wrap`, `only the selected tab is in the tab order`, `TabPanel hides inactive panels but keeps them mounted`, `an indicator is shown on the tab`, `Field links its label, hint and error`, `Input mono uses the mono font class`, `controls have dark variants and a focus ring`.
- [ ] **Step 2: Run** `pnpm test src/components/ui`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test`, `npx tsc --noEmit`, `pnpm build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: tabs and form controls`.

---

### Task 4: App shell

**Files:**
- Modify: `src/components/AppShell.tsx`; create `src/components/AppShell.test.tsx`

**Interfaces:**
- Consumes: Tasks 1 to 3, `useTheme`.
- Produces: `AppShell({ children })` with a 224 px left sidebar (logo mark with the `sparkles` icon in an accent tile, the name "Abracadabra", nav items Tasks (`tasks` icon) and Settings (`settings` icon) as `NavLink`s with an accent tint and a left bar when active, `aria-current="page"` on the active one), a theme toggle at the bottom of the sidebar (icon button with `aria-label` "Switch to dark mode" / "Switch to light mode" and the `sun`/`moon` icon), no top header, and a `main` that scrolls on its own, with content centred and capped at `max-w-6xl` and `min-w-0`.

- [ ] **Step 1: Write failing tests** `the sidebar links to tasks and settings and marks the active one`, `the theme toggle switches mode and has an accessible name`, `the content area renders its children`.
- [ ] **Step 2: Run** `pnpm test src/components/AppShell.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** (mock `useTheme` or use its real implementation with `localStorage` cleared, as convenient).
- [ ] **Step 4: Run** `pnpm test`, `npx tsc --noEmit`, `pnpm build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: new app shell`.

---

### Task 5: Tasks page, task list and history

**Files:**
- Modify: `src/views/TasksPage.tsx`, `src/views/TaskList.tsx`, `src/components/RunHistory.tsx`, `src/components/ReadyBanner.tsx`, `src/components/OrphanedStashes.tsx`, `src/components/FirstRunGate.tsx` only if it renders markup

**Interfaces:**
- Consumes: Tasks 1 to 4.
- Produces: the Tasks/History switch uses `Tabs` (labels "Tasks" and "History", `label="Tasks and history"`; keep the `?tab=history` query behaviour), the page uses `PageHeader`. `TaskList`: toolbar (search `Input`, filter `Select`s, refresh `Button` with the `refresh` icon, "Run selected (n)" primary button), then the tasks as a list of `Card`-style rows: checkbox, title (truncating), project and label chips (`Badge`), the latest run's `StatusBadge` linking to it, `Plan` (ghost, `list` icon) and `Run` (primary, `play` icon) buttons. Empty and no-source states use `EmptyState`; errors and the batch message use `Notice`; `ReadyBanner` and `OrphanedStashes` render with `Notice`. `RunHistory` rows use `Badge`/`StatusBadge` and `Button`. All existing behaviour, disabled states, titles and accessible names are unchanged.

- [ ] **Step 1: Write failing tests** for what is new: `the tasks page tabs switch to history and back` (and the query string), `a task row shows its status badge and links to the run`, `empty state when there are no tasks`. Keep `TaskList.ready.test.tsx`, `ReadyBanner.test.tsx` and `RunHistory.test.tsx` green without weakening them.
- [ ] **Step 2: Run** the new tests. Expected: FAIL.
- [ ] **Step 3: Implement** the restyle with the primitives; remove local button/input class constants from the touched files.
- [ ] **Step 4: Run** `pnpm test`, `npx tsc --noEmit`, `pnpm build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: restyle tasks page and history`.

---

### Task 6: Run page tabs

**Files:**
- Modify: `src/views/TaskRun.tsx`, `src/views/TaskRun.test.tsx`
- Create: `src/views/run/RunHeader.tsx`, `OverviewTab.tsx`, `ChangesTab.tsx`, `ActivityTab.tsx`

**Interfaces:**
- Consumes: Tasks 1 to 4, existing run components and handlers.
- Produces:
  - `TaskRun` keeps loading the run, subscribing to `run://status` and the existing handlers, and renders `RunHeader`, a `Tabs` bar (`label="Run sections"`, tabs `overview`, `changes`, `activity`, `idPrefix="run"`) and three `TabPanel`s that stay mounted while hidden.
  - `RunHeader`: back link ("Tasks"), the task title (opens the task URL when there is one), `StatusBadge`, the tests badge, the meta line (project, branch, base ref and commit, agent time, usage), and the actions (Open in editor when configured, Cancel run when cancellable, with their inline errors).
  - `OverviewTab`: in this order, notices (queued/waiting-for, run error, reviewer asked for changes, redo error, folder-on-branch with Switch back, stash notice, removed files, worker re-runs) and the branch-conflict prompt; for approved or handed-off runs the publish actions; the worker summary or plan card (with CopyButton) and the planned run's "Run from plan" / "Run from task description" actions; the reviewer notes card with Apply suggestions; the test output; the diagram. Text and behaviour as today.
  - `ChangesTab`: the live diff while working or reviewing (not plan runs), the per-file review while awaiting approval (not plan runs), the diff viewer otherwise for awaiting approval or approved runs.
  - `ActivityTab`: the stepper, the console and Delete run (with its confirmation) for finished runs.
  - Default tab: `changes` when the run awaits approval and is not a plan run, or is working or reviewing and is not a plan run; otherwise `overview`. It is evaluated on first load and whenever the status changes until the user clicks a tab; after that it never changes by itself. Opening another run resets it. The Changes tab shows indicator `dot` while awaiting approval; Activity shows `pulse` while the run is cancellable (active).

- [ ] **Step 1: Write failing tests** (extend `TaskRun.test.tsx`; keep its existing tests meaningful, adapting queries to the tab structure): `an awaiting-approval run opens on the changes tab`, `a finished run opens on overview`, `a plan run opens on overview`, `the default tab follows a status change until the user picks a tab`, `choosing a tab is not overridden by later status changes`, `switching tabs keeps the changes panel mounted` (the mocked file review is still in the document, hidden), `overview holds the worker summary and reviewer notes`, `activity holds the console and delete run`, `opening another run resets the default tab`.
- [ ] **Step 2: Run** `pnpm test src/views/TaskRun.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** the split; move markup with its state to the tab component that uses it; keep `TaskRun` under about 250 lines.
- [ ] **Step 4: Run** `pnpm test`, `npx tsc --noEmit`, `pnpm build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: tabbed run page`.

---

### Task 7: Run components

**Files:**
- Modify: `src/components/FileReview.tsx`, `ReviewSummary.tsx`, `RunEscapeActions.tsx`, `DiffViewer.tsx`, `PublishActions.tsx`, `PrLensDiagram.tsx`, `RunConsole.tsx`, `RunStatus.tsx` (stepper), `BranchConflictPrompt.tsx`, `CopyButton.tsx`, `Markdown.tsx` (spacing and typography only)

**Interfaces:**
- Consumes: Tasks 1 to 3.
- Produces: these components render with `Card`, `Button`, `Badge`, `Notice`, `Input`/`Textarea` and `Icon`; the stepper shows a connected step track with check, spinner and pending states (status never by colour alone); the per-file review keeps its layout (header with progress, file list, diff, note field, three decision buttons) with Yes as primary, "No, just remove" and "No, redo this" as danger/secondary, and a sticky decision bar; the diff viewer keeps its status letters. Accessible names, keyboard shortcuts and test ids are unchanged.

- [ ] **Step 1: Run** the existing tests for these components to confirm the starting state is green (`pnpm test`).
- [ ] **Step 2: Write failing tests** only for new structure that tests can see: `the stepper marks completed, current and pending steps with text`, `the decision buttons keep their accessible names`.
- [ ] **Step 3: Implement** the restyle; remove local class constants for buttons and inputs.
- [ ] **Step 4: Run** `pnpm test`, `npx tsc --noEmit`, `pnpm build`. Expected: PASS (existing tests unchanged).
- [ ] **Step 5: Commit** `feat: restyle run components`.

---

### Task 8: Settings and setup

**Files:**
- Modify: `src/views/Settings.tsx`, `src/views/Setup.tsx`, `src/components/ConnectionsSection.tsx`, `AgentSection.tsx`, `InstructionsSection.tsx`, `BaseBranchSection.tsx`, `AgentCommandsSection.tsx`, `TemplatesSection.tsx`, `LocalReposSection.tsx`, `ProjectOverridesSection.tsx`, `OverridesEditor.tsx`, `GitSourceForm.tsx`, `TestCommandButton.tsx`, `AutoTextarea.tsx`

**Interfaces:**
- Consumes: Tasks 1 to 3.
- Produces: `Settings` uses `PageHeader` (title "Settings", the "Run setup again" link as a secondary button) and each section is a `Card` with title and description; Advanced stays a collapsible with the same storage key, restyled as a disclosure card; form controls come from `Form.tsx`; the agent cards in `AgentSection` become selectable tiles with a check mark when selected (still `aria-pressed`); `Setup` is a centred card with a three-step progress indicator and the same step logic. No local `inputClass`/`buttonClass` constants remain in these files. All accessible names, ids and behaviour are unchanged.

- [ ] **Step 1: Confirm** `pnpm test` is green.
- [ ] **Step 2: Write failing tests** for new structure only: `settings sections are cards with headings`, `the setup wizard shows which step you are on`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test`, `npx tsc --noEmit`, `pnpm build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: restyle settings and setup`.

---

### Task 9: Consistency sweep

**Files:**
- Modify: any file still using ad-hoc styles

**Interfaces:**
- Consumes: everything above.
- Produces: a clean state: no remaining `inputClass`, `buttonClass` or `panelClass` constants (grep `src/`), no direct `indigo-` classes outside `App.css`, no leftover unused imports, focus rings on every interactive element (checkboxes and `details` summaries included), `motion-reduce` on every animation, nothing wider than the viewport at 960 px by inspection of the class lists (truncation on titles, branches, paths; `min-w-0` on flex children).

- [ ] **Step 1: Write failing checks** as tests where they can be tests: a test that scans `src/` source text for forbidden patterns (`indigo-` outside `App.css`, the removed constant names) and fails with the list of offenders.
- [ ] **Step 2: Run** `pnpm test src/lib/styleRules.test.ts`. Expected: FAIL with offenders listed.
- [ ] **Step 3: Fix** the offenders.
- [ ] **Step 4: Run** `pnpm test`, `npx tsc --noEmit`, `pnpm build`, and `cd src-tauri && cargo test` (the Rust side is untouched but must stay green). Expected: PASS.
- [ ] **Step 5: Commit** `chore: ui consistency sweep`.
