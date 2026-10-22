//! Git provider Tauri commands (`test_connection`, `list_tasks`).

use tauri::AppHandle;

use crate::config::{self, GitProvider};
use crate::error::AppError;
use crate::providers::{self, Task};
use crate::secrets;

/// Tests connectivity + auth using the given (not-necessarily-saved-yet) credentials.
#[tauri::command]
pub async fn test_connection(
    app: AppHandle,
    provider: GitProvider,
    base_url: String,
    token: String,
) -> Result<(), AppError> {
    log::info!("test_connection invoked (provider={provider:?}, base_url={base_url})");
    let timeouts = config::load(&app).map(|c| c.timeouts).unwrap_or_default();

    let result = providers::build(provider, &base_url, &token, &timeouts)
        .test_connection()
        .await
        .map_err(AppError::from);

    match &result {
        Ok(()) => log::info!("test_connection succeeded for {base_url}"),
        Err(err) => log::warn!("test_connection failed for {base_url}: {err:?}"),
    }
    result
}

/// Lists tasks for a saved git source — its own assigned issues, or a single
/// project's issues if `project_filter` is set.
#[tauri::command]
pub async fn list_tasks(app: AppHandle, source_id: String) -> Result<Vec<Task>, AppError> {
    log::info!("list_tasks invoked for source {source_id}");

    let cfg = config::load(&app).map_err(|message| {
        log::error!("list_tasks({source_id}): could not load config: {message}");
        AppError::Other { message }
    })?;

    let source = cfg
        .git_sources
        .iter()
        .find(|s| s.id == source_id)
        .ok_or_else(|| {
            log::warn!("list_tasks({source_id}): no such git source");
            AppError::Other {
                message: "git source not found".to_string(),
            }
        })?;

    let token = secrets::get_token(&source_id)
        .map_err(|message| {
            log::error!("list_tasks({source_id}): could not read token: {message}");
            AppError::Other { message }
        })?
        .ok_or_else(|| {
            log::warn!("list_tasks({source_id}): no token saved");
            AppError::Other {
                message: "no token saved for this source — add one in Settings".to_string(),
            }
        })?;

    let provider = providers::build(source.provider, &source.base_url, &token, &cfg.timeouts);
    let tasks = match source.project_filter.as_deref() {
        Some(project) if !project.trim().is_empty() => provider.list_project_issues(project).await,
        _ => provider.list_my_issues().await,
    };
    let result = tasks.map_err(AppError::from);

    match &result {
        Ok(tasks) => log::info!("list_tasks({source_id}) succeeded: {} task(s)", tasks.len()),
        Err(err) => log::warn!("list_tasks({source_id}) failed: {err:?}"),
    }
    result
}
