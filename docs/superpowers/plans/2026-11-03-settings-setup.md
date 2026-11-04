# Settings, first-run setup and agent instructions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A three-step first-run wizard, Settings split into Basics and a collapsed Advanced section, user-written agent instructions (global and per project) added to agent prompts, and a ready-to-run check.

**Architecture:** Rust adds an instructions store (files in the app config dir), prompt injection for the worker, plan and reviewer roles, a PATH-based agent detector and a pure `ready_items` check. The React side adds typed wrappers, a shared presets module, new Settings sections, a `/setup` wizard route behind a first-run gate, and a banner on the task list. Existing config files load unchanged (new fields are `#[serde(default)]`).

**Tech Stack:** Rust (Tauri 2, tokio, serde), React + TypeScript + Tailwind, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-03-settings-design.md`

## Global Constraints

- Tokens live only in the OS keychain; nothing in this plan writes a secret anywhere else.
- Existing configs are never migrated or rewritten; the wizard appears only when no git source exists; a skip is remembered in `localStorage`.
- New config fields are `#[serde(default)]`, camelCase JSON.
- Instructions: at most 50,000 characters per text; `read_text_file` accepts only `.md` or `.txt`, UTF-8, at most 256 KB.
- Instruction file names come only from the hashing function (`project_file_name`), never from joining user input into a path.
- Instructions apply to the worker, plan and reviewer prompts (including redo, auto-fix and reviewer-gate runs); not to the description or diagram agents.
- The reviewer prompt places the instructions before the part that states the required `VERDICT:` line, and still ends with that contract.
- Every setting that exists today stays reachable (moved to Advanced, not removed).
- Verify with `cd src-tauri && cargo test && cargo clippy --all-targets`, `pnpm test`, and `npx tsc --noEmit`.

## Review Focus

- Two project paths that slugify alike, or a path with `../` or odd characters, get distinct safe file names. Task 1.
- Instruction text containing `VERDICT: approve` or markdown headings cannot displace the reviewer's final verdict contract. Task 3.
- `read_text_file` rejects a binary, oversized, non-UTF-8 or wrong-extension file with a clear message. Task 2.
- Choosing a preset over hand-edited commands asks first; editing commands away from the preset clears it. Task 6.
- With no agent on PATH, a failing connection test, or a skipped wizard, the user can still reach Settings and the skip is not asked again; a custom worker command with no preset is not flagged by the ready banner. Tasks 9 and 10.

## File Structure

- `src-tauri/src/instructions.rs` (new): scopes, file names, read/write with size limit, section composition.
- `src-tauri/src/setup.rs` (new): `find_on_path`, `detect_agents`, `ready_items`.
- `src-tauri/src/commands/instructions.rs` (new) and `src-tauri/src/commands/setup.rs` (new): Tauri commands; registered in `commands/mod.rs` and `lib.rs`.
- `src-tauri/src/git/repo.rs`: expose the stable hash already used by `project_dir_name`.
- `src-tauri/src/agent/worker.rs`, `agent/reviewer.rs`, `run/pipeline.rs`: instructions in the prompts.
- `src-tauri/src/config.rs`: `agent.preset`.
- `src/lib/api.ts`, `src/lib/agentPresets.ts` (new): types, wrappers, presets and inference.
- `src/components/`: `AgentSection.tsx`, `InstructionsSection.tsx`, `ConnectionsSection.tsx`, `BaseBranchSection.tsx` (new); `AgentCommandsSection.tsx`, `TemplatesSection.tsx`, `LocalReposSection.tsx` (modified).
- `src/views/Settings.tsx` (rewrite), `src/views/Setup.tsx` (new), `src/App.tsx`, `src/views/TaskList.tsx`.

---

### Task 1: Instructions storage

