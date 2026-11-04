//! Commands behind the first-run wizard: agent CLI detection and the ready check.

use tauri::AppHandle;

use crate::setup::{self, DetectedAgent, ReadyItem};

fn process_path() -> String {
    std::env::var("PATH").unwrap_or_default()
}

#[tauri::command]
pub fn detect_agent_clis() -> Vec<DetectedAgent> {
    setup::detect_agents(&process_path())
}

#[tauri::command]
pub fn check_ready(app: AppHandle, source_id: String) -> Result<Vec<ReadyItem>, String> {
    let config = crate::config::load(&app)?.resolved_for(&source_id, "");
    let has_token = crate::secrets::has_token(&source_id)?;
    Ok(setup::ready_items(&config, has_token, &process_path()))
}
