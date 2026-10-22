//! Spawns an agent CLI command (worker, reviewer or test hook), streaming its
//! stdout/stderr line-by-line as Tauri events scoped by run id, and captures a
//! bounded amount of output for later use (commit messages, review notes, run
//! storage). Children run in their own process group so a timeout or an app exit
//! can take down the whole tree (e.g. `pnpm` -> `node`), not just the launcher.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, BufReader};
use tokio::process::Command;

use crate::run::RunStore;

/// Lines longer than this are split rather than buffered without bound.
const MAX_LINE_BYTES: u64 = 16 * 1024;
/// Only the last lines of each stream are kept; the end is what summaries and
/// failure messages need.
const MAX_STORED_LINES: usize = 5000;
/// Lines per run kept for the console to replay when the run view opens late.
const MAX_BUFFERED_LINES: usize = 2000;
/// Runs whose console output is kept in memory.
const MAX_BUFFERED_RUNS: usize = 20;
/// How long output readers may outlive the process (a leftover grandchild can
/// hold the pipes open) before the process group is killed.
const STREAM_GRACE: Duration = Duration::from_secs(5);

/// Which agent step produced a line of output — picks the Tauri event name
/// the frontend listens on for live streaming.
#[derive(Debug, Clone, Copy)]
pub enum AgentRole {
    Worker,
    Reviewer,
    Tester,
    /// Writes the merge request description.
    Describer,
}

impl AgentRole {
    fn event_name(self) -> &'static str {
        match self {
            AgentRole::Worker => "agent://worker-output",
            AgentRole::Reviewer => "agent://reviewer-output",
            AgentRole::Tester => "agent://test-output",
            AgentRole::Describer => "agent://describer-output",
        }
    }

    fn label(self) -> &'static str {
        match self {
            AgentRole::Worker => "worker",
            AgentRole::Reviewer => "reviewer",
            AgentRole::Tester => "tests",
            AgentRole::Describer => "describer",
        }
    }
}

/// Captured result of a completed agent process run.
pub struct AgentRunOutput {
    pub success: bool,
    /// Killed for exceeding its time limit.
    pub timed_out: bool,
    pub stdout: Vec<String>,
    pub stderr: Vec<String>,
}

/// Per-run settings shared by the worker, reviewer and test steps.
#[derive(Default)]
pub struct AgentRuntime {
    /// Extra environment variables (e.g. the agent credential).
    pub env: Vec<(String, String)>,
    /// `None` means no limit.
    pub timeout: Option<Duration>,
    /// Picks a cost or token figure out of an agent's output lines.
    pub usage_regex: Option<regex::Regex>,
}

impl AgentRuntime {
    /// Same limits, without the credential — for steps that don't need it.
    pub fn without_env(&self) -> AgentRuntime {
        AgentRuntime { env: Vec::new(), timeout: self.timeout, usage_regex: self.usage_regex.clone() }
    }
}

/// The last output line `regex` matches: its first capture group, or the whole match.
fn find_usage(regex: &regex::Regex, lines: &[String]) -> Option<String> {
    lines.iter().rev().find_map(|line| {
        let caps = regex.captures(line)?;
        let found = caps.get(1).or_else(|| caps.get(0))?;
        Some(found.as_str().trim().to_string()).filter(|text| !text.is_empty())
    })
}

/// One command to run.
pub struct AgentCommand<'a> {
    pub role: AgentRole,
    pub template: &'a str,
    pub prompt_file: Option<&'a Path>,
    /// Fills `{system_prompt}` in the template; see `resolve_prompt_file`.
    pub system_prompt: Option<&'a Path>,
    pub cwd: &'a Path,
    pub runtime: &'a AgentRuntime,
}

/// Last `max` characters of `text`, marked as truncated if anything was cut.
pub fn tail_chars(text: &str, max: usize) -> String {
    let text = text.trim();
    let count = text.chars().count();
    if count <= max {
        return text.to_string();
    }
    let tail: String = text.chars().skip(count - max).collect();
    format!("... (output truncated)\n{tail}")
}

