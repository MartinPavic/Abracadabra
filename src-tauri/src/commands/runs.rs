//! Run Tauri commands: start, inspect, and the approval actions.

use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

use crate::agent::runner::{BufferedLine, OutputBuffer};
use crate::config::{self, AppConfig};
use crate::error::AppError;
use crate::git::diff::{live_diff, redo_diff, run_diff, FileDiff};
use crate::git::inplace::{ensure_on_branch, require_clean, return_to_original, undo_run};
use crate::git::locks::RepoLocks;
use crate::git::repo::push_branch;
use crate::providers::{self, MergeRequestRequest};
use crate::run::merge_request::{draft_for_run, MergeRequestDraft};
use crate::run::pipeline::{base_of, enter, execute_redo, execute_run, request_cancel, RunInput};
use crate::run::{now_ms, NewRun, RunRecord, RunStatus, RunStore};
use crate::secrets;

/// The run, if it's waiting on the user's decision.
fn awaiting_run(app: &AppHandle, run_id: &str) -> Result<RunRecord, AppError> {
    let record = app
        .state::<RunStore>()
        .get(run_id)
        .ok_or_else(|| AppError::not_found(format!("unknown run {run_id}")))?;
    if record.status != RunStatus::AwaitingApproval {
        return Err(AppError::conflict(format!("run is {:?}, not awaiting approval", record.status)));
    }
    Ok(record)
}

/// "Yes": accepts the run's commit.
#[tauri::command]
pub fn approve_run(app: AppHandle, run_id: String) -> Result<(), AppError> {
    Ok(enter(&app, &run_id, RunStatus::Approved, None)?)
}

/// "No": discards the run: deletes its branch and puts the project folder back
/// on the branch it was on, with the stashed changes restored. The status
/// changes first, so a concurrent "Yes" or redo can't win the race and have the
/// branch deleted underneath it.
#[tauri::command]
pub async fn discard_run(app: AppHandle, run_id: String) -> Result<(), AppError> {
    let record = awaiting_run(&app, &run_id)?;
    enter(&app, &run_id, RunStatus::Discarded, None)?;
    let Some(repo) = &record.repo_path else { return Ok(()) };

    let _guard = app.state::<RepoLocks>().lock(repo).await;
    let note = undo_run(
        repo,
        record.branch.as_deref(),
        record.original_ref.as_deref(),
        record.stash_commit.as_deref(),
    )
    .await
    .map_err(|err| AppError::git(format!("the run was discarded, but restoring your project folder failed: {err}")))?;
    if record.stash_commit.is_some() && note.is_none() {
        app.state::<RunStore>().clear_stash(&run_id)?;
    }
    match note {
        Some(note) => Err(AppError::git(format!("the run was discarded and its branch deleted, but {note}"))),
        None => Ok(()),
    }
}

/// Switches the project folder back to the branch it was on before the run and
/// restores the changes stashed for it, leaving the run's branch in place.
#[tauri::command]
pub async fn return_to_original_branch(app: AppHandle, run_id: String) -> Result<(), AppError> {
    let record = app
        .state::<RunStore>()
        .get(&run_id)
        .ok_or_else(|| AppError::not_found(format!("unknown run {run_id}")))?;
    if !matches!(record.status, RunStatus::AwaitingApproval | RunStatus::Approved | RunStatus::HandedOff) {
        return Err(AppError::conflict(format!("run is {:?}; there is nothing to switch back from", record.status)));
    }
    let (Some(repo), Some(original)) = (&record.repo_path, &record.original_ref) else {
        return Err(AppError::conflict("this run didn't record where your folder was"));
    };
    let _guard = app.state::<RepoLocks>().lock(repo).await;
    return_to_original(repo, original, record.stash_commit.as_deref()).await.map_err(AppError::git)?;
    Ok(app.state::<RunStore>().clear_stash(&run_id)?)
}

