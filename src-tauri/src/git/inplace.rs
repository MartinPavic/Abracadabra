//! Runs work directly in the user's project folder: the folder's uncommitted
//! changes are stashed, a branch is cut from the base commit, and the folder is
//! left on that branch for review. These helpers set that up and undo it.
//!
//! Destructive steps (`reset --hard`, `clean`) only ever run while the run's own
//! branch is checked out, so they can't touch work on any other branch.

use std::path::Path;

use super::worktree::branch_exists;
use super::{rev_parse, run_git, run_git_output};

/// Name of the checked-out branch, or `None` when HEAD is detached.
pub async fn current_branch(repo: &Path) -> Result<Option<String>, String> {
    // Exits non-zero when detached.
    match run_git_output(repo, &["symbolic-ref", "--short", "-q", "HEAD"]).await {
        Ok(name) => Ok(Some(name.trim().to_string()).filter(|name| !name.is_empty())),
        Err(_) => Ok(None),
    }
}

/// What HEAD points at: the branch name, or the commit when detached.
pub async fn current_ref(repo: &Path) -> Result<String, String> {
    match current_branch(repo).await? {
        Some(branch) => Ok(branch),
        None => rev_parse(repo, "HEAD").await,
    }
}

/// Whether the folder has uncommitted changes or untracked (not ignored) files.
pub async fn is_dirty(repo: &Path) -> Result<bool, String> {
    let status = run_git_output(repo, &["status", "--porcelain"]).await?;
    Ok(!status.trim().is_empty())
}

async fn stash_tip(repo: &Path) -> Option<String> {
    run_git_output(repo, &["rev-parse", "-q", "--verify", "refs/stash"])
        .await
        .ok()
        .map(|sha| sha.trim().to_string())
}

/// Stashes uncommitted and untracked changes. Returns the stash's commit, which
/// stays valid when other stashes are added or dropped; `None` if there was
/// nothing to stash.
pub async fn stash_changes(repo: &Path, message: &str) -> Result<Option<String>, String> {
    if !is_dirty(repo).await? {
        return Ok(None);
    }
    let before = stash_tip(repo).await;
    run_git(repo, &["stash", "push", "--include-untracked", "-m", message]).await?;
    let after = stash_tip(repo).await;
    Ok(if after != before { after } else { None })
}

/// Pops the stash with this commit onto the current checkout. On conflicts git
/// keeps the stash, so nothing is lost.
pub async fn restore_stash(repo: &Path, stash: &str) -> Result<(), String> {
    let listed = run_git_output(repo, &["stash", "list", "--format=%H"]).await?;
    let index = listed
        .lines()
        .position(|line| line.trim() == stash)
        .ok_or_else(|| "the stash with your earlier changes is gone (was it dropped?)".to_string())?;
    run_git(repo, &["stash", "pop", "--quiet", &format!("stash@{{{index}}}")]).await
}

/// Checks out a branch name or, when detached before, a commit.
pub async fn checkout(repo: &Path, target: &str) -> Result<(), String> {
    run_git(repo, &["checkout", "--quiet", target, "--"]).await
}

/// Creates `branch` at `base_commit` and switches to it.
pub async fn start_branch(repo: &Path, branch: &str, base_commit: &str) -> Result<(), String> {
    log::info!("creating branch {branch} in {}", repo.display());
    run_git(repo, &["checkout", "--quiet", "-b", branch, base_commit]).await
}

/// Makes sure `branch` is checked out, switching to it if the folder is clean.
pub async fn ensure_on_branch(repo: &Path, branch: &str) -> Result<(), String> {
    if current_branch(repo).await?.as_deref() == Some(branch) {
        return Ok(());
    }
    if is_dirty(repo).await? {
        return Err(format!(
            "{} has uncommitted changes and isn't on {branch}; commit or stash them, or switch to {branch}",
            repo.display()
        ));
    }
    checkout(repo, branch).await
}

/// Errors unless the folder has no uncommitted changes.
pub async fn require_clean(repo: &Path) -> Result<(), String> {
    if is_dirty(repo).await? {
        return Err(format!(
            "{} has uncommitted changes; commit or stash them first",
            repo.display()
        ));
    }
    Ok(())
}

/// Puts the folder back as it was before the run: drops the run's branch and
/// anything uncommitted on it, returns to `original` and restores the stash.
/// Returns a note when the stash had to stay behind because the folder isn't on
/// `original` any more.
pub async fn undo_run(
    repo: &Path,
    branch: Option<&str>,
    original: Option<&str>,
    stash: Option<&str>,
) -> Result<Option<String>, String> {
    if let Some(branch) = branch {
        if current_branch(repo).await?.as_deref() == Some(branch) {
            run_git(repo, &["reset", "--hard"]).await?;
            run_git(repo, &["clean", "-fd"]).await?;
            if let Some(original) = original {
                checkout(repo, original).await?;
            }
        }
        if branch_exists(repo, branch).await? {
            run_git(repo, &["branch", "-D", branch]).await?;
        }
    }

    let Some(stash) = stash else { return Ok(None) };
    let here = current_ref(repo).await?;
    if original == Some(here.as_str()) {
        restore_stash(repo, stash).await?;
        Ok(None)
    } else {
        Ok(Some(
            "your earlier uncommitted changes are still in the stash (git stash list)".to_string(),
        ))
    }
}

