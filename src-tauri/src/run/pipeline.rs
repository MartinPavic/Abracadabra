//! Drives one run through clone -> branch -> worker -> tests -> reviewer ->
//! commit, emitting `run://status` on every transition.

use std::path::{Path, PathBuf};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_notification::NotificationExt;

use super::limiter::{ProjectGate, RunLimiter};
use super::{now_ms, BranchConflict, RunRecord, RunStatus, RunStatusEvent, RunStore};
use crate::agent::reviewer::{run_reviewer, split_verdict, ReviewInput, ReviewVerdict};
use crate::agent::runner::{
    remove_prompt_files, resolve_prompt_file, tail_chars, AgentRuntime, ProcessRegistry,
};
use crate::agent::tester::{run_tests, TestResult};
use crate::agent::worker::{run_worker, WorkerInput};
use crate::config::{AppConfig, ReviewerGate};
use crate::git::commit::{commit_all, has_changes, render_commit_message, restore_to};
use crate::git::inplace::{
    current_branch, current_ref, ensure_on_branch, in_progress_operation, require_clean, snapshot, stash_changes,
    stash_message, start_branch, undo_run,
};
use crate::git::locks::RepoLocks;
use crate::git::repo::{ensure_clone, managed_repo_dir, prepare_local_repo};
use crate::git::{resolve_base, rev_parse};
use crate::git::worktree::{
    branch_exists, is_valid_branch_name, render_branch_name, suggest_free_branch,
};
use crate::providers;
use crate::secrets::{self, AGENT_CREDENTIAL_ID};

pub struct RunInput {
    pub run_id: String,
    /// The git source this run's task came from (scopes the managed clone).
    pub source_id: String,
    pub project_url: String,
    /// Used for clone/fetch auth only; never logged.
    pub token: String,
    /// e.g. "group/project", used to name the local clone directory.
    pub project_path: String,
    pub base_branch: String,
    /// The project's own default branch, used if `base_branch` doesn't exist there.
    pub fallback_branch: String,
    pub issue_iid: String,
    pub issue_ref: String,
    pub title: String,
    pub description: String,
    /// Issue labels; only used to pick the branch's `{type}`.
    pub labels: Vec<String>,
    pub feedback: Option<String>,
    /// Branch name chosen by the user, replacing the templated one (retry after a conflict).
    pub branch_override: Option<String>,
    /// Plan from an earlier plan run for the worker to follow.
    pub plan: Option<String>,
    /// Produce a plan only: no reviewer, no commit, no branch.
    pub plan_only: bool,
}

pub(crate) fn enter<R: Runtime>(
    app: &AppHandle<R>,
    run_id: &str,
    status: RunStatus,
    error: Option<String>,
) -> Result<(), String> {
    let event = app.state::<RunStore>().transition(run_id, status, error)?;
    log::info!("run {run_id} -> {status:?}");
    if status.is_terminal() {
        // A queued run in the same project may be next in line.
        app.state::<ProjectGate>().notify();
    }
    notify_if_unfocused(app, run_id, status, event.error.as_deref());
    app.emit("run://status", event)
        .map_err(|err| format!("could not emit run status: {err}"))
}

/// Desktop notification for runs that need the user (ready for review or failed),
/// only when they aren't already looking at the app.
fn notify_if_unfocused<R: Runtime>(app: &AppHandle<R>, run_id: &str, status: RunStatus, error: Option<&str>) {
    let (title, fallback_body) = match status {
        RunStatus::AwaitingApproval => ("Run ready for review", "Review the changes and approve or discard them."),
        RunStatus::Planned => ("Plan ready", "Open the run to read the plan."),
        RunStatus::Failed => ("Run failed", "Open the run to see what went wrong."),
        _ => return,
    };
    let focused = app
        .get_webview_window("main")
        .and_then(|window| window.is_focused().ok())
        .unwrap_or(false);
    if focused {
        return;
    }

    let task_title = app.state::<RunStore>().get(run_id).map(|r| r.task_title).unwrap_or_default();
    let body = match (task_title.is_empty(), error) {
        (false, Some(err)) => format!("{task_title}: {err}"),
        (false, None) => task_title,
        (true, Some(err)) => err.to_string(),
        (true, None) => fallback_body.to_string(),
    };
    if let Err(err) = app.notification().builder().title(title).body(body).show() {
        log::warn!("could not show notification for run {run_id}: {err}");
    }
}

