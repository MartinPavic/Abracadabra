# Per-file review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the whole-run Yes / No / Redo buttons with a guided one-file-at-a-time review whose decisions are applied once, at the end.

**Architecture:** Decisions are stored on the `RunRecord` (`file_review`) and change nothing in git until `finish_file_review` runs. Finish restores "remove" files to their base version and amends the run's single commit, then either approves the run or starts the existing redo with feedback built from the notes. The core logic is generic over the Tauri runtime (like `pipeline.rs`) so it is tested with the mock-runtime e2e setup.

**Tech Stack:** Rust (Tauri 2, tokio, serde), React + TypeScript, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-30-per-file-review-design.md`

## Global Constraints

- A run is exactly one commit on its own branch on top of `base_commit`; Finish must keep it that way.
- Every git operation on the project folder takes `RepoLocks` for that folder.
- New `RunRecord` fields are `#[serde(default)]` so old history files load; JSON is camelCase.
- `fileReview` is tied to `commitSha`; nothing touches git before `finish_file_review`.
- Removed files are final; the summary says so before Finish.
- Keyboard shortcuts (`Y`, `N`, arrows, `Shift+Y`) are ignored while a text field has focus.
- Verify with `cd src-tauri && cargo test && cargo clippy --all-targets`, `pnpm test`, and `npx tsc --noEmit` at the project root.

## Review Focus

- A path with spaces, unicode or a leading `-` is removed correctly (literal pathspecs). Task 1.
- Removing every changed file fails cleanly and leaves the commit and decisions intact. Tasks 1 and 3.
- A binary or oversized file (patch is only a notice) can still be decided. Task 6.
- Double Finish (second click or a call while the redo is queued) is refused. Task 3.
- A deleted file ("D") marked remove is restored, and an added file ("A") marked remove is deleted. Task 1.

## File Structure

- `src-tauri/src/git/commit.rs`: add `remove_files_from_commit`.
- `src-tauri/src/run/file_review.rs` (new): types, pure helpers (`rebase`, `build_feedback`, `undecided`), and `finish_review`.
- `src-tauri/src/run/mod.rs`: `file_review` field, store methods.
- `src-tauri/src/run/pipeline.rs`: rebase the review after a successful redo.
- `src-tauri/src/commands/runs.rs`, `src-tauri/src/lib.rs`: two commands, shared `start_redo`.
- `src/lib/api.ts`: types and wrappers.
- `src/lib/fileReview.ts` (new): pure helpers for the UI.
- `src/components/FileReview.tsx` (new): focus view and summary.
- `src/views/TaskRun.tsx`: use `FileReview` while a run awaits approval; delete `ApprovalActions.tsx` and its test.

---

### Task 1: Remove files from the run's commit

**Files:**
- Modify: `src-tauri/src/git/commit.rs`
- Test: same file, `mod tests`

**Interfaces:**
- Produces: `pub async fn remove_files_from_commit(work_dir: &Path, base: &str, paths: &[String]) -> Result<(), String>`. Restores each path to its `base` version (deleting it if it does not exist in `base`), then amends HEAD with the same message. Errors with "nothing left to commit" if the result equals `base`; in that case the caller restores the old commit with `restore_to`.

- [ ] **Step 1: Write failing tests** in `commit.rs` using the existing `init_repo` helper plus a `base` commit: `removes_an_added_file_and_restores_a_modified_one` (commit adds `new.txt` and `keep.txt` and edits `a.txt`; after removing `new.txt` and `a.txt`, `git diff --name-only base HEAD` is exactly `keep.txt`), `restores_a_deleted_file` (commit deletes `a.txt`; removing `a.txt` brings it back), `handles_paths_with_spaces_and_a_leading_dash` (`-odd name.txt` added then removed), `refuses_when_nothing_would_remain`, and each asserts `git rev-list --count base..HEAD` is `1`.
- [ ] **Step 2: Run** `cd src-tauri && cargo test git::commit -- --nocapture`. Expected: FAIL, function not defined.
- [ ] **Step 3: Implement** `remove_files_from_commit`. For each path run `git --literal-pathspecs cat-file -e <base>:<path>`; if it succeeds `git --literal-pathspecs checkout <base> -- <path>`, otherwise `git --literal-pathspecs rm -f -- <path>`. Then use `has_changes(work_dir, base)`; if false return the error. Finish with `git commit -q --amend --no-edit`.
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `git add src-tauri/src/git/commit.rs && git commit -m "feat: remove files from a run's commit"`.

