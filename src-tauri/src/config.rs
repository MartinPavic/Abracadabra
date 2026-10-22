//! `AppConfig` struct + load/save to the Tauri app-config dir.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GitProvider {
    GitLab,
    GitHub,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSourceConfig {
    pub id: String,
    pub name: String,
    pub provider: GitProvider,
    pub base_url: String,
    #[serde(default)]
    pub project_filter: Option<String>,
    /// Applies to every project of this source unless a project override wins.
    #[serde(default)]
    pub overrides: SettingsOverride,
}

/// Optional replacements for global settings; unset (or blank) fields fall back.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SettingsOverride {
    pub base_branch: Option<String>,
    pub branch_template: Option<String>,
    pub commit_template: Option<String>,
    pub worker_cmd: Option<String>,
    pub reviewer_cmd: Option<String>,
    pub plan_cmd: Option<String>,
    pub description_cmd: Option<String>,
    pub test_cmd: Option<String>,
    pub worker_prompt_file: Option<String>,
    pub reviewer_prompt_file: Option<String>,
    pub plan_prompt_file: Option<String>,
}

impl SettingsOverride {
    fn apply_to(&self, config: &mut AppConfig) {
        let set = |target: &mut String, value: &Option<String>| {
            if let Some(value) = value.as_deref().filter(|v| !v.trim().is_empty()) {
                *target = value.to_string();
            }
        };
        set(&mut config.base_branch, &self.base_branch);
        set(&mut config.branch_template, &self.branch_template);
        set(&mut config.commit_template, &self.commit_template);
        set(&mut config.agent.worker_cmd, &self.worker_cmd);
        set(&mut config.agent.reviewer_cmd, &self.reviewer_cmd);
        set(&mut config.agent.plan_cmd, &self.plan_cmd);
        set(&mut config.agent.description_cmd, &self.description_cmd);
        set(&mut config.test_cmd, &self.test_cmd);
        set(&mut config.agent.worker_prompt_file, &self.worker_prompt_file);
        set(&mut config.agent.reviewer_prompt_file, &self.reviewer_prompt_file);
        set(&mut config.agent.plan_prompt_file, &self.plan_prompt_file);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentConfig {
    pub worker_cmd: String,
    pub reviewer_cmd: String,
    /// Worker command used for plan-only runs (typically the worker command with
    /// the CLI's plan/read-only mode); empty disables plan-only runs.
    pub plan_cmd: String,
    /// Command that writes the merge request's summary and reviewer checklist
    /// from the run's changes; empty uses the worker's summary and a generic list.
    pub description_cmd: String,
    /// Env var the agent CLI reads its credential from (e.g. `ANTHROPIC_API_KEY`);
    /// the secret itself lives in the OS keychain. Empty disables injection.
    pub credential_env_var: String,
    /// Longest an agent or test process may run, in seconds; 0 means no limit.
    pub timeout_secs: u64,
    /// System prompt files filling `{system_prompt}` in the commands above. A
    /// project's own `.task-doer/<role>.md` wins over these.
    pub worker_prompt_file: String,
    pub reviewer_prompt_file: String,
    pub plan_prompt_file: String,
    /// Regex run over each agent's output lines to find a cost or token figure
    /// (its first capture group, else the whole match); empty records nothing.
    pub usage_regex: String,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            worker_cmd: String::new(),
            reviewer_cmd: String::new(),
            plan_cmd: String::new(),
            description_cmd: String::new(),
            credential_env_var: String::new(),
            timeout_secs: 30 * 60,
            worker_prompt_file: String::new(),
            reviewer_prompt_file: String::new(),
            plan_prompt_file: String::new(),
            usage_regex: String::new(),
        }
    }
}

/// Rejects a `usage_regex` that doesn't compile, so a typo shows up when saving.
pub fn validate_usage_regex(pattern: &str) -> Result<(), String> {
    if pattern.trim().is_empty() {
        return Ok(());
    }
    regex::Regex::new(pattern).map(|_| ()).map_err(|err| format!("usage regex is invalid: {err}"))
}

/// What to do when the reviewer's verdict asks for changes.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewerGate {
    /// Show the verdict only.
    Off,
    /// Highlight the run as needing attention.
    Warn,
    /// Redo once, automatically, with the reviewer's notes as feedback.
    #[default]
    AutoRedo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TimeoutConfig {
    pub connect_timeout_secs: u64,
    pub retry_attempts: u32,
}

