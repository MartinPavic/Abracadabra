//! Diff of a run's committed changes against its base commit.

use std::path::Path;

use serde::Serialize;

use super::run_git_output;

/// Patches larger than this are replaced by a notice; a megabyte-sized diff over
/// IPC and into the DOM helps nobody.
const MAX_PATCH_BYTES: usize = 200_000;
/// Files beyond this many are listed without a patch.
const MAX_PATCHED_FILES: usize = 300;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    /// Git's one-letter status: A(dded), M(odified), D(eleted), T(ype changed).
    pub status: String,
    /// Unified diff for this file, including git's header lines.
    pub patch: String,
}

/// Parses `git diff --name-status -z --no-renames` output into (status, path) pairs.
fn parse_name_status(output: &str) -> Vec<(String, String)> {
    let mut fields = output.split('\0').filter(|f| !f.is_empty());
    let mut entries = Vec::new();
    while let (Some(status), Some(path)) = (fields.next(), fields.next()) {
        entries.push((status.to_string(), path.to_string()));
    }
    entries
}

/// Lists every file changed between `base` and the tip of branch `head`
/// (merge-base diff, so later movement of the base branch doesn't leak in) with
/// its patch. Reading the branch rather than HEAD keeps this right when the
/// project folder has since been switched to another branch. A file whose patch
/// can't be loaded or is too large still appears, with a notice instead of a
/// patch, so one bad file doesn't blank the whole view.
pub async fn run_diff(repo: &Path, base: &str, head: &str) -> Result<Vec<FileDiff>, String> {
    diff_with_patches(repo, &[&format!("{base}...refs/heads/{head}")]).await
}

/// Every file that differs between two commits, with its patch. Used to show
/// what a redo changed relative to the result it replaced.
pub async fn redo_diff(repo: &Path, previous: &str, current: &str) -> Result<Vec<FileDiff>, String> {
    diff_with_patches(repo, &[previous, current]).await
}

/// What the worker has changed so far, uncommitted: the working tree against
/// `base`, plus new files git doesn't track yet (shown as additions). Read-only,
/// so it can't disturb a running agent.
pub async fn live_diff(repo: &Path, base: &str) -> Result<Vec<FileDiff>, String> {
    let mut files = diff_with_patches(repo, &[base]).await?;
    let untracked = run_git_output(repo, &["ls-files", "-z", "--others", "--exclude-standard"]).await?;
    for path in untracked.split('\0').filter(|p| !p.is_empty()).take(MAX_UNTRACKED_FILES) {
        if files.iter().any(|f| f.path == path) {
            continue;
        }
        files.push(FileDiff {
            path: path.to_string(),
            status: "A".to_string(),
            patch: new_file_patch(&repo.join(path), path),
        });
    }
    Ok(files)
}

/// More new files than this are left out of the live view.
const MAX_UNTRACKED_FILES: usize = 100;

/// A unified diff that adds the whole file, for text files of reasonable size.
fn new_file_patch(full_path: &Path, path: &str) -> String {
    let content = match std::fs::read(full_path) {
        Ok(bytes) => bytes,
        Err(err) => return format!("(could not read this file: {err})"),
    };
    if content.len() > MAX_PATCH_BYTES {
        return format!("(new file too large to display: {} KB)", content.len() / 1024);
    }
    let Ok(text) = String::from_utf8(content) else {
        return "(new binary file)".to_string();
    };
    let lines: Vec<&str> = text.lines().collect();
    let mut patch = format!("diff --git a/{path} b/{path}\nnew file mode 100644\n--- /dev/null\n+++ b/{path}\n");
    if !lines.is_empty() {
        patch.push_str(&format!("@@ -0,0 +1,{} @@\n", lines.len()));
        for line in lines {
            patch.push('+');
            patch.push_str(line);
            patch.push('\n');
        }
    }
    patch
}

/// Runs `git diff <revs>` per file; see `run_diff` for how problem files appear.
async fn diff_with_patches(repo: &Path, revs: &[&str]) -> Result<Vec<FileDiff>, String> {
    let mut names_args = vec!["diff", "--name-status", "-z", "--no-renames"];
    names_args.extend_from_slice(revs);
    let names = parse_name_status(&run_git_output(repo, &names_args).await?);

    let mut files = Vec::new();
    for (index, (status, path)) in names.into_iter().enumerate() {
        let patch = if index >= MAX_PATCHED_FILES {
            "(too many changed files: patch not loaded)".to_string()
        } else {
            let mut args = vec!["--literal-pathspecs", "diff", "--no-renames"];
            args.extend_from_slice(revs);
            args.extend_from_slice(&["--", &path]);
            match run_git_output(repo, &args).await {
                Ok(patch) if patch.len() > MAX_PATCH_BYTES => {
                    format!("(diff too large to display: {} KB)", patch.len() / 1024)
                }
                Ok(patch) => patch,
                Err(err) => format!("(could not load this file's diff: {err})"),
            }
        };
        files.push(FileDiff { path, status, patch });
    }
    Ok(files)
}

/// The whole unified diff between `base` and the tip of branch `head`, as one
/// text (for prompts); see `run_diff` for the per-file view.
pub async fn branch_patch(repo: &Path, base: &str, head: &str) -> Result<String, String> {
    let range = format!("{base}...refs/heads/{head}");
    run_git_output(repo, &["diff", "--no-renames", &range]).await
}