/// "Redo automatically": re-runs the pipeline on the run's branch with the
/// user's feedback added to the worker prompt. Returns once it has started.
#[tauri::command]
pub async fn redo_run(app: AppHandle, run_id: String, feedback: String) -> Result<(), AppError> {
    let record = awaiting_run(&app, &run_id)?;
    // Fail now, not after queueing, if the folder can't be put on the run's branch.
    if let (Some(repo), Some(branch)) = (&record.repo_path, &record.branch) {
        let _guard = app.state::<RepoLocks>().lock(repo).await;
        ensure_on_branch(repo, branch).await.map_err(AppError::git)?;
        require_clean(repo).await.map_err(AppError::git)?;
    }
    let cfg = config::load(&app)?.resolved_for(&record.source_id, &record.project);
    // Moving to `queued` here, not in the task, makes a double click fail fast.
    enter(&app, &run_id, RunStatus::Queued, None)?;

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        execute_redo(&app_handle, &cfg, run_id, feedback).await;
    });
    Ok(())
}

/// A run whose branch is ready to publish: approved, or handed off to the user
/// (who may have edited and committed in the worktree themselves).
fn publishable_run(app: &AppHandle, run_id: &str) -> Result<RunRecord, AppError> {
    let record = app
        .state::<RunStore>()
        .get(run_id)
        .ok_or_else(|| AppError::not_found(format!("unknown run {run_id}")))?;
    if !matches!(record.status, RunStatus::Approved | RunStatus::HandedOff) {
        return Err(AppError::conflict(format!("run is {:?}, not approved", record.status)));
    }
    Ok(record)
}

/// Pushes a run's branch to `origin`. Git's own error (protected branch,
/// rejected, auth) is returned as-is for the run view to show.
#[tauri::command]
pub async fn push_run(app: AppHandle, run_id: String) -> Result<(), AppError> {
    let record = publishable_run(&app, &run_id)?;
    if record.pushed {
        return Ok(());
    }
    let (Some(worktree), Some(branch)) = (record.work_dir.filter(|p| p.is_dir()), record.branch) else {
        return Err(AppError::not_found("this run's project folder no longer exists"));
    };
    let token = secrets::get_token(&record.source_id)?;
    push_branch(&worktree, &branch, token.as_deref()).await.map_err(AppError::git)?;
    Ok(app.state::<RunStore>().set_pushed(&run_id)?)
}

/// The title and description the merge request would get, for the user to edit
/// before it is created. With a description command configured this writes the
/// summary and checklist once per commit; `regenerate` writes them again.
#[tauri::command]
pub async fn preview_merge_request(
    app: AppHandle,
    run_id: String,
    regenerate: Option<bool>,
) -> Result<MergeRequestDraft, AppError> {
    let record = publishable_run(&app, &run_id)?;
    let cfg = config::load(&app)?.resolved_for(&record.source_id, &record.project);
    Ok(draft_for_run(&app, &cfg, &record, regenerate.unwrap_or(false)).await?)
}