/// Executes the whole pipeline once a slot is free (the run stays `queued`
/// until then). Any step error marks the run `failed` with the error message and
/// puts the project folder back as it was (a leftover branch would make every
/// re-run of the issue hit a branch conflict); on success the run ends in
/// `awaiting_approval`, with the folder left on the run's branch. A run the user
/// cancelled is undone the same way but ends `cancelled`.
pub async fn execute_run<R: Runtime>(app: &AppHandle<R>, config: &AppConfig, input: RunInput) {
    let run_id = input.run_id.clone();
    wait_for_project(app, &run_id).await;
    let _slot = app.state::<RunLimiter>().acquire(config.max_parallel_runs).await;
    let registry = app.state::<ProcessRegistry>();
    if registry.is_cancelled(&run_id) {
        // Cancelled while queued: `request_cancel` already settled the status.
        registry.clear_cancel(&run_id);
        return;
    }
    if let Err(err) = run_steps(app, config, &input).await {
        let cancelled = registry.is_cancelled(&run_id);
        if cancelled {
            log::info!("run {run_id} cancelled");
        } else {
            log::error!("run {run_id} failed: {err}");
        }
        clean_up_run(app, &run_id).await;
        let _ = if cancelled {
            enter(app, &run_id, RunStatus::Cancelled, None)
        } else {
            enter(app, &run_id, RunStatus::Failed, Some(err))
        };
    }
    registry.clear_cancel(&run_id);
    remove_prompt_files(app, &run_id);
}

const CANCELLED: &str = "cancelled by you";

/// Upper bound for `auto_fix_attempts`, whatever the config says.
const MAX_FIX_ATTEMPTS: u32 = 3;

/// Holds a queued run back until every earlier run in its project folder has
/// finished (they would fight over the checked-out branch), in the order they
/// were started. Waiting runs don't hold a slot. Returns early if the run is
/// cancelled meanwhile.
async fn wait_for_project<R: Runtime>(app: &AppHandle<R>, run_id: &str) {
    let store = app.state::<RunStore>();
    let gate = app.state::<ProjectGate>();
    loop {
        // Registered before looking, so a run finishing in between wakes us.
        let mut changed = std::pin::pin!(gate.changed());
        changed.as_mut().enable();

        if app.state::<ProcessRegistry>().is_cancelled(run_id) {
            return;
        }
        let blocker = store.blocker_of(run_id);
        let changed_blocker = store.set_blocked_by(run_id, blocker.clone()).unwrap_or(false);
        if changed_blocker {
            let _ = app.emit(
                "run://status",
                RunStatusEvent { run_id: run_id.to_string(), status: RunStatus::Queued, at_ms: now_ms(), error: None },
            );
        }
        match blocker {
            None => return,
            Some(title) => {
                log::info!("run {run_id} is waiting for \"{title}\"");
                changed.await;
            }
        }
    }
}

fn check_cancelled<R: Runtime>(app: &AppHandle<R>, run_id: &str) -> Result<(), String> {
    if app.state::<ProcessRegistry>().is_cancelled(run_id) {
        Err(CANCELLED.to_string())
    } else {
        Ok(())
    }
}

/// Stops a run that is queued or in progress: kills the agent it is running and
/// makes the pipeline stop at its next step. Its changes are undone the way a
/// failure's are. A queued run settles right away; a queued redo goes back to
/// awaiting approval with its earlier result.
pub fn request_cancel<R: Runtime>(app: &AppHandle<R>, run_id: &str) -> Result<(), String> {
    let record = app
        .state::<RunStore>()
        .get(run_id)
        .ok_or_else(|| format!("unknown run {run_id}"))?;
    if !matches!(
        record.status,
        RunStatus::Queued | RunStatus::Cloning | RunStatus::Working | RunStatus::Reviewing | RunStatus::Committing
    ) {
        return Err(format!("run is {:?}; there is nothing to cancel", record.status));
    }
    app.state::<ProcessRegistry>().cancel(run_id);
    if record.status == RunStatus::Queued {
        if record.commit_sha.is_some() {
            enter(app, run_id, RunStatus::AwaitingApproval, None)?;
        } else {
            enter(app, run_id, RunStatus::Cancelled, None)?;
        }
    }
    Ok(())
}

