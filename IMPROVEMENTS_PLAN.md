# Abracadabra: improvements plan

Order is by value and dependency. Each step lists what to change and how to know it is done. Verify every step with `cd src-tauri && cargo test && cargo clippy --all-targets` and `npx tsc --noEmit` at the project root.

## Phase 1: trust the pipeline

**Status: done (1.1 to 1.4).** 1.1 deviates from the steps below: instead of a `PipelineEnv` struct, the pipeline functions are generic over the Tauri runtime (`AppHandle<R>`), and the tests in `src-tauri/src/e2e_tests.rs` run on Tauri's mock runtime with inline fake agent scripts. 1.2 computes orphaned stashes on demand (command `list_orphaned_stashes`) instead of at startup, and "Dismiss" is stored in `localStorage`.

### 1.1 End-to-end smoke test (fake agent, throwaway repos)
1. Add `src-tauri/tests/pipeline_e2e.rs` (integration test, no Tauri window). Build a temp bare `origin.git` with `main` and `dev`, and a temp working clone.
2. Add a fake agent script in `src-tauri/tests/fixtures/fake_agent.sh`: reads the prompt file, appends a line to a file, prints two bullets. A second variant exits non-zero, and a third sleeps (for timeout and cancel tests).
3. Make the pipeline testable without `AppHandle`: extract the git and agent steps from `run/pipeline.rs` (`run_steps`, `work_review_commit`) behind a small `PipelineEnv` struct (paths, config, event sink). The Tauri code passes the real one; tests pass a recording sink.
4. Cover: happy path ends in `awaiting_approval` on a `feat/...` branch with one commit; failure restores the original branch and stash; discard restores stash; redo failure rolls back; base-branch fallback from `dev` to `main`; branch-name conflict.
5. Done when all six scenarios pass in CI with no network.

### 1.2 Stash safety net
1. In `git/inplace.rs` add `list_task_doer_stashes(repo)`: stashes whose message starts with `task-doer: changes before run`.
2. At startup (`lib.rs`, after `recover_interrupted_runs`), for each known project folder compare against `stash_commit` of existing runs. Anything unreferenced goes into a new `orphaned_stashes` list.
3. Add command `list_orphaned_stashes` and a banner in `TasksPage.tsx` with "Restore" (`git stash pop`, only if clean) and "Dismiss".
4. Done when deleting a failed run that holds a stash no longer loses track of it.

### 1.3 Guard Plan runs against file changes
1. In `plan_only_steps` capture `git status --porcelain` before the plan command and after.
2. If they differ, fail the run with "the plan command modified files: ..." and do not auto-revert (the user decides).
3. Test with the modifying fake agent.

### 1.4 Refuse to start on a mid-operation repo
1. In `git/inplace.rs` add `in_progress_operation(repo)`: checks for `MERGE_HEAD`, `rebase-merge`, `rebase-apply`, `CHERRY_PICK_HEAD`, `BISECT_LOG` under the git dir (use `rev-parse --git-path`).
2. Call it before the stash in `run_steps`; return a clear error naming the operation.

## Phase 2: control

**Status: all of Phase 2 done (2.3 shows the uncommitted changes of a working run, refreshed every 5 seconds).** Deviations: cancel takes effect between steps and kills the running agent at once (a `git fetch` in progress finishes first). The queue is state-based (`RunStore::blocker_of` plus a `ProjectGate` wake-up) rather than a held lock, because a run awaiting approval keeps its project occupied until it is approved or discarded.

### 2.1 Cancel button for active runs
1. `ProcessRegistry` in `agent/runner.rs` already kills process groups. Add `cancel(run_id)` that kills the run's current process and sets a cancel flag on the run.
2. New status `Cancelled` (terminal) in `run/mod.rs`; allow `(any non-terminal) -> Cancelled`. Update `is_terminal`, `RunStatus` in `src/lib/api.ts`, `RunStatusPill`, and the stepper.
3. In `execute_run`, when an agent step returns because of the cancel flag, enter `Cancelled` instead of `Failed` and run `clean_up_run`.
4. Command `cancel_run`; "Cancel" button on `TaskRun.tsx` while the status is queued, working, reviewing or committing (queued runs are just removed from the limiter).
5. Tests: cancel during worker restores the folder and stash; cancel while queued never touches git.