**Files:**
- Create: `src-tauri/src/instructions.rs` (add `pub mod instructions;` to `lib.rs`)
- Modify: `src-tauri/src/git/repo.rs` (make the FNV hash in `project_dir_name` a `pub(crate) fn stable_hash(text: &str) -> u32` used by both)
- Test: `mod tests` in `instructions.rs`

**Interfaces:**
- Produces:
  - `pub const MAX_CHARS: usize = 50_000;`
  - `#[derive(Deserialize)] #[serde(tag = "kind", rename_all = "camelCase")] pub enum Scope { Global, #[serde(rename_all = "camelCase")] Project { source_id: String, project_path: String } }`
  - `pub fn project_file_name(source_id: &str, project_path: &str) -> String`: only `[A-Za-z0-9_-]` plus `.md`, at most 120 characters (the readable slug is truncated, the hash suffix is kept), different for different (source, path) pairs.
  - `pub fn scope_path(dir: &Path, scope: &Scope) -> PathBuf`: `dir/global.md` or `dir/projects/<project_file_name>`.
  - `pub fn read(dir: &Path, scope: &Scope) -> Result<String, String>` (missing file gives `""`), `pub fn write(dir: &Path, scope: &Scope, text: &str) -> Result<(), String>` (error over `MAX_CHARS`; empty text deletes the file; creates directories).
  - `pub struct InstructionsDir(pub PathBuf);` (Tauri managed state holding the instructions directory, so tests can point it at a temporary folder instead of the real config dir) and `pub fn dir<R: Runtime>(app: &AppHandle<R>) -> PathBuf` returning a clone of `app.state::<InstructionsDir>().0`.
  - `pub fn compose(global: &str, project: &str) -> Option<String>`: `None` when both are blank; otherwise the line `## Instructions from the user`, then `\n\n<global>` if the global text is non-blank, then `\n\n### For this project\n\n<project>` if the project text is non-blank (texts trimmed).

- [ ] **Step 1: Write failing tests** `project_file_name_is_safe_for_odd_paths` (inputs `../../etc/passwd`, `a b/ü`, `a/b` vs `a-b`: all match `^[A-Za-z0-9_-]+\.md$`, `a/b` and `a-b` differ, length at most 120 for a 500-character path), `same_path_on_two_sources_differs`, `write_then_read_round_trips_and_empty_text_removes_the_file`, `write_rejects_text_over_the_limit`, `reading_a_missing_scope_gives_empty_text`, `compose_orders_global_before_project_and_omits_empty_parts`.
- [ ] **Step 2: Run** `cd src-tauri && cargo test instructions::`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the items above; the slug uses `slugify_project_path` on `"{source_id}/{project_path}"`.
- [ ] **Step 4: Run** the tests, then `cargo test && cargo clippy --all-targets`. Expected: PASS (unused warnings until Task 2 are acceptable).
- [ ] **Step 5: Commit** `feat: agent instructions storage`.

---

### Task 2: Instruction commands and file import

**Files:**
- Create: `src-tauri/src/commands/instructions.rs`
- Modify: `src-tauri/src/commands/mod.rs`, `src-tauri/src/lib.rs` (register)
- Test: `mod tests` in the new file

**Interfaces:**
- Consumes: Task 1.
- Produces commands: `get_instructions(app: AppHandle, scope: Scope) -> Result<String, String>`, `set_instructions(app: AppHandle, scope: Scope, text: String) -> Result<(), String>`, `read_text_file(path: String) -> Result<String, String>`. The directory is `instructions::dir(&app)`; this task registers `InstructionsDir(app_config_dir()?.join("instructions"))` as managed state where `lib.rs` sets up the other managed state.
- `fn read_text_file_checked(path: &Path) -> Result<String, String>` (pure, testable): requires extension `md` or `txt` (case-insensitive), a regular file (follows symlinks), size at most 256 KB, valid UTF-8; each failure has its own message.