/// Undoes what a run that didn't finish did to the project folder: drops its
/// branch and changes, returns to the earlier branch and restores the stashed
/// changes. Only what this run created is ever removed: a branch that already
/// existed is never recorded on the run.
async fn clean_up_run<R: Runtime>(app: &AppHandle<R>, run_id: &str) {
    let store = app.state::<RunStore>();
    let Some(record) = store.get(run_id) else { return };
    let Some(repo) = record.repo_path.as_deref() else { return };
    if record.branch.is_none() && record.stash_commit.is_none() {
        return;
    }
    let _guard = app.state::<RepoLocks>().lock(repo).await;
    let undone = undo_run(
        repo,
        record.branch.as_deref(),
        record.original_ref.as_deref(),
        record.stash_commit.as_deref(),
    )
    .await;
    match undone {
        Ok(None) => {
            let _ = store.clear_stash(run_id);
        }
        Ok(Some(note)) => log::warn!("run {run_id}: {note}"),
        Err(err) => log::warn!("run {run_id}: could not restore the project folder: {err}"),
    }
}

/// Rolls the run's branch back to `commit`, discarding uncommitted changes, but
/// only if the folder is on that branch: it must never reset anything else.
async fn roll_back_branch(worktree: &Path, branch: &str, commit: &str) -> Result<(), String> {
    if current_branch(worktree).await?.as_deref() == Some(branch) {
        restore_to(worktree, commit).await
    } else {
        Ok(())
    }
}

/// At startup: undoes what runs interrupted by the last exit left behind, and
/// rolls interrupted redos back to their last good commit.
pub async fn recover_interrupted_runs<R: Runtime>(app: &AppHandle<R>) {
    let (failed, restored) = app.state::<RunStore>().take_interrupted();
    for record in failed {
        clean_up_run(app, &record.id).await;
        remove_prompt_files(app, &record.id);
    }
    for record in restored {
        if let (Some(worktree), Some(branch), Some(commit)) =
            (record.work_dir.as_deref(), record.branch.as_deref(), record.commit_sha.as_deref())
        {
            if let Err(err) = roll_back_branch(worktree, branch, commit).await {
                log::warn!("run {}: could not roll back an interrupted redo: {err}", record.id);
            }
        }
        remove_prompt_files(app, &record.id);
    }
}