/// Leaves a run's branch (kept) for the folder's original checkout and restores
/// the stashed changes there.
pub async fn return_to_original(repo: &Path, original: &str, stash: Option<&str>) -> Result<(), String> {
    require_clean(repo).await?;
    checkout(repo, original).await?;
    if let Some(stash) = stash {
        restore_stash(repo, stash).await?;
    }
    Ok(())
}

/// The merge, rebase, cherry-pick, revert or bisect the folder is in the middle
/// of, if any. A run must not stash and switch branches under one.
pub async fn in_progress_operation(repo: &Path) -> Result<Option<&'static str>, String> {
    const MARKERS: [(&str, &str); 6] = [
        ("MERGE_HEAD", "merge"),
        ("rebase-merge", "rebase"),
        ("rebase-apply", "rebase"),
        ("CHERRY_PICK_HEAD", "cherry-pick"),
        ("REVERT_HEAD", "revert"),
        ("BISECT_LOG", "bisect"),
    ];
    for (marker, name) in MARKERS {
        let located = run_git_output(repo, &["rev-parse", "--git-path", marker]).await?;
        if repo.join(located.trim()).exists() {
            return Ok(Some(name));
        }
    }
    Ok(None)
}

/// Everything about the folder's tracked and untracked state that a command
/// could change, for before/after comparisons.
pub async fn snapshot(repo: &Path) -> Result<String, String> {
    let status = run_git_output(repo, &["status", "--porcelain"]).await?;
    let diff = run_git_output(repo, &["diff", "HEAD"]).await.unwrap_or_default();
    Ok(format!("{status}\n--\n{diff}"))
}

/// A stash this app created before a run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunStash {
    pub commit: String,
    pub message: String,
}

const STASH_MESSAGE_PREFIX: &str = "task-doer: changes before run";

/// The message `stash_changes` is called with for `run_id`.
pub fn stash_message(run_id: &str) -> String {
    format!("{STASH_MESSAGE_PREFIX} {run_id}")
}

/// The run a stash message from `stash_message` belongs to.
pub fn run_id_of_stash(message: &str) -> Option<&str> {
    message.strip_prefix(STASH_MESSAGE_PREFIX).map(str::trim)
}

