//! Branch naming for runs: templates, change types, slugs, and checks that a
//! name is valid and free.

use std::path::Path;

use super::{run_git, run_git_output};
use crate::template::substitute;

/// Longest slug taken from an issue title, keeping branch names well under
/// filesystem and ref-name length limits.
const MAX_SLUG_CHARS: usize = 50;

/// Fills a branch name template (e.g. `"{type}/{issue_iid}-{slug}"`) in with the
/// change type (`feat`, `fix`, ...), the issue's iid and a slugified title.
pub fn render_branch_name(template: &str, issue_iid: &str, title: &str, labels: &[String]) -> String {
    let (kind, title) = classify_title(title, labels);
    substitute(
        template,
        &[("type", kind), ("issue_iid", issue_iid), ("slug", &slugify_title(title))],
    )
}

/// Maps a word like `bug` or `feature` to a conventional-commit type.
fn canonical_type(word: &str) -> Option<&'static str> {
    Some(match word.trim().to_ascii_lowercase().as_str() {
        "feat" | "feature" | "enhancement" => "feat",
        "fix" | "bug" | "bugfix" | "hotfix" => "fix",
        "chore" => "chore",
        "refactor" | "refactoring" => "refactor",
        "docs" | "doc" | "documentation" => "docs",
        "test" | "tests" | "testing" => "test",
        "perf" | "performance" => "perf",
        "ci" => "ci",
        "build" => "build",
        "style" => "style",
        _ => return None,
    })
}

/// The change type for an issue and its title without any conventional prefix.
/// A prefix in the title (`fix(api): ...`) wins, then the first recognised label
/// (`bug`, `type::chore`, `kind/docs`), otherwise `feat`.
pub fn classify_title<'a>(title: &'a str, labels: &[String]) -> (&'static str, &'a str) {
    let from_title = title.split_once(':').and_then(|(prefix, rest)| {
        let prefix = prefix.trim().trim_end_matches('!');
        let kind = canonical_type(prefix.split('(').next().unwrap_or(prefix))?;
        let rest = rest.trim();
        Some((kind, if rest.is_empty() { title } else { rest }))
    });
    if let Some(found) = from_title {
        return found;
    }
    let from_labels = labels
        .iter()
        .find_map(|label| canonical_type(label.rsplit([':', '/']).next().unwrap_or(label)));
    (from_labels.unwrap_or("feat"), title)
}

/// Turns an issue title into a lowercase, dash-separated branch-name-safe slug.
pub fn slugify_title(title: &str) -> String {
    let mut slug = String::with_capacity(title.len().min(MAX_SLUG_CHARS + 1));
    let mut last_was_dash = false;
    for ch in title.trim().chars() {
        if slug.len() >= MAX_SLUG_CHARS {
            break;
        }
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
            last_was_dash = false;
        } else if !last_was_dash {
            slug.push('-');
            last_was_dash = true;
        }
    }
    slug.trim_matches('-').to_string()
}

/// Whether `name` is usable as a new local branch name (valid ref name, and not
/// something git could mistake for an option or revision expression).
pub async fn is_valid_branch_name(repo_path: &Path, name: &str) -> bool {
    if name.is_empty() || name.starts_with('-') || name.contains("@{") {
        return false;
    }
    run_git(repo_path, &["check-ref-format", "--branch", name]).await.is_ok()
}

/// Whether a local branch named exactly `branch_name` exists in the repo at `repo_path`.
pub async fn branch_exists(repo_path: &Path, branch_name: &str) -> Result<bool, String> {
    let wanted = format!("refs/heads/{branch_name}");
    // for-each-ref matches by prefix, so compare names exactly (`a` must not match `a/b`).
    let listed = run_git_output(repo_path, &["for-each-ref", "--format=%(refname)", &wanted]).await?;
    Ok(listed.lines().any(|line| line == wanted))
}