/// Opens a merge/pull request for a pushed run and stores its URL on the run.
/// `title` and `description` replace the generated ones when given and not blank.
#[tauri::command]
pub async fn create_merge_request(
    app: AppHandle,
    run_id: String,
    title: Option<String>,
    description: Option<String>,
) -> Result<String, AppError> {
    let record = publishable_run(&app, &run_id)?;
    if let Some(url) = record.merge_request_url.clone() {
        return Ok(url);
    }
    if !record.pushed {
        return Err(AppError::conflict("push the branch first"));
    }
    let Some(branch) = record.branch.clone() else {
        return Err(AppError::conflict("this run has no branch"));
    };

    let cfg = config::load(&app)?.resolved_for(&record.source_id, &record.project);
    let source = cfg
        .git_sources
        .iter()
        .find(|s| s.id == record.source_id)
        .ok_or_else(|| "git source not found".to_string())?;
    let token = secrets::get_token(&record.source_id)?.ok_or(AppError::Auth)?;

    let given = |text: Option<String>| text.filter(|t| !t.trim().is_empty());
    // The draft (and a possible description command call) is only needed for what
    // the caller didn't supply.
    let (title, description) = match (given(title), given(description)) {
        (Some(title), Some(description)) => (title, description),
        (title, description) => {
            let draft = draft_for_run(&app, &cfg, &record, false).await?;
            (title.unwrap_or(draft.title), description.unwrap_or(draft.description))
        }
    };
    let request = MergeRequestRequest {
        project_path: record.project.clone(),
        source_branch: branch,
        target_branch: record.base_branch.clone(),
        title,
        description,
    };
    let url = providers::build(source.provider, &source.base_url, &token, &cfg.timeouts)
        .create_merge_request(&request)
        .await?;

    app.state::<RunStore>().set_merge_request_url(&run_id, url.clone())?;
    if cfg.comment_mr_link {
        providers::comment_on_issue(
            &cfg,
            &record.source_id,
            &token,
            &record.task_id,
            &format!("Merge request opened for this issue: {url}"),
        )
        .await;
    }
    Ok(url)
}

/// "Redo manually": opens the project folder, on the run's branch, and leaves it
/// to the user.
#[tauri::command]
pub async fn hand_off_run(app: AppHandle, run_id: String) -> Result<(), AppError> {
    let record = awaiting_run(&app, &run_id)?;
    let folder = record
        .work_dir
        .filter(|p| p.is_dir())
        .ok_or_else(|| "this run's project folder no longer exists".to_string())?;
    if let Some(branch) = &record.branch {
        let _guard = app.state::<RepoLocks>().lock(&folder).await;
        ensure_on_branch(&folder, branch).await.map_err(AppError::git)?;
    }
    app.opener()
        .open_path(folder.to_string_lossy(), None::<&str>)
        .map_err(|err| format!("could not open {}: {err}", folder.display()))?;
    Ok(enter(&app, &run_id, RunStatus::HandedOff, None)?)
}

#[tauri::command]
pub fn list_runs(app: AppHandle) -> Vec<RunRecord> {
    app.state::<RunStore>().list()
}

#[tauri::command]
pub fn get_run(app: AppHandle, run_id: String) -> Result<RunRecord, AppError> {
    app.state::<RunStore>()
        .get(&run_id)
        .ok_or_else(|| AppError::not_found(format!("unknown run {run_id}")))
}

/// Stops a queued or running run; see `request_cancel`.
#[tauri::command]
pub fn cancel_run(app: AppHandle, run_id: String) -> Result<(), AppError> {
    Ok(request_cancel(&app, &run_id)?)
}

/// Removes a finished run from the history. Its branch and commits, if any,
/// stay in the repository.
#[tauri::command]
pub fn delete_run(app: AppHandle, run_id: String) -> Result<(), AppError> {
    app.state::<RunStore>().delete(&run_id)?;
    app.state::<OutputBuffer>().remove(&run_id);
    Ok(())
}

/// Recent console output of a run (stdout/stderr of worker, reviewer and tests),
/// for views opened after the output was emitted.
#[tauri::command]
pub fn get_run_output(app: AppHandle, run_id: String) -> Vec<BufferedLine> {
    app.state::<OutputBuffer>().get(&run_id)
}

/// Files changed by a run (since its base commit) with per-file patches.
#[tauri::command]
pub async fn get_run_diff(app: AppHandle, run_id: String) -> Result<Vec<FileDiff>, AppError> {
    let record = app
        .state::<RunStore>()
        .get(&run_id)
        .ok_or_else(|| AppError::not_found(format!("unknown run {run_id}")))?;
    let (Some(work_dir), Some(base), Some(branch)) =
        (record.work_dir.as_deref(), base_of(&record), record.branch.as_deref())
    else {
        return Err(AppError::conflict("this run has no branch yet"));
    };
    if !work_dir.is_dir() {
        return Err(AppError::not_found("this run's project folder no longer exists"));
    }
    run_diff(work_dir, base, branch).await.map_err(AppError::git)
}

