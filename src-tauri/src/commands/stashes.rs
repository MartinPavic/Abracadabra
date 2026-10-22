//! Stashes the app made before runs that no run refers to any more (for
//! example because the run was deleted), so changes stashed for a run can't be
//! forgotten.

use std::collections::{BTreeSet, HashSet};
use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::config;
use crate::error::AppError;
use crate::git::inplace::{list_run_stashes, require_clean, restore_stash, run_id_of_stash};
use crate::git::locks::RepoLocks;
use crate::run::RunStore;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanedStash {
    pub repo_path: String,
    pub commit: String,
    pub message: String,
}

/// Folders runs have worked in or are configured to work in.
fn known_repos(app: &AppHandle) -> Result<BTreeSet<PathBuf>, String> {
    let mut repos: BTreeSet<PathBuf> =
        app.state::<RunStore>().list().into_iter().filter_map(|run| run.repo_path).collect();
    for dir in config::load(app)?.local_repos.values() {
        let dir = dir.trim();
        if !dir.is_empty() {
            repos.insert(PathBuf::from(dir));
        }
    }
    Ok(repos)
}

#[tauri::command]
pub async fn list_orphaned_stashes(app: AppHandle) -> Result<Vec<OrphanedStash>, String> {
    let runs = app.state::<RunStore>().list();
    let referenced: HashSet<&str> = runs.iter().filter_map(|run| run.stash_commit.as_deref()).collect();
    let mut found = Vec::new();
    for repo in known_repos(&app)?.into_iter().filter(|repo| repo.is_dir()) {
        let stashes = match list_run_stashes(&repo).await {
            Ok(stashes) => stashes,
            Err(err) => {
                log::debug!("could not list stashes in {}: {err}", repo.display());
                continue;
            }
        };
        for stash in stashes {
            let owner_is_active = run_id_of_stash(&stash.message)
                .and_then(|id| runs.iter().find(|run| run.id == id))
                .is_some_and(|run| !run.status.is_terminal());
            if referenced.contains(stash.commit.as_str()) || owner_is_active {
                continue;
            }
            found.push(OrphanedStash {
                repo_path: repo.display().to_string(),
                commit: stash.commit,
                message: stash.message,
            });
        }
    }
    Ok(found)
}

/// Pops one of the app's stashes onto a clean checkout. Only folders the app
/// knows about, and only stashes it created, are accepted.
#[tauri::command]
pub async fn restore_orphaned_stash(app: AppHandle, repo_path: String, commit: String) -> Result<(), AppError> {
    let repo = PathBuf::from(&repo_path);
    if !known_repos(&app)?.contains(&repo) {
        return Err(AppError::not_found("that folder isn't one of your project folders"));
    }
    let _guard = app.state::<RepoLocks>().lock(&repo).await;
    if !list_run_stashes(&repo).await.map_err(AppError::git)?.iter().any(|stash| stash.commit == commit) {
        return Err(AppError::not_found("that stash no longer exists"));
    }
    require_clean(&repo).await.map_err(AppError::git)?;
    restore_stash(&repo, &commit).await.map_err(AppError::git)
}