- [ ] **Step 1: Write failing tests** `a_markdown_file_is_read`, `other_extensions_are_refused`, `a_file_over_256_kb_is_refused`, `invalid_utf8_is_refused`, `a_directory_is_refused`, `a_missing_file_gives_a_clear_error`.
- [ ] **Step 2: Run** `cargo test commands::instructions`. Expected: FAIL.
- [ ] **Step 3: Implement** the three commands and `read_text_file_checked`; register them in `generate_handler!`.
- [ ] **Step 4: Run** `cargo test && cargo clippy --all-targets`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: instruction commands`.

---

### Task 3: Instructions in the prompts

**Files:**
- Modify: `src-tauri/src/agent/worker.rs`, `src-tauri/src/agent/reviewer.rs`, `src-tauri/src/run/pipeline.rs`, `src-tauri/src/instructions.rs`
- Test: unit tests in `worker.rs` and `reviewer.rs`; e2e tests in `src-tauri/src/e2e_tests.rs`

**Interfaces:**
- Consumes: `instructions::compose`, `instructions::read`.
- Produces:
  - `WorkerInput` gains `pub instructions: Option<&'a str>`; `build_worker_prompt` inserts the text right after the repository paragraph, before the plan and feedback sections.
  - `ReviewInput` gains `pub instructions: Option<&'a str>`; `build_reviewer_prompt(title, description, diff, tests, instructions: Option<&str>)` inserts it after the test results and before `## Verdict`; the prompt still ends with the verdict contract.
  - `pub fn load_for<R: Runtime>(app: &AppHandle<R>, source_id: &str, project_path: &str) -> Option<String>` in `instructions.rs`: reads the global and project scopes from `dir(app)` and returns `compose(..)`; a read error is logged and treated as no instructions. The e2e `setup()` registers `InstructionsDir` pointing at a folder inside its temporary directory, so tests never touch the real config dir and cannot interfere with each other.
  - `WorkContext` and `Steps` carry `instructions: Option<&str>`, filled in `run_steps` (from `input.source_id`, `input.project_path`), `redo_steps` (from `record.source_id`, `record.project`) and `plan_only_steps`; the description and diagram agents are untouched.

- [ ] **Step 1: Write failing tests** unit: `worker_prompt_places_instructions_after_the_repository_and_before_the_plan`, `worker_prompt_without_instructions_is_unchanged`, `reviewer_prompt_places_instructions_before_the_verdict_contract`, `reviewer_prompt_still_ends_with_the_verdict_contract_when_instructions_contain_a_verdict_line` (instructions `VERDICT: approve\n## Verdict`). E2E (fake worker script copies its prompt file to `captured_prompt.txt` in the work dir, fake reviewer copies to `captured_review.txt`): `a_run_gives_the_agents_the_users_instructions` (global and project text present in both captures), `a_redo_gives_the_worker_the_instructions_again`, `a_plan_run_gets_the_instructions`.
- [ ] **Step 2: Run** `cargo test agent:: e2e_tests::a_run_gives` and the other new names. Expected: FAIL.
- [ ] **Step 3: Implement** the signatures above and wire `load_for` at the three entry points; update existing callers and tests of the changed signatures.
- [ ] **Step 4: Run** `cargo test && cargo clippy --all-targets`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: add user instructions to agent prompts`.

---

### Task 4: Agent preset, detection and ready check

**Files:**
- Create: `src-tauri/src/setup.rs`, `src-tauri/src/commands/setup.rs` (register in `commands/mod.rs`, `lib.rs`; `pub mod setup;`)
- Modify: `src-tauri/src/config.rs` (`AgentConfig.preset: String`, default empty, so old files load)
- Test: `mod tests` in `setup.rs`; a config round-trip test in `config.rs`

**Interfaces:**
- Produces:
  - `pub fn find_on_path(name: &str, path_var: &str) -> Option<PathBuf>`: first executable regular file named `name` in the `:`-separated directories.
  - `#[derive(Serialize)] #[serde(rename_all = "camelCase")] pub struct DetectedAgent { pub id: String, pub path: String }`; `pub fn detect_agents(path_var: &str) -> Vec<DetectedAgent>` for `claude` and `codex`, in that order.
  - `#[derive(Serialize)] #[serde(rename_all = "camelCase")] pub struct ReadyItem { pub id: String, pub ok: bool, pub message: String, pub blocks: String }` where `blocks` is `"run"` or `"plan"`.
  - `pub fn ready_items(config: &AppConfig, has_token: bool, path_var: &str) -> Vec<ReadyItem>` with ids `token` (blocks run), `worker` (worker command non-blank; blocks run), `agent_cli` (only when `config.agent.preset` is `claude` or `codex`: that binary found on PATH; blocks run; no item otherwise), `plan` (plan command non-blank; blocks plan).
  - Commands: `detect_agent_clis() -> Vec<DetectedAgent>` (uses the process `PATH`), `check_ready(app: AppHandle, source_id: String) -> Result<Vec<ReadyItem>, String>` (loads config, applies `resolved_for(&source_id, "")`, `secrets::has_token`).