impl Default for TimeoutConfig {
    fn default() -> Self {
        Self {
            connect_timeout_secs: 10,
            retry_attempts: 3,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppConfig {
    pub git_sources: Vec<GitSourceConfig>,
    pub agent: AgentConfig,
    /// Branch runs start from (`origin/<this>`); a project without it uses its
    /// own default branch instead.
    pub base_branch: String,
    pub branch_template: String,
    pub commit_template: String,
    /// Merge/pull request description. Placeholders: `{worker_summary}`,
    /// `{files_changed}`, `{review_notes}`, `{issue_ref}`.
    pub merge_request_template: String,
    /// Command run in the worktree after the worker (e.g. `sh -c "pnpm test"`);
    /// its result goes to the reviewer. Empty skips the step.
    pub test_cmd: String,
    /// How many times the worker may be asked to fix failing tests before the
    /// run goes to review anyway (0 to 3).
    pub auto_fix_attempts: u32,
    pub reviewer_gate: ReviewerGate,
    /// Comment on the issue with the merge request's link once it is created.
    pub comment_mr_link: bool,
    /// Comment on the issue with the plan after a plan run.
    pub comment_plan: bool,
    /// Finished runs older than this many days are deleted at startup; 0 keeps them all.
    pub keep_runs_days: u32,
    /// Command that opens a run's project folder in your editor, e.g. `code {path}`.
    pub ide_command: String,
    /// Project path (e.g. "group/project") -> absolute path of the user's local
    /// checkout; projects without an entry get an app-managed clone instead.
    pub local_repos: HashMap<String, String>,
    /// Project path -> overrides; these win over the git source's overrides.
    pub project_overrides: HashMap<String, SettingsOverride>,
    /// How many runs may execute at once; the rest wait in `queued`.
    pub max_parallel_runs: u32,
    pub timeouts: TimeoutConfig,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            git_sources: Vec::new(),
            agent: AgentConfig::default(),
            base_branch: "dev".to_string(),
            branch_template: DEFAULT_BRANCH_TEMPLATE.to_string(),
            commit_template: DEFAULT_COMMIT_TEMPLATE.to_string(),
            merge_request_template: DEFAULT_MERGE_REQUEST_TEMPLATE.to_string(),
            test_cmd: String::new(),
            auto_fix_attempts: 0,
            reviewer_gate: ReviewerGate::default(),
            comment_mr_link: false,
            comment_plan: false,
            keep_runs_days: 0,
            ide_command: String::new(),
            local_repos: HashMap::new(),
            project_overrides: HashMap::new(),
            max_parallel_runs: 2,
            timeouts: TimeoutConfig::default(),
        }
    }
}

const CONFIG_FILE_NAME: &str = "config.json";

/// `{type}` is feat/fix/chore/... picked from the issue's title or labels.
const DEFAULT_BRANCH_TEMPLATE: &str = "{type}/{issue_iid}-{slug}";
const LEGACY_BRANCH_TEMPLATE: &str = "taskdoer/{issue_iid}-{slug}";

/// A short conventional subject; the worker's full summary stays out of the history.
const DEFAULT_COMMIT_TEMPLATE: &str = "{type}: {title}\n\nRefs {issue_ref}";
const LEGACY_COMMIT_TEMPLATE: &str = "{issue_ref}: {title}\n\n{worker_summary}";

/// `{summary}` and `{checklist}` come from the description command when one is
/// set; the test evidence section is left for the developer to fill in.
const DEFAULT_MERGE_REQUEST_TEMPLATE: &str = "## Summary\n{summary}\n\n## Related issue\n{issue_link}\n\n## Checklist (filled by reviewer)\n{checklist}\n\n## Test evidence\n<!-- Add screenshots, logs or test output showing this was tested. -->\n";
const LEGACY_MERGE_REQUEST_TEMPLATES: [&str; 2] = [
    "{worker_summary}\n\n## Files changed\n{files_changed}\n\n## Review notes\n{review_notes}\n\nCloses {issue_ref}",
    "## Summary\n{summary}\n\n## Files changed\n{files_changed}\n\nCloses {issue_ref}",
];

impl AppConfig {
    /// A copy with the git source's overrides, then the project's, applied over
    /// the global settings (project > source > global).
    pub fn resolved_for(&self, source_id: &str, project_path: &str) -> AppConfig {
        let mut resolved = self.clone();
        if let Some(source) = self.git_sources.iter().find(|s| s.id == source_id) {
            source.overrides.apply_to(&mut resolved);
        }
        if let Some(project) = self.project_overrides.get(project_path) {
            project.apply_to(&mut resolved);
        }
        resolved
    }
}

fn config_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|err| format!("could not resolve app config dir: {err}"))?;
    Ok(dir.join(CONFIG_FILE_NAME))
}

