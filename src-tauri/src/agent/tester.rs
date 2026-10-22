//! Test/lint hook — runs the configured command in the run's worktree after
//! the worker; the outcome goes to the reviewer and the run view.

use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};

use super::runner::{run_agent, tail_chars, AgentCommand, AgentRole, AgentRunOutput, AgentRuntime};

/// How much of the output's tail is kept; failures are usually at the end.
const MAX_OUTPUT_CHARS: usize = 8000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub passed: bool,
    pub output: String,
}

/// Runs `test_cmd` in `work_dir` (without the agent credential). A failing,
/// timed-out or unstartable command is a failed result, never an error: it
/// informs the review instead of stopping the run.
pub async fn run_tests<R: Runtime>(
    app: &AppHandle<R>,
    run_id: &str,
    test_cmd: &str,
    work_dir: &Path,
    runtime: &AgentRuntime,
) -> TestResult {
    let runtime = runtime.without_env();
    let command = AgentCommand {
        role: AgentRole::Tester,
        template: test_cmd,
        prompt_file: None,
        system_prompt: None,
        cwd: work_dir,
        runtime: &runtime,
    };
    match run_agent(app, run_id, &command).await {
        Ok(output) => summarize(output),
        Err(err) => TestResult { passed: false, output: err },
    }
}

fn summarize(output: AgentRunOutput) -> TestResult {
    let mut lines = output.stdout;
    lines.extend(output.stderr);
    if output.timed_out {
        lines.push("(tests timed out and were stopped)".to_string());
    }
    TestResult {
        passed: output.success,
        output: tail_chars(&lines.join("\n"), MAX_OUTPUT_CHARS),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn output(success: bool, stdout: &[&str], stderr: &[&str]) -> AgentRunOutput {
        AgentRunOutput {
            success,
            timed_out: false,
            stdout: stdout.iter().map(|s| s.to_string()).collect(),
            stderr: stderr.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn combines_stdout_and_stderr_and_keeps_the_verdict() {
        let result = summarize(output(false, &["1 passed"], &["1 failed"]));
        assert!(!result.passed);
        assert_eq!(result.output, "1 passed\n1 failed");
        assert!(summarize(output(true, &["ok"], &[])).passed);
    }

    #[test]
    fn long_output_keeps_the_tail() {
        let text = format!("{}END", "x".repeat(MAX_OUTPUT_CHARS));
        let kept = tail_chars(&text, MAX_OUTPUT_CHARS);
        assert!(kept.starts_with("... (output truncated)"));
        assert!(kept.ends_with("END"));
        assert_eq!(tail_chars("short", MAX_OUTPUT_CHARS), "short");
    }
}