async fn run_steps<R: Runtime>(app: &AppHandle<R>, config: &AppConfig, input: &RunInput) -> Result<(), String> {
    let run_id = input.run_id.as_str();
    if input.plan_only && config.agent.plan_cmd.trim().is_empty() {
        return Err("plan command is not configured — set one in Settings".to_string());
    }

    enter(app, run_id, RunStatus::Cloning, None)?;
    let local_dir = config
        .local_repos
        .get(&input.project_path)
        .map(|dir| dir.trim())
        .filter(|dir| !dir.is_empty());
    let repo_path = match local_dir {
        Some(dir) => PathBuf::from(dir),
        None => managed_repo_dir(app, &input.source_id, &input.project_path)?,
    };

    // Held through setup: concurrent runs on one repo would race on clone/fetch
    // and on git's ref locks.
    let repo_guard = app.state::<RepoLocks>().lock(&repo_path).await;
    if local_dir.is_some() {
        log::info!("run {run_id}: using local folder {}", repo_path.display());
        prepare_local_repo(&repo_path, &input.project_url, Some(&input.token)).await?;
    } else {
        ensure_clone(&input.project_url, &repo_path, Some(&input.token)).await?;
    }

    check_cancelled(app, run_id)?;

    // Plans only read the folder as it is: no stash, no branch.
    if input.plan_only {
        drop(repo_guard);
        enter(app, run_id, RunStatus::Working, None)?;
        return plan_only_steps(app, config, input, &repo_path).await;
    }

    // Resolved first so a branch-name retry starts from the base actually used.
    let (base_branch, base_ref, base_commit) =
        resolve_base(&repo_path, &input.base_branch, &input.fallback_branch).await?;
    log::info!("run {run_id}: starting from {base_ref} at {base_commit}");
    app.state::<RunStore>().set_base_branch(run_id, base_branch)?;

    let branch = input
        .branch_override
        .clone()
        .unwrap_or_else(|| {
            render_branch_name(&config.branch_template, &input.issue_iid, &input.title, &input.labels)
        });
    if !is_valid_branch_name(&repo_path, &branch).await {
        return Err(format!("{branch:?} is not a valid git branch name"));
    }
    if branch_exists(&repo_path, &branch).await? {
        let suggestion = suggest_free_branch(&repo_path, &branch).await?;
        app.state::<RunStore>().set_branch_conflict(
            run_id,
            Some(BranchConflict { branch: branch.clone(), suggestion }),
        )?;
        return Err(format!("branch {branch} already exists"));
    }

    if let Some(operation) = in_progress_operation(&repo_path).await? {
        return Err(format!(
            "{} has a {operation} in progress; finish or abort it before starting a run",
            repo_path.display()
        ));
    }
    let original_ref = current_ref(&repo_path).await?;

    // Recorded before anything in the folder changes, so a failure from here on
    // can be undone (see `clean_up_run`).
    let store = app.state::<RunStore>();
    store.set_workspace(
        run_id,
        repo_path.clone(),
        branch.clone(),
        base_ref,
        base_commit.clone(),
        repo_path.clone(),
    )?;
    store.set_restore_point(run_id, original_ref.clone(), None)?;
    let stash = stash_changes(&repo_path, &stash_message(run_id)).await?;
    if stash.is_some() {
        log::info!("run {run_id}: stashed uncommitted changes in {}", repo_path.display());
        store.set_restore_point(run_id, original_ref, stash)?;
    }
    start_branch(&repo_path, &branch, &base_commit).await?;
    drop(repo_guard);

    enter(app, run_id, RunStatus::Working, None)?;
    let ctx = WorkContext {
        run_id,
        title: &input.title,
        description: &input.description,
        issue_ref: &input.issue_ref,
        labels: &input.labels,
        plan: input.plan.as_deref(),
        work_dir: &repo_path,
        base: &base_commit,
    };
    work_review_commit(app, config, &ctx, input.feedback.as_deref()).await
}

/// Plan-only run: the plan command's output becomes the run's summary. It runs
/// in the project folder as it is. Starts from a run in `working`.
async fn plan_only_steps<R: Runtime>(
    app: &AppHandle<R>,
    config: &AppConfig,
    input: &RunInput,
    repo_path: &Path,
) -> Result<(), String> {
    let run_id = input.run_id.as_str();
    let runtime = agent_runtime(config)?;
    let plan_input = WorkerInput {
        title: &input.title,
        description: &input.description,
        feedback: None,
        plan: None,
        plan_only: true,
    };
    // A work run in the same folder changes files legitimately, so the check
    // only means something while none is active.
    let work_run_active = || {
        app.state::<RunStore>()
            .list()
            .iter()
            .any(|r| !r.plan_only && r.project == input.project_path && !r.status.is_terminal())
    };
    let guard_applies = !work_run_active();
    let before = snapshot(repo_path).await?;
    let plan_prompt = resolve_prompt_file(repo_path, &config.agent.plan_prompt_file, "plan.md");
    let plan = run_worker(
        app,
        run_id,
        &config.agent.plan_cmd,
        &plan_input,
        repo_path,
        plan_prompt.as_deref(),
        &runtime,
    )
    .await?;
    if guard_applies && !work_run_active() && snapshot(repo_path).await? != before {
        return Err(format!(
            "the plan command changed files in {}; plan runs must be read-only (check `git status` there)",
            repo_path.display()
        ));
    }
    app.state::<RunStore>().set_worker_summary(run_id, plan.clone())?;
    if config.comment_plan {
        let task_id = app.state::<RunStore>().get(run_id).map(|run| run.task_id);
        if let Some(task_id) = task_id {
            let body = format!("Implementation plan (written by Abracadabra):\n\n{plan}");
            providers::comment_on_issue(config, &input.source_id, &input.token, &task_id, &body).await;
        }
    }
    enter(app, run_id, RunStatus::Planned, None)
}

