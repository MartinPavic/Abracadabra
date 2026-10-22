//! Git finalize step — turns everything the worker did into one commit on top
//! of the run's base, using the configurable commit message template.

use std::path::Path;

use super::worktree::classify_title;
use super::{run_git, run_git_output};
use crate::template::substitute;

/// Fills a commit message template (e.g. `"{type}: {title}\n\nRefs {issue_ref}"`).
/// `{type}` is feat/fix/... and `{title}` has any conventional prefix removed.
pub fn render_commit_message(
    template: &str,
    issue_ref: &str,
    title: &str,
    labels: &[String],
    worker_summary: &str,
) -> String {
    let (kind, title) = classify_title(title, labels);
    substitute(
        template,
        &[("type", kind), ("issue_ref", issue_ref), ("title", title), ("worker_summary", worker_summary)],
    )
}

/// Stages everything and reports whether the worktree now differs from `base`,
/// counting both uncommitted changes and commits the worker made itself.
pub async fn has_changes(work_dir: &Path, base: &str) -> Result<bool, String> {
    run_git(work_dir, &["add", "-A"]).await?;
    let diff = run_git_output(work_dir, &["diff", "--cached", "--name-only", base]).await?;
    Ok(!diff.trim().is_empty())
}

/// Rolls the worktree back to `commit`, discarding whatever a failed or
/// interrupted redo left behind (tracked changes and untracked files).
pub async fn restore_to(work_dir: &Path, commit: &str) -> Result<(), String> {
    run_git(work_dir, &["reset", "--hard", commit]).await?;
    run_git(work_dir, &["clean", "-fd"]).await
}