/// What the worker has changed so far in a run that is still working: the
/// uncommitted state of the project folder against the run's base commit.
#[tauri::command]
pub async fn get_run_diff_live(app: AppHandle, run_id: String) -> Result<Vec<FileDiff>, AppError> {
    let record = app
        .state::<RunStore>()
        .get(&run_id)
        .ok_or_else(|| AppError::not_found(format!("unknown run {run_id}")))?;
    if !matches!(record.status, RunStatus::Working | RunStatus::Reviewing) {
        return Err(AppError::conflict("this run isn't working right now"));
    }
    let (Some(repo), Some(base)) = (record.work_dir.as_deref(), base_of(&record)) else {
        return Err(AppError::conflict("this run has no branch yet"));
    };
    if !repo.is_dir() {
        return Err(AppError::not_found("this run's project folder no longer exists"));
    }
    live_diff(repo, base).await.map_err(AppError::git)
}

/// What the last redo changed: the diff between the commit it replaced and the
/// run's current commit.
#[tauri::command]
pub async fn get_redo_diff(app: AppHandle, run_id: String) -> Result<Vec<FileDiff>, AppError> {
    let record = app
        .state::<RunStore>()
        .get(&run_id)
        .ok_or_else(|| AppError::not_found(format!("unknown run {run_id}")))?;
    let (Some(repo), Some(previous), Some(current)) =
        (record.work_dir.as_deref(), record.previous_commit_sha.as_deref(), record.commit_sha.as_deref())
    else {
        return Err(AppError::conflict("this run hasn't been redone"));
    };
    if !repo.is_dir() {
        return Err(AppError::not_found("this run's project folder no longer exists"));
    }
    redo_diff(repo, previous, current).await.map_err(AppError::git)
}

/// Task ids end up in run ids and so in file names and URLs.
fn is_safe_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '~' | '-'))
}

/// Starts a run for a task in the background and returns its run id right
/// away; progress arrives via `run://status` and `agent://*-output` events.
#[tauri::command]
pub async fn start_run(
    app: AppHandle,
    source_id: String,
    task_id: String,
    plan_only: Option<bool>,
    from_plan_run_id: Option<String>,
) -> Result<String, AppError> {
    let plan_only = plan_only.unwrap_or(false);
    log::info!("start_run invoked for source {source_id}, task {task_id} (plan_only={plan_only})");
    if !is_safe_id(&task_id) {
        return Err("malformed task id".into());
    }
    let plan = match from_plan_run_id.as_deref() {
        Some(_) if plan_only => return Err(AppError::conflict("a plan run can't be based on another plan")),
        Some(plan_run_id) => Some(plan_of(&app, plan_run_id, &source_id, &task_id)?),
        None => None,
    };
    if app.state::<RunStore>().find_active_for_task(&source_id, &task_id).is_some() {
        return Err(AppError::conflict("a run for this task is already in progress"));
    }

    let cfg = config::load(&app)?;
    let source = cfg
        .git_sources
        .iter()
        .find(|s| s.id == source_id)
        .ok_or_else(|| "git source not found".to_string())?;
    let token = secrets::get_token(&source_id)?.ok_or(AppError::Auth)?;

    let details = providers::build(source.provider, &source.base_url, &token, &cfg.timeouts)
        .get_issue_details(&task_id)
        .await?;

    let cfg = cfg.resolved_for(&source_id, &details.project_path);
    let run_id = format!("{task_id}-{}", now_ms());
    let input = RunInput {
        run_id,
        source_id: source_id.clone(),
        project_url: details.clone_url,
        token,
        project_path: details.project_path,
        base_branch: Some(cfg.base_branch.trim())
            .filter(|branch| !branch.is_empty())
            .map_or_else(|| details.default_branch.clone(), str::to_string),
        fallback_branch: details.default_branch,
        issue_iid: details.iid,
        issue_ref: details.issue_ref,
        title: details.title,
        description: details.description,
        labels: details.labels,
        feedback: None,
        branch_override: None,
        plan,
        plan_only,
    };
    launch_run(&app, cfg, input, &source_id, &task_id, &details.url)
}