### 2.2 Per-project queue
1. Replace the "another run is in progress" error in `RunStore::create_unless_active` with a `waiting_for` list: the run is created as `queued` with `blocked_by: Option<String>`.
2. In `run/limiter.rs` add a per-project gate keyed by `project`; `execute_run` acquires it after the global slot and releases it when the run reaches a terminal state.
3. When a blocking run finishes, the next queued run for that project starts automatically. Show "Waiting for <task>" on the queued run.
4. Done when starting two tasks in one project runs them one after the other without errors.

### 2.3 Live diff while working
1. Command `get_run_diff_live(run_id)`: `git diff HEAD` plus untracked files in the project folder, only while the run is `working`.
2. `DiffViewer` gets a "Changes so far" mode, polled every 5 seconds while the run is active.

## Phase 3: workflow

**Status: all of Phase 3 done (3.3 and 3.5 included; 3.3 posts only when its two Settings checkboxes are on, and a failed comment is only logged).** Deviations: 3.1 has no separate `publish_run` command; the approved run page always shows the editable title (default `type: title`) and description, and "Push & create MR / PR" does both. 3.4 also saves the task filters per git source and ignores a saved filter whose value no longer exists. 3.6 has a "Copy" button on the worker summary, plan and reviewer notes, and its tests are in `Markdown.test.tsx`.

### 3.1 One-click publish
1. New command `publish_run(run_id)`: runs `push_run`, then `create_merge_request`.
2. Add an editable title and description step: command `preview_merge_request(run_id)` returns the rendered description; `PublishActions.tsx` shows it in a textarea and passes the edited text to `create_merge_request`.
3. Done when "Yes, then publish" takes two clicks and the MR body can be edited first.

### 3.2 Re-review after redo
1. Store `previous_commit_sha` on the run before each redo.
2. Command `get_redo_diff(run_id)`: diff between `previous_commit_sha` and the current commit.
3. `DiffViewer` tabs: "All changes" and "Since last redo".

### 3.3 Comment back on the issue
1. Add `create_issue_comment` to the `Provider` trait (`providers/mod.rs`); implement for GitLab (`POST /projects/:id/issues/:iid/notes`) and GitHub (`POST /repos/:o/:r/issues/:n/comments`). Do not retry the POST.
2. Post the MR link after `create_merge_request` and the plan text after a plan run, behind two settings checkboxes (default off).

### 3.4 Saved task filters and run badges
1. Persist the task list filters in `localStorage` per git source.
2. In `TaskList.tsx` join tasks with `listRuns()` and show a badge ("planned", "in progress", "approved") per task.

### 3.5 Batch runs
1. Checkbox column in `TaskList.tsx` and a "Run selected" button that calls `startRun` sequentially and reports which ones were refused or queued.
2. Depends on 2.2 so same-project tasks queue instead of failing.

### 3.6 Markdown for worker summary and reviewer notes
1. Add `react-markdown` and `remark-gfm` (`pnpm add react-markdown remark-gfm`). Do not enable raw HTML, so agent output cannot inject markup.
2. New `src/components/Markdown.tsx`: wraps `ReactMarkdown` with Tailwind classes for headings, lists, inline code, code blocks (mono, scrollable), tables and blockquotes, in both light and dark mode. Links open through `openUrl` from `lib/api.ts`, never in the app window.
3. In `TaskRun.tsx` replace the bullet list built by `toBullets` (worker summary), the plan text (`planOnly`) and the reviewer notes paragraph (`whitespace-pre-wrap`) with `<Markdown>`. Keep the raw text available through a "Copy" button.
4. Check the cut-down `{summary}` in merge request descriptions still ends on a complete line (it is plain markdown there already).
5. Tests: a Markdown component test for headings, lists, code blocks, a link click calling `openUrl`, and that a `<script>` or `<img onerror>` in the input renders as text.
6. Done when a worker summary with bullets and code spans and a reviewer report with headings and code blocks read as formatted text.

### 3.7 AI-written merge request description (done)
The default MR template has four sections: Summary, Related issue (`{issue_link}`), Checklist (filled by reviewer, `{checklist}`, up to 6 check boxes) and an empty Test evidence section. An optional description command (`agent.description_cmd`, overridable per source or project) writes the summary and checklist from the issue, the diff, the worker summary and the review notes. It runs when an approved run's MR editor opens, is cached on the run until the commit changes, can be re-run with "Regenerate", and falls back to the worker summary and a generic checklist (with a note) if it fails or edits files in the project folder.

## Phase 4: agent quality