/// Process groups of running agents (by run), so they can be killed when the
/// app exits or the user cancels a run, plus the set of runs asked to stop.
#[derive(Default)]
pub struct ProcessRegistry {
    pids: Mutex<HashMap<u32, String>>,
    cancelled: Mutex<HashSet<String>>,
}

impl ProcessRegistry {
    fn add(&self, pid: u32, run_id: &str) {
        self.pids.lock().expect("process registry poisoned").insert(pid, run_id.to_string());
    }

    fn remove(&self, pid: u32) {
        self.pids.lock().expect("process registry poisoned").remove(&pid);
    }

    /// Kills every registered process group.
    pub fn kill_all(&self) {
        for (pid, _) in self.pids.lock().expect("process registry poisoned").drain() {
            kill_process_group(pid);
        }
    }

    /// Asks the run to stop: flags it, and kills whatever it is running now.
    /// The pipeline checks the flag between steps.
    pub fn cancel(&self, run_id: &str) {
        self.cancelled.lock().expect("cancel set poisoned").insert(run_id.to_string());
        for (pid, owner) in self.pids.lock().expect("process registry poisoned").iter() {
            if owner == run_id {
                kill_process_group(*pid);
            }
        }
    }

    pub fn is_cancelled(&self, run_id: &str) -> bool {
        self.cancelled.lock().expect("cancel set poisoned").contains(run_id)
    }

    pub fn clear_cancel(&self, run_id: &str) {
        self.cancelled.lock().expect("cancel set poisoned").remove(run_id);
    }
}

#[cfg(unix)]
fn kill_process_group(pid: u32) {
    // SAFETY: plain syscall; the pid is a group leader this module spawned.
    unsafe {
        libc::killpg(pid as libc::pid_t, libc::SIGKILL);
    }
}

#[cfg(not(unix))]
fn kill_process_group(_pid: u32) {}

/// One captured console line.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BufferedLine {
    pub role: &'static str,
    pub stream: &'static str,
    pub line: String,
}

/// Run ids in the order their output first appeared, and each run's lines.
type BufferState = (Vec<String>, HashMap<String, VecDeque<BufferedLine>>);

/// Recent agent output per run, so the console can show lines emitted before
/// the run view was opened. In memory only.
#[derive(Default)]
pub struct OutputBuffer(Mutex<BufferState>);

impl OutputBuffer {
    fn push(&self, run_id: &str, line: BufferedLine) {
        let mut guard = self.0.lock().expect("output buffer poisoned");
        let (order, runs) = &mut *guard;
        if !runs.contains_key(run_id) {
            order.push(run_id.to_string());
            if order.len() > MAX_BUFFERED_RUNS {
                let oldest = order.remove(0);
                runs.remove(&oldest);
            }
        }
        let lines = runs.entry(run_id.to_string()).or_default();
        lines.push_back(line);
        if lines.len() > MAX_BUFFERED_LINES {
            lines.pop_front();
        }
    }

    pub fn get(&self, run_id: &str) -> Vec<BufferedLine> {
        let guard = self.0.lock().expect("output buffer poisoned");
        guard.1.get(run_id).map(|lines| lines.iter().cloned().collect()).unwrap_or_default()
    }

    pub fn remove(&self, run_id: &str) {
        let mut guard = self.0.lock().expect("output buffer poisoned");
        guard.0.retain(|id| id != run_id);
        guard.1.remove(run_id);
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentOutputEvent {
    run_id: String,
    stream: &'static str,
    line: String,
}

/// Writes `content` (task description + any redo feedback) to a prompt file
/// under the app data dir, returning its path for use in a command template.
pub fn write_prompt_file<R: Runtime>(
    app: &AppHandle<R>,
    run_id: &str,
    role: AgentRole,
    content: &str,
) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("could not resolve app data dir: {err}"))?
        .join("prompts");
    std::fs::create_dir_all(&dir).map_err(|err| format!("could not create {}: {err}", dir.display()))?;