/// First of `<branch>-2`, `<branch>-3`, ... that doesn't exist yet.
pub async fn suggest_free_branch(repo_path: &Path, branch_name: &str) -> Result<String, String> {
    for n in 2..1000 {
        let candidate = format!("{branch_name}-{n}");
        if !branch_exists(repo_path, &candidate).await? {
            return Ok(candidate);
        }
    }
    Err(format!("could not find a free branch name based on {branch_name}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command as StdCommand;

    fn init_repo_with_commit(dir: &Path) {
        let run = |args: &[&str]| {
            let status = StdCommand::new("git")
                .current_dir(dir)
                .args(args)
                .status()
                .expect("failed to run git");
            assert!(status.success(), "git {args:?} failed");
        };
        run(&["init", "-q", "-b", "main"]);
        run(&["config", "user.email", "test@example.com"]);
        run(&["config", "user.name", "Test"]);
        std::fs::write(dir.join("README.md"), "hello").unwrap();
        run(&["add", "-A"]);
        run(&["commit", "-q", "-m", "initial"]);
    }

    #[test]
    fn renders_branch_name_from_template() {
        let branch = render_branch_name("{type}/{issue_iid}-{slug}", "42", "Fix the Thing!", &[]);
        assert_eq!(branch, "feat/42-fix-the-thing");
    }

    #[test]
    fn classify_title_prefers_title_prefix_then_labels_then_feat() {
        let labels = |l: &[&str]| l.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let kind = |title: &str, l: &[&str]| classify_title(title, &labels(l)).0;
        assert_eq!(kind("fix(api): crash", &["feature"]), "fix");
        assert_eq!(kind("Refactor!: split module", &[]), "refactor");
        assert_eq!(kind("Crash on login", &["priority", "Bug"]), "fix");
        assert_eq!(kind("Tidy", &["type::chore"]), "chore");
        assert_eq!(kind("Docs", &["kind/documentation"]), "docs");
        assert_eq!(kind("Add export", &["unknown"]), "feat");
        assert_eq!(kind("Note: something", &[]), "feat");
    }

    #[test]
    fn classify_title_strips_only_a_recognised_prefix() {
        assert_eq!(classify_title("fix(api): crash on login", &[]).1, "crash on login");
        assert_eq!(classify_title("Note: something", &[]).1, "Note: something");
        assert_eq!(classify_title("fix:", &[]).1, "fix:");
    }

    #[test]
    fn branch_slug_drops_the_title_prefix() {
        assert_eq!(render_branch_name("{type}/{issue_iid}-{slug}", "12", "fix: Login crash", &[]), "fix/12-login-crash");
    }

    #[test]
    fn slugify_collapses_punctuation_and_lowercases() {
        assert_eq!(slugify_title("  Fix   the Thing!! "), "fix-the-thing");
    }

    #[test]
    fn slugify_is_bounded() {
        let slug = slugify_title(&"word ".repeat(100));
        assert!(slug.len() <= MAX_SLUG_CHARS);
        assert!(!slug.ends_with('-'));
    }

    #[test]
    fn branch_template_does_not_expand_placeholders_in_titles() {
        assert_eq!(render_branch_name("t/{issue_iid}-{slug}", "1", "{issue_iid}", &[]), "t/1-issue-iid");
    }

    #[tokio::test]
    async fn validates_branch_names() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo_with_commit(tmp.path());
        assert!(is_valid_branch_name(tmp.path(), "taskdoer/1-fix").await);
        assert!(!is_valid_branch_name(tmp.path(), "-bad").await);
        assert!(!is_valid_branch_name(tmp.path(), "").await);
        assert!(!is_valid_branch_name(tmp.path(), "has space").await);
        assert!(!is_valid_branch_name(tmp.path(), "star*").await);
        assert!(!is_valid_branch_name(tmp.path(), "@{-1}").await);
    }

    #[tokio::test]
    async fn branch_existence_is_an_exact_match() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo_with_commit(tmp.path());
        run_git(tmp.path(), &["branch", "feature/deep"]).await.unwrap();
        assert!(branch_exists(tmp.path(), "feature/deep").await.unwrap());
        assert!(!branch_exists(tmp.path(), "feature").await.unwrap());
        assert!(!branch_exists(tmp.path(), "feat").await.unwrap());
    }

    #[tokio::test]
    async fn detects_existing_branches_and_suggests_a_free_name() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo_with_commit(tmp.path());
        run_git(tmp.path(), &["branch", "taskdoer/3-x"]).await.unwrap();

        assert!(branch_exists(tmp.path(), "taskdoer/3-x").await.unwrap());
        assert!(!branch_exists(tmp.path(), "taskdoer/3-y").await.unwrap());
        assert_eq!(suggest_free_branch(tmp.path(), "taskdoer/3-x").await.unwrap(), "taskdoer/3-x-2");

        run_git(tmp.path(), &["branch", "taskdoer/3-x-2"]).await.unwrap();
        assert_eq!(suggest_free_branch(tmp.path(), "taskdoer/3-x").await.unwrap(), "taskdoer/3-x-3");
    }
}
