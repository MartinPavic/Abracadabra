//! Config-related Tauri commands (`get_config`, `save_config`, token storage).

use tauri::{AppHandle, Manager};

use crate::config::{self, AppConfig};
use crate::run::limiter::RunLimiter;
use crate::secrets;

#[tauri::command]
pub fn get_config(app: AppHandle) -> Result<AppConfig, String> {
    log::debug!("get_config invoked");
    config::load(&app)
}

#[tauri::command]
pub fn save_config(app: AppHandle, config: AppConfig) -> Result<(), String> {
    log::debug!("save_config invoked");
    config::validate_usage_regex(&config.agent.usage_regex)?;
    config::save(&app, &config)?;
    // Applies to runs that are already waiting for a slot, too.
    app.state::<RunLimiter>().set_limit(config.max_parallel_runs);
    Ok(())
}

/// Stores a git source's token in the OS keychain. The raw token never round-trips
/// back through `get_config` — the config file only ever holds the source id.
#[tauri::command]
pub fn set_token(source_id: String, token: String) -> Result<(), String> {
    log::debug!("set_token invoked for source {source_id}");
    secrets::set_token(&source_id, &token)
}

/// Reports whether a token is stored for a git source, without exposing its value.
#[tauri::command]
pub fn has_token(source_id: String) -> Result<bool, String> {
    log::debug!("has_token invoked for source {source_id}");
    secrets::has_token(&source_id)
}

/// Removes a git source's stored token, e.g. when the source is deleted in Settings.
#[tauri::command]
pub fn remove_token(source_id: String) -> Result<(), String> {
    log::debug!("remove_token invoked for source {source_id}");
    secrets::delete_token(&source_id)
}