/// Stashes in `repo` that this app created, newest first.
pub async fn list_run_stashes(repo: &Path) -> Result<Vec<RunStash>, String> {
    let listed = run_git_output(repo, &["stash", "list", "--format=%H %gs"]).await?;
    Ok(listed
        .lines()
        .filter_map(|line| {
            let (commit, subject) = line.split_once(' ')?;
            // The subject reads "On <branch>: <message>".
            let message = subject.split_once(": ").map_or(subject, |(_, message)| message);
            message
                .starts_with(STASH_MESSAGE_PREFIX)
                .then(|| RunStash { commit: commit.to_string(), message: message.to_string() })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git").current_dir(dir).args(args).output().unwrap();
        assert!(out.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    fn init_repo(dir: &Path) {
        git(dir, &["init", "-q", "-b", "main"]);
        git(dir, &["config", "user.email", "test@example.com"]);
        git(dir, &["config", "user.name", "Test"]);
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        git(dir, &["add", "-A"]);
        git(dir, &["commit", "-q", "-m", "initial"]);
    }

    #[tokio::test]
    async fn clean_folder_has_nothing_to_stash() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo(tmp.path());
        assert_eq!(stash_changes(tmp.path(), "m").await.unwrap(), None);
        assert_eq!(current_ref(tmp.path()).await.unwrap(), "main");
    }

    #[tokio::test]
    async fn undo_returns_to_the_original_state_with_changes_restored() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path();
        init_repo(repo);
        std::fs::write(repo.join("a.txt"), "edited\n").unwrap();
        std::fs::write(repo.join("scratch.txt"), "mine\n").unwrap();

        let stash = stash_changes(repo, "task-doer: test").await.unwrap();
        assert!(stash.is_some());
        assert!(!is_dirty(repo).await.unwrap());

        let base = rev_parse(repo, "main").await.unwrap();
        start_branch(repo, "feat/1-x", &base).await.unwrap();
        std::fs::write(repo.join("a.txt"), "agent\n").unwrap();
        std::fs::write(repo.join("new.txt"), "agent\n").unwrap();

        let note = undo_run(repo, Some("feat/1-x"), Some("main"), stash.as_deref()).await.unwrap();
        assert_eq!(note, None);
        assert_eq!(current_ref(repo).await.unwrap(), "main");
        assert!(!branch_exists(repo, "feat/1-x").await.unwrap());
        assert_eq!(std::fs::read_to_string(repo.join("a.txt")).unwrap(), "edited\n");
        assert_eq!(std::fs::read_to_string(repo.join("scratch.txt")).unwrap(), "mine\n");
        assert!(!repo.join("new.txt").exists());
    }

    #[tokio::test]
    async fn undo_leaves_the_stash_when_the_folder_moved_elsewhere() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path();
        init_repo(repo);
        std::fs::write(repo.join("a.txt"), "edited\n").unwrap();
        let stash = stash_changes(repo, "m").await.unwrap();

        let base = rev_parse(repo, "main").await.unwrap();
        start_branch(repo, "feat/1-x", &base).await.unwrap();
        git(repo, &["checkout", "-q", "-b", "other"]);

        let note = undo_run(repo, Some("feat/1-x"), Some("main"), stash.as_deref()).await.unwrap();
        assert!(note.is_some());
        assert_eq!(current_ref(repo).await.unwrap(), "other");
        assert!(!branch_exists(repo, "feat/1-x").await.unwrap());
        assert_eq!(std::fs::read_to_string(repo.join("a.txt")).unwrap(), "one\n");
        assert!(stash_tip(repo).await.is_some());
    }

    #[tokio::test]
    async fn undo_never_resets_another_branch() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path();
        init_repo(repo);
        let base = rev_parse(repo, "main").await.unwrap();
        start_branch(repo, "feat/1-x", &base).await.unwrap();
        git(repo, &["checkout", "-q", "main"]);
        std::fs::write(repo.join("a.txt"), "my work\n").unwrap();

        undo_run(repo, Some("feat/1-x"), Some("main"), None).await.unwrap();
        assert_eq!(std::fs::read_to_string(repo.join("a.txt")).unwrap(), "my work\n");
    }

    #[tokio::test]
    async fn ensure_on_branch_refuses_when_dirty_elsewhere() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path();
        init_repo(repo);
        let base = rev_parse(repo, "main").await.unwrap();
        start_branch(repo, "feat/1-x", &base).await.unwrap();
        git(repo, &["checkout", "-q", "main"]);

        ensure_on_branch(repo, "feat/1-x").await.unwrap();
        assert_eq!(current_ref(repo).await.unwrap(), "feat/1-x");

        git(repo, &["checkout", "-q", "main"]);
        std::fs::write(repo.join("a.txt"), "dirty\n").unwrap();
        assert!(ensure_on_branch(repo, "feat/1-x").await.is_err());
    }

    #[tokio::test]
    async fn return_to_original_keeps_the_branch_and_restores_the_stash() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path();
        init_repo(repo);
        std::fs::write(repo.join("a.txt"), "edited\n").unwrap();
        let stash = stash_changes(repo, "m").await.unwrap();
        let base = rev_parse(repo, "main").await.unwrap();
        start_branch(repo, "feat/1-x", &base).await.unwrap();

        return_to_original(repo, "main", stash.as_deref()).await.unwrap();
        assert_eq!(current_ref(repo).await.unwrap(), "main");
        assert!(branch_exists(repo, "feat/1-x").await.unwrap());
        assert_eq!(std::fs::read_to_string(repo.join("a.txt")).unwrap(), "edited\n");
    }

    #[tokio::test]
    async fn detects_an_operation_in_progress() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path();
        init_repo(repo);
        assert_eq!(in_progress_operation(repo).await.unwrap(), None);

        std::fs::write(repo.join(".git/MERGE_HEAD"), "abc\n").unwrap();
        assert_eq!(in_progress_operation(repo).await.unwrap(), Some("merge"));
        std::fs::remove_file(repo.join(".git/MERGE_HEAD")).unwrap();

        std::fs::create_dir(repo.join(".git/rebase-merge")).unwrap();
        assert_eq!(in_progress_operation(repo).await.unwrap(), Some("rebase"));
    }

    #[tokio::test]
    async fn snapshot_changes_when_files_change() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path();
        init_repo(repo);
        let clean = snapshot(repo).await.unwrap();
        assert_eq!(snapshot(repo).await.unwrap(), clean);

        std::fs::write(repo.join("a.txt"), "edited\n").unwrap();
        let edited = snapshot(repo).await.unwrap();
        assert_ne!(edited, clean);

        // Editing an already-modified file again is still noticed.
        std::fs::write(repo.join("a.txt"), "edited again\n").unwrap();
        assert_ne!(snapshot(repo).await.unwrap(), edited);

        std::fs::write(repo.join("new.txt"), "x\n").unwrap();
        assert_ne!(snapshot(repo).await.unwrap(), clean);
    }

    #[tokio::test]
    async fn lists_only_the_stashes_this_app_made() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path();
        init_repo(repo);
        std::fs::write(repo.join("a.txt"), "mine\n").unwrap();
        git(repo, &["stash", "push", "-m", "my own stash"]);
        std::fs::write(repo.join("a.txt"), "edited\n").unwrap();
        let ours = stash_changes(repo, &stash_message("run-1")).await.unwrap().unwrap();

        let listed = list_run_stashes(repo).await.unwrap();
        assert_eq!(listed, vec![RunStash { commit: ours, message: "task-doer: changes before run run-1".into() }]);
    }
}