/// The plan produced by a finished plan run for this same task.
fn plan_of(app: &AppHandle, plan_run_id: &str, source_id: &str, task_id: &str) -> Result<String, AppError> {
    let record = app
        .state::<RunStore>()
        .get(plan_run_id)
        .ok_or_else(|| AppError::not_found(format!("unknown run {plan_run_id}")))?;
    if record.status != RunStatus::Planned || record.source_id != source_id || record.task_id != task_id {
        return Err(AppError::conflict("that run is not a finished plan for this task"));
    }
    record
        .worker_summary
        .filter(|plan| !plan.trim().is_empty())
        .ok_or_else(|| AppError::conflict("that plan is empty"))
}

/// Records the run (refusing a duplicate for the same task) and spawns its
/// pipeline in the background.
fn launch_run(
    app: &AppHandle,
    cfg: AppConfig,
    input: RunInput,
    source_id: &str,
    task_id: &str,
    task_url: &str,
) -> Result<String, AppError> {
    let run_id = input.run_id.clone();
    app.state::<RunStore>().create_unless_active(NewRun {
        run_id: &run_id,
        task_id,
        task_title: &input.title,
        task_url,
        description: &input.description,
        issue_ref: &input.issue_ref,
        source_id,
        issue_iid: &input.issue_iid,
        clone_url: &input.project_url,
        base_branch: &input.base_branch,
        plan_only: input.plan_only,
        plan: input.plan.as_deref(),
        labels: &input.labels,
        project: &input.project_path,
    })?;

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        execute_run(&app_handle, &cfg, input).await;
    });
    Ok(run_id)
}

/// After a run failed because its branch name was taken: starts a new run for
/// the same task on `branch`. Returns the new run's id.
#[tauri::command]
pub fn retry_run_with_branch(app: AppHandle, run_id: String, branch: String) -> Result<String, AppError> {
    let branch = branch.trim().to_string();
    if branch.is_empty() || branch.starts_with('-') || branch.chars().any(char::is_whitespace) {
        return Err("enter a branch name without spaces or a leading dash".into());
    }

    let store = app.state::<RunStore>();
    let record = store.get(&run_id).ok_or_else(|| AppError::not_found(format!("unknown run {run_id}")))?;
    if record.status != RunStatus::Failed || record.branch_conflict.is_none() {
        return Err(AppError::conflict("this run isn't waiting on a branch name"));
    }

    let cfg = config::load(&app)?.resolved_for(&record.source_id, &record.project);
    let token = secrets::get_token(&record.source_id)?
        .ok_or_else(|| "no token saved for this source — add one in Settings".to_string())?;
    let input = RunInput {
        run_id: format!("{}-{}", record.task_id, now_ms()),
        source_id: record.source_id.clone(),
        project_url: record.clone_url.clone(),
        token,
        project_path: record.project.clone(),
        base_branch: record.base_branch.clone(),
        fallback_branch: record.base_branch.clone(),
        issue_iid: record.issue_iid.clone(),
        issue_ref: record.issue_ref.clone(),
        title: record.task_title.clone(),
        description: record.description.clone(),
        labels: record.labels.clone(),
        feedback: None,
        branch_override: Some(branch),
        plan: record.plan.clone(),
        plan_only: record.plan_only,
    };

    let new_run_id = launch_run(&app, cfg, input, &record.source_id, &record.task_id, &record.task_url)?;
    store.set_branch_conflict(&run_id, None)?;
    Ok(new_run_id)
}
