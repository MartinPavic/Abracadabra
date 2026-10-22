//! One-time move of the app's data from the bundle identifier it had before the rename.

use std::fs;
use std::path::Path;

use tauri::{AppHandle, Manager, Runtime};

const LEGACY_IDENTIFIER: &str = "com.martinpavic.abracadabra";

/// Moves the old identifier's folder (next to `new_dir`) to `new_dir` if the new one doesn't exist
/// yet. Managed clones live inside it and runs.json stores their absolute paths, so those are
/// rewritten too.
fn adopt_legacy_dir(new_dir: &Path) -> bool {
    let Some(parent) = new_dir.parent() else { return false };
    let old_dir = parent.join(LEGACY_IDENTIFIER);
    if !old_dir.is_dir() || new_dir.exists() {
        return false;
    }
    if let Err(err) = fs::rename(&old_dir, new_dir) {
        log::warn!("could not move {} to {}: {err}", old_dir.display(), new_dir.display());
        return false;
    }
    log::info!("moved {} to {}", old_dir.display(), new_dir.display());

    let runs = new_dir.join("runs.json");
    if let Ok(text) = fs::read_to_string(&runs) {
        let updated = text.replace(&old_dir.display().to_string(), &new_dir.display().to_string());
        if updated != text {
            if let Err(err) = fs::write(&runs, updated) {
                log::warn!("could not update paths in {}: {err}", runs.display());
            }
        }
    }
    true
}

/// Call before anything reads the config or the run history.
pub fn adopt_legacy_data<R: Runtime>(app: &AppHandle<R>) {
    let path = app.path();
    for dir in [path.app_config_dir(), path.app_data_dir()].into_iter().flatten() {
        adopt_legacy_dir(&dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moves_the_old_folder_and_rewrites_clone_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join(LEGACY_IDENTIFIER);
        let new = tmp.path().join("Abracadabra");
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("config.json"), "{}").unwrap();
        fs::write(old.join("runs.json"), format!(r#"[{{"repoPath":"{}/repos/a"}}]"#, old.display())).unwrap();

        assert!(adopt_legacy_dir(&new));

        assert!(!old.exists());
        assert!(new.join("config.json").exists());
        let runs = fs::read_to_string(new.join("runs.json")).unwrap();
        assert!(runs.contains(&format!("{}/repos/a", new.display())));
        assert!(!runs.contains(LEGACY_IDENTIFIER));
    }

    #[test]
    fn leaves_an_existing_new_folder_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join(LEGACY_IDENTIFIER);
        let new = tmp.path().join("Abracadabra");
        fs::create_dir_all(&old).unwrap();
        fs::create_dir_all(&new).unwrap();

        assert!(!adopt_legacy_dir(&new));
        assert!(old.exists());
    }

    #[test]
    fn does_nothing_without_an_old_folder() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(!adopt_legacy_dir(&tmp.path().join("Abracadabra")));
    }
}
