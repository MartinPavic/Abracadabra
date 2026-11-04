//! Reading and saving the user's agent instructions, and importing them from a text file.

use std::fs::{self, File};
use std::io::Read;
use std::path::Path;

use tauri::AppHandle;

use crate::instructions::{self, Scope};

/// Largest file the import accepts.
const MAX_IMPORT_BYTES: u64 = 256 * 1024;

fn read_text_file_checked(path: &Path) -> Result<String, String> {
    let is_text = path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md") || ext.eq_ignore_ascii_case("txt"));
    if !is_text {
        return Err("only .md and .txt files can be imported".into());
    }
    let read_error = |err: std::io::Error| format!("could not read {}: {err}", path.display());
    let metadata = fs::metadata(path).map_err(read_error)?;
    if !metadata.is_file() {
        return Err("that is not a file".into());
    }
    let too_large = || "that file is larger than 256 KB".to_string();
    if metadata.len() > MAX_IMPORT_BYTES {
        return Err(too_large());
    }
    // Bounded separately in case the file grew after the size check.
    let mut bytes = Vec::new();
    File::open(path)
        .and_then(|file| file.take(MAX_IMPORT_BYTES + 1).read_to_end(&mut bytes))
        .map_err(read_error)?;
    if bytes.len() as u64 > MAX_IMPORT_BYTES {
        return Err(too_large());
    }
    String::from_utf8(bytes).map_err(|_| "that file is not valid UTF-8 text".to_string())
}

#[tauri::command]
pub fn get_instructions(app: AppHandle, scope: Scope) -> Result<String, String> {
    instructions::read(&instructions::dir(&app), &scope)
}

#[tauri::command]
pub fn set_instructions(app: AppHandle, scope: Scope, text: String) -> Result<(), String> {
    instructions::write(&instructions::dir(&app), &scope, &text)
}

/// Returns the file's text for the user to review; nothing is saved here.
#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    read_text_file_checked(Path::new(&path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn a_markdown_file_is_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rules.md");
        fs::write(&path, "# Rules\nBe kind.\n").unwrap();
        assert_eq!(read_text_file_checked(&path).unwrap(), "# Rules\nBe kind.\n");
    }

    #[test]
    fn a_txt_file_with_an_uppercase_extension_is_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("NOTES.TXT");
        fs::write(&path, "hello").unwrap();
        assert_eq!(read_text_file_checked(&path).unwrap(), "hello");
    }

    #[test]
    fn other_extensions_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["rules.rs", "rules", "rules.md.exe"] {
            let path = dir.path().join(name);
            fs::write(&path, "text").unwrap();
            let err = read_text_file_checked(&path).unwrap_err();
            assert!(err.contains("only .md and .txt files can be imported"), "{name}: {err}");
        }
    }

    #[test]
    fn a_file_over_256_kb_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.md");
        fs::write(&path, vec![b'a'; 256 * 1024 + 1]).unwrap();
        let err = read_text_file_checked(&path).unwrap_err();
        assert!(err.contains("larger than 256 KB"), "{err}");

        fs::write(&path, vec![b'a'; 256 * 1024]).unwrap();
        assert_eq!(read_text_file_checked(&path).unwrap().len(), 256 * 1024);
    }

    #[test]
    fn invalid_utf8_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bad.txt");
        fs::write(&path, [0xff, 0xfe, 0xfd]).unwrap();
        let err = read_text_file_checked(&path).unwrap_err();
        assert!(err.contains("not valid UTF-8"), "{err}");
    }

    #[test]
    fn a_directory_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("folder.md");
        fs::create_dir(&path).unwrap();
        let err = read_text_file_checked(&path).unwrap_err();
        assert!(err.contains("not a file"), "{err}");
    }

    #[test]
    fn a_missing_file_gives_a_clear_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("missing.md");
        let err = read_text_file_checked(&path).unwrap_err();
        assert!(err.contains("could not read"), "{err}");
        assert!(err.contains("missing.md"), "{err}");
    }
}