---

### Task 2: Review model, pure helpers, store

**Files:**
- Create: `src-tauri/src/run/file_review.rs` (declare `pub mod file_review;` in `run/mod.rs`)
- Modify: `src-tauri/src/run/mod.rs`
- Test: `mod tests` in `file_review.rs`

**Interfaces:**
- Produces (all `Serialize, Deserialize, Clone, Debug`, camelCase, `Decision` lowercase):
  - `enum Decision { Keep, Remove, Redo }`
  - `struct FileMark { decision: Option<Decision>, note: Option<String> }`
  - `struct FileReview { commit_sha: String, files: BTreeMap<String, FileMark> }`
  - `struct MarkChange { path: String, decision: Option<Decision>, note: Option<String> }`
  - `fn rebase(review: FileReview, changed: &HashSet<String>, current: &HashSet<String>, new_commit: &str) -> FileReview`: drops paths not in `current` and paths in `changed`, except a `redo` mark for an unchanged file, which keeps its note with `decision: None`; sets `commit_sha`.
  - `fn undecided(paths: &[String], review: Option<&FileReview>) -> Vec<String>`
  - `fn build_feedback(general_note: Option<&str>, review: &FileReview) -> Option<String>`: `None` when there is no general note and no redo marks. Order: general note; one line per redo file `path: note` (empty note renders as `path: redo this file`); `Keep these files unchanged unless the task requires changing them: a, b`; `The user removed these files; do not add them back: c`. Sections with no entries are omitted.
