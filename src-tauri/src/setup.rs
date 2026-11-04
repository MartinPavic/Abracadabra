//! First-run setup helpers: finding agent CLIs on PATH and checking a source is ready to run.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::config::{AppConfig, SettingsOverride};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedAgent {
    pub id: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadyItem {
    pub id: String,
    pub ok: bool,
    pub message: String,
    /// What a failing item stops: `"run"` or `"plan"`.
    pub blocks: String,
}

const AGENT_CLIS: [&str; 2] = ["claude", "codex"];

fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else { return false };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// First executable file called `name` in the directories of `path_var`.
pub fn find_on_path(name: &str, path_var: &str) -> Option<PathBuf> {
    if name.is_empty() || name.contains(['/', '\\']) {
        return None;
    }
    std::env::split_paths(path_var)
        .filter(|dir| !dir.as_os_str().is_empty())
        .map(|dir| dir.join(name))
        .find(|candidate| is_executable_file(candidate))
}

pub fn detect_agents(path_var: &str) -> Vec<DetectedAgent> {
    AGENT_CLIS
        .iter()
        .filter_map(|id| {
            find_on_path(id, path_var)
                .map(|path| DetectedAgent { id: (*id).to_string(), path: path.to_string_lossy().into_owned() })
        })
        .collect()
}

fn item(id: &str, ok: bool, blocks: &str, good: &str, bad: String) -> ReadyItem {
    ReadyItem {
        id: id.to_string(),
        ok,
        message: if ok { good.to_string() } else { bad },
        blocks: blocks.to_string(),
    }
}

/// A command item: ok when the resolved command is set, or when some project override sets one.
fn command_item(
    config: &AppConfig,
    id: &str,
    blocks: &str,
    resolved: &str,
    from_override: impl Fn(&SettingsOverride) -> &Option<String>,
    bad: String,
) -> ReadyItem {
    let global = !resolved.trim().is_empty();
    let in_override = config
        .project_overrides
        .values()
        .any(|over| from_override(over).as_deref().is_some_and(|cmd| !cmd.trim().is_empty()));
    let good = if global {
        format!("A {id} command is set.")
    } else {
        format!("A {id} command is set for some projects.")
    };
    item(id, global || in_override, blocks, &good, bad)
}