    let path = dir.join(format!("{run_id}-{}.md", role.label()));
    std::fs::write(&path, content).map_err(|err| format!("could not write prompt file: {err}"))?;
    Ok(path)
}

/// Deletes a run's prompt files (they hold the issue text and the diff).
pub fn remove_prompt_files<R: Runtime>(app: &AppHandle<R>, run_id: &str) {
    let Ok(data_dir) = app.path().app_data_dir() else { return };
    for role in [AgentRole::Worker, AgentRole::Reviewer, AgentRole::Describer] {
        let path = data_dir.join("prompts").join(format!("{run_id}-{}.md", role.label()));
        if let Err(err) = std::fs::remove_file(&path) {
            if err.kind() != std::io::ErrorKind::NotFound {
                log::warn!("could not remove prompt file {}: {err}", path.display());
            }
        }
    }
}

/// The system-prompt file for an agent role: `<repo>/.task-doer/<name>` if the
/// project has one, else the configured path (blank means none).
pub fn resolve_prompt_file(repo: &Path, configured: &str, name: &str) -> Option<PathBuf> {
    let in_repo = repo.join(".task-doer").join(name);
    if in_repo.is_file() {
        return Some(in_repo);
    }
    Some(configured.trim()).filter(|path| !path.is_empty()).map(PathBuf::from)
}

/// Splits a command template into arguments, then substitutes `{prompt_file}`,
/// `{system_prompt}` and `{cwd}` inside each one, so paths containing spaces
/// (e.g. macOS's "Application Support") stay a single argument even when unquoted.
fn render_command(
    template: &str,
    prompt_file: Option<&Path>,
    system_prompt: Option<&Path>,
    cwd: &Path,
) -> Result<Vec<String>, String> {
    let as_str = |path: Option<&Path>, what: &str| -> Result<Option<String>, String> {
        path.map(|p| {
            p.to_str().map(str::to_string).ok_or_else(|| format!("{what} path is not valid UTF-8"))
        })
        .transpose()
    };
    let prompt_file_str = as_str(prompt_file, "prompt file")?;
    let system_prompt_str = as_str(system_prompt, "system prompt")?;
    let cwd_str = cwd.to_str().ok_or_else(|| "cwd path is not valid UTF-8".to_string())?;
    let args = shlex::split(template).ok_or_else(|| "could not parse agent command template".to_string())?;
    if system_prompt_str.is_none() && args.iter().any(|arg| arg.contains("{system_prompt}")) {
        return Err(
            "the command uses {system_prompt} but no prompt file is set for it (Settings, or .task-doer/ in the project)"
                .to_string(),
        );
    }
    Ok(args
        .into_iter()
        .map(|arg| {
            let mut arg = arg.replace("{cwd}", cwd_str);
            if let Some(path) = &prompt_file_str {
                arg = arg.replace("{prompt_file}", path);
            }
            if let Some(path) = &system_prompt_str {
                arg = arg.replace("{system_prompt}", path);
            }
            arg
        })
        .collect())
}