- [ ] **Step 1: Write failing tests** `finds_an_executable_on_the_path`, `ignores_a_non_executable_file_and_a_missing_name`, `detects_both_agents_in_order`, `ready_when_token_worker_and_cli_present`, `a_custom_worker_without_a_preset_is_ready`, `missing_token_blocks_run`, `a_preset_whose_cli_is_not_on_path_blocks_run`, `an_empty_plan_command_blocks_only_plan`, `an_old_config_without_a_preset_loads_with_an_empty_one`.
- [ ] **Step 2: Run** `cargo test setup:: config::`. Expected: FAIL.
- [ ] **Step 3: Implement** all of the above and register the two commands.
- [ ] **Step 4: Run** `cargo test && cargo clippy --all-targets`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: agent detection and ready check`.

---

### Task 5: Frontend API and presets

**Files:**
- Modify: `src/lib/api.ts`, `src/components/AgentCommandsSection.tsx`
- Create: `src/lib/agentPresets.ts`, `src/lib/agentPresets.test.ts`

**Interfaces:**
- Produces in `api.ts`: `AgentConfig.preset: string`; `type InstructionScope = { kind: "global" } | { kind: "project"; sourceId: string; projectPath: string }`; `interface DetectedAgent { id: string; path: string }`; `interface ReadyItem { id: string; ok: boolean; message: string; blocks: "run" | "plan" }`; wrappers `getInstructions(scope)`, `setInstructions(scope, text)`, `readTextFile(path)`, `detectAgentClis()`, `checkReady(sourceId)`.
- Produces in `agentPresets.ts`: `agentPresets` (the two existing presets moved out of `AgentCommandsSection.tsx`, each `{ id: "claude" | "codex", label, worker, readOnly }`), `inferPreset(agent: Pick<AgentConfig, "workerCmd" | "reviewerCmd" | "planCmd" | "descriptionCmd">): "claude" | "codex" | ""`, `applyPreset(agent: AgentConfig, id: "claude" | "codex"): AgentConfig` (sets the four commands and `preset`, touches nothing else).
- `AgentCommandsSection` imports the presets from the new module and sets `agent.preset = inferPreset(commands)` when it saves.

- [ ] **Step 1: Write failing tests** `inferPreset recognises each preset and returns an empty string for edited commands`, `applyPreset sets the four commands and the preset and leaves prompt files and the credential alone`.
- [ ] **Step 2: Run** `pnpm test src/lib/agentPresets.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the module and wrappers; update existing test fixtures and mocks if `tsc` requires.
- [ ] **Step 4: Run** `pnpm test` and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: client api and presets for setup`.

---

### Task 6: Agent section in Basics

**Files:**
- Create: `src/components/AgentSection.tsx`, `src/components/AgentSection.test.tsx`
- Modify: `src/components/AgentCommandsSection.tsx` (remove its preset dropdown; keep the commands)

**Interfaces:**
- Consumes: Task 5, `testAgentCommand`, `detectAgentClis`.
- Produces: `AgentSection({ config, onChange }: { config: AppConfig; onChange: (next: AppConfig) => Promise<void> })`: one card per preset (label, "Detected" or "Not found on PATH" from `detectAgentClis`), the selected card from `config.agent.preset`, and a "Test agent" button running `testAgentCommand(config.agent.workerCmd)`. Choosing a preset calls `onChange({ ...config, agent: applyPreset(config.agent, id) })` directly, except when the four commands are non-empty and `inferPreset` of them is `""` (hand-edited): then an inline confirmation ("Replace your edited commands?") must be accepted first. A "Custom" card shows when `preset` is empty and commands exist, with the text "Edit the commands under Advanced" (no link).

- [ ] **Step 1: Write failing tests** `choosing a preset saves its commands and preset`, `choosing a preset over hand-edited commands asks first and does nothing on cancel`, `a preset that is not on PATH is labelled`, `test agent runs the worker command and shows the result`.
- [ ] **Step 2: Run** `pnpm test src/components/AgentSection.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** the component in the style of the existing sections.
- [ ] **Step 4: Run** `pnpm test` and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: agent section`.

---

### Task 7: Instructions section

**Files:**
- Create: `src/components/InstructionsSection.tsx`, `src/components/InstructionsSection.test.tsx`

**Interfaces:**
- Consumes: Task 5 wrappers, `@tauri-apps/plugin-dialog` `open` (as `LocalReposSection` does), `config.gitSources`, `listRuns`.
- Produces: `InstructionsSection({ config }: { config: AppConfig })`: a "Global" markdown textarea with Save and "Import file..." (picks a `.md`/`.txt`, calls `readTextFile`, puts the text in the textarea without saving); below it a select of known projects (distinct `sourceId` + project from `listRuns()`, labelled with the source name) with the same editor for that project's scope. Save errors (including the 50,000 character limit) are shown next to the editor and the text is kept.

- [ ] **Step 1: Write failing tests** `loads and saves the global instructions`, `import fills the editor but does not save`, `a project editor uses the source and project path scope`, `a save error keeps the text and shows the message`.
- [ ] **Step 2: Run** `pnpm test src/components/InstructionsSection.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test` and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: instructions section`.