/// Squashes everything since `base` (the worker's commits and uncommitted
/// changes alike) into a single commit with `message`. Also used for redos, so a
/// run always ends up as exactly one commit. Errors if nothing differs from `base`.
pub async fn commit_all(work_dir: &Path, message: &str, base: &str) -> Result<(), String> {
    if !has_changes(work_dir, base).await? {
        return Err("nothing to commit: the worker made no changes".to_string());
    }
    run_git(work_dir, &["reset", "--soft", base]).await?;
    run_git(work_dir, &["commit", "-m", message]).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn init_repo(dir: &Path) {
        let git = |args: &[&str]| {
            let status = Command::new("git").current_dir(dir).args(args).status().unwrap();
            assert!(status.success(), "git {args:?} failed");
        };
        git(&["init", "-q", "-b", "main"]);
        git(&["config", "user.email", "test@example.com"]);
        git(&["config", "user.name", "Test"]);
        std::fs::write(dir.join("a.txt"), "old\n").unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-q", "-m", "initial"]);
    }

    #[test]
    fn renders_commit_message_from_template() {
        let message = render_commit_message(
            "{type}: {title}\n\nRefs {issue_ref}\n\n{worker_summary}",
            "group/proj#7",
            "Fix bug",
            &["bug".to_string()],
            "Changed a.txt",
        );
        assert_eq!(message, "fix: Fix bug\n\nRefs group/proj#7\n\nChanged a.txt");
    }

    #[test]
    fn commit_title_drops_a_conventional_prefix() {
        let message = render_commit_message("{type}: {title}", "x#1", "chore(ci): bump node", &[], "");
        assert_eq!(message, "chore: bump node");
    }

    #[tokio::test]
    async fn commits_modified_and_new_files() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo(tmp.path());
        std::fs::write(tmp.path().join("a.txt"), "new\n").unwrap();
        std::fs::write(tmp.path().join("b.txt"), "brand new\n").unwrap();

        commit_all(tmp.path(), "proj#1: Fix\n\nsummary", "HEAD").await.unwrap();

        let log = run_git_output(tmp.path(), &["log", "-1", "--format=%B"]).await.unwrap();
        assert_eq!(log.trim(), "proj#1: Fix\n\nsummary");
        let status = run_git_output(tmp.path(), &["status", "--porcelain"]).await.unwrap();
        assert!(status.trim().is_empty());
    }

    #[tokio::test]
    async fn squashes_a_workers_own_commits_into_one() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo(tmp.path());
        let base = run_git_output(tmp.path(), &["rev-parse", "HEAD"]).await.unwrap();
        let base = base.trim();

        // A worker that commits on its own (e.g. aider), then leaves one more edit.
        std::fs::write(tmp.path().join("a.txt"), "one\n").unwrap();
        run_git(tmp.path(), &["commit", "-qam", "worker commit 1"]).await.unwrap();
        std::fs::write(tmp.path().join("b.txt"), "two\n").unwrap();
        run_git(tmp.path(), &["add", "-A"]).await.unwrap();
        run_git(tmp.path(), &["commit", "-qm", "worker commit 2"]).await.unwrap();
        std::fs::write(tmp.path().join("c.txt"), "three\n").unwrap();

        commit_all(tmp.path(), "ours", base).await.unwrap();

        let count = run_git_output(tmp.path(), &["rev-list", "--count", &format!("{base}..HEAD")]).await.unwrap();
        assert_eq!(count.trim(), "1");
        let files = run_git_output(tmp.path(), &["diff", "--name-only", base, "HEAD"]).await.unwrap();
        assert_eq!(files.lines().collect::<Vec<_>>(), vec!["a.txt", "b.txt", "c.txt"]);
        let log = run_git_output(tmp.path(), &["log", "-1", "--format=%B"]).await.unwrap();
        assert_eq!(log.trim(), "ours");
    }

    #[tokio::test]
    async fn recommitting_replaces_the_previous_commit() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo(tmp.path());
        let base = run_git_output(tmp.path(), &["rev-parse", "HEAD"]).await.unwrap();
        let base = base.trim();

        std::fs::write(tmp.path().join("a.txt"), "first\n").unwrap();
        commit_all(tmp.path(), "first message", base).await.unwrap();
        std::fs::write(tmp.path().join("a.txt"), "second\n").unwrap();
        commit_all(tmp.path(), "second message", base).await.unwrap();

        let count = run_git_output(tmp.path(), &["rev-list", "--count", &format!("{base}..HEAD")]).await.unwrap();
        assert_eq!(count.trim(), "1");
        let log = run_git_output(tmp.path(), &["log", "-1", "--format=%B"]).await.unwrap();
        assert_eq!(log.trim(), "second message");
    }

    #[tokio::test]
    async fn restore_to_discards_later_work() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo(tmp.path());
        let good = run_git_output(tmp.path(), &["rev-parse", "HEAD"]).await.unwrap();
        let good = good.trim();

        std::fs::write(tmp.path().join("a.txt"), "half-done\n").unwrap();
        std::fs::write(tmp.path().join("junk.txt"), "x\n").unwrap();
        run_git(tmp.path(), &["add", "junk.txt"]).await.unwrap();
        run_git(tmp.path(), &["commit", "-qam", "wip"]).await.unwrap();
        std::fs::write(tmp.path().join("untracked.txt"), "y\n").unwrap();

        restore_to(tmp.path(), good).await.unwrap();

        assert_eq!(std::fs::read_to_string(tmp.path().join("a.txt")).unwrap(), "old\n");
        assert!(!tmp.path().join("junk.txt").exists());
        assert!(!tmp.path().join("untracked.txt").exists());
        assert_eq!(run_git_output(tmp.path(), &["rev-parse", "HEAD"]).await.unwrap().trim(), good);
    }

    #[tokio::test]
    async fn errors_when_there_is_nothing_to_commit() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo(tmp.path());

        assert!(!has_changes(tmp.path(), "HEAD").await.unwrap());
        let err = commit_all(tmp.path(), "msg", "HEAD").await.unwrap_err();
        assert!(err.contains("nothing to commit"));
    }
}
