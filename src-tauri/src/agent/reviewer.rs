//! Reviewer step — feeds the original task and the worker's diff to the
//! configured reviewer command and captures its notes.

use std::path::Path;

use tauri::{AppHandle, Runtime};

use super::runner::{
    run_agent, tail_chars, write_prompt_file, AgentCommand, AgentRole, AgentRunOutput, AgentRuntime,
};
use super::tester::TestResult;
use crate::git::staged_diff;

/// Larger diffs are cut (the reviewer is told) so the prompt file stays usable.
const MAX_DIFF_CHARS: usize = 200_000;
/// Review notes kept on the run record and shown in the UI.
const MAX_NOTES_CHARS: usize = 40_000;

pub fn build_reviewer_prompt(title: &str, description: &str, diff: &str, tests: Option<&TestResult>) -> String {
    let diff = diff.trim_end();
    let shown: String = diff.chars().take(MAX_DIFF_CHARS).collect();
    let cut_note = if shown.len() < diff.len() {
        "\n... (diff truncated: review the remaining changes in the worktree)"
    } else {
        ""
    };
    let mut prompt = format!(
        "# Review request\n\nReview the following change against the original task. \
         Point out bugs, missed requirements and risky edits.\n\n\
         ## Original task: {}\n\n{}\n\n## Diff\n\n```diff\n{}{}\n```\n",
        title.trim(),
        description.trim(),
        shown,
        cut_note
    );
    if let Some(tests) = tests {
        let verdict = if tests.passed { "PASSED" } else { "FAILED" };
        prompt.push_str(&format!(
            "\n## Test results: {verdict}\n\n```\n{}\n```\n",
            tests.output.trim_end()
        ));
    }
    prompt.push_str(
        "\n## Verdict\n\nEnd your review with one final line, exactly `VERDICT: approve` if the change \
         is good to merge or `VERDICT: changes` if it needs changes before merging.\n",
    );
    prompt
}

/// The reviewer's overall call, taken from the last line of its notes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReviewVerdict {
    Approve,
    Changes,
}

impl ReviewVerdict {
    pub fn as_str(self) -> &'static str {
        match self {
            ReviewVerdict::Approve => "approve",
            ReviewVerdict::Changes => "changes",
        }
    }
}

/// Splits a trailing `VERDICT: approve|changes` line (markdown emphasis and case
/// ignored) off the notes. Without one the notes are returned as they are.
pub fn split_verdict(notes: &str) -> (String, Option<ReviewVerdict>) {
    let trimmed = notes.trim_end();
    let (head, last) = trimmed.rsplit_once('\n').unwrap_or(("", trimmed));
    let plain: String = last.chars().filter(|c| !matches!(c, '*' | '`' | '_' | '#')).collect();
    let plain = plain.trim().to_lowercase();
    let Some(value) = plain.strip_prefix("verdict:") else {
        return (trimmed.to_string(), None);
    };
    let verdict = if value.contains("changes") || value.contains("reject") {
        ReviewVerdict::Changes
    } else if value.contains("approve") {
        ReviewVerdict::Approve
    } else {
        return (trimmed.to_string(), None);
    };
    (head.trim_end().to_string(), Some(verdict))
}
/// Turns a finished reviewer process into `review_notes` (stdout) or, on a
/// non-zero exit, an error carrying the captured stderr.
fn into_review_notes(output: AgentRunOutput) -> Result<String, String> {
    if output.timed_out {
        return Err("reviewer timed out and was stopped".to_string());
    }
    if output.success {
        return Ok(tail_chars(&output.stdout.join("\n"), MAX_NOTES_CHARS));
    }
    let stderr = tail_chars(&output.stderr.join("\n"), 2000);
    Err(if stderr.is_empty() {
        "reviewer exited with a non-zero status".to_string()
    } else {
        format!("reviewer failed: {stderr}")
    })
}

pub struct ReviewInput<'a> {
    pub title: &'a str,
    pub description: &'a str,
    /// Commit the run's branch was cut from; the review covers everything since.
    pub base: &'a str,
    /// Outcome of the test/lint hook, if one is configured.
    pub tests: Option<&'a TestResult>,
}

