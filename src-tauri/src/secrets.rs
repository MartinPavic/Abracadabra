//! OS keychain-backed token storage (via the `keyring` crate). Config file
//! stores only non-secret fields + a `GitSourceConfig::id` reference; the raw
//! token itself lives only in the OS keychain, keyed by that id.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use keyring::Entry;

const SERVICE_NAME: &str = "task-doer";

/// Keychain key for the agent CLI's credential (git sources use their own ids).
pub const AGENT_CREDENTIAL_ID: &str = "agent-credential";

/// Secrets already read (or written) this launch, `None` meaning "no entry".
/// macOS asks for the login password on every keychain read of an app whose
/// signature it doesn't trust, so each entry is read at most once.
struct SecretCache(Mutex<HashMap<String, Option<String>>>);

impl SecretCache {
    fn new() -> Self {
        Self(Mutex::new(HashMap::new()))
    }

    /// Returns the cached value, or loads it. The lock is held while loading so
    /// two callers never trigger the same keychain prompt twice; errors are not cached.
    fn get_or_load(
        &self,
        id: &str,
        load: impl FnOnce() -> Result<Option<String>, String>,
    ) -> Result<Option<String>, String> {
        let mut map = self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(value) = map.get(id) {
            return Ok(value.clone());
        }
        let value = load()?;
        map.insert(id.to_string(), value.clone());
        Ok(value)
    }

    fn remember(&self, id: &str, value: Option<String>) {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(id.to_string(), value);
    }
}

static CACHE: LazyLock<SecretCache> = LazyLock::new(SecretCache::new);

fn entry_for(source_id: &str) -> Result<Entry, String> {
    Entry::new(SERVICE_NAME, source_id).map_err(|err| format!("could not access keychain: {err}"))
}

/// Stores (or overwrites) the token for a git source.
pub fn set_token(source_id: &str, token: &str) -> Result<(), String> {
    log::info!("storing token for source {source_id}");
    entry_for(source_id)?
        .set_password(token)
        .map_err(|err| format!("could not store token: {err}"))?;
    CACHE.remember(source_id, Some(token.to_string()));
    Ok(())
}

/// Returns whether a token is currently stored for a git source, without exposing it.
pub fn has_token(source_id: &str) -> Result<bool, String> {
    let result = get_token(source_id).map(|token| token.is_some());
    log::debug!("has_token({source_id}) -> {result:?}");
    result
}

/// Reads the raw token for internal use (e.g. building an HTTP client) — never
/// exposed to the frontend directly.
pub fn get_token(source_id: &str) -> Result<Option<String>, String> {
    CACHE.get_or_load(source_id, || {
        log::debug!("reading token for source {source_id} from the keychain");
        match entry_for(source_id)?.get_password() {
            Ok(token) => Ok(Some(token)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(err) => Err(format!("could not read keychain: {err}")),
        }
    })
}

/// Removes the stored token for a git source, if any.
pub fn delete_token(source_id: &str) -> Result<(), String> {
    log::info!("deleting token for source {source_id}");
    match entry_for(source_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {
            CACHE.remember(source_id, None);
            Ok(())
        }
        Err(err) => Err(format!("could not delete token: {err}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn a_secret_is_loaded_once_and_then_served_from_memory() {
        let cache = SecretCache::new();
        let loads = Cell::new(0);
        let load = || {
            loads.set(loads.get() + 1);
            Ok(Some("tok".to_string()))
        };
        assert_eq!(cache.get_or_load("a", load).unwrap().as_deref(), Some("tok"));
        assert_eq!(cache.get_or_load("a", load).unwrap().as_deref(), Some("tok"));
        assert_eq!(loads.get(), 1);
    }

    #[test]
    fn a_missing_entry_is_remembered_too() {
        let cache = SecretCache::new();
        let loads = Cell::new(0);
        let load = || {
            loads.set(loads.get() + 1);
            Ok(None)
        };
        assert_eq!(cache.get_or_load("a", load).unwrap(), None);
        assert_eq!(cache.get_or_load("a", load).unwrap(), None);
        assert_eq!(loads.get(), 1);
    }

    #[test]
    fn a_failed_load_is_not_cached() {
        let cache = SecretCache::new();
        assert!(cache.get_or_load("a", || Err("denied".to_string())).is_err());
        assert_eq!(cache.get_or_load("a", || Ok(Some("tok".to_string()))).unwrap().as_deref(), Some("tok"));
    }

    #[test]
    fn remembering_a_write_or_delete_replaces_the_cached_value() {
        let cache = SecretCache::new();
        cache.remember("a", Some("new".to_string()));
        assert_eq!(cache.get_or_load("a", || panic!("must not hit the keychain")).unwrap().as_deref(), Some("new"));
        cache.remember("a", None);
        assert_eq!(cache.get_or_load("a", || panic!("must not hit the keychain")).unwrap(), None);
    }

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