/// Everything a run (or plan run) needs before it can start, passing items included.
/// `config` is resolved for the source but still carries every project override.
pub fn ready_items(config: &AppConfig, has_token: bool, path_var: &str) -> Vec<ReadyItem> {
    let mut items = vec![
        item(
            "token",
            has_token,
            "run",
            "A token is saved for this git source.",
            "No token is saved for this git source.".to_string(),
        ),
        command_item(
            config,
            "worker",
            "run",
            &config.agent.worker_cmd,
            |over| &over.worker_cmd,
            "No worker command is set.".to_string(),
        ),
    ];
    let preset = config.agent.preset.as_str();
    if AGENT_CLIS.contains(&preset) {
        items.push(item(
            "agent_cli",
            find_on_path(preset, path_var).is_some(),
            "run",
            &format!("{preset} was found on PATH."),
            format!("{preset} was not found on PATH."),
        ));
    }
    items.push(command_item(
        config,
        "plan",
        "plan",
        &config.agent.plan_cmd,
        |over| &over.plan_cmd,
        "No plan command is set, so plan runs are unavailable.".to_string(),
    ));
    items
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    #[cfg(unix)]
    fn write_file(dir: &Path, name: &str, mode: u32) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join(name);
        fs::write(&path, "#!/bin/sh\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
        path
    }

    fn path_var(dirs: &[&Path]) -> String {
        std::env::join_paths(dirs).unwrap().to_string_lossy().into_owned()
    }

    fn ready_config(preset: &str) -> AppConfig {
        let mut config = AppConfig::default();
        config.agent.preset = preset.to_string();
        config.agent.worker_cmd = "claude -p {prompt}".to_string();
        config.agent.plan_cmd = "claude -p {prompt} --permission-mode plan".to_string();
        config
    }

    fn item<'a>(items: &'a [ReadyItem], id: &str) -> &'a ReadyItem {
        items.iter().find(|i| i.id == id).unwrap_or_else(|| panic!("no {id} item"))
    }

    #[cfg(unix)]
    #[test]
    fn finds_an_executable_on_the_path() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let expected = write_file(second.path(), "claude", 0o755);
        let vars = path_var(&[first.path(), second.path()]);
        assert_eq!(find_on_path("claude", &vars), Some(expected));
    }

    #[cfg(unix)]
    #[test]
    fn ignores_a_non_executable_file_and_a_missing_name() {
        let dir = tempfile::tempdir().unwrap();
        write_file(dir.path(), "claude", 0o644);
        fs::create_dir(dir.path().join("codex")).unwrap();
        let vars = path_var(&[dir.path()]);
        assert_eq!(find_on_path("claude", &vars), None);
        assert_eq!(find_on_path("codex", &vars), None);
        assert_eq!(find_on_path("nothing", &vars), None);
        assert_eq!(find_on_path("claude", ""), None);
        assert_eq!(find_on_path("../claude", &vars), None);
    }

    #[cfg(unix)]
    #[test]
    fn detects_both_agents_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let codex = write_file(dir.path(), "codex", 0o755);
        let claude = write_file(dir.path(), "claude", 0o755);
        let found = detect_agents(&path_var(&[dir.path()]));
        let ids: Vec<&str> = found.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(ids, ["claude", "codex"]);
        assert_eq!(found[0].path, claude.to_string_lossy());
        assert_eq!(found[1].path, codex.to_string_lossy());
    }

    #[cfg(unix)]
    #[test]
    fn ready_when_token_worker_and_cli_present() {
        let dir = tempfile::tempdir().unwrap();
        write_file(dir.path(), "claude", 0o755);
        let items = ready_items(&ready_config("claude"), true, &path_var(&[dir.path()]));
        let ids: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, ["token", "worker", "agent_cli", "plan"]);
        assert!(items.iter().all(|i| i.ok && !i.message.is_empty()));
    }

    #[test]
    fn a_custom_worker_without_a_preset_is_ready() {
        let items = ready_items(&ready_config(""), true, "");
        let ids: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, ["token", "worker", "plan"]);
        assert!(items.iter().all(|i| i.ok));
    }

    #[test]
    fn missing_token_blocks_run() {
        let items = ready_items(&ready_config(""), false, "");
        let token = item(&items, "token");
        assert!(!token.ok);
        assert_eq!(token.blocks, "run");
        assert_eq!(token.message, "No token is saved for this git source.");
        assert!(item(&items, "worker").ok);
    }

    #[test]
    fn a_preset_whose_cli_is_not_on_path_blocks_run() {
        let dir = tempfile::tempdir().unwrap();
        let items = ready_items(&ready_config("codex"), true, &path_var(&[dir.path()]));
        let cli = item(&items, "agent_cli");
        assert!(!cli.ok);
        assert_eq!(cli.blocks, "run");
        assert!(cli.message.contains("codex") && cli.message.contains("PATH"));
    }

    #[test]
    fn an_unknown_preset_has_no_cli_item() {
        let items = ready_items(&ready_config("aider"), true, "");
        assert!(items.iter().all(|i| i.id != "agent_cli"));
    }

    #[test]
    fn an_empty_plan_command_blocks_only_plan() {
        let mut config = ready_config("");
        config.agent.plan_cmd = "  ".to_string();
        let items = ready_items(&config, true, "");
        let plan = item(&items, "plan");
        assert!(!plan.ok);
        assert_eq!(plan.blocks, "plan");
        assert_eq!(plan.message, "No plan command is set, so plan runs are unavailable.");
        assert!(items.iter().filter(|i| i.id != "plan").all(|i| i.ok));
    }

    #[test]
    fn a_blank_worker_command_blocks_run() {
        let mut config = ready_config("");
        config.agent.worker_cmd = String::new();
        let items = ready_items(&config, true, "");
        let worker = item(&items, "worker");
        assert!(!worker.ok);
        assert_eq!(worker.blocks, "run");
        assert_eq!(worker.message, "No worker command is set.");
    }

    fn with_project_override(mut config: AppConfig, project: &str, set: impl FnOnce(&mut SettingsOverride)) -> AppConfig {
        let mut over = SettingsOverride::default();
        set(&mut over);
        config.project_overrides.insert(project.to_string(), over);
        config
    }

    #[test]
    fn a_worker_command_set_only_in_a_project_override_counts_as_ready() {
        let mut config = ready_config("");
        config.agent.worker_cmd = String::new();
        let config = with_project_override(config, "group/blank", |o| o.worker_cmd = Some("  ".into()));
        let config = with_project_override(config, "group/app", |o| o.worker_cmd = Some("my worker".into()));
        // As `check_ready` passes it: resolved for the source, overrides still attached.
        let items = ready_items(&config.resolved_for("s1", ""), true, "");
        let worker = item(&items, "worker");
        assert!(worker.ok);
        assert_eq!(worker.message, "A worker command is set for some projects.");
    }

    #[test]
    fn a_plan_command_set_only_in_a_project_override_counts_as_ready() {
        let mut config = ready_config("");
        config.agent.plan_cmd = String::new();
        let config = with_project_override(config, "group/app", |o| o.plan_cmd = Some("my plan".into()));
        let items = ready_items(&config, true, "");
        let plan = item(&items, "plan");
        assert!(plan.ok);
        assert_eq!(plan.message, "A plan command is set for some projects.");
    }

    #[test]
    fn blank_commands_in_every_project_override_still_block() {
        let mut config = ready_config("");
        config.agent.worker_cmd = String::new();
        config.agent.plan_cmd = String::new();
        let config = with_project_override(config, "group/app", |o| {
            o.worker_cmd = Some(" ".into());
            o.plan_cmd = None;
            o.base_branch = Some("main".into());
        });
        let items = ready_items(&config, true, "");
        assert!(!item(&items, "worker").ok);
        assert!(!item(&items, "plan").ok);
    }

    #[test]
    fn a_global_command_keeps_the_plain_message_when_overrides_also_set_one() {
        let config = with_project_override(ready_config(""), "group/app", |o| {
            o.worker_cmd = Some("my worker".into());
        });
        let items = ready_items(&config, true, "");
        assert_eq!(item(&items, "worker").message, "A worker command is set.");
    }
}
