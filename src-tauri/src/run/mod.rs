//! Run status machine and persistent run storage (a JSON file in the app data
//! dir, rewritten atomically on every change).

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::agent::tester::TestResult;

pub mod limiter;
pub mod merge_request;
pub mod pipeline;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Queued,
    Cloning,
    Working,
    Reviewing,
    Committing,
    AwaitingApproval,
    Approved,
    Discarded,
    /// User took over manually; the run's branch is left as it is.
    HandedOff,
    /// Plan-only run finished: the plan is on the record.
    Planned,
    Failed,
    /// Stopped by the user while queued or in progress; its changes were undone.
    Cancelled,
}

impl RunStatus {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            RunStatus::Approved
                | RunStatus::Discarded
                | RunStatus::HandedOff
                | RunStatus::Planned
                | RunStatus::Failed
                | RunStatus::Cancelled
        )
    }

    /// Happy path is strictly linear; any non-terminal state may fail, and a
    /// run awaiting approval can loop back through `queued` for an automatic
    /// redo (which then waits for a free slot like any other run). A redo that
    /// fails returns to `awaiting_approval` (the earlier commit is still good).
    pub fn can_transition_to(self, next: RunStatus) -> bool {
        use RunStatus::*;
        if self.is_terminal() {
            return false;
        }
        matches!(
            (self, next),
            (Queued, Cloning)
                | (Cloning, Working)
                | (Working, Reviewing)
                // The worker re-run to fix failing tests or the reviewer's findings.
                | (Reviewing, Working)
                | (Reviewing, Committing)
                // A redo cancelled while it waited for a slot.
                | (Queued, AwaitingApproval)
                | (Committing, AwaitingApproval)
                | (Working, AwaitingApproval)
                | (Reviewing, AwaitingApproval)
                | (AwaitingApproval, Approved)
                | (AwaitingApproval, Discarded)
                | (AwaitingApproval, HandedOff)
                | (AwaitingApproval, Queued)
                | (Queued, Working)
                | (Working, Planned)
                | (_, Failed)
                | (_, Cancelled)
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusTransition {
    pub status: RunStatus,
    pub at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchConflict {
    /// The branch name that already exists.
    pub branch: String,
    /// A free name the user can accept instead.
    pub suggestion: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    pub id: String,
    pub task_id: String,
    pub task_title: String,
    #[serde(default)]
    pub task_url: String,
    /// Issue body and reference, kept so a redo can rebuild the worker prompt and commit message.
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub issue_ref: String,
    /// What a retry needs to rebuild the run; no secrets (the token stays in the keychain).
    #[serde(default)]
    pub source_id: String,
    #[serde(default)]
    pub issue_iid: String,
    #[serde(default)]
    pub clone_url: String,
    #[serde(default)]
    pub base_branch: String,
    /// Set when the run failed because its branch name was already taken.
    #[serde(default)]
    pub branch_conflict: Option<BranchConflict>,
    /// Plan-only run: produces a plan instead of a commit.
    #[serde(default)]
    pub plan_only: bool,
    /// Plan the worker is told to follow, taken from an earlier plan run.
    #[serde(default)]
    pub plan: Option<String>,
    /// Title of the earlier run in the same project this one is waiting for.
    #[serde(default)]
    pub blocked_by: Option<String>,
    /// How many times the worker was re-run automatically to fix failing tests.
    #[serde(default)]
    pub fix_attempts: u32,
    /// The reviewer's overall call (`approve` or `changes`), if it gave one.
    #[serde(default)]
    pub review_verdict: Option<String>,
    /// Cost or token figures the agent printed, as `step: value`, in the order they came.
    #[serde(default)]
    pub usage: Vec<String>,
    /// Merge request summary and checklist written by the description command,
    /// kept until the run's commit changes.
    #[serde(default)]
    pub generated_summary: Option<String>,
    #[serde(default)]
    pub generated_checklist: Option<String>,
    /// Issue labels, kept to pick the commit's type again on a redo.
    #[serde(default)]
    pub labels: Vec<String>,
    /// The branch has been pushed to the remote.
    #[serde(default)]
    pub pushed: bool,
    #[serde(default)]
    pub merge_request_url: Option<String>,
    /// Outcome of the configured test/lint hook, if it ran.
    #[serde(default)]
    pub test_result: Option<TestResult>,
    /// Why the last automatic redo failed; the run itself stays approvable.
    #[serde(default)]
    pub redo_error: Option<String>,
    /// The base ref's commit when the worktree was created, so diffs and reviews
    /// stay stable when the base branch moves.
    #[serde(default)]
    pub base_commit: Option<String>,
    /// The commit the run produced (set once it awaits approval); a failed or
    /// interrupted redo is rolled back to it.
    #[serde(default)]
    pub commit_sha: Option<String>,
    /// The commit a successful redo replaced, to show what the redo changed.
    #[serde(default)]
    pub previous_commit_sha: Option<String>,
    pub project: String,
    pub status: RunStatus,
    pub history: Vec<StatusTransition>,
    pub error: Option<String>,
    pub review_notes: Option<String>,
    pub worker_summary: Option<String>,
    pub repo_path: Option<PathBuf>,
    pub branch: Option<String>,
    /// Ref the run's branch was cut from, e.g. "origin/main".
    pub base_ref: Option<String>,
    /// The folder the run works in: the project folder itself.
    #[serde(alias = "worktreePath")]
    pub work_dir: Option<PathBuf>,
    /// Branch (or commit, if detached) the project folder was on before the run.
    #[serde(default)]
    pub original_ref: Option<String>,
    /// Stash holding the folder's uncommitted changes from before the run, until
    /// they are restored.
    #[serde(default)]
    pub stash_commit: Option<String>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

impl RunRecord {
    /// Applies a state-machine transition. `error` is only kept for `Failed`.
    fn apply(&mut self, next: RunStatus, error: Option<String>) -> Result<RunStatusEvent, String> {
        if !self.status.can_transition_to(next) {
            return Err(format!("invalid run transition {:?} -> {next:?}", self.status));
        }
        let at_ms = now_ms();
        self.status = next;
        self.history.push(StatusTransition { status: next, at_ms });
        self.updated_at_ms = at_ms;
        self.error = if next == RunStatus::Failed { error } else { None };
        if next == RunStatus::Queued {
            self.redo_error = None;
        }
        Ok(RunStatusEvent {
            run_id: self.id.clone(),
            status: next,
            at_ms,
            error: self.error.clone(),
        })
    }
}

/// Payload of the `run://status` Tauri event.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunStatusEvent {
    pub run_id: String,
    pub status: RunStatus,
    pub at_ms: u64,
    pub error: Option<String>,
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Details of a run being created.
#[derive(Default)]
pub struct NewRun<'a> {
    pub run_id: &'a str,
    pub task_id: &'a str,
    pub task_title: &'a str,
    pub task_url: &'a str,
    pub description: &'a str,
    pub issue_ref: &'a str,
    pub source_id: &'a str,
    pub issue_iid: &'a str,
    pub clone_url: &'a str,
    pub base_branch: &'a str,
    pub plan_only: bool,
    pub plan: Option<&'a str>,
    pub labels: &'a [String],
    pub project: &'a str,
}

#[derive(Default)]
pub struct RunStore {
    runs: Mutex<HashMap<String, RunRecord>>,
    /// `None` keeps the store purely in memory (used by tests).
    path: Option<PathBuf>,
    /// Runs found mid-pipeline at load time, for startup cleanup: those marked
    /// failed, and those put back to `awaiting_approval` (interrupted redos).
    interrupted: Mutex<(Vec<RunRecord>, Vec<RunRecord>)>,
}

impl RunStore {
    /// Loads persisted runs from `path`. Runs caught mid-pipeline by an app
    /// exit can't resume, so they're marked failed (and listed by
    /// `take_interrupted` for cleanup); `awaiting_approval` runs stay actionable
    /// since their worktree is still on disk. Records are parsed one by one, so
    /// a single unreadable record (say, from a different version) can't take the
    /// whole history with it.
    pub fn load(path: PathBuf) -> Self {
        let mut runs: HashMap<String, RunRecord> = HashMap::new();
        if path.exists() {
            let parsed = fs::read_to_string(&path)
                .map_err(|err| err.to_string())
                .and_then(|raw| serde_json::from_str::<Vec<serde_json::Value>>(&raw).map_err(|err| err.to_string()));
            match parsed {
                Ok(values) => {
                    let mut skipped = 0;
                    for value in values {
                        match serde_json::from_value::<RunRecord>(value) {
                            Ok(record) => {
                                runs.insert(record.id.clone(), record);
                            }
                            Err(err) => {
                                skipped += 1;
                                log::error!("skipping unreadable run record: {err}");
                            }
                        }
                    }
                    if skipped > 0 {
                        let backup = path.with_extension(format!("json.bak-{}", now_ms()));
                        log::warn!("skipped {skipped} run record(s); original kept at {}", backup.display());
                        let _ = fs::copy(&path, backup);
                    }
                }
                Err(err) => {
                    let aside = path.with_extension(format!("json.corrupt-{}", now_ms()));
                    log::error!("could not read runs from {}: {err}; moved to {}", path.display(), aside.display());
                    let _ = fs::rename(&path, aside);
                }
            }
        }

        let mut failed = Vec::new();
        let mut restored = Vec::new();
        for record in runs.values_mut() {
            let in_pipeline = !record.status.is_terminal() && record.status != RunStatus::AwaitingApproval;
            if !in_pipeline {
                continue;
            }
            if record.commit_sha.is_some() {
                // An interrupted redo: the earlier commit is still good, so the run
                // goes back to awaiting approval instead of failing.
                let at_ms = now_ms();
                record.status = RunStatus::AwaitingApproval;
                record.history.push(StatusTransition { status: RunStatus::AwaitingApproval, at_ms });
                record.updated_at_ms = at_ms;
                record.redo_error = Some("interrupted by app restart".to_string());
                restored.push(record.clone());
            } else {
                let _ = record.apply(RunStatus::Failed, Some("interrupted by app restart".to_string()));
                failed.push(record.clone());
            }
        }

        let changed = !failed.is_empty() || !restored.is_empty();
        let store = Self {
            runs: Mutex::new(runs),
            path: Some(path),
            interrupted: Mutex::new((failed, restored)),
        };
        if changed {
            log::warn!("recovered runs interrupted by the last app exit");
            store.persist(&store.lock());
        }
        store
    }

    /// Runs interrupted by the last app exit (taken once, for cleanup): those
    /// marked failed, and those restored to `awaiting_approval`.
    pub fn take_interrupted(&self) -> (Vec<RunRecord>, Vec<RunRecord>) {
        std::mem::take(&mut *self.interrupted.lock().expect("interrupted list poisoned"))
    }

    #[cfg(test)]
    pub fn create(&self, run_id: &str) -> RunRecord {
        self.create_for_task(NewRun { run_id, ..NewRun::default() })
    }

    /// The id of a run for `task_id` (from `source_id`) that hasn't finished yet,
    /// i.e. one that is queued, in progress or waiting for approval.
    pub fn find_active_for_task(&self, source_id: &str, task_id: &str) -> Option<String> {
        self.lock()
            .values()
            .find(|r| r.source_id == source_id && r.task_id == task_id && !r.status.is_terminal())
            .map(|r| r.id.clone())
    }

    #[cfg(test)]
    pub fn create_for_task(&self, new: NewRun) -> RunRecord {
        let record = Self::new_record(&new);
        let mut runs = self.lock();
        runs.insert(new.run_id.to_string(), record.clone());
        self.persist(&runs);
        record
    }

    /// Like `create_for_task`, but refuses if a run for the same task (and git
    /// source) is still unfinished. A run that has to wait for an earlier one in
    /// the same project folder is created `queued` and records what it waits for
    /// (see `blocker_of`). The check and the insert happen under one lock, so a
    /// double click can't start two runs.
    pub fn create_unless_active(&self, new: NewRun) -> Result<RunRecord, String> {
        let mut record = Self::new_record(&new);
        let mut runs = self.lock();
        let active = runs
            .values()
            .any(|r| r.source_id == new.source_id && r.task_id == new.task_id && !r.status.is_terminal());
        if active {
            return Err("a run for this task is already in progress".to_string());
        }
        if runs.contains_key(new.run_id) {
            return Err(format!("run {} already exists", new.run_id));
        }
        record.blocked_by = Self::blocker_in(&runs, &record).map(|other| other.task_title.clone());
        runs.insert(new.run_id.to_string(), record.clone());
        self.persist(&runs);
        Ok(record)
    }

    /// The latest earlier run in the same project folder that `me` has to wait
    /// for: one still unfinished (including one awaiting approval), since they
    /// would fight over the checked-out branch. Plan runs don't touch the
    /// checkout, so they neither wait nor are waited for.
    fn blocker_in<'a>(runs: &'a HashMap<String, RunRecord>, me: &RunRecord) -> Option<&'a RunRecord> {
        if me.plan_only {
            return None;
        }
        runs.values()
            .filter(|other| {
                other.id != me.id
                    && !other.plan_only
                    && other.project == me.project
                    && !other.status.is_terminal()
                    && (other.created_at_ms, &other.id) < (me.created_at_ms, &me.id)
            })
            .max_by_key(|other| (other.created_at_ms, other.id.clone()))
    }

    /// Title of the run `run_id` currently waits for, if any.
    pub fn blocker_of(&self, run_id: &str) -> Option<String> {
        let runs = self.lock();
        let me = runs.get(run_id)?;
        Self::blocker_in(&runs, me).map(|other| other.task_title.clone())
    }

    /// Stores what a queued run waits for; returns whether that changed.
    pub fn set_blocked_by(&self, run_id: &str, blocked_by: Option<String>) -> Result<bool, String> {
        self.update(run_id, |record| {
            let changed = record.blocked_by != blocked_by;
            record.blocked_by = blocked_by;
            Ok(changed)
        })
    }

    fn new_record(new: &NewRun) -> RunRecord {
        let now = now_ms();
        RunRecord {
            id: new.run_id.to_string(),
            task_id: new.task_id.to_string(),
            task_title: new.task_title.to_string(),
            task_url: new.task_url.to_string(),
            description: new.description.to_string(),
            issue_ref: new.issue_ref.to_string(),
            source_id: new.source_id.to_string(),
            issue_iid: new.issue_iid.to_string(),
            clone_url: new.clone_url.to_string(),
            base_branch: new.base_branch.to_string(),
            branch_conflict: None,
            plan_only: new.plan_only,
            plan: new.plan.map(str::to_string),
            blocked_by: None,
            fix_attempts: 0,
            review_verdict: None,
            usage: Vec::new(),
            generated_summary: None,
            generated_checklist: None,
            labels: new.labels.to_vec(),
            pushed: false,
            merge_request_url: None,
            test_result: None,
            redo_error: None,
            base_commit: None,
            commit_sha: None,
            previous_commit_sha: None,
            project: new.project.to_string(),
            status: RunStatus::Queued,
            history: vec![StatusTransition { status: RunStatus::Queued, at_ms: now }],
            error: None,
            review_notes: None,
            worker_summary: None,
            repo_path: None,
            branch: None,
            base_ref: None,
            work_dir: None,
            original_ref: None,
            stash_commit: None,
            created_at_ms: now,
            updated_at_ms: now,
        }
    }

    /// Moves a run to `next` if the state machine allows it, recording the
    /// timestamp. `error` is only kept for `Failed`.
    pub fn transition(&self, run_id: &str, next: RunStatus, error: Option<String>) -> Result<RunStatusEvent, String> {
        self.update(run_id, |record| record.apply(next, error))
    }

    pub fn set_review_notes(&self, run_id: &str, notes: String) -> Result<(), String> {
        self.update(run_id, |record| {
            record.review_notes = Some(notes);
            Ok(())
        })
    }

    /// Stores the reviewer's verdict (`None` when the latest review gave none).
    pub fn set_review_verdict(&self, run_id: &str, verdict: Option<&str>) -> Result<(), String> {
        self.update(run_id, |record| {
            record.review_verdict = verdict.map(str::to_string);
            Ok(())
        })
    }

    pub fn set_fix_attempts(&self, run_id: &str, attempts: u32) -> Result<(), String> {
        self.update(run_id, |record| {
            record.fix_attempts = attempts;
            Ok(())
        })
    }

    /// Notes what an agent step reported using; unknown runs are ignored.
    pub fn add_usage(&self, run_id: &str, step: &str, value: &str) {
        let _ = self.update(run_id, |record| {
            record.usage.push(format!("{step}: {value}"));
            Ok(())
        });
    }

    /// Marks (or, with `None`, clears) the branch-name conflict a failed run is waiting on.
    pub fn set_branch_conflict(&self, run_id: &str, conflict: Option<BranchConflict>) -> Result<(), String> {
        self.update(run_id, |record| {
            record.branch_conflict = conflict;
            Ok(())
        })
    }

    /// Replaces the stored test outcome (`None` when no hook ran this time).
    pub fn set_test_result(&self, run_id: &str, result: Option<TestResult>) -> Result<(), String> {
        self.update(run_id, |record| {
            record.test_result = result;
            Ok(())
        })
    }

    pub fn set_pushed(&self, run_id: &str) -> Result<(), String> {
        self.update(run_id, |record| {
            record.pushed = true;
            Ok(())
        })
    }

    pub fn set_merge_request_url(&self, run_id: &str, url: String) -> Result<(), String> {
        self.update(run_id, |record| {
            record.merge_request_url = Some(url);
            Ok(())
        })
    }

    pub fn set_worker_summary(&self, run_id: &str, summary: String) -> Result<(), String> {
        self.update(run_id, |record| {
            record.worker_summary = Some(summary);
            Ok(())
        })
    }

    /// Records the folder state to return to: where it was before the run and
    /// the stash holding its uncommitted changes.
    pub fn set_restore_point(
        &self,
        run_id: &str,
        original_ref: String,
        stash_commit: Option<String>,
    ) -> Result<(), String> {
        self.update(run_id, |record| {
            record.original_ref = Some(original_ref);
            record.stash_commit = stash_commit;
            Ok(())
        })
    }

    /// Records the branch the run actually starts from (it becomes the merge
    /// request's target).
    pub fn set_base_branch(&self, run_id: &str, base_branch: String) -> Result<(), String> {
        self.update(run_id, |record| {
            record.base_branch = base_branch;
            Ok(())
        })
    }

    /// Marks the stashed changes as restored.
    pub fn clear_stash(&self, run_id: &str) -> Result<(), String> {
        self.update(run_id, |record| {
            record.stash_commit = None;
            Ok(())
        })
    }

    /// Records where the run's work lives, for later diff/cleanup/hand-off.
    pub fn set_workspace(
        &self,
        run_id: &str,
        repo_path: PathBuf,
        branch: String,
        base_ref: String,
        base_commit: String,
        work_dir: PathBuf,
    ) -> Result<(), String> {
        self.update(run_id, |record| {
            record.repo_path = Some(repo_path);
            record.branch = Some(branch);
            record.base_ref = Some(base_ref);
            record.base_commit = Some(base_commit);
            record.work_dir = Some(work_dir);
            Ok(())
        })
    }

    pub fn set_commit_sha(&self, run_id: &str, sha: String) -> Result<(), String> {
        self.update(run_id, |record| {
            record.commit_sha = Some(sha);
            // A description written for the old commit no longer fits.
            record.generated_summary = None;
            record.generated_checklist = None;
            Ok(())
        })
    }

    /// Caches the merge request summary and checklist written for the current commit.
    pub fn set_generated_description(
        &self,
        run_id: &str,
        summary: String,
        checklist: Option<String>,
    ) -> Result<(), String> {
        self.update(run_id, |record| {
            record.generated_summary = Some(summary);
            record.generated_checklist = checklist;
            Ok(())
        })
    }

    /// Remembers the commit a redo just replaced.
    pub fn set_previous_commit(&self, run_id: &str, sha: String) -> Result<(), String> {
        self.update(run_id, |record| {
            record.previous_commit_sha = Some(sha);
            Ok(())
        })
    }

    /// Records (or, with `None`, clears) why the last automatic redo failed.
    pub fn set_redo_error(&self, run_id: &str, error: Option<String>) -> Result<(), String> {
        self.update(run_id, |record| {
            record.redo_error = error;
            Ok(())
        })
    }

    pub fn get(&self, run_id: &str) -> Option<RunRecord> {
        self.lock().get(run_id).cloned()
    }

    /// Removes a finished run from the history. Unfinished runs must be
    /// discarded (or finish) first, so nothing still working loses its record.
    pub fn delete(&self, run_id: &str) -> Result<(), String> {
        let mut runs = self.lock();
        let record = runs.get(run_id).ok_or_else(|| format!("unknown run {run_id}"))?;
        if !record.status.is_terminal() {
            return Err(format!("run is {:?}; finish or discard it before deleting", record.status));
        }
        runs.remove(run_id);
        self.persist(&runs);
        Ok(())
    }

    /// Deletes finished runs last updated before `cutoff_ms`, returning how many.
    /// A run whose stashed changes are still unrestored is kept, since its record
    /// is what points to them.
    pub fn purge_finished_before(&self, cutoff_ms: u64) -> usize {
        let mut runs = self.lock();
        let before = runs.len();
        runs.retain(|_, run| {
            !(run.status.is_terminal() && run.updated_at_ms < cutoff_ms && run.stash_commit.is_none())
        });
        let removed = before - runs.len();
        if removed > 0 {
            self.persist(&runs);
        }
        removed
    }

    /// All runs, newest first.
    pub fn list(&self) -> Vec<RunRecord> {
        let mut runs: Vec<RunRecord> = self.lock().values().cloned().collect();
        runs.sort_by_key(|run| std::cmp::Reverse(run.created_at_ms));
        runs
    }

    fn update<T>(&self, run_id: &str, change: impl FnOnce(&mut RunRecord) -> Result<T, String>) -> Result<T, String> {
        let mut runs = self.lock();
        let record = runs.get_mut(run_id).ok_or_else(|| format!("unknown run {run_id}"))?;
        let result = change(record)?;
        self.persist(&runs);
        Ok(result)
    }

    /// Writes via a temp file + rename so a crash can't leave a half-written store.
    fn persist(&self, runs: &HashMap<String, RunRecord>) {
        let Some(path) = &self.path else { return };
        let mut list: Vec<&RunRecord> = runs.values().collect();
        list.sort_by_key(|r| r.created_at_ms);

        let result = serde_json::to_string_pretty(&list)
            .map_err(|err| err.to_string())
            .and_then(|json| {
                if let Some(parent) = path.parent() {
                    fs::create_dir_all(parent).map_err(|err| err.to_string())?;
                }
                let tmp = path.with_extension("json.tmp");
                let mut file = fs::File::create(&tmp).map_err(|err| err.to_string())?;
                file.write_all(json.as_bytes()).map_err(|err| err.to_string())?;
                // Flush to disk before the rename, so a power loss can't leave an empty file.
                file.sync_all().map_err(|err| err.to_string())?;
                fs::rename(&tmp, path).map_err(|err| err.to_string())
            });
        if let Err(err) = result {
            log::error!("could not persist runs to {}: {err}", path.display());
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, RunRecord>> {
        self.runs.lock().expect("run store lock poisoned")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn happy_path_walks_every_state_with_timestamps() {
        let store = RunStore::default();
        store.create("r1");
        for next in [
            RunStatus::Cloning,
            RunStatus::Working,
            RunStatus::Reviewing,
            RunStatus::Committing,
            RunStatus::AwaitingApproval,
            RunStatus::Approved,
        ] {
            let event = store.transition("r1", next, None).unwrap();
            assert_eq!(event.status, next);
        }

        let record = store.get("r1").unwrap();
        assert_eq!(record.status, RunStatus::Approved);
        assert_eq!(record.history.len(), 7);
        assert!(record.history.windows(2).all(|w| w[0].at_ms <= w[1].at_ms));
    }

    #[test]
    fn awaiting_approval_can_be_redone_or_handed_off() {
        let store = RunStore::default();
        store.create("r1");
        for next in [
            RunStatus::Cloning,
            RunStatus::Working,
            RunStatus::Reviewing,
            RunStatus::Committing,
            RunStatus::AwaitingApproval,
            RunStatus::Queued,
            RunStatus::Working,
            RunStatus::Reviewing,
            RunStatus::Committing,
            RunStatus::AwaitingApproval,
            RunStatus::HandedOff,
        ] {
            store.transition("r1", next, None).unwrap();
        }
        assert!(store.transition("r1", RunStatus::Approved, None).is_err());
    }

    #[test]
    fn plan_only_runs_end_in_planned() {
        let store = RunStore::default();
        store.create("r1");
        for next in [RunStatus::Cloning, RunStatus::Working, RunStatus::Planned] {
            store.transition("r1", next, None).unwrap();
        }
        assert!(store.transition("r1", RunStatus::Reviewing, None).is_err());
    }

    #[test]
    fn rejects_skipping_states() {
        let store = RunStore::default();
        store.create("r1");
        assert!(store.transition("r1", RunStatus::Reviewing, None).is_err());
        assert_eq!(store.get("r1").unwrap().status, RunStatus::Queued);
    }

    #[test]
    fn any_active_state_can_fail_and_keeps_the_error() {
        let store = RunStore::default();
        store.create("r1");
        store.transition("r1", RunStatus::Cloning, None).unwrap();
        let event = store.transition("r1", RunStatus::Failed, Some("boom".into())).unwrap();
        assert_eq!(event.error.as_deref(), Some("boom"));
        assert_eq!(store.get("r1").unwrap().error.as_deref(), Some("boom"));
    }

    #[test]
    fn terminal_states_are_final() {
        let store = RunStore::default();
        store.create("r1");
        store.transition("r1", RunStatus::Failed, None).unwrap();
        assert!(store.transition("r1", RunStatus::Cloning, None).is_err());
        assert!(store.transition("r1", RunStatus::Failed, None).is_err());
    }

    #[test]
    fn unknown_run_is_an_error() {
        assert!(RunStore::default().transition("nope", RunStatus::Cloning, None).is_err());
    }

    #[test]
    fn status_serializes_as_snake_case() {
        assert_eq!(serde_json::to_string(&RunStatus::AwaitingApproval).unwrap(), "\"awaiting_approval\"");
    }

    #[test]
    fn runs_survive_a_reload_with_their_details() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("runs.json");

        let store = RunStore::load(path.clone());
        store.create_for_task(NewRun {
            run_id: "r1",
            task_id: "7-1",
            task_title: "Fix bug",
            task_url: "https://x/1",
            project: "group/proj",
            ..NewRun::default()
        });
        store
            .set_workspace(
                "r1",
                "/repo".into(),
                "taskdoer/1-fix".into(),
                "origin/main".into(),
                "abc123".into(),
                "/wt".into(),
            )
            .unwrap();
        store.set_review_notes("r1", "looks fine".into()).unwrap();
        for next in [
            RunStatus::Cloning,
            RunStatus::Working,
            RunStatus::Reviewing,
            RunStatus::Committing,
            RunStatus::AwaitingApproval,
        ] {
            store.transition("r1", next, None).unwrap();
        }

        let reloaded = RunStore::load(path);
        let record = reloaded.get("r1").expect("run should be persisted");
        assert_eq!(record.status, RunStatus::AwaitingApproval);
        assert_eq!(record.task_title, "Fix bug");
        assert_eq!(record.branch.as_deref(), Some("taskdoer/1-fix"));
        assert_eq!(record.review_notes.as_deref(), Some("looks fine"));
        assert_eq!(record.history.len(), 6);
    }

    #[test]
    fn old_finished_runs_are_purged_but_not_active_or_stash_holding_ones() {
        let store = RunStore::default();
        for id in ["done", "active", "stashed", "recent"] {
            store.create(id);
        }
        store.transition("done", RunStatus::Failed, Some("x".into())).unwrap();
        store.transition("stashed", RunStatus::Failed, Some("x".into())).unwrap();
        store.set_restore_point("stashed", "main".into(), Some("abc".into())).unwrap();
        store.transition("recent", RunStatus::Failed, Some("x".into())).unwrap();

        let far_future = now_ms() + 10_000;
        assert_eq!(store.purge_finished_before(far_future), 2, "done and recent");
        assert!(store.get("done").is_none());
        assert!(store.get("active").is_some());
        assert!(store.get("stashed").is_some());
        assert_eq!(store.purge_finished_before(0), 0);
    }

    #[test]
    fn only_finished_runs_can_be_deleted() {
        let store = RunStore::default();
        store.create("r1");
        assert!(store.delete("r1").is_err());
        assert!(store.get("r1").is_some());

        store.transition("r1", RunStatus::Failed, Some("x".into())).unwrap();
        store.delete("r1").unwrap();
        assert!(store.get("r1").is_none());
        assert!(store.delete("r1").is_err());
    }

    #[test]
    fn a_run_waits_for_earlier_runs_in_the_same_project_folder() {
        let store = RunStore::default();
        let new = |run_id, task_id, title, plan_only| NewRun {
            run_id,
            task_id,
            task_title: title,
            source_id: "s",
            project: "group/proj",
            plan_only,
            ..NewRun::default()
        };
        let first = store.create_unless_active(new("r1", "1-1", "First", false)).unwrap();
        assert_eq!(first.blocked_by, None);

        let second = store.create_unless_active(new("r2", "1-2", "Second", false)).unwrap();
        assert_eq!(second.blocked_by.as_deref(), Some("First"));
        let third = store.create_unless_active(new("r3", "1-3", "Third", false)).unwrap();
        assert_eq!(third.blocked_by.as_deref(), Some("Second"), "waits in line");

        // Plan runs don't touch the checkout.
        let plan = store.create_unless_active(new("r4", "1-4", "Plan", true)).unwrap();
        assert_eq!(plan.blocked_by, None);
        assert_eq!(store.blocker_of("r4"), None);
        let other = NewRun { project: "group/other", ..new("r5", "1-5", "Other", false) };
        assert_eq!(store.create_unless_active(other).unwrap().blocked_by, None);

        store.transition("r1", RunStatus::Failed, Some("x".into())).unwrap();
        assert_eq!(store.blocker_of("r2"), None);
        assert_eq!(store.blocker_of("r3").as_deref(), Some("Second"));
    }

    #[test]
    fn an_interrupted_redo_goes_back_to_awaiting_approval() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("runs.json");
        let store = RunStore::load(path.clone());
        store.create("r1");
        for next in [
            RunStatus::Cloning,
            RunStatus::Working,
            RunStatus::Reviewing,
            RunStatus::Committing,
            RunStatus::AwaitingApproval,
        ] {
            store.transition("r1", next, None).unwrap();
        }
        store.set_commit_sha("r1", "abc".into()).unwrap();
        store.transition("r1", RunStatus::Queued, None).unwrap();
        store.transition("r1", RunStatus::Working, None).unwrap();

        let reloaded = RunStore::load(path);
        let record = reloaded.get("r1").unwrap();
        assert_eq!(record.status, RunStatus::AwaitingApproval);
        assert_eq!(record.redo_error.as_deref(), Some("interrupted by app restart"));
        let (failed, restored) = reloaded.take_interrupted();
        assert!(failed.is_empty());
        assert_eq!(restored.len(), 1);
    }

    #[test]
    fn reload_fails_runs_interrupted_mid_pipeline() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("runs.json");

        let store = RunStore::load(path.clone());
        store.create("working");
        store.transition("working", RunStatus::Cloning, None).unwrap();
        store.transition("working", RunStatus::Working, None).unwrap();

        let reloaded = RunStore::load(path);
        let record = reloaded.get("working").unwrap();
        assert_eq!(record.status, RunStatus::Failed);
        assert_eq!(record.error.as_deref(), Some("interrupted by app restart"));
    }

    #[test]
    fn corrupt_store_file_is_set_aside_and_store_starts_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("runs.json");
        std::fs::write(&path, "not json").unwrap();

        let store = RunStore::load(path.clone());
        assert!(store.list().is_empty());
        let set_aside = std::fs::read_dir(tmp.path())
            .unwrap()
            .any(|entry| entry.unwrap().file_name().to_string_lossy().starts_with("runs.json.corrupt"));
        assert!(set_aside);
    }

    #[test]
    fn one_unreadable_record_does_not_lose_the_rest() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("runs.json");
        let store = RunStore::load(path.clone());
        store.create("good");
        let mut values: Vec<serde_json::Value> =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        values.push(serde_json::json!({ "id": "from-the-future", "status": "time_traveling" }));
        std::fs::write(&path, serde_json::to_string(&values).unwrap()).unwrap();

        let reloaded = RunStore::load(path);
        assert!(reloaded.get("good").is_some());
        assert!(reloaded.get("from-the-future").is_none());
        let backed_up = std::fs::read_dir(tmp.path())
            .unwrap()
            .any(|entry| entry.unwrap().file_name().to_string_lossy().contains("json.bak-"));
        assert!(backed_up);
    }

    #[test]
    fn records_saved_with_the_old_worktree_path_name_still_load() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("runs.json");
        let store = RunStore::load(path.clone());
        store.create("old");
        let mut values: Vec<serde_json::Value> =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let record = values[0].as_object_mut().unwrap();
        record.remove("workDir");
        record.insert("worktreePath".into(), "/tmp/old-folder".into());
        std::fs::write(&path, serde_json::to_string(&values).unwrap()).unwrap();

        let loaded = RunStore::load(path).get("old").unwrap();
        assert_eq!(loaded.work_dir, Some(PathBuf::from("/tmp/old-folder")));
    }

    #[test]
    fn finds_only_unfinished_runs_for_a_task() {
        let store = RunStore::default();
        store.create_for_task(NewRun { run_id: "r1", task_id: "7-1", source_id: "s", ..NewRun::default() });
        assert_eq!(store.find_active_for_task("s", "7-1").as_deref(), Some("r1"));
        assert!(store.find_active_for_task("other", "7-1").is_none());

        store.transition("r1", RunStatus::Failed, None).unwrap();
        assert!(store.find_active_for_task("s", "7-1").is_none());
    }

    #[test]
    fn a_failed_redo_returns_to_awaiting_approval_and_requeueing_clears_the_banner() {
        let store = RunStore::default();
        store.create("r1");
        for next in [
            RunStatus::Cloning,
            RunStatus::Working,
            RunStatus::Reviewing,
            RunStatus::Committing,
            RunStatus::AwaitingApproval,
            RunStatus::Queued,
            RunStatus::Working,
            RunStatus::AwaitingApproval,
        ] {
            store.transition("r1", next, None).unwrap();
        }
        store.set_redo_error("r1", Some("worker failed".into())).unwrap();
        assert_eq!(store.get("r1").unwrap().redo_error.as_deref(), Some("worker failed"));

        store.transition("r1", RunStatus::Queued, None).unwrap();
        assert!(store.get("r1").unwrap().redo_error.is_none());
    }

    #[test]
    fn branch_conflict_persists_and_can_be_cleared() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("runs.json");
        let store = RunStore::load(path.clone());
        store.create("r1");
        store
            .set_branch_conflict("r1", Some(BranchConflict { branch: "a".into(), suggestion: "a-2".into() }))
            .unwrap();

        let reloaded = RunStore::load(path);
        assert_eq!(reloaded.get("r1").unwrap().branch_conflict.unwrap().suggestion, "a-2");
        reloaded.set_branch_conflict("r1", None).unwrap();
        assert!(reloaded.get("r1").unwrap().branch_conflict.is_none());
    }

    #[test]
    fn list_returns_newest_first() {
        let store = RunStore::default();
        store.create("old");
        std::thread::sleep(std::time::Duration::from_millis(2));
        store.create("new");
        let ids: Vec<String> = store.list().into_iter().map(|r| r.id).collect();
        assert_eq!(ids, vec!["new", "old"]);
    }
}
