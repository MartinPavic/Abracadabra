//! Shell environment fix-up: apps launched from Finder get a minimal `PATH`
//! (`/usr/bin:/bin:...`), so tools installed via Homebrew, nvm or `~/.local/bin`
//! (`claude`, `pnpm`, `node`, ...) would not be found. The login shell's `PATH`
//! is merged in at startup.

#[cfg(unix)]
pub fn merge_login_shell_path() {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let spawned = Command::new(&shell)
        .args(["-ilc", &format!("printf '{MARKER}%s{MARKER}' \"$PATH\"")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    let Ok(mut child) = spawned else { return };

    // An interactive shell can block on a misbehaving rc file; don't wait forever.
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                log::warn!("login shell did not report its PATH in time; keeping the current PATH");
                return;
            }
        }
    }

    let mut output = String::new();
    if child.stdout.take().map(|mut out| out.read_to_string(&mut output)).is_none() {
        return;
    }
    let Some(login_path) = extract_marked(&output) else { return };
    let merged = merge_paths(login_path, &std::env::var("PATH").unwrap_or_default());
    log::info!("merged the login shell PATH into the app environment");
    std::env::set_var("PATH", merged);
}

#[cfg(not(unix))]
pub fn merge_login_shell_path() {}

const MARKER: &str = "__TASKDOER_PATH__";

/// The text between the two markers, ignoring any noise a shell rc file prints.
fn extract_marked(output: &str) -> Option<&str> {
    let start = output.find(MARKER)? + MARKER.len();
    let end = start + output[start..].find(MARKER)?;
    Some(&output[start..end])
}

/// Login-shell entries first, then whatever the app already had, without duplicates.
fn merge_paths(login: &str, current: &str) -> String {
    let mut seen = std::collections::HashSet::new();
    login
        .split(':')
        .chain(current.split(':'))
        .filter(|entry| !entry.is_empty() && seen.insert(*entry))
        .collect::<Vec<_>>()
        .join(":")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_the_path_between_markers_and_ignores_rc_noise() {
        let output = format!("Welcome!\n{MARKER}/opt/homebrew/bin:/usr/bin{MARKER}\n");
        assert_eq!(extract_marked(&output), Some("/opt/homebrew/bin:/usr/bin"));
        assert_eq!(extract_marked("no markers"), None);
        assert_eq!(extract_marked(&format!("{MARKER}unterminated")), None);
    }

    #[test]
    fn merges_without_duplicates_login_first() {
        assert_eq!(
            merge_paths("/opt/homebrew/bin:/usr/bin", "/usr/bin:/bin:/usr/sbin"),
            "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin"
        );
        assert_eq!(merge_paths("", "/bin"), "/bin");
    }
}