- Produces on `RunRecord`: `#[serde(default)] pub file_review: Option<FileReview>`; `RunStore::apply_mark_changes(&self, run_id, changes: Vec<MarkChange>) -> Result<(), String>` (creates the review from the run's `commit_sha` if absent; a change with `decision: None` and no note removes the entry); `RunStore::set_file_review(&self, run_id, review: Option<FileReview>) -> Result<(), String>`.

- [ ] **Step 1: Write failing tests** `rebase_keeps_untouched_decisions_and_clears_changed_ones`, `rebase_keeps_the_note_of_an_unchanged_redo_file_without_a_decision`, `rebase_drops_files_that_left_the_diff`, `feedback_lists_notes_kept_and_removed_files_in_order`, `feedback_is_none_without_redo_marks_or_a_general_note`, `a_general_note_alone_gives_feedback`, `undecided_lists_files_without_a_decision`, and a store test `marks_are_stored_and_cleared`.
- [ ] **Step 2: Run** `cd src-tauri && cargo test run::file_review`. Expected: FAIL.
- [ ] **Step 3: Implement** the types, helpers and store methods; add `file_review: None` to the `RunRecord` constructor.
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: file review model and helpers`.

---

### Task 3: `finish_review` and rebase after a redo

**Files:**
- Modify: `src-tauri/src/run/file_review.rs`, `src-tauri/src/run/pipeline.rs`
- Test: `src-tauri/src/e2e_tests.rs`

**Interfaces:**
- Consumes: Tasks 1 and 2; `run_diff`, `redo_diff`, `RepoLocks`, `ensure_on_branch`, `require_clean`, `restore_to`, `enter`.
- Produces: `pub async fn finish_review<R: Runtime>(app: &AppHandle<R>, run_id: &str, general_note: Option<&str>) -> Result<Option<String>, AppError>`. Returns `Some(feedback)` when a redo must be started (run still `awaiting_approval`); returns `None` after moving the run to `approved`. Errors with `AppError::conflict` unless the run is `awaiting_approval`, and while any changed file is undecided (message names them).
- Behaviour: take the repo lock, `ensure_on_branch` and `require_clean`; apply removals with `remove_files_from_commit`; on error `restore_to(old commit)` and return it. On success set `previous_commit_sha` to the old commit, `commit_sha` to the new HEAD, and `set_file_review(rebase(...))` with `changed = removed` so removed files drop out. Build feedback from the review as it was before the rebase.
- Also: `pipeline.rs::redo_steps`, in the `Ok(())` arm after `set_previous_commit`, loads `redo_diff(good_commit, new_commit)` and `run_diff(base, branch)`, and stores `rebase(...)`.

- [ ] **Step 1: Write failing e2e tests** (add a `multi_worker` helper that writes `a.txt`, `b.txt` and edits `README.md`): `finish_removes_marked_files_and_approves` (a.txt remove, others keep: returns `None`, status `Approved`, `rev-list --count origin/dev..HEAD` is `1`, `git ls-files` has no `a.txt`, `commit_sha` equals HEAD, `previous_commit_sha` is the old one, tree clean), `finish_returns_feedback_for_redo_marks` (feedback contains the note, `Keep these files unchanged` with `README.md`, and `do not add them back` with `a.txt`; status still `AwaitingApproval`), `finish_refuses_while_a_file_is_undecided` (error names the file, commit unchanged), `finish_fails_cleanly_when_every_file_is_removed` (error, HEAD unchanged, marks intact), `a_second_finish_is_refused_once_the_run_is_queued`, `after_a_redo_only_changed_files_return_to_review` (redo worker appends only to `b.txt`: `a.txt` and `README.md` stay `Keep`, `b.txt` has no mark).
- [ ] **Step 2: Run** `cd src-tauri && cargo test e2e_tests::finish`. Expected: FAIL.
- [ ] **Step 3: Implement** `finish_review` and the rebase in `redo_steps`.
- [ ] **Step 4: Run** `cargo test && cargo clippy --all-targets`. Expected: PASS, no warnings.
- [ ] **Step 5: Commit** `feat: finish a file review`.

---

### Task 4: Commands

**Files:**
- Modify: `src-tauri/src/commands/runs.rs`, `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `finish_review`, `RunStore::apply_mark_changes`.
- Produces commands: `set_file_decisions(app, run_id: String, changes: Vec<MarkChange>) -> Result<(), AppError>` (requires `awaiting_approval`; stores marks only), `finish_file_review(app, run_id: String, general_note: Option<String>) -> Result<(), AppError>` (calls `finish_review`; when it returns `Some(feedback)` calls `start_redo`).
- Refactor: move the body of `redo_run` after the `awaiting_run` check into `async fn start_redo(app: &AppHandle, run_id: String, feedback: String) -> Result<(), AppError>`; `redo_run` keeps working through it. Remove nothing else.

- [ ] **Step 1:** Add the commands and register both in `generate_handler!` in `lib.rs`; extract `start_redo`.
- [ ] **Step 2: Run** `cd src-tauri && cargo test && cargo clippy --all-targets`. Expected: PASS (existing redo tests still pass).
- [ ] **Step 3: Commit** `feat: file review commands`.

---

### Task 5: Frontend API and helpers

**Files:**
- Modify: `src/lib/api.ts`
- Create: `src/lib/fileReview.ts`, `src/lib/fileReview.test.ts`

**Interfaces:**
- Produces in `api.ts`: `type Decision = "keep" | "remove" | "redo"`; `interface FileMark { decision: Decision | null; note: string | null }`; `interface FileReviewState { commitSha: string; files: Record<string, FileMark> }`; `RunRecord.fileReview: FileReviewState | null`; `setFileDecisions(runId: string, changes: { path: string; decision: Decision | null; note?: string | null }[]): Promise<void>`; `finishFileReview(runId: string, generalNote?: string): Promise<void>`.
- Produces in `fileReview.ts`: `nextUndecided(paths: string[], marks: Record<string, FileMark>, from: number): number | null` (searches forward then wraps; `null` when all decided); `groupMarks(paths: string[], marks): { keep: string[]; remove: string[]; redo: string[]; undecided: string[] }`.

- [ ] **Step 1: Write failing tests** `nextUndecided skips decided files and wraps around`, `nextUndecided returns null when everything is decided`, `groupMarks puts files without a decision in undecided`.
- [ ] **Step 2: Run** `pnpm test src/lib/fileReview.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the types, wrappers and helpers.
- [ ] **Step 4: Run** `pnpm test` and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: file review client api`.

---

### Task 6: `FileReview` focus view

**Files:**
- Create: `src/components/FileReview.tsx`, `src/components/FileReview.test.tsx`
- Modify: `src/components/DiffViewer.tsx` (export `classifyPatch`)

**Interfaces:**
- Consumes: Task 5, `getRunDiff`, `setFileDecisions`.
- Produces: `FileReview({ run, onChanged }: { run: RunRecord; onChanged: () => void })`. It loads `getRunDiff(run.id)`, starts at the first undecided file, and shows header "File N of M" with a progress bar, path, status letter, the patch (lines styled by `classifyPatch`), a note input, and buttons **No, redo this**, **No, just remove**, **Yes**. Each decision calls `setFileDecisions` (note only for redo) and advances with `nextUndecided`; when none remain it shows the summary (Task 7). Controls: back and forward arrows, "Skip for later", "Accept all remaining" (also `Shift+Y`) which sends one `setFileDecisions` call with `keep` for every undecided path and shows the summary. `Y` and `N` shortcuts follow the Global Constraints; `N` means "just remove".

- [ ] **Step 1: Write failing tests** `Yes keeps the file and shows the next one`, `redo sends the note and advances`, `Y and N keys decide, but not while typing in the note field`, `back returns to the previous file`, `accept all remaining keeps every undecided file in one call`, `a file with only a notice instead of a patch can still be decided`.
- [ ] **Step 2: Run** `pnpm test src/components/FileReview.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** the component in the style of `DiffViewer.tsx` (Tailwind classes, dark mode).
- [ ] **Step 4: Run** `pnpm test` and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: per-file review view`.

---

### Task 7: Summary and wiring

**Files:**
- Modify: `src/components/FileReview.tsx`, `src/views/TaskRun.tsx`, `src/views/TaskRun.test.tsx`
- Delete: `src/components/ApprovalActions.tsx`, `src/components/ApprovalActions.test.tsx`

**Interfaces:**
- Consumes: `groupMarks`, `finishFileReview`, `discardRun`, `handOffRun`.
- Produces: a summary inside `FileReview` with four groups (kept, removed, redo with notes, undecided; clicking a file jumps back to it), an optional general note, a warning that removed files are deleted from the branch on finish, **Finish** (disabled while any file is undecided; label "Apply and redo" when redo files or a general note exist, otherwise "Finish review"), **Discard run** (inline confirmation as in the old component), **Open in editor / hand off**, and, when `run.previousCommitSha` is set, a `<details>` with `<DiffViewer runId redone />`.
- `TaskRun.tsx`: while `status === "awaiting_approval"` and not `planOnly`, render `FileReview` instead of `DiffViewer` and `ApprovalActions`; other statuses keep `DiffViewer`; remove the `ApprovalActions` import and mock.

- [ ] **Step 1: Write failing tests** in `FileReview.test.tsx`: `finish is disabled while a file is undecided`, `finish with only keeps and removes calls finishFileReview without a note`, `redo files change the finish label and the general note is sent`, `discard asks for confirmation first`, `the summary warns that removed files are deleted`.
- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement** the summary, wire `TaskRun.tsx`, delete the old component and its test, update `TaskRun.test.tsx` mocks (`FileReview` replaces `ApprovalActions`).
- [ ] **Step 4: Run** `pnpm test`, `npx tsc --noEmit`, `cd src-tauri && cargo test && cargo clippy --all-targets`. Expected: all PASS.
- [ ] **Step 5: Manual check** with `pnpm tauri dev`: run a task, review files with `Y` and `N`, finish with a removal, then with a redo note.
- [ ] **Step 6: Commit** `feat: review summary and run page wiring`.