/// `(status, path)` for every file changed between `base` and the tip of branch `head`.
pub async fn changed_files(repo: &Path, base: &str, head: &str) -> Result<Vec<(String, String)>, String> {
    let range = format!("{base}...refs/heads/{head}");
    let names = run_git_output(repo, &["diff", "--name-status", "-z", "--no-renames", &range]).await?;
    Ok(parse_name_status(&names))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn parses_nul_separated_name_status() {
        let parsed = parse_name_status("M\0src/a.rs\0A\0b c.txt\0D\0old.txt\0");
        assert_eq!(
            parsed,
            vec![
                ("M".to_string(), "src/a.rs".to_string()),
                ("A".to_string(), "b c.txt".to_string()),
                ("D".to_string(), "old.txt".to_string()),
            ]
        );
    }

    #[tokio::test]
    async fn lists_added_modified_and_deleted_files_with_patches() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let git = |args: &[&str]| {
            let status = Command::new("git").current_dir(dir).args(args).status().unwrap();
            assert!(status.success(), "git {args:?} failed");
        };
        git(&["init", "-q", "-b", "main"]);
        git(&["config", "user.email", "test@example.com"]);
        git(&["config", "user.name", "Test"]);
        std::fs::write(dir.join("keep.txt"), "old\n").unwrap();
        std::fs::write(dir.join("gone.txt"), "bye\n").unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-q", "-m", "base"]);

        git(&["checkout", "-q", "-b", "work"]);
        std::fs::write(dir.join("keep.txt"), "new\n").unwrap();
        std::fs::write(dir.join("added file.txt"), "hello\n").unwrap();
        std::fs::remove_file(dir.join("gone.txt")).unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-q", "-m", "work"]);

        let files = run_diff(dir, "main", "work").await.unwrap();
        let by_path = |p: &str| files.iter().find(|f| f.path == p).unwrap_or_else(|| panic!("missing {p}"));

        assert_eq!(files.len(), 3);
        assert_eq!(by_path("keep.txt").status, "M");
        assert!(by_path("keep.txt").patch.contains("-old") && by_path("keep.txt").patch.contains("+new"));
        assert_eq!(by_path("added file.txt").status, "A");
        assert_eq!(by_path("gone.txt").status, "D");
    }

    #[tokio::test]
    async fn no_changes_means_no_files() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let git = |args: &[&str]| {
            let status = Command::new("git").current_dir(dir).args(args).status().unwrap();
            assert!(status.success());
        };
        git(&["init", "-q", "-b", "main"]);
        git(&["config", "user.email", "test@example.com"]);
        git(&["config", "user.name", "Test"]);
        std::fs::write(dir.join("a.txt"), "x\n").unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-q", "-m", "base"]);

        assert!(run_diff(dir, "main", "main").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn live_diff_shows_uncommitted_edits_and_untracked_files() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let git = |args: &[&str]| {
            let out = Command::new("git").current_dir(dir).args(args).output().unwrap();
            assert!(out.status.success());
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        git(&["init", "-q", "-b", "main"]);
        git(&["config", "user.email", "test@example.com"]);
        git(&["config", "user.name", "Test"]);
        std::fs::write(dir.join("a.txt"), "old\n").unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-q", "-m", "base"]);
        let base = git(&["rev-parse", "HEAD"]);

        assert!(live_diff(dir, &base).await.unwrap().is_empty());

        std::fs::write(dir.join("a.txt"), "new\n").unwrap();
        std::fs::write(dir.join("fresh.txt"), "one\ntwo\n").unwrap();
        std::fs::write(dir.join("blob.bin"), [0u8, 159, 146, 150]).unwrap();
        let files = live_diff(dir, &base).await.unwrap();

        assert_eq!(files.len(), 3);
        let a = files.iter().find(|f| f.path == "a.txt").unwrap();
        assert!(a.patch.contains("-old") && a.patch.contains("+new"));
        let fresh = files.iter().find(|f| f.path == "fresh.txt").unwrap();
        assert_eq!(fresh.status, "A");
        assert!(fresh.patch.contains("@@ -0,0 +1,2 @@\n+one\n+two\n"));
        assert_eq!(files.iter().find(|f| f.path == "blob.bin").unwrap().patch, "(new binary file)");
        // Nothing was staged by looking.
        assert!(git(&["diff", "--cached", "--name-only"]).is_empty());
    }

    #[tokio::test]
    async fn redo_diff_compares_two_commits_directly() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let git = |args: &[&str]| {
            let out = Command::new("git").current_dir(dir).args(args).output().unwrap();
            assert!(out.status.success());
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        git(&["init", "-q", "-b", "main"]);
        git(&["config", "user.email", "test@example.com"]);
        git(&["config", "user.name", "Test"]);
        std::fs::write(dir.join("a.txt"), "base\n").unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-q", "-m", "base"]);
        std::fs::write(dir.join("a.txt"), "first\n").unwrap();
        git(&["commit", "-q", "-am", "first"]);
        let first = git(&["rev-parse", "HEAD"]);
        std::fs::write(dir.join("a.txt"), "second\n").unwrap();
        std::fs::write(dir.join("b.txt"), "new\n").unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-q", "-m", "second"]);
        let second = git(&["rev-parse", "HEAD"]);

        let files = redo_diff(dir, &first, &second).await.unwrap();
        assert_eq!(files.len(), 2);
        let a = files.iter().find(|f| f.path == "a.txt").unwrap();
        assert!(a.patch.contains("-first") && a.patch.contains("+second"));
        assert_eq!(files.iter().find(|f| f.path == "b.txt").unwrap().status, "A");
    }
}