/// Loads the config from disk, falling back to defaults if no file exists yet.
pub fn load(app: &AppHandle) -> Result<AppConfig, String> {
    let path = config_file_path(app)?;
    if !path.exists() {
        log::debug!("no config file at {}; using defaults", path.display());
        return Ok(AppConfig::default());
    }

    log::debug!("loading config from {}", path.display());
    let raw = fs::read_to_string(&path).map_err(|err| {
        log::error!("could not read config at {}: {err}", path.display());
        format!("could not read config: {err}")
    })?;
    let mut config: AppConfig = serde_json::from_str(&raw).map_err(|err| {
        log::error!("could not parse config at {}: {err}", path.display());
        format!("could not parse config: {err}")
    })?;
    // Configs saved while the old defaults were current move to the new defaults.
    if config.branch_template == LEGACY_BRANCH_TEMPLATE {
        config.branch_template = DEFAULT_BRANCH_TEMPLATE.to_string();
    }
    if config.commit_template == LEGACY_COMMIT_TEMPLATE {
        config.commit_template = DEFAULT_COMMIT_TEMPLATE.to_string();
    }
    if LEGACY_MERGE_REQUEST_TEMPLATES.contains(&config.merge_request_template.as_str()) {
        config.merge_request_template = DEFAULT_MERGE_REQUEST_TEMPLATE.to_string();
    }
    log::info!("loaded config ({} git source(s))", config.git_sources.len());
    Ok(config)
}

/// Persists the config to disk as pretty-printed JSON, creating the config dir if needed.
pub fn save(app: &AppHandle, config: &AppConfig) -> Result<(), String> {
    let path = config_file_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("could not create config dir: {err}"))?;
    }
    let raw = serde_json::to_string_pretty(config)
        .map_err(|err| format!("could not serialize config: {err}"))?;
    // Temp file + rename, so a crash mid-write can't leave a truncated config.
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, raw)
        .and_then(|_| fs::rename(&tmp, &path))
        .map_err(|err| {
            log::error!("could not write config to {}: {err}", path.display());
            format!("could not write config: {err}")
        })?;
    log::info!(
        "saved config to {} ({} git source(s))",
        path.display(),
        config.git_sources.len()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_overrides_beat_source_overrides_beat_global() {
        let mut config = AppConfig::default();
        config.agent.worker_cmd = "global-worker".to_string();
        config.agent.reviewer_cmd = "global-reviewer".to_string();
        config.git_sources.push(GitSourceConfig {
            id: "s1".to_string(),
            name: "Source".to_string(),
            provider: GitProvider::GitLab,
            base_url: "https://gitlab.example.com".to_string(),
            project_filter: None,
            overrides: SettingsOverride {
                worker_cmd: Some("source-worker".to_string()),
                reviewer_cmd: Some("source-reviewer".to_string()),
                branch_template: Some("   ".to_string()),
                ..SettingsOverride::default()
            },
        });
        config.project_overrides.insert(
            "group/special".to_string(),
            SettingsOverride { worker_cmd: Some("project-worker".to_string()), ..SettingsOverride::default() },
        );

        let special = config.resolved_for("s1", "group/special");
        assert_eq!(special.agent.worker_cmd, "project-worker");
        assert_eq!(special.agent.reviewer_cmd, "source-reviewer");

        let other = config.resolved_for("s1", "group/other");
        assert_eq!(other.agent.worker_cmd, "source-worker");
        // Blank overrides fall back to the global value.
        assert_eq!(other.branch_template, AppConfig::default().branch_template);

        let unknown_source = config.resolved_for("nope", "group/other");
        assert_eq!(unknown_source.agent.worker_cmd, "global-worker");
    }

    #[test]
    fn default_config_serializes_as_camel_case_json() {
        let json = serde_json::to_string(&AppConfig::default()).unwrap();
        assert!(json.contains("\"gitSources\""));
        assert!(json.contains("\"branchTemplate\""));
        assert!(json.contains("\"localRepos\""));
        assert!(json.contains("\"connectTimeoutSecs\""));
    }

    #[test]
    fn default_config_round_trips_through_json() {
        let original = AppConfig::default();
        let json = serde_json::to_string(&original).unwrap();
        let restored: AppConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(original.branch_template, restored.branch_template);
        assert_eq!(original.commit_template, restored.commit_template);
        assert_eq!(
            original.timeouts.connect_timeout_secs,
            restored.timeouts.connect_timeout_secs
        );
    }

    #[test]
    fn missing_fields_fall_back_to_defaults() {
        let restored: AppConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(restored.git_sources.len(), 0);
        assert_eq!(restored.timeouts.retry_attempts, 3);
    }
}