/// Re-runs worker -> reviewer -> commit on a run's branch with the
/// user's feedback, replacing its commit. The caller has already moved the run
/// to `queued`; it goes to `working` once a slot is free. If the redo fails the
/// branch is rolled back to the run's earlier commit and the run returns to
/// `awaiting_approval` with the error shown, since that commit is still good.
pub async fn execute_redo<R: Runtime>(app: &AppHandle<R>, config: &AppConfig, run_id: String, feedback: String) {
    let _slot = app.state::<RunLimiter>().acquire(config.max_parallel_runs).await;
    let registry = app.state::<ProcessRegistry>();
    if registry.is_cancelled(&run_id) {
        // Cancelled while queued: `request_cancel` already put the run back.
        registry.clear_cancel(&run_id);
        return;
    }
    if let Err(err) = redo_steps(app, config, &run_id, &feedback).await {
        log::error!("redo of run {run_id} failed: {err}");
        let _ = enter(app, &run_id, RunStatus::Failed, Some(err));
    }
    registry.clear_cancel(&run_id);
    remove_prompt_files(app, &run_id);
}

async fn redo_steps<R: Runtime>(
    app: &AppHandle<R>,
    config: &AppConfig,
    run_id: &str,
    feedback: &str,
) -> Result<(), String> {
    enter(app, run_id, RunStatus::Working, None)?;
    let record = app
        .state::<RunStore>()
        .get(run_id)
        .ok_or_else(|| format!("unknown run {run_id}"))?;
    let (Some(work_dir), Some(base)) = (record.work_dir.as_deref(), base_of(&record)) else {
        return Err("this run has no worktree to redo in".to_string());
    };
    let Some(good_commit) = record.commit_sha.as_deref() else {
        return Err("this run has no commit to redo from".to_string());
    };
    let Some(branch) = record.branch.as_deref() else {
        return Err("this run has no branch to redo on".to_string());
    };

    // The folder is the user's too: if it can't be put on the run's branch
    // without clobbering their changes, leave the earlier result untouched.
    let ready = {
        let _guard = app.state::<RepoLocks>().lock(work_dir).await;
        match ensure_on_branch(work_dir, branch).await {
            Ok(()) => require_clean(work_dir).await,
            Err(err) => Err(err),
        }
    };
    if let Err(err) = ready {
        log::warn!("redo of run {run_id} did not start: {err}");
        app.state::<RunStore>().set_redo_error(run_id, Some(err))?;
        return enter(app, run_id, RunStatus::AwaitingApproval, None);
    }

    let ctx = WorkContext {
        run_id,
        title: &record.task_title,
        description: &record.description,
        issue_ref: &record.issue_ref,
        labels: &record.labels,
        plan: record.plan.as_deref(),
        work_dir,
        base,
    };
    match work_review_commit(app, config, &ctx, Some(feedback)).await {
        Ok(()) => app.state::<RunStore>().set_previous_commit(run_id, good_commit.to_string()),
        Err(err) => {
            let err = if check_cancelled(app, run_id).is_err() { CANCELLED.to_string() } else { err };
            roll_back_branch(work_dir, branch, good_commit)
                .await
                .map_err(|restore_err| format!("{err} (and rolling back failed: {restore_err})"))?;
            log::warn!("redo of run {run_id} failed, restored the earlier commit: {err}");
            app.state::<RunStore>().set_redo_error(run_id, Some(err))?;
            enter(app, run_id, RunStatus::AwaitingApproval, None)
        }
    }
}

