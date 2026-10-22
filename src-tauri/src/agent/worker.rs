//! Worker step — builds the worker prompt from the issue and runs the
//! configured worker command inside the run's worktree.

use std::path::Path;

use tauri::{AppHandle, Runtime};

use super::runner::{
    run_agent, tail_chars, write_prompt_file, AgentCommand, AgentRole, AgentRunOutput, AgentRuntime,
};

/// How much of the worker's output is kept as its summary (commit message body,
/// MR description, run record).
const MAX_SUMMARY_CHARS: usize = 20_000;

pub struct WorkerInput<'a> {
    pub title: &'a str,
    /// Issue body; GitLab keeps acceptance criteria here, so no separate field.
    pub description: &'a str,
    /// Extra instructions from the user when redoing a run.
    pub feedback: Option<&'a str>,
    /// Plan from an earlier plan run that the worker should follow.
    pub plan: Option<&'a str>,
    /// Ask for an implementation plan instead of making the change.
    pub plan_only: bool,
}

pub fn build_worker_prompt(input: &WorkerInput, repo_path: &Path) -> String {
    let instruction = if input.plan_only {
        "Do not modify any files. Investigate the code and write an implementation plan: \
         the files to change, the approach, and risks."
    } else {
        "Make the changes needed to complete this task there; do not commit. When done, reply with a \
         short summary of what you changed: at most 5 bullet points, one line each, no preamble or \
         closing remarks."
    };
    let mut prompt = format!(
        "# Task: {}\n\n{}\n\n## Repository\n\nThe repository is checked out at `{}`. {}\n",
        input.title.trim(),
        input.description.trim(),
        repo_path.display(),
        instruction
    );
    if let Some(plan) = input.plan.map(str::trim).filter(|p| !p.is_empty()) {
        prompt.push_str(&format!(
            "\n## Implementation plan\n\nAn earlier planning pass produced this plan. Follow it; if you \
             find it is wrong, deviate where needed and say so in your summary.\n\n{plan}\n"
        ));
    }
    if let Some(feedback) = input.feedback.map(str::trim).filter(|f| !f.is_empty()) {
        prompt.push_str(&format!("\n## Additional feedback\n\n{feedback}\n"));
    }
    prompt
}

/// Turns a finished worker process into its summary (stdout) or, on a
/// non-zero exit, an error carrying the captured stderr.
fn into_summary(output: AgentRunOutput) -> Result<String, String> {
    if output.timed_out {
        return Err("worker timed out and was stopped".to_string());
    }
    if output.success {
        return Ok(tail_chars(&output.stdout.join("\n"), MAX_SUMMARY_CHARS));
    }
    let stderr = output.stderr.join("\n");
    let stderr = tail_chars(&stderr, 2000);
    Err(if stderr.is_empty() {
        "worker exited with a non-zero status".to_string()
    } else {
        format!("worker failed: {stderr}")
    })
}

/// Runs the worker in `work_dir`. `Ok` holds the worker's stdout summary
/// (used later in the commit message); `Err` means the run should be `failed`.
pub async fn run_worker<R: Runtime>(
    app: &AppHandle<R>,
    run_id: &str,
    worker_cmd: &str,
    input: &WorkerInput<'_>,
    work_dir: &Path,
    system_prompt: Option<&Path>,
    runtime: &AgentRuntime,
) -> Result<String, String> {
    if worker_cmd.trim().is_empty() {
        return Err("worker command is not configured".to_string());
    }

    let prompt = build_worker_prompt(input, work_dir);
    let prompt_file = write_prompt_file(app, run_id, AgentRole::Worker, &prompt)?;
    let command = AgentCommand {
        role: AgentRole::Worker,
        template: worker_cmd,
        prompt_file: Some(&prompt_file),
        system_prompt,
        cwd: work_dir,
        runtime,
    };
    into_summary(run_agent(app, run_id, &command).await?)
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
    fn prompt_includes_title_description_and_repo_path() {
        let input = WorkerInput { title: "Fix bug", description: "It crashes.", feedback: None, plan: None, plan_only: false };
        let prompt = build_worker_prompt(&input, Path::new("/tmp/wt"));
        assert!(prompt.contains("# Task: Fix bug"));
        assert!(prompt.contains("It crashes."));
        assert!(prompt.contains("/tmp/wt"));
        assert!(!prompt.contains("Additional feedback"));
        assert!(!prompt.contains("Implementation plan"));
    }

    #[test]
    fn prompt_includes_the_plan_when_given() {
        let input = WorkerInput { title: "t", description: "d", feedback: None, plan: Some("1. edit a.py"), plan_only: false };
        let prompt = build_worker_prompt(&input, Path::new("/tmp/wt"));
        assert!(prompt.contains("## Implementation plan"));
        assert!(prompt.contains("1. edit a.py"));
    }

    #[test]
    fn plan_only_prompt_forbids_changes() {
        let input = WorkerInput { title: "t", description: "d", feedback: None, plan: None, plan_only: true };
        let prompt = build_worker_prompt(&input, Path::new("/tmp/wt"));
        assert!(prompt.contains("Do not modify any files"));
        assert!(!prompt.contains("Make the changes"));
    }

    #[test]
    fn prompt_appends_feedback_on_redo() {
        let input = WorkerInput { title: "t", description: "d", feedback: Some("use a smaller diff"), plan: None, plan_only: false };
        let prompt = build_worker_prompt(&input, Path::new("/tmp/wt"));
        assert!(prompt.contains("## Additional feedback\n\nuse a smaller diff"));
    }

    #[test]
    fn success_returns_stdout_as_summary() {
        let summary = into_summary(output(true, &["did a", "did b"], &[])).unwrap();
        assert_eq!(summary, "did a\ndid b");
    }

    #[test]
    fn failure_returns_captured_stderr() {
        let err = into_summary(output(false, &[], &["boom"])).unwrap_err();
        assert_eq!(err, "worker failed: boom");
    }

    #[test]
    fn timeout_is_reported_as_such() {
        let mut timed_out = output(false, &["partial"], &[]);
        timed_out.timed_out = true;
        assert_eq!(into_summary(timed_out).unwrap_err(), "worker timed out and was stopped");
    }
}
