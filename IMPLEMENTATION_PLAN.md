# Abracadabra — Detailed Implementation Plan

Step-by-step build plan expanding the phases in [project.md](project.md). Each phase lists concrete tasks in build order, the commands/files involved, and a "done when" check. Work through phases in order — later phases depend on earlier ones unless noted.

Stack: **Tauri (Rust) + React/Vite (TypeScript)**, GitLab-first, CLI coding agent shelled out to, system `git` CLI for all git operations.

---

## Phase 0 — Scaffolding & config foundation

1. **Init the Tauri + React project**
   - `pnpm create tauri-app task-doer --template react-ts`
   - Verify `pnpm tauri dev` opens an empty window.
2. **Set up project layout**
   - `src-tauri/src/main.rs` — entry point, Tauri builder, plugin registration.
   - `src-tauri/src/commands/` — one file per Tauri command group (`config.rs`, `providers.rs`, `runs.rs`).
   - `src-tauri/src/git/mod.rs` — git CLI wrapper module (empty stub for now).
   - `src-tauri/src/config.rs` — config struct + load/save.
   - `src-tauri/src/secrets.rs` — token storage wrapper.
   - `src/views/`, `src/components/`, `src/lib/api.ts` (typed wrapper around `invoke`).
3. **Routing/nav shell**
   - Add a router (`react-router-dom`) with routes: `/settings`, `/tasks`, `/tasks/:id`.
   - Sidebar/topbar nav with placeholder empty-state pages.
   - Pick a UI kit (Tailwind + headless components, or a small kit like `shadcn/ui`) and wire up base styling/theme (light/dark).
4. **Config schema + persistence**
   - Define `AppConfig` struct in `config.rs`: `git_sources: Vec<GitSourceConfig>`, `agent: AgentConfig { worker_cmd, reviewer_cmd }`, `branch_template`, `commit_template`, `timeouts`.
   - Serialize as JSON to Tauri's app-config dir (`tauri::api::path::app_config_dir`).
   - Tauri commands: `get_config`, `save_config`.
   - Frontend: a `useConfig()` hook calling these.
5. **Secure token storage**
   - Add `keyring` crate (`cargo add keyring`) to store PAT per git source, keyed by source id; config file stores only non-secret fields + a reference id.
   - Commands: `set_token(source_id, token)`, `has_token(source_id)` (never return the raw token to the frontend unless explicitly needed for a "reveal" action).
6. **Done when:** app launches, Settings page can create a dummy git source entry with a token, restart the app and confirm the entry (but not the raw token) reloads from disk, and the token itself round-trips through `keyring` (verify via a "test read" debug command, then remove it).

---

## Phase 1 — GitLab integration & task list

*(depends on Phase 0)*

1. **GitLab API client**
   - `cargo add reqwest --features json,rustls-tls` and `cargo add serde --features derive`.
   - `src-tauri/src/providers/mod.rs` — define a `Provider` trait: `async fn list_my_issues(&self) -> Result<Vec<Task>>`, `async fn list_project_issues(&self, project: &str) -> Result<Vec<Task>>`, `async fn test_connection(&self) -> Result<()>`.
   - `src-tauri/src/providers/gitlab.rs` — implement `Provider` using GitLab REST v4 (`/api/v4/issues?scope=assigned_to_me`, `/api/v4/projects/:id/issues`), auth via `PRIVATE-TOKEN` header.
   - Handle pagination via `Link`/`X-Next-Page` headers.
2. **Settings UI — git source form**
   - Form fields: name, provider (GitLab/GitHub — GitHub disabled/greyed until Phase 5), base URL, token, optional project/group filter.
   - "Test connection" button → calls `test_connection` command → shows success or a categorized error (auth vs network vs timeout).
3. **Network error handling**
   - Wrap all provider HTTP calls in a retry helper: N attempts with exponential backoff, only retrying on connect/timeout errors (not on 4xx).
   - On final failure, if the error is a connect-timeout, return a distinct `TimeoutError` variant; frontend renders "Could not reach <host> — check your VPN connection" specifically for this variant, generic message otherwise.