---

### Task 8: Settings page: Basics and Advanced

**Files:**
- Create: `src/components/ConnectionsSection.tsx` (the source list, add form and remove logic now inside `Settings.tsx`), `src/components/BaseBranchSection.tsx`
- Modify: `src/views/Settings.tsx`, `src/components/TemplatesSection.tsx` (remove the base branch field), `src/components/LocalReposSection.tsx` (heading "Project checkouts", one explanatory line: without an entry the app uses its own clone)
- Test: `src/views/Settings.test.tsx` (new)

**Interfaces:**
- Produces: `Settings` renders Basics (`ConnectionsSection`, `AgentSection`, `InstructionsSection`, `BaseBranchSection`) and then a collapsed "Advanced" `<details>` (open state kept in `localStorage` key `settings-advanced-open`) containing, in this order: `AgentCommandsSection`, `TemplatesSection`, `ProjectOverridesSection`, `LocalReposSection`. Per-source overrides stay inside each connection. A "Run setup again" link goes to `/setup`. `BaseBranchSection({ config, onChange })` saves `baseBranch` only. `ConnectionsSection({ config, onChange }: { config: AppConfig; onChange: (next: AppConfig) => Promise<void> })` owns the add, remove and per-source overrides logic that is in `Settings.tsx` today; `Settings` keeps the loading and error states.

