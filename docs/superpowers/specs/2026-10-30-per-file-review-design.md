# Per-file review: design

Date: 2026-10-30. Status: draft for approval. Project 1 of 3 (2: first-run wizard and Basics/Advanced settings, 3: run page and task list redesign; each gets its own design).

## Intent

Today a finished run is judged as a whole: Yes / No / Redo automatically / Redo manually. To say "this file is fine, that one is wrong" the user must write free text. The goal is a fast, guided review: one file at a time, one keypress per decision, and a clear end state. This is the core moment of the product, so it should feel quick and obvious to someone seeing the app for the first time.

## Goals

- Review a run's changed files one by one. After each decision the next file shows automatically.
- Per file: **Yes** (keep), **No, just remove** (revert the file from the branch), **No, redo this** (optional one-line note).
- Notes from "redo" files are sent to the agent in one redo. Files the user accepted are marked "keep unchanged unless needed". If the agent changes an accepted file anyway, that file returns to review. Accepted files the agent did not touch stay accepted.
- Progress survives closing the app.
- Keyboard: `Y`, `N`, arrow keys to go back and forward, "skip for later".
- "Accept all remaining": one action that marks every undecided file as Yes and opens the summary.
- A final summary lists accepted, removed, redo and undecided files and is the only place that changes git.

## Non-goals

- Line-level or hunk-level decisions (file is the unit).
- Locking accepted files (the agent may change them; see above).
- Changing the plan-only runs, the live "Changes so far" view, or the publish step.
- Re-running tests and the reviewer after a "just remove" (see Calls).

## Anti-goals

- Per-click git operations on the user's project folder.
- A half-reviewed branch after a crash.
- Hidden destructive actions: removing a file is only applied at the final step and the summary says what will happen.

## Constraints from the existing code

- A run is exactly one commit on its own branch (`git/commit.rs::commit_all` squashes everything since the base). `RunRecord` holds `commit_sha`, `previous_commit_sha`, `base_commit`.
- `redo_run` takes one feedback string, queues the run, and `redo_steps` re-runs worker, tests and reviewer, then replaces the commit. On failure it rolls back to the earlier commit and returns to `awaiting_approval`.
- `git/diff.rs::redo_diff(previous, current)` already lists the files a redo changed.
- `ApprovalActions.tsx` holds the current buttons; `TaskRun.tsx` renders `DiffViewer` and `ApprovalActions` while a run awaits approval; `DiffViewer` is also used for the live view and the redo tab.
- Repo operations take the per-repo lock (`RepoLocks`).

## Approaches considered

- **A. Collect decisions, apply once at the end (chosen).** Decisions are stored on the run. "Finish review" applies removals by amending the single commit, then starts the existing redo path with the notes. Nothing touches git until then, so going back is free and a crash loses nothing.
- B. Apply each decision to git immediately. More git operations, needs undo for "back", and a crash leaves a half-reviewed branch.
- C. Turn everything into feedback text. Cheapest, but "just remove" would depend on the agent obeying.

## Design

### Data

Add to `RunRecord` (camelCase in JSON, optional so old history files load):

- `fileReview: { commitSha, files: { [path]: { decision: "keep" | "remove" | "redo", note?: string } } }`. It is tied to `commitSha`; when the run's commit changes, the stored review is rebased as described under "After a redo".

Commands (all return `AppError`, all require status `awaiting_approval`):

- `set_file_decision(run_id, path, decision | null, note?)`: saves one decision (null clears it). Does not touch git.
- `finish_file_review(run_id, general_note?)`: see below.

### Finish review

Preconditions: every changed file has a decision (no undecided files). Takes the repo lock, then:

1. If there are files marked "remove": for each, restore it to its base version (`git checkout <base> -- <path>` for modified or deleted files, `git rm -f -- <path>` for added files, using literal pathspecs), then amend the commit so the run is still one commit on top of `base`. Update `commit_sha` and keep the previous one in `previous_commit_sha`. If no changes remain at all, do not commit; return a conflict error telling the user to discard the run instead (the summary offers this up front).
2. If there are files marked "redo", or a general note was written: build the feedback string and start the existing redo path (`redo_run` logic, status goes to `queued`). The redo runs from the commit produced in step 1. The feedback string contains, in order: the general note (if any), the per-file notes with their paths, "Keep these files unchanged unless the task requires changing them: ..." listing accepted files, and "The user removed these files; do not add them back: ..." listing removed files.
3. If there are no "redo" files: move the run to `approved` (same as today's Yes). Publishing works as it does now.

If step 1 fails part-way, reset the work dir to the earlier `commit_sha` (`restore_to`) and return the error; the run stays `awaiting_approval` with decisions intact.

### After a redo

When the redo finishes, the run is `awaiting_approval` again with a new `commit_sha`. Using `redo_diff(previous, current)`:

- A file whose content changed (or that is new) has its decision cleared and returns to review, including previously accepted files.
- A file that did not change keeps its decision. "Redo" files the agent did not change also return to review (their note is kept as the default text).
- A file removed earlier does not appear in the diff; if the agent adds it back it is new and goes to review.
- Files that no longer appear in the diff against the base at all drop out of the review.
- Accepted deviation: after a failed or never-started redo the review is not rebased (Redo marks keep their decision, so the user can retry with the notes intact); `rebase` runs only after a successful redo.

### UI

- New component `FileReview` replaces `DiffViewer` + `ApprovalActions` on the run page while the run awaits approval (layout C from the mockup): header "File N of M" with a progress bar, file name, status letter and +/- counts, the diff, an optional note field for "redo", buttons **No, redo this**, **No, just remove**, **Yes**.
- Deciding advances to the next undecided file; after the last decision the summary shows.
- Back/forward arrows and "skip for later" move between files without deciding. "Accept all remaining" sits next to them (and as `Shift+Y`); it sets every undecided file to Yes and goes to the summary. Clicking a file in a small list lets the user jump.
- Summary: four groups (kept, removed, redo with notes, undecided), an optional general note field ("Anything else the agent should change?"), then actions:
  - **Finish** (disabled while any file is undecided): runs `finish_file_review`. Label reflects the outcome ("Publish..." / "Apply and redo"). The summary states that removed files are deleted from the branch on finish and cannot be brought back from the app.
  - **Discard run** (existing confirm dialog).
  - **Open in editor / hand off** (existing hand-off, replaces "Redo manually").
- The existing `DiffViewer` stays for the live view and for approved or finished runs. The redo tab ("Since last redo") remains available in the summary or the file view.
- The removed whole-run Yes / No buttons: the summary's Finish replaces Yes, Discard replaces No, "redo" with notes replaces Redo automatically, hand off remains.
- Patches that are too large or binary show their notice text and can still be decided.
- Keyboard shortcuts are ignored while the note field has focus.

### Errors

- Failed finish: show the error inline on the summary, keep all decisions.
- Redo failure behaves as today (rollback to the commit from step 1, error shown, run back to `awaiting_approval`).

### Tests

- Rust: removing a modified, an added and a deleted file from the commit; remove-all case; finish failure restores the commit; feedback string contents; review rebasing after a redo (changed accepted file returns, untouched one stays). Use the existing fake-agent e2e setup in `src-tauri/src/e2e_tests.rs` for the redo path.
- Frontend (Vitest): deciding advances to the next file; keyboard shortcuts; back navigation; summary enables Finish only when all are decided; notes are passed on.

## Calls made without the user

- The removal amend does not re-run tests or the reviewer. The run page notes that tests and review refer to the earlier version.
- Finish requires every file decided ("skip for later" files block it) so nothing is accepted by accident.
- Decisions are saved on the run record in the existing history store, not in `localStorage`.
- Removal is applied before the redo, so a failed redo keeps the removals. After a failed redo the review is rebased onto the step-1 commit with the same rules as after a successful one; removals are final.
- Besides per-file notes there is one optional general note, so a redo can start when every file is accepted (for example "add tests"). `finish_file_review` takes it as a parameter.
- The feedback tells the agent not to re-add removed files. If it does anyway, the file returns to review as a new file.
- Crash during Finish: the gap between amending the commit and updating the run record is accepted, not repaired at startup. The diff is read from the branch tip, and Finish is safe to run again (restoring a file to its base version twice changes nothing), and decisions for files that no longer appear in the diff are dropped.
- A redo that changes nothing sends its "redo" files back to review with their notes prefilled; the user can accept them.

## Left to the builder

- Exact names, struct layout, and event wiring.
- How the progress bar and file list look in detail.
- Whether the progress bar and file list look exactly like the mockup.