**Status: 4.1 to 4.4 done.** 4.4: the run page shows the time spent in each step (summed over redos, live while running), the total agent time, and, when the `usageRegex` setting (Settings, agent section) is set, the cost or token figure each worker, reviewer or description step printed (the last matching line, first capture group or whole match, stderr checked before stdout; stored as `usage` on the run). Deviations for 4.1 to 4.3: prompt files are settings fields (`workerPromptFile` and so on, also overridable per source or project) and a project's `.task-doer/<role>.md` always wins over them; a command that uses `{system_prompt}` with no file set fails the run with a clear message. The reviewer's `VERDICT:` line is requested in the generated review prompt, so existing reviewer commands need no change. The auto-redo gate runs the worker once more with the review notes, re-runs the tests and reviews again.

### 4.1 Per-project prompts
1. Config: `prompt_files: { worker, reviewer, plan }` as optional paths in `SettingsOverride`.
2. Resolve in `agent/runner.rs`: replace a `{system_prompt}` placeholder in the command template with the resolved file; keep the global default.
3. Optional convention: if `<repo>/.task-doer/worker.md` exists, use it unless overridden.

### 4.2 Auto-fix loop on failing tests
1. Setting `auto_fix_attempts` (default 0, max 3).
2. In `work_review_commit`, after `run_tests` fails and attempts remain, call the worker again with the test output as feedback (reuse `WorkerInput.feedback`), then rerun tests.
3. Record the attempts on the run and show them in the stepper.

### 4.3 Reviewer gate
1. Ask the reviewer prompt for a final line `VERDICT: approve|changes`.
2. Parse it in `agent/reviewer.rs` into `ReviewInput`/`RunRecord.review_verdict`.
3. Setting `reviewer_gate`: `off` (default), `warn` (red badge), `auto_redo` (one automatic redo using the notes, same code path as "Apply suggestions").

### 4.4 Duration and cost per run
1. Record start and end timestamps per step in `history` (already present) and show durations on `TaskRun.tsx`.
2. If the agent CLI prints a cost or token line, add an optional regex setting `usage_regex`; store the captured value on the run.

## Phase 5: polish

1. **Test agent command**: Settings button runs the worker with a trivial prompt in a temp folder and shows the output (reuse `run_agent`).
2. **Open in IDE**: setting `ide_command` (for example `code {path}`); button on the run page.
3. **History search and retention**: text search over title and project in `RunHistory.tsx`; setting `keep_runs_days` and a purge at startup for finished runs.
4. **Packaging**: see the build steps in the README (`pnpm tauri build`), then add a release workflow.

Status: all of Phase 5 and Phase 6 done. 5.4 and 6.4: `.gitlab-ci.yml` (frontend, backend, and a macOS bundle job that runs on tags or by hand) is untested because there is no git remote yet. 6.1: Vitest + Testing Library (`pnpm test`) with tests for durations, `describeError`, Markdown, `ApprovalActions`, `RunHistory` and `TaskRun`. 6.2: `AppError` (`auth`, `timeout`, `not_found`, `conflict`, `git`, `other`) in `src-tauri/src/error.rs`, returned by the provider, run, stash and open-in-editor commands; config, token and test-agent commands still return plain strings, which the UI shows as they are. The plan's `Agent` variant was dropped because no command produces one. 6.3: `worktree_path` is now `work_dir` (old history files still load through a serde alias), `set_worktree` is `set_workspace`.

## Phase 6: engineering

1. **Frontend tests**: add Vitest and Testing Library. Start with `ApprovalActions` (confirm flow), `RunHistory` (delete flow, filter), `TaskRun` (buttons per status).
2. **Typed errors**: introduce `AppError { Auth, Timeout, NotFound, Git(String), Agent(String), Conflict(String), Other(String) }` in `src-tauri/src/error.rs`; convert commands to return it (serialised with a `kind` field); map `kind` to messages and actions in the UI (for example "Open Settings" on `Auth`). Migrate one command module at a time.
3. **Rename leftovers**: `worktree_path` to `work_dir` with `#[serde(alias = "worktree_path")]`, `set_worktree` to `set_workspace`, comments and test names.
4. **CI**: GitHub Actions or GitLab CI with jobs for `cargo test`, `cargo clippy -- -D warnings`, `npx tsc --noEmit`, and `pnpm tauri build` on macOS.

## Suggested order

1. 1.1, 1.4, 1.3, 1.2 (safety first)
2. 2.1, 2.2
3. 3.1, 3.4, 3.2, 3.6
4. 4.1, 4.2, 4.3
5. 2.3, 3.3, 3.5, 4.4
6. Phase 5 and Phase 6 in parallel as time allows
