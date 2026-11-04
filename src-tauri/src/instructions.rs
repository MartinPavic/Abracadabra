//! User-written agent instructions, stored as markdown files in the app config dir.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use tauri::{AppHandle, Manager, Runtime};

use crate::git::repo::{slugify_project_path, stable_hash};

pub const MAX_CHARS: usize = 50_000;

/// Longest instruction file name, so it stays valid on any filesystem.
const MAX_FILE_NAME_CHARS: usize = 120;

/// Tauri managed state holding the instructions directory, so tests can use a temp folder.
pub struct InstructionsDir(pub PathBuf);

pub fn dir<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    app.state::<InstructionsDir>().0.clone()
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Scope {
    Global,
    #[serde(rename_all = "camelCase")]
    Project { source_id: String, project_path: String },
}

/// File names come only from here, never from joining user input into a path.
pub fn project_file_name(source_id: &str, project_path: &str) -> String {
    let key = format!("{source_id}/{project_path}");
    let suffix = format!("-{:08x}.md", stable_hash(&key));
    let slug: String = slugify_project_path(&key)
        .chars()
        .take(MAX_FILE_NAME_CHARS - suffix.len())
        .collect();
    format!("{slug}{suffix}")
}

pub fn scope_path(dir: &Path, scope: &Scope) -> PathBuf {
    match scope {
        Scope::Global => dir.join("global.md"),
        Scope::Project { source_id, project_path } => {
            dir.join("projects").join(project_file_name(source_id, project_path))
        }
    }
}

pub fn read(dir: &Path, scope: &Scope) -> Result<String, String> {
    let path = scope_path(dir, scope);
    match fs::read_to_string(&path) {
        Ok(text) => Ok(text),
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(String::new()),
        Err(err) => Err(format!("could not read {}: {err}", path.display())),
    }
}

/// Blank text deletes the file, so "no instructions" has a single representation.
pub fn write(dir: &Path, scope: &Scope, text: &str) -> Result<(), String> {
    if text.chars().count() > MAX_CHARS {
        return Err(format!("Instructions are limited to {MAX_CHARS} characters."));
    }
    let path = scope_path(dir, scope);
    if text.trim().is_empty() {
        return match fs::remove_file(&path) {
            Err(err) if err.kind() != ErrorKind::NotFound => {
                Err(format!("could not remove {}: {err}", path.display()))
            }
            _ => Ok(()),
        };
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("could not create {}: {err}", parent.display()))?;
    }
    fs::write(&path, text).map_err(|err| format!("could not write {}: {err}", path.display()))
}

/// The prompt section for the user's instructions, or `None` when there are none.
pub fn compose(global: &str, project: &str) -> Option<String> {
    let (global, project) = (global.trim(), project.trim());
    if global.is_empty() && project.is_empty() {
        return None;
    }
    let mut out = String::from("## Instructions from the user");
    if !global.is_empty() {
        out.push_str("\n\n");
        out.push_str(global);
    }
    if !project.is_empty() {
        out.push_str("\n\n### For this project\n\n");
        out.push_str(project);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use regex::Regex;

    fn project(source_id: &str, project_path: &str) -> Scope {
        Scope::Project { source_id: source_id.into(), project_path: project_path.into() }
    }

    #[test]
    fn project_file_name_is_safe_for_odd_paths() {
        let pattern = Regex::new(r"^[A-Za-z0-9_-]+\.md$").unwrap();
        for path in ["../../etc/passwd", "a b/ü", "a/b", "a-b"] {
            let name = project_file_name("gitlab", path);
            assert!(pattern.is_match(&name), "{name}");
        }
        assert_ne!(project_file_name("gitlab", "a/b"), project_file_name("gitlab", "a-b"));
        let long = project_file_name("gitlab", &"x/".repeat(250));
        assert!(long.chars().count() <= 120, "{}", long.len());
        assert!(pattern.is_match(&long));
    }

    #[test]
    fn same_path_on_two_sources_differs() {
        assert_ne!(project_file_name("one", "g/p"), project_file_name("two", "g/p"));
    }

    #[test]
    fn write_then_read_round_trips_and_empty_text_removes_the_file() {
        let dir = tempfile::tempdir().unwrap();
        for scope in [Scope::Global, project("s", "g/p")] {
            write(dir.path(), &scope, "be terse").unwrap();
            assert_eq!(read(dir.path(), &scope).unwrap(), "be terse");
            assert!(scope_path(dir.path(), &scope).exists());
            write(dir.path(), &scope, "  \n").unwrap();
            assert_eq!(read(dir.path(), &scope).unwrap(), "");
            assert!(!scope_path(dir.path(), &scope).exists());
            write(dir.path(), &scope, "").unwrap();
        }
    }

    #[test]
    fn write_rejects_text_over_the_limit() {
        let dir = tempfile::tempdir().unwrap();
        assert!(write(dir.path(), &Scope::Global, &"a".repeat(MAX_CHARS)).is_ok());
        assert!(write(dir.path(), &Scope::Global, &"a".repeat(MAX_CHARS + 1)).is_err());
        assert!(write(dir.path(), &Scope::Global, &"ü".repeat(MAX_CHARS)).is_ok());
    }

    #[test]
    fn reading_a_missing_scope_gives_empty_text() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read(dir.path(), &Scope::Global).unwrap(), "");
        assert_eq!(read(dir.path(), &project("s", "g/p")).unwrap(), "");
    }

    #[test]
    fn compose_orders_global_before_project_and_omits_empty_parts() {
        assert_eq!(compose(" ", "\n"), None);
        assert_eq!(
            compose(" G ", " P ").unwrap(),
            "## Instructions from the user\n\nG\n\n### For this project\n\nP"
        );
        assert_eq!(compose("G", "").unwrap(), "## Instructions from the user\n\nG");
        assert_eq!(
            compose("", "P").unwrap(),
            "## Instructions from the user\n\n### For this project\n\nP"
        );
    }

    #[test]
    fn scope_deserializes_from_camel_case() {
        let global: Scope = serde_json::from_str(r#"{"kind":"global"}"#).unwrap();
        assert_eq!(global, Scope::Global);
        let scoped: Scope =
            serde_json::from_str(r#"{"kind":"project","sourceId":"s","projectPath":"g/p"}"#).unwrap();
        assert_eq!(scoped, project("s", "g/p"));
    }
}
