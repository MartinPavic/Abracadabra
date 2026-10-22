//! OS keychain-backed token storage (via the `keyring` crate). Config file
//! stores only non-secret fields + a `GitSourceConfig::id` reference; the raw
//! token itself lives only in the OS keychain, keyed by that id.

use keyring::Entry;

const SERVICE_NAME: &str = "task-doer";

/// Keychain key for the agent CLI's credential (git sources use their own ids).
pub const AGENT_CREDENTIAL_ID: &str = "agent-credential";

fn entry_for(source_id: &str) -> Result<Entry, String> {
    Entry::new(SERVICE_NAME, source_id).map_err(|err| format!("could not access keychain: {err}"))
}

/// Stores (or overwrites) the token for a git source.
pub fn set_token(source_id: &str, token: &str) -> Result<(), String> {
    log::info!("storing token for source {source_id}");
    entry_for(source_id)?
        .set_password(token)
        .map_err(|err| format!("could not store token: {err}"))
}

/// Returns whether a token is currently stored for a git source, without exposing it.
pub fn has_token(source_id: &str) -> Result<bool, String> {
    let result = match entry_for(source_id)?.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(err) => Err(format!("could not read keychain: {err}")),
    };
    log::debug!("has_token({source_id}) -> {result:?}");
    result
}

/// Reads the raw token for internal use (e.g. building an HTTP client) — never
/// exposed to the frontend directly.
pub fn get_token(source_id: &str) -> Result<Option<String>, String> {
    log::debug!("reading token for source {source_id}");
    match entry_for(source_id)?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(format!("could not read keychain: {err}")),
    }
}

/// Removes the stored token for a git source, if any.
pub fn delete_token(source_id: &str) -> Result<(), String> {
    log::info!("deleting token for source {source_id}");
    match entry_for(source_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(format!("could not delete token: {err}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Ignored by default: exercises the real OS keychain (may prompt for
    // access on macOS). Run manually with `cargo test -- --ignored` to verify
    // the round-trip.
    #[test]
    #[ignore]
    fn token_round_trips_through_os_keychain() {
        let source_id = "taskdoer-debug-test-source";
        set_token(source_id, "debug-token-value").unwrap();
        assert!(has_token(source_id).unwrap());
        assert_eq!(
            get_token(source_id).unwrap().as_deref(),
            Some("debug-token-value")
        );
        delete_token(source_id).unwrap();
        assert!(!has_token(source_id).unwrap());
    }
}