/// Runs an agent CLI command to completion, streaming each stdout/stderr line
/// as a Tauri event scoped by `run_id`. A non-zero exit (or a timeout) is
/// reported via `AgentRunOutput` rather than as an `Err` — callers decide what
/// a failed run means.
pub async fn run_agent<R: Runtime>(
    app: &AppHandle<R>,
    run_id: &str,
    command: &AgentCommand<'_>,
) -> Result<AgentRunOutput, String> {
    let role = command.role;
    let args = render_command(command.template, command.prompt_file, command.system_prompt, command.cwd)?;
    let (program, rest) = args
        .split_first()
        .ok_or_else(|| "agent command template is empty".to_string())?;

    log::info!("starting {} agent for run {run_id}: {program}", role.label());

    let mut process = Command::new(program);
    process
        .args(rest)
        .current_dir(command.cwd)
        .envs(command.runtime.env.iter().map(|(k, v)| (k, v)))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Own process group, so the whole tree can be killed at once.
    #[cfg(unix)]
    process.process_group(0);
    let mut child = process
        .spawn()
        .map_err(|err| format!("could not spawn {program}: {err}"))?;

    let pid = child.id();
    let registry = app.state::<ProcessRegistry>();
    if let Some(pid) = pid {
        registry.add(pid, run_id);
        // Cancelled between steps, just before this process existed.
        if registry.is_cancelled(run_id) {
            kill_process_group(pid);
        }
    }

    let stdout = child.stdout.take().expect("child spawned with piped stdout");
    let stderr = child.stderr.take().expect("child spawned with piped stderr");
    let mut stdout_task = tokio::spawn(stream_and_emit(app.clone(), run_id.to_string(), role, "stdout", stdout));
    let mut stderr_task = tokio::spawn(stream_and_emit(app.clone(), run_id.to_string(), role, "stderr", stderr));

    let mut timed_out = false;
    let status = match command.runtime.timeout {
        Some(limit) => match tokio::time::timeout(limit, child.wait()).await {
            Ok(status) => status,
            Err(_) => {
                log::warn!("{} agent for run {run_id} exceeded {limit:?}; killing it", role.label());
                timed_out = true;
                if let Some(pid) = pid {
                    kill_process_group(pid);
                }
                child.wait().await
            }
        },
        None => child.wait().await,
    };

    // The process is gone; its output readers should finish promptly. A leftover
    // grandchild holding the pipes open gets the group killed instead.
    let (stdout_done, stderr_done) = tokio::join!(
        tokio::time::timeout(STREAM_GRACE, &mut stdout_task),
        tokio::time::timeout(STREAM_GRACE, &mut stderr_task),
    );
    let (stdout_lines, stderr_lines) = match (stdout_done, stderr_done) {
        (Ok(out), Ok(err)) => (out, err),
        (out, err) => {
            if let Some(pid) = pid {
                kill_process_group(pid);
            }
            (
                match out {
                    Ok(done) => done,
                    Err(_) => stdout_task.await,
                },
                match err {
                    Ok(done) => done,
                    Err(_) => stderr_task.await,
                },
            )
        }
    };
    if let Some(pid) = pid {
        registry.remove(pid);
    }

    let status = status.map_err(|err| format!("could not wait for {program}: {err}"))?;
    log::info!("{} agent for run {run_id} exited with {status}", role.label());

    let stdout = stdout_lines.map_err(|err| format!("stdout stream task failed: {err}"))?;
    let stderr = stderr_lines.map_err(|err| format!("stderr stream task failed: {err}"))?;
    if let (Some(regex), Some(store), true) = (
        &command.runtime.usage_regex,
        app.try_state::<RunStore>(),
        matches!(role, AgentRole::Worker | AgentRole::Reviewer | AgentRole::Describer),
    ) {
        let found = find_usage(regex, &stderr).or_else(|| find_usage(regex, &stdout));
        if let Some(value) = found {
            store.add_usage(run_id, role.label(), &value);
        }
    }

    Ok(AgentRunOutput { success: status.success() && !timed_out, timed_out, stdout, stderr })
}

/// Reads `reader` line-by-line, emitting each line as a Tauri event and keeping
/// it in the run's console buffer; returns the collected tail for the caller.
async fn stream_and_emit<R: Runtime>(
    app: AppHandle<R>,
    run_id: String,
    role: AgentRole,
    stream_name: &'static str,
    reader: impl AsyncRead + Unpin,
) -> Vec<String> {
    stream_lines(reader, |line| {
        app.state::<OutputBuffer>().push(
            &run_id,
            BufferedLine { role: role.label(), stream: stream_name, line: line.to_string() },
        );
        let _ = app.emit(
            role.event_name(),
            AgentOutputEvent {
                run_id: run_id.clone(),
                stream: stream_name,
                line: line.to_string(),
            },
        );
    })
    .await
}