4. **Task List view**
   - Command `list_tasks(source_id)` → returns `Vec<Task>` (id, title, project, labels, url, updated_at).
   - UI: table with search box (client-side filter on title) and a project/label filter dropdown; manual "Refresh" button with loading state.
5. **Done when:** pointing the app at a real GitLab instance + PAT lists real assigned issues, "Test connection" correctly distinguishes a bad token from a bad/unreachable host, and search/filter work against the fetched list.

---

## Phase 2 — Agent pipeline & git worktree isolation

*(depends on Phase 1)*

1. **Local repo manager**
   - `src-tauri/src/git/repo.rs`: `ensure_clone(project_url, local_path)` — `git clone` if missing, else `git fetch`.
   - Store clones under an app-data subfolder, one directory per project (slugified from project path/namespace).
2. **Worktree + branch creation**
   - `src-tauri/src/git/worktree.rs`: `create_worktree(repo_path, branch_name, worktree_path)` running `git worktree add -b <branch> <path> origin/<base>`.
   - Branch name built from the configurable template (default `taskdoer/{issue_iid}-{slug(title)}`).
   - Track active worktrees in an in-memory/DB map keyed by run id, for later cleanup on "No".
3. **Agent process runner**
   - `src-tauri/src/agent/runner.rs`: given a command template (e.g. `"claude-code --prompt {prompt_file} --cwd {cwd}"`), substitute placeholders, spawn with `tokio::process::Command`, capture stdout/stderr line-by-line.
   - Emit each line as a Tauri event (`agent://worker-output`, `agent://reviewer-output`) scoped by run id so the frontend can stream it live.
   - Write the task description (+ any extra feedback on redo) to a temp prompt file passed to the CLI.
4. **Worker step**
   - Build worker prompt: issue title + description + acceptance criteria + repo path.
   - Run agent runner with the worker command; on non-zero exit, mark run `failed` with captured stderr.
5. **Reviewer step**
   - Build reviewer prompt: original task description + `git diff` output from the worktree.
   - Run agent runner with the reviewer command; capture its text output as `review_notes`.
6. **Git finalize step**
   - `git -C <worktree> add -A && git -C <worktree> commit -m "<templated message>"`.
   - Commit message template default: `"{issue_ref}: {title}\n\n{worker_summary}"`.
7. **Run status machine**
   - States: `queued → cloning → working (worker) → reviewing → committing → awaiting_approval → approved/discarded/failed`.
   - Persist run state transitions with timestamps (see Phase 3 storage) and emit a `run://status` event on each transition.
8. **Done when:** triggering a run against a real throwaway GitLab issue produces an actual `git worktree`, a new branch, live-streamed worker/reviewer output in a debug console, and a real commit — verified with `git log`/`git worktree list` on disk.

---

## Phase 3 — Approval UI

*(depends on Phase 2)*

1. **Run storage**
   - Add `tauri-plugin-sql` with SQLite, or a simple JSON-lines append store if SQL feels heavy for v1.
   - Table/schema: `runs(id, task_id, project, branch, status, created_at, updated_at, decision, worker_summary, review_notes)`.
   - Commands: `list_runs()`, `get_run(id)`, `update_run_status(id, status)`.
2. **Task Run view**
   - Header: task title/link, current status pill, live step indicator (fetch → worker → reviewer → commit → approval).
   - Body: worker summary (parsed as bullet points from its output/commit message) + reviewer notes panel.
3. **Diff viewer component**
   - Command `get_run_diff(run_id)` → `git -C <worktree> diff <base>...HEAD --name-status` for the file list, then per-file `git diff` for content.
   - `src/components/DiffViewer.tsx` — file list + syntax-highlighted unified diff (e.g. via `react-diff-viewer` or a simple custom renderer).