/// The commit a run was cut from (falls back to the ref for runs saved before
/// the base commit was recorded).
pub(crate) fn base_of(record: &RunRecord) -> Option<&str> {
    record.base_commit.as_deref().or(record.base_ref.as_deref())
}

struct WorkContext<'a> {
    run_id: &'a str,
    title: &'a str,
    description: &'a str,
    issue_ref: &'a str,
    labels: &'a [String],
    plan: Option<&'a str>,
    work_dir: &'a Path,
    /// Commit the run's branch was cut from.
    base: &'a str,
}

/// The worker, test and reviewer steps of one run, with the settings they share.
struct Steps<'a, R: Runtime> {
    app: &'a AppHandle<R>,
    config: &'a AppConfig,
    ctx: &'a WorkContext<'a>,
    runtime: AgentRuntime,
    worker_prompt: Option<PathBuf>,
    reviewer_prompt: Option<PathBuf>,
}

impl<R: Runtime> Steps<'_, R> {
    async fn worker(&self, feedback: Option<&str>) -> Result<String, String> {
        let input = WorkerInput {
            title: self.ctx.title,
            description: self.ctx.description,
            feedback,
            plan: self.ctx.plan,
            plan_only: false,
        };
        run_worker(
            self.app,
            self.ctx.run_id,
            &self.config.agent.worker_cmd,
            &input,
            self.ctx.work_dir,
            self.worker_prompt.as_deref(),
            &self.runtime,
        )
        .await
    }

    async fn tests(&self) -> Option<TestResult> {
        if self.config.test_cmd.trim().is_empty() {
            return None;
        }
        Some(
            run_tests(self.app, self.ctx.run_id, &self.config.test_cmd, self.ctx.work_dir, &self.runtime)
                .await,
        )
    }

    /// Reviews the current changes; returns the notes without the verdict line.
    async fn review(&self, tests: Option<&TestResult>) -> Result<(String, Option<ReviewVerdict>), String> {
        let input = ReviewInput {
            title: self.ctx.title,
            description: self.ctx.description,
            base: self.ctx.base,
            tests,
        };
        let notes = run_reviewer(
            self.app,
            self.ctx.run_id,
            &self.config.agent.reviewer_cmd,
            &input,
            self.ctx.work_dir,
            self.reviewer_prompt.as_deref(),
            &self.runtime,
        )
        .await?;
        Ok(split_verdict(&notes))
    }
}

/// The user's feedback (on a redo) followed by what the pipeline wants fixed.
fn with_extra(feedback: Option<&str>, extra: &str) -> String {
    match feedback.map(str::trim).filter(|f| !f.is_empty()) {
        Some(feedback) => format!("{feedback}\n\n{extra}"),
        None => extra.to_string(),
    }
}

