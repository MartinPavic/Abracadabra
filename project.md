## Abracadabra

### 1. Project idea

A desktop app that turns assigned GitLab/GitHub issues into reviewed, ready-to-push branches with minimal manual effort:

- Fetch open issues/tasks assigned to me, or belonging to a project I select.
- On demand (button press), run an automated pipeline per selected task:
  1. Read the task/issue description (and comments/acceptance criteria).
  2. **Worker agent** — implements the task in a local checkout.
  3. **Reviewer agent** — reviews the worker's changes against the task description.
  4. Prepare a git branch and commit(s) for the change.
  5. Present the result in the app as a point-by-point summary of what was done, and ask for human approval:
     - **Yes** — accept and keep the branch/commits.
     - **No** — discard the attempt.
     - **Redo automatically** — send feedback back to the worker agent for another pass.
     - **Redo manually** — open the branch in the local codebase/editor for the human to finish.
- UI should be clean, modern, and simple — not cluttered with options.
- Git source is configurable per project (GitLab or GitHub, with base URL + token).
- If a connection times out, warn the user and suggest checking whether their VPN is on.

### 2. Implementation plan

Turns the idea above into a phased build for a Tauri + React desktop app that pulls GitLab issues, runs a worker/reviewer CLI coding agent pipeline in an isolated `git worktree`, and gates the result behind a human approval UI.

**Decisions locked**
- Stack: Tauri (Rust backend) + React/Vite frontend.
- Agent engine: shell out to an existing CLI coding agent (e.g. GitHub Copilot CLI / Claude Code / Aider — command configurable, not hardcoded to one vendor).
- MVP git provider: GitLab only first; GitHub support added after MVP works end-to-end (reuse a provider-abstraction interface so GitHub is additive, not a rewrite).
- Local git ops: shell out to system `git` CLI (no libgit2/isomorphic-git dependency).

**Phases**

#### Phase 0 — Scaffolding & config foundation
1. Init Tauri project: Rust backend (`src-tauri/src/`), React+Vite frontend (`src/`), TypeScript, basic routing (Settings / Task List / Task Run views).
2. Define app config schema (JSON/TOML) for: git source(s) (provider, base URL, project/group filter), agent CLI command + args template, branch/commit naming templates, timeout/retry settings.
3. Secure token storage: use OS keychain via Tauri plugin (`tauri-plugin-stronghold` or `keyring` crate) instead of plaintext config file for GitLab PAT.
4. Basic app shell UI (nav, empty states) with a simple/modern component library (e.g. Tailwind or a minimal design system) — no business logic yet.

#### Phase 1 — GitLab integration & task list *(depends on Phase 0)*
1. Rust backend: GitLab REST/GraphQL client (via `reqwest`) — fetch issues assigned to current user, and issues for a selected project/group; handle pagination.
2. Settings UI: add/edit GitLab connection (base URL + PAT), "Test connection" action that surfaces auth/network errors distinctly.
3. Timeout/network-error handling: wrap GitLab calls with a retry+backoff helper; on final failure, show the "check your VPN" warning specifically for connect-timeout style errors (distinguish from 401/403).
4. Task List UI: table/list of fetched issues with title, project, labels; filter by project and search by title; manual refresh button.

#### Phase 2 — Agent pipeline & git worktree isolation *(depends on Phase 1)*
1. Local repo manager: given a task's project, ensure a local clone exists (clone if missing, fetch/pull if present) — shell out to `git`.
2. Per-task isolated workspace: create a `git worktree` on a new branch named from a configurable template (e.g. `taskdoer/{issue-iid}-{slug}`) before running any agent.
3. Worker step: build the agent CLI invocation (task description + repo path as args/stdin per configured template), spawn it as a child process from Rust (`tokio::process::Command`), stream stdout/stderr back to the frontend.
4. Reviewer step: run a second, separately-configured agent CLI invocation whose prompt includes the original task description + the worker's diff, capturing its verdict/notes as text.
5. Git finalize step: `git add`/`git commit` (message from template referencing the issue), leave branch checked out in the worktree; do not push yet.
6. Per-step status model (fetch → clone/worktree → worker → reviewer → git commit → awaiting approval → done/failed) surfaced to the frontend via Tauri events.