/// Reads `reader` line-by-line, invoking `on_line` for each one, and returns the
/// last `MAX_STORED_LINES` lines. Bytes are decoded lossily, so output that isn't
/// valid UTF-8 can't stop the reader (which would leave the child blocked on a
/// closed pipe), and overlong lines are split instead of buffered whole. Kept
/// free of any Tauri dependency so it's directly testable.
async fn stream_lines(reader: impl AsyncRead + Unpin, mut on_line: impl FnMut(&str)) -> Vec<String> {
    let mut reader = BufReader::new(reader);
    let mut lines = VecDeque::new();
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match (&mut reader).take(MAX_LINE_BYTES).read_until(b'\n', &mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        if buf.last() == Some(&b'\n') {
            buf.pop();
            if buf.last() == Some(&b'\r') {
                buf.pop();
            }
        }
        let line = String::from_utf8_lossy(&buf);
        on_line(&line);
        lines.push_back(line.into_owned());
        if lines.len() > MAX_STORED_LINES {
            lines.pop_front();
        }
    }
    lines.into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usage_is_the_capture_group_of_the_last_matching_line() {
        let re = regex::Regex::new(r"cost: \$([0-9.]+)").unwrap();
        let lines = vec!["cost: $0.10".to_string(), "done".to_string(), "cost: $0.25 total".to_string()];
        assert_eq!(find_usage(&re, &lines).as_deref(), Some("0.25"));
    }

    #[test]
    fn usage_falls_back_to_the_whole_match_and_none_without_one() {
        let re = regex::Regex::new(r"\d+ tokens").unwrap();
        assert_eq!(find_usage(&re, &["used 1200 tokens".to_string()]).as_deref(), Some("1200 tokens"));
        assert_eq!(find_usage(&re, &["nothing here".to_string()]), None);
    }

    #[test]
    fn render_command_substitutes_placeholders() {
        let rendered = render_command(
            "claude-code --prompt {prompt_file} --cwd {cwd}",
            Some(Path::new("/tmp/prompt.md")),
            None,
            Path::new("/tmp/work"),
        )
        .unwrap();
        assert_eq!(
            rendered,
            vec!["claude-code", "--prompt", "/tmp/prompt.md", "--cwd", "/tmp/work"]
        );
    }

    #[test]
    fn render_command_works_without_a_prompt_file() {
        let rendered =
            render_command("sh -c \"cd {cwd} && pnpm test\"", None, None, Path::new("/tmp/work")).unwrap();
        assert_eq!(rendered, vec!["sh", "-c", "cd /tmp/work && pnpm test"]);
    }

    #[test]
    fn render_command_fills_the_system_prompt_or_says_it_is_missing() {
        let template = "agent --append-system-prompt-file {system_prompt} {prompt_file}";
        let rendered = render_command(
            template,
            Some(Path::new("/tmp/p.md")),
            Some(Path::new("/repo/.task-doer/worker.md")),
            Path::new("/tmp/work"),
        )
        .unwrap();
        assert_eq!(rendered[2], "/repo/.task-doer/worker.md");

        let err = render_command(template, Some(Path::new("/tmp/p.md")), None, Path::new("/tmp/work")).unwrap_err();
        assert!(err.contains("{system_prompt}"));
    }

    #[test]
    fn a_projects_own_prompt_file_wins_over_the_configured_one() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(resolve_prompt_file(tmp.path(), "", "worker.md"), None);
        assert_eq!(
            resolve_prompt_file(tmp.path(), " /global/worker.md ", "worker.md"),
            Some(PathBuf::from("/global/worker.md"))
        );

        std::fs::create_dir(tmp.path().join(".task-doer")).unwrap();
        std::fs::write(tmp.path().join(".task-doer/worker.md"), "x").unwrap();
        assert_eq!(
            resolve_prompt_file(tmp.path(), "/global/worker.md", "worker.md"),
            Some(tmp.path().join(".task-doer/worker.md"))
        );
    }

    #[test]
    fn render_command_keeps_paths_with_spaces_as_one_argument() {
        let rendered = render_command(
            "agent --prompt {prompt_file} \"read {prompt_file} now\"",
            Some(Path::new("/Users/me/Library/Application Support/app/prompts/run.md")),
            None,
            Path::new("/tmp/work"),
        )
        .unwrap();
        assert_eq!(rendered[2], "/Users/me/Library/Application Support/app/prompts/run.md");
        assert_eq!(rendered[3], "read /Users/me/Library/Application Support/app/prompts/run.md now");
        assert_eq!(rendered.len(), 4);
    }

    #[tokio::test]
    async fn invalid_utf8_does_not_stop_the_reader() {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "echo one; printf 'bad\\377byte\\n'; echo two"])
            .stdout(Stdio::piped())
            .spawn()
            .expect("failed to spawn /bin/sh");
        let stdout = child.stdout.take().expect("piped stdout");

        let lines = stream_lines(stdout, |_| {}).await;
        let status = child.wait().await.expect("child should exit");

        assert_eq!(lines, vec!["one", "bad\u{FFFD}byte", "two"]);
        assert!(status.success());
    }

    #[tokio::test]
    async fn overlong_lines_are_split_and_only_the_tail_is_kept() {
        let long = format!("{}\n", "x".repeat(MAX_LINE_BYTES as usize * 2 + 10));
        let lines = stream_lines(std::io::Cursor::new(long.into_bytes()), |_| {}).await;
        assert_eq!(lines.len(), 3);
        assert!(lines.iter().all(|line| line.len() <= MAX_LINE_BYTES as usize));

        let many: String = (0..MAX_STORED_LINES + 10).map(|n| format!("line {n}\n")).collect();
        let lines = stream_lines(std::io::Cursor::new(many.into_bytes()), |_| {}).await;
        assert_eq!(lines.len(), MAX_STORED_LINES);
        assert_eq!(lines.last().unwrap(), &format!("line {}", MAX_STORED_LINES + 9));
    }

    #[test]
    fn tail_chars_keeps_the_end() {
        assert_eq!(tail_chars("  short ", 100), "short");
        let kept = tail_chars("abcdefghij", 4);
        assert!(kept.starts_with("... (output truncated)"));
        assert!(kept.ends_with("ghij"));
    }

    #[test]
    fn output_buffer_keeps_recent_lines_per_run() {
        let buffer = OutputBuffer::default();
        let line = |text: &str| BufferedLine { role: "worker", stream: "stdout", line: text.to_string() };
        for n in 0..MAX_BUFFERED_LINES + 5 {
            buffer.push("r1", line(&n.to_string()));
        }
        buffer.push("r2", line("other"));

        let r1 = buffer.get("r1");
        assert_eq!(r1.len(), MAX_BUFFERED_LINES);
        assert_eq!(r1.first().unwrap().line, "5");
        assert_eq!(buffer.get("r2").len(), 1);
        assert!(buffer.get("missing").is_empty());
    }

    #[tokio::test]
    async fn stream_lines_captures_output_and_invokes_callback() {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "echo one; echo two"])
            .stdout(Stdio::piped())
            .spawn()
            .expect("failed to spawn /bin/sh");
        let stdout = child.stdout.take().expect("piped stdout");

        let mut seen = Vec::new();
        let lines = stream_lines(stdout, |line| seen.push(line.to_string())).await;
        child.wait().await.expect("child should exit");

        assert_eq!(lines, vec!["one".to_string(), "two".to_string()]);
        assert_eq!(seen, lines);
    }
}