/// Worker, tests, reviewer and commit steps, starting from a run already in
/// `working`. Failing tests send the worker back up to `auto_fix_attempts`
/// times, and with the reviewer gate on `auto_redo` a "changes" verdict sends it
/// back once. The result is always exactly one commit on top of `base`.
async fn work_review_commit<R: Runtime>(
    app: &AppHandle<R>,
    config: &AppConfig,
    ctx: &WorkContext<'_>,
    feedback: Option<&str>,
) -> Result<(), String> {
    let run_id = ctx.run_id;
    let store = app.state::<RunStore>();
    let steps = Steps {
        app,
        config,
        ctx,
        runtime: agent_runtime(config)?,
        worker_prompt: resolve_prompt_file(ctx.work_dir, &config.agent.worker_prompt_file, "worker.md"),
        reviewer_prompt: resolve_prompt_file(ctx.work_dir, &config.agent.reviewer_prompt_file, "reviewer.md"),
    };
    store.set_fix_attempts(run_id, 0)?;
    store.set_review_verdict(run_id, None)?;

    let mut summary = steps.worker(feedback).await?;
    store.set_worker_summary(run_id, summary.clone())?;
    check_cancelled(app, run_id)?;

    // Checked before spending a reviewer run on nothing. Counts commits the worker
    // made itself (aider, for one) as changes.
    if !has_changes(ctx.work_dir, ctx.base).await? {
        return Err("the worker made no changes".to_string());
    }

    enter(app, run_id, RunStatus::Reviewing, None)?;
    let mut test_result = steps.tests().await;
    check_cancelled(app, run_id)?;

    let mut attempts = 0;
    while attempts < config.auto_fix_attempts.min(MAX_FIX_ATTEMPTS) {
        let Some(failed) = test_result.as_ref().filter(|result| !result.passed) else { break };
        attempts += 1;
        store.set_fix_attempts(run_id, attempts)?;
        let extra = format!(
            "The tests failed after your changes. Fix the code so they pass; do not delete or weaken \
             tests.\n\nEnd of the test output:\n```\n{}\n```",
            tail_chars(&failed.output, 4000)
        );
        enter(app, run_id, RunStatus::Working, None)?;
        let fix = steps.worker(Some(&with_extra(feedback, &extra))).await?;
        summary = format!("{summary}\n{fix}");
        store.set_worker_summary(run_id, summary.clone())?;
        check_cancelled(app, run_id)?;
        enter(app, run_id, RunStatus::Reviewing, None)?;
        test_result = steps.tests().await;
        check_cancelled(app, run_id)?;
    }
    store.set_test_result(run_id, test_result.clone())?;

    let (mut notes, mut verdict) = steps.review(test_result.as_ref()).await?;
    check_cancelled(app, run_id)?;
    if config.reviewer_gate == ReviewerGate::AutoRedo && verdict == Some(ReviewVerdict::Changes) {
        store.set_review_notes(run_id, notes.clone())?;
        let extra = format!("A code review of your changes found issues. Address them.\n\n{notes}");
        enter(app, run_id, RunStatus::Working, None)?;
        let fix = steps.worker(Some(&with_extra(feedback, &extra))).await?;
        summary = format!("{summary}\n{fix}");
        store.set_worker_summary(run_id, summary.clone())?;
        check_cancelled(app, run_id)?;
        enter(app, run_id, RunStatus::Reviewing, None)?;
        test_result = steps.tests().await;
        store.set_test_result(run_id, test_result.clone())?;
        check_cancelled(app, run_id)?;
        (notes, verdict) = steps.review(test_result.as_ref()).await?;
        check_cancelled(app, run_id)?;
    }
    store.set_review_notes(run_id, notes)?;
    store.set_review_verdict(run_id, verdict.map(ReviewVerdict::as_str))?;

    enter(app, run_id, RunStatus::Committing, None)?;
    let message = render_commit_message(&config.commit_template, ctx.issue_ref, ctx.title, ctx.labels, &summary);
    commit_all(ctx.work_dir, &message, ctx.base).await?;
    let commit = rev_parse(ctx.work_dir, "HEAD").await?;
    store.set_commit_sha(run_id, commit)?;

    enter(app, run_id, RunStatus::AwaitingApproval, None)
}

/// Limits and environment for agent processes: the keychain-stored credential
/// under the configured variable name (nothing is injected if either is unset,
/// so a CLI that is already logged in keeps working as-is) and the time limit.
pub(crate) fn agent_runtime(config: &AppConfig) -> Result<AgentRuntime, String> {
    let var = config.agent.credential_env_var.trim();
    let env = if var.is_empty() {
        Vec::new()
    } else {
        secrets::get_token(AGENT_CREDENTIAL_ID)?
            .map(|token| vec![(var.to_string(), token)])
            .unwrap_or_default()
    };
    let timeout = (config.agent.timeout_secs > 0).then(|| Duration::from_secs(config.agent.timeout_secs));
    let pattern = config.agent.usage_regex.trim();
    let usage_regex = if pattern.is_empty() {
        None
    } else {
        regex::Regex::new(pattern)
            .inspect_err(|err| log::warn!("ignoring invalid usage regex: {err}"))
            .ok()
    };
    Ok(AgentRuntime { env, timeout, usage_regex })
}