#### Phase 3 — Approval UI *(depends on Phase 2)*
1. Run summary view: point-by-point breakdown of what the worker did (parsed from its output/commit message) + reviewer's notes.
2. Diff viewer: show the committed changes (`git diff` against the base branch) inline, file-by-file.
3. Approval actions:
   - **Yes** — mark run approved, branch/commit retained (ready for later push/MR, see Phase 5).
   - **No** — delete the worktree/branch, mark run discarded.
   - **Redo automatically** — prompt user for optional extra feedback text, re-run Phase 2 steps 3–5 with that feedback appended to the worker prompt, reusing the same worktree/branch.
   - **Redo manually** — open the worktree path in the user's configured editor/file manager (Tauri `open` API) and mark run as "handed off".
4. Run history list: persist each run's task id, status, timestamps, and final decision to local storage (SQLite via `tauri-plugin-sql` or a simple JSON store) so history survives app restart.

#### Phase 4 — Reliability, notifications, polish *(depends on Phase 3, can split across parallel workstreams)*
1. Desktop notification (Tauri notification API) when a run reaches "awaiting approval" or "failed" while the app is unfocused.
2. Concurrency control: allow queuing multiple tasks with a configurable max-parallel-runs limit (each in its own worktree).
3. Dry-run mode: optional flag that runs the worker agent in "plan only" mode (if the underlying CLI supports it) and shows the plan before committing to a full run.
4. Settings polish: per-project overrides for agent command/prompt, branch/commit templates.

#### Phase 5 — GitHub support & stretch features *(depends on Phase 1's provider abstraction, independent of Phase 2-4 internals)*
1. Implement the same provider interface used for GitLab for GitHub (REST/GraphQL via `octocrab` or `reqwest`), reusing the Task List/Settings UI.
2. **Push & create MR/PR** — explicit manual button on an approved run (not automatic on "Yes"), triggering:
   - `git push` the run's branch to `origin`.
   - Create an MR/PR via the provider API, with a description generated from a configurable template populated with a summary of changes (e.g. worker's point-by-point summary, files changed, reviewer notes), linking back to the source issue.
   - Button only enabled once a run is in "approved" state; surface push/MR-creation errors (e.g. remote rejected, branch protection) inline rather than silently failing.
3. Optional test/lint hook: run project's test command after the worker step and include pass/fail in the reviewer's context and the approval summary.

**Relevant files (new project, initial structure to create)**
- `src-tauri/Cargo.toml`, `src-tauri/src/main.rs` — Tauri app entry, command registration.
- `src-tauri/src/git/` — git CLI wrapper (clone/fetch/worktree/commit/diff).
- `src-tauri/src/providers/gitlab.rs` (Phase 1), `src-tauri/src/providers/github.rs` (Phase 5), behind a shared `Provider` trait.
- `src-tauri/src/agent/` — CLI agent process spawning + streaming for worker/reviewer.
- `src-tauri/src/config.rs`, `src-tauri/src/secrets.rs` — config schema + keychain-backed token storage.
- `src/views/Settings.tsx`, `src/views/TaskList.tsx`, `src/views/TaskRun.tsx` — main frontend views.
- `src/components/DiffViewer.tsx`, `src/components/RunSummary.tsx`, `src/components/ApprovalActions.tsx`.

**Verification**
1. Phase 0: app launches (`pnpm tauri dev`), navigates between empty views, config file + keychain entry created/read round-trip works.
2. Phase 1: settings "Test connection" succeeds against a real GitLab token; task list populates from a real project; simulate a timeout (e.g. block the host) to confirm the VPN warning path triggers instead of a generic error.
3. Phase 2: manually trigger a run against a throwaway GitLab issue/repo; confirm a real worktree + branch + commit is created and the agent CLI output streams live in the UI.
4. Phase 3: exercise all four approval actions once each against a completed run; confirm run history persists after app restart.
5. Phase 4: run two tasks concurrently and confirm isolation (no cross-contamination of worktrees); confirm notification fires when app is backgrounded.
6. Phase 5: repeat Phase 1–3 verification against a GitHub repo/token.

**Further considerations**
1. Which CLI coding agent to standardize the default config on (Copilot CLI vs Claude Code vs Aider) — recommend making it a free-text command template from day one so this is a config choice, not a hardcoded integration, avoiding lock-in.
2. Push/MR creation is Phase 5 stretch, explicitly manual (a dedicated "Push & create MR" button on an approved run) rather than automatic on "Yes" — keeps local-only as the default after approval, pushing/MR is an extra deliberate step.