4. **Approval actions component**
   - `src/components/ApprovalActions.tsx` with four buttons, disabled until status is `awaiting_approval`:
     - **Yes** → `approve_run(id)` → status `approved`.
     - **No** → `discard_run(id)` → removes worktree/branch (`git worktree remove --force`, `git branch -D`), status `discarded`.
     - **Redo automatically** → opens a small feedback textarea → `redo_run(id, feedback)` → re-enters worker step with feedback appended to prompt, reusing worktree/branch.
     - **Redo manually** → `open_in_editor(worktree_path)` (Tauri `opener` plugin) → status `handed_off`.
5. **Run history list**
   - `/tasks` page gets a "History" tab/section listing past runs with status badges, filter by status, link into the Task Run view (read-only for terminal states).
6. **Done when:** a full run can be approved, discarded, redone automatically (with feedback reflected in the next worker prompt), or handed off manually — and closing/reopening the app still shows the run in history with correct status.

---

## Phase 4 — Reliability, notifications, polish

*(depends on Phase 3; sub-items are independent of each other)*

1. **Desktop notifications**
   - Add Tauri notification permission/plugin; fire a notification on transition into `awaiting_approval` or `failed` only when the window is not focused.
2. **Concurrency control**
   - Add a `max_parallel_runs` config value; a simple in-process semaphore gating how many runs execute their worker/reviewer steps simultaneously (queued runs show `queued` status).
3. **Dry-run mode**
   - Add a per-run "Plan only" toggle before starting; if the agent CLI template supports a plan/dry-run flag, substitute it in and stop after showing the plan (no commit step).
4. **Per-project overrides**
   - Extend config schema so branch/commit templates and agent commands can be overridden per git source/project, falling back to global defaults.
5. **Done when:** two runs kicked off back-to-back are properly isolated and respect the concurrency limit, and a background notification appears when a run finishes while the app is minimized.

---

## Phase 5 — GitHub support & stretch features

*(GitHub work depends only on Phase 1's `Provider` trait; MR/PR work depends on Phase 3)*

1. **GitHub provider**
   - `cargo add octocrab` (or plain `reqwest` against GitHub REST v3).
   - `src-tauri/src/providers/github.rs` implementing the same `Provider` trait (assigned issues, repo issues, `test_connection`).
   - Enable GitHub option in the Settings git-source form.
2. **Push & create MR/PR button**
   - Enabled only when a run's status is `approved`.
   - `push_run(id)`: `git -C <worktree> push origin <branch>`; surface push errors (protected branch, rejected, auth) inline on the run view.
   - `create_merge_request(id)`: build description from a configurable template (placeholders: `{worker_summary}`, `{files_changed}`, `{review_notes}`, `{issue_ref}`); call GitLab "create MR" / GitHub "create PR" API; store the returned MR/PR URL on the run record and show it as a link.
3. **Optional test/lint hook**
   - Add a per-project `test_cmd` config; run it in the worktree after the worker step, capture pass/fail + output, feed into the reviewer prompt and show a pass/fail badge on the run view.
4. **Done when:** the same end-to-end flow (Phase 1–3) works against a GitHub repo/token, and clicking "Push & create MR" on an approved GitLab run produces a real MR with a populated description.

---

## Cross-cutting notes

- **Error taxonomy**: keep a single `AppError` enum in Rust (`Auth`, `Timeout`, `NotFound`, `GitFailure(String)`, `AgentFailure(String)`, `Other(String)`) serialized to the frontend so UI copy stays consistent across phases instead of showing raw error strings.
- **Testing**: unit-test the git wrapper and provider clients against a local throwaway GitLab project before wiring real UI flows each phase; avoid testing against real work issues until Phase 3 approval flow exists.
- **Security**: never log raw tokens; redact them in any debug/error output. Worktree paths and agent stdout may contain repo contents — keep run logs local-only (no telemetry) unless explicitly added later.
