//! Small helpers around runs and settings: opening a run in the editor and
//! trying out an agent command.

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::agent::runner::{run_agent, tail_chars, AgentCommand, AgentRole};
use crate::config;
use crate::error::AppError;
use crate::run::pipeline::agent_runtime;
use crate::run::{now_ms, RunStore};

/// Splits an editor command like `code {path}` into arguments, with the folder
/// substituted inside each one so paths with spaces stay a single argument.
fn render_ide_command(template: &str, folder: &str) -> Result<Vec<String>, String> {
    let args = shlex::split(template).ok_or_else(|| "could not parse the IDE command".to_string())?;
    if args.is_empty() {
        return Err("set an IDE command in Settings, e.g. code {path}".to_string());
    }
    Ok(args.into_iter().map(|arg| arg.replace("{path}", folder)).collect())
}

/// Opens a run's project folder with the configured editor command.
#[tauri::command]
pub fn open_in_ide(app: AppHandle, run_id: String) -> Result<(), AppError> {
    let record = app
        .state::<RunStore>()
        .get(&run_id)
        .ok_or_else(|| AppError::not_found(format!("unknown run {run_id}")))?;
    let folder = record
        .work_dir
        .filter(|path| path.is_dir())
        .ok_or_else(|| AppError::not_found("this run's project folder no longer exists"))?;
    let folder_str = folder.to_str().ok_or_else(|| "the folder path is not valid UTF-8".to_string())?;
    let args = render_ide_command(&config::load(&app)?.ide_command, folder_str)?;
    let (program, rest) = args.split_first().ok_or_else(|| "the IDE command is empty".to_string())?;

    let mut child = Command::new(program)
        .args(rest)
        .current_dir(&folder)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|err| format!("could not start {program}: {err}"))?;
    // Reaped in the background so the editor launcher doesn't linger as a zombie.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTestResult {
    pub ok: bool,
    pub timed_out: bool,
    /// The end of what the command printed (stdout, then stderr).
    pub output: String,
    /// Why it couldn't be started at all (bad template, missing program).
    pub error: Option<String>,
}

/// Runs an agent command once with a trivial prompt, in an empty temporary
/// folder, so a Settings typo shows up now rather than in the middle of a run.
/// Uses the saved agent credential and a two minute limit.
#[tauri::command]
pub async fn test_agent_command(
    app: AppHandle,
    command: String,
    system_prompt: Option<String>,
) -> Result<AgentTestResult, String> {
    if command.trim().is_empty() {
        return Err("enter a command first".to_string());
    }
    let mut runtime = agent_runtime(&config::load(&app)?)?;
    runtime.timeout = Some(Duration::from_secs(120));

    let dir = std::env::temp_dir().join(format!("abracadabra-test-{}", now_ms()));
    std::fs::create_dir_all(&dir).map_err(|err| format!("could not create {}: {err}", dir.display()))?;
    let prompt_file = dir.join("prompt.md");
    std::fs::write(&prompt_file, "Reply with the single word OK and nothing else.\n")
        .map_err(|err| format!("could not write the test prompt: {err}"))?;
    let system_prompt: Option<PathBuf> = system_prompt
        .map(|path| path.trim().to_string())
        .filter(|path| !path.is_empty())
        .map(PathBuf::from);

    let spec = AgentCommand {
        role: AgentRole::Worker,
        template: &command,
        prompt_file: Some(&prompt_file),
        system_prompt: system_prompt.as_deref(),
        cwd: &dir,
        runtime: &runtime,
    };
    let outcome = run_agent(&app, "agent-test", &spec).await;
    let _ = std::fs::remove_dir_all(&dir);

    Ok(match outcome {
        Ok(output) => {
            let mut text = output.stdout.join("\n");
            if !output.stderr.is_empty() {
                text.push_str("\n--- stderr ---\n");
                text.push_str(&output.stderr.join("\n"));
            }
            AgentTestResult {
                ok: output.success && !output.timed_out,
                timed_out: output.timed_out,
                output: tail_chars(&text, 4000),
                error: None,
            }
        }
        Err(err) => AgentTestResult { ok: false, timed_out: false, output: String::new(), error: Some(err) },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_ide_command_gets_the_folder() {
        assert_eq!(
            render_ide_command("code {path}", "/Users/me/My Project").unwrap(),
            vec!["code", "/Users/me/My Project"]
        );
        assert_eq!(
            render_ide_command("open -a \"Visual Studio Code\" {path}", "/p").unwrap(),
            vec!["open", "-a", "Visual Studio Code", "/p"]
        );
    }

    #[test]
    fn an_empty_ide_command_says_what_to_set() {
        assert!(render_ide_command("  ", "/p").unwrap_err().contains("IDE command"));
    }
}