/// Runs the reviewer in `work_dir` over the worker's changes. `Ok` holds
/// the review notes; `Err` means the run should be `failed`.
pub async fn run_reviewer<R: Runtime>(
    app: &AppHandle<R>,
    run_id: &str,
    reviewer_cmd: &str,
    input: &ReviewInput<'_>,
    work_dir: &Path,
    system_prompt: Option<&Path>,
    runtime: &AgentRuntime,
) -> Result<String, String> {
    if reviewer_cmd.trim().is_empty() {
        return Err("reviewer command is not configured".to_string());
    }

    let diff = staged_diff(work_dir, input.base).await?;
    let prompt = build_reviewer_prompt(input.title, input.description, &diff, input.tests);
    let prompt_file = write_prompt_file(app, run_id, AgentRole::Reviewer, &prompt)?;
    let command = AgentCommand {
        role: AgentRole::Reviewer,
        template: reviewer_cmd,
        prompt_file: Some(&prompt_file),
        system_prompt,
        cwd: work_dir,
        runtime,
    };
    into_review_notes(run_agent(app, run_id, &command).await?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn output(success: bool, stdout: &[&str], stderr: &[&str]) -> AgentRunOutput {
        AgentRunOutput {
            success,
            timed_out: false,
            stdout: stdout.iter().map(|s| s.to_string()).collect(),
            stderr: stderr.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn prompt_includes_task_and_diff() {
        let prompt = build_reviewer_prompt("Fix bug", "It crashes.", "+added line\n", None);
        assert!(prompt.contains("## Original task: Fix bug"));
        assert!(prompt.contains("It crashes."));
        assert!(prompt.contains("```diff\n+added line\n```"));
        assert!(!prompt.contains("Test results"));
    }

    #[test]
    fn prompt_includes_test_results_when_present() {
        let failed = TestResult { passed: false, output: "1 failed".to_string() };
        let prompt = build_reviewer_prompt("t", "d", "+x\n", Some(&failed));
        assert!(prompt.contains("## Test results: FAILED"));
        assert!(prompt.contains("1 failed"));

        let passed = TestResult { passed: true, output: "ok".to_string() };
        assert!(build_reviewer_prompt("t", "d", "+x\n", Some(&passed)).contains("Test results: PASSED"));
    }

    #[test]
    fn oversized_diffs_are_cut_with_a_notice() {
        let diff = format!("+{}", "x".repeat(MAX_DIFF_CHARS * 2));
        let prompt = build_reviewer_prompt("t", "d", &diff, None);
        assert!(prompt.contains("diff truncated"));
        assert!(prompt.len() < MAX_DIFF_CHARS + 2000);
    }

    #[test]
    fn the_prompt_asks_for_a_verdict_line() {
        assert!(build_reviewer_prompt("t", "d", "+x\n", None).contains("VERDICT: changes"));
    }

    #[test]
    fn a_trailing_verdict_line_is_split_off_the_notes() {
        let (notes, verdict) = split_verdict("Looks fine.\n\nVERDICT: approve\n");
        assert_eq!((notes.as_str(), verdict), ("Looks fine.", Some(ReviewVerdict::Approve)));

        let (notes, verdict) = split_verdict("- bug in a.rs\n**Verdict: Changes**");
        assert_eq!((notes.as_str(), verdict), ("- bug in a.rs", Some(ReviewVerdict::Changes)));

        let (notes, verdict) = split_verdict("VERDICT: changes");
        assert_eq!((notes.as_str(), verdict), ("", Some(ReviewVerdict::Changes)));
    }

    #[test]
    fn notes_without_a_verdict_are_left_alone() {
        let (notes, verdict) = split_verdict("Looks fine.\nThe verdict: unclear");
        assert_eq!((notes.as_str(), verdict), ("Looks fine.\nThe verdict: unclear", None));
        assert_eq!(split_verdict("VERDICT: maybe").1, None);
    }

    #[test]
    fn success_returns_stdout_as_review_notes() {
        let notes = into_review_notes(output(true, &["looks ok", "nit: naming"], &[])).unwrap();
        assert_eq!(notes, "looks ok\nnit: naming");
    }

    #[test]
    fn failure_returns_captured_stderr() {
        let err = into_review_notes(output(false, &[], &["boom"])).unwrap_err();
        assert_eq!(err, "reviewer failed: boom");
    }

    #[tokio::test]
    async fn staged_diff_includes_modified_and_new_files() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
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

        std::fs::write(dir.join("a.txt"), "new\n").unwrap();
        std::fs::write(dir.join("b.txt"), "brand new\n").unwrap();

        let diff = staged_diff(dir, "HEAD").await.unwrap();
        assert!(diff.contains("-old") && diff.contains("+new"));
        assert!(diff.contains("b.txt") && diff.contains("+brand new"));
    }
}