- [ ] **Step 1: Write failing tests** `basics are visible and advanced is collapsed by default`, `every previous section is reachable inside advanced`, `the advanced state is remembered`, `base branch saves from basics`.
- [ ] **Step 2: Run** `pnpm test src/views/Settings.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** the extraction and the new layout; keep behaviour of moved code unchanged (add and remove sources, token handling).
- [ ] **Step 4: Run** `pnpm test` and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: settings basics and advanced`.

---

### Task 9: Setup wizard and first-run gate

**Files:**
- Create: `src/views/Setup.tsx`, `src/views/Setup.test.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `testConnection`, `setToken`, `removeToken`, `saveConfig` via `useConfig().update`, `detectAgentClis`, `applyPreset`, `testAgentCommand`.
- Produces: route `/setup` rendering `Setup` with three steps. Step 1: provider, base URL (prefilled `https://gitlab.com` or `https://github.com` when the provider changes and the field is untouched), token, name derived from the URL host; Continue is disabled until `testConnection` has succeeded for the current values; Continue saves like `Settings.handleAdd` (token first, config second, token removed if saving fails). Step 2: one card per detected agent (selecting calls `applyPreset`), a message and a "Custom commands in Settings" link when none is detected, optional "Test agent". Step 3: summary and a button to `/tasks`. "I'll set it up myself" on every step stores `localStorage` key `setup-skipped` = `"1"` and navigates to `/settings`.
- `App.tsx`: the `/tasks` route element is wrapped by a gate that redirects to `/setup` when the config is loaded, `gitSources` is empty and `setup-skipped` is not set. The gate renders nothing while the config loads. The gate is the route element itself (not a wrapper kept mounted across routes), so it fetches the config afresh each time `/tasks` is entered; otherwise a gate holding a stale "no sources" config would bounce the user back to `/setup` right after finishing it.

- [ ] **Step 1: Write failing tests** `continue is disabled until the connection test passes`, `changing a field after a passing test disables continue again`, `saving the source stores the token first and removes it if the config save fails`, `a detected agent can be chosen and fills the preset`, `with no agent detected the step explains and still allows finishing`, `skipping goes to settings and remembers the skip`, `the gate redirects to setup only when there are no sources and no skip`, `finishing the wizard and opening tasks does not redirect back to setup`.
- [ ] **Step 2: Run** `pnpm test src/views/Setup.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test` and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: first-run setup wizard`.

---

### Task 10: Ready-to-run banner

**Files:**
- Modify: `src/views/TaskList.tsx`
- Create: `src/components/ReadyBanner.tsx`, `src/components/ReadyBanner.test.tsx`

**Interfaces:**
- Consumes: `checkReady(sourceId)`.
- Produces: `ReadyBanner({ items, ...})`-style component and a `useReady(sourceId)` hook (re-checks when the source changes and when the window regains focus) used by `TaskList`. Items with `ok: false` are listed with a link: `token` goes to `/settings` (Connections), `worker` and `agent_cli` go to `/settings` (Agent), `plan` is listed only as a note. While any `blocks: "run"` item fails, the Run, "Run selected" and plan buttons are disabled with the first message as `title`; while only a `blocks: "plan"` item fails, only the Plan button is disabled. When `checkReady` itself fails, no banner is shown and the buttons stay enabled.

- [ ] **Step 1: Write failing tests** `nothing is shown when every item is ok`, `a failing run item disables run buttons with the reason`, `a failing plan item disables only the plan button`, `a failed check leaves the buttons enabled`, `a custom worker command without a preset shows no banner`.
- [ ] **Step 2: Run** `pnpm test src/components/ReadyBanner.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** and wire it into `TaskList.tsx`.
- [ ] **Step 4: Run** `pnpm test`, `npx tsc --noEmit`, and `cd src-tauri && cargo test && cargo clippy --all-targets`. Expected: all PASS.
- [ ] **Step 5: Manual check** with `pnpm tauri dev`: wizard on a fresh config directory, Settings layout, instructions reaching a real run's prompt, banner states.
- [ ] **Step 6: Commit** `feat: ready-to-run banner`.
