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

/// Takes `paths` out of the run's single commit by putting each back to its
/// `base` version (deleting it if `base` doesn't have it), then amends HEAD with
/// the same message. Errors with "nothing left to commit" if nothing would differ
/// from `base`; the worktree is left as is, so the caller restores the old commit.
pub async fn remove_files_from_commit(work_dir: &Path, base: &str, paths: &[String]) -> Result<(), String> {
    for path in paths {
        let in_base = run_git(work_dir, &["--literal-pathspecs", "cat-file", "-e", &format!("{base}:{path}")])
            .await
            .is_ok();
        if in_base {
            run_git(work_dir, &["--literal-pathspecs", "checkout", base, "--", path]).await?;
        } else {
            run_git(work_dir, &["--literal-pathspecs", "rm", "-f", "--", path]).await?;
        }
    }
    if !has_changes(work_dir, base).await? {
        return Err("nothing left to commit: every changed file was removed".to_string());
    }
    run_git(work_dir, &["commit", "-q", "--amend", "--no-edit"]).await
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

    /// Returns the base SHA of a fresh repo; the commit under test goes on top of it.
    async fn base_of(dir: &Path) -> String {
        init_repo(dir);
        run_git_output(dir, &["rev-parse", "HEAD"]).await.unwrap().trim().to_string()
    }

    async fn commit_everything(dir: &Path) {
        run_git(dir, &["add", "-A"]).await.unwrap();
        run_git(dir, &["commit", "-qm", "run commit"]).await.unwrap();
    }

    async fn changed_files(dir: &Path, base: &str) -> Vec<String> {
        let out = run_git_output(dir, &["diff", "--name-only", base, "HEAD"]).await.unwrap();
        out.lines().map(str::to_string).collect()
    }

    async fn commits_since(dir: &Path, base: &str) -> String {
        let out = run_git_output(dir, &["rev-list", "--count", &format!("{base}..HEAD")]).await.unwrap();
        out.trim().to_string()
    }

    #[tokio::test]
    async fn removes_an_added_file_and_restores_a_modified_one() {
        let tmp = tempfile::tempdir().unwrap();
        let base = base_of(tmp.path()).await;
        std::fs::write(tmp.path().join("new.txt"), "n\n").unwrap();
        std::fs::write(tmp.path().join("keep.txt"), "k\n").unwrap();
        std::fs::write(tmp.path().join("a.txt"), "edited\n").unwrap();
        commit_everything(tmp.path()).await;

        remove_files_from_commit(tmp.path(), &base, &["new.txt".into(), "a.txt".into()]).await.unwrap();

        assert_eq!(changed_files(tmp.path(), &base).await, vec!["keep.txt"]);
        assert_eq!(std::fs::read_to_string(tmp.path().join("a.txt")).unwrap(), "old\n");
        assert!(!tmp.path().join("new.txt").exists());
        assert_eq!(commits_since(tmp.path(), &base).await, "1");
        let log = run_git_output(tmp.path(), &["log", "-1", "--format=%B"]).await.unwrap();
        assert_eq!(log.trim(), "run commit");
    }

    #[tokio::test]
    async fn restores_a_deleted_file() {
        let tmp = tempfile::tempdir().unwrap();
        let base = base_of(tmp.path()).await;
        std::fs::write(tmp.path().join("keep.txt"), "k\n").unwrap();
        std::fs::remove_file(tmp.path().join("a.txt")).unwrap();
        commit_everything(tmp.path()).await;

        remove_files_from_commit(tmp.path(), &base, &["a.txt".into()]).await.unwrap();

        assert_eq!(std::fs::read_to_string(tmp.path().join("a.txt")).unwrap(), "old\n");
        assert_eq!(changed_files(tmp.path(), &base).await, vec!["keep.txt"]);
        assert_eq!(commits_since(tmp.path(), &base).await, "1");
    }

    #[tokio::test]
    async fn handles_paths_with_spaces_and_a_leading_dash() {
        let tmp = tempfile::tempdir().unwrap();
        let base = base_of(tmp.path()).await;
        std::fs::write(tmp.path().join("-odd name.txt"), "o\n").unwrap();
        std::fs::write(tmp.path().join("keep.txt"), "k\n").unwrap();
        commit_everything(tmp.path()).await;

        remove_files_from_commit(tmp.path(), &base, &["-odd name.txt".into()]).await.unwrap();

        assert!(!tmp.path().join("-odd name.txt").exists());
        assert_eq!(changed_files(tmp.path(), &base).await, vec!["keep.txt"]);
        assert_eq!(commits_since(tmp.path(), &base).await, "1");
    }

    #[tokio::test]
    async fn refuses_when_nothing_would_remain() {
        let tmp = tempfile::tempdir().unwrap();
        let base = base_of(tmp.path()).await;
        std::fs::write(tmp.path().join("new.txt"), "n\n").unwrap();
        std::fs::write(tmp.path().join("a.txt"), "edited\n").unwrap();
        commit_everything(tmp.path()).await;

        let err = remove_files_from_commit(tmp.path(), &base, &["new.txt".into(), "a.txt".into()])
            .await
            .unwrap_err();

        assert!(err.starts_with("nothing left to commit"), "{err}");
        assert_eq!(commits_since(tmp.path(), &base).await, "1");
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
