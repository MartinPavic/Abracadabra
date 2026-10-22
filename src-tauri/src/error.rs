//! Error type sent to the frontend by commands, so the UI can word each kind of failure differently.

use serde::Serialize;

use crate::providers::ProviderError;

/// Serialised as `{ "kind": "auth" | "timeout" | ..., "message"? }`.
#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AppError {
    /// Missing, bad or expired token: the user should open Settings.
    Auth,
    /// The server could not be reached: the user should check the VPN.
    Timeout,
    /// The run, source or stash asked for doesn't exist (any more).
    NotFound { message: String },
    /// The request doesn't fit the current state, e.g. approving a run that isn't waiting.
    Conflict { message: String },
    /// A git command failed; the message is git's own.
    Git { message: String },
    Other { message: String },
}

impl AppError {
    pub fn not_found(message: impl Into<String>) -> Self {
        AppError::NotFound { message: message.into() }
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        AppError::Conflict { message: message.into() }
    }

    pub fn git(message: impl Into<String>) -> Self {
        AppError::Git { message: message.into() }
    }
}

impl From<ProviderError> for AppError {
    fn from(err: ProviderError) -> Self {
        match err {
            ProviderError::Auth => AppError::Auth,
            ProviderError::Timeout => AppError::Timeout,
            ProviderError::Other(message) => AppError::Other { message },
        }
    }
}

impl From<String> for AppError {
    fn from(message: String) -> Self {
        AppError::Other { message }
    }
}

impl From<&str> for AppError {
    fn from(message: &str) -> Self {
        AppError::Other { message: message.to_string() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialises_with_a_kind_tag() {
        assert_eq!(serde_json::to_string(&AppError::Auth).unwrap(), r#"{"kind":"auth"}"#);
        assert_eq!(
            serde_json::to_string(&AppError::from("boom")).unwrap(),
            r#"{"kind":"other","message":"boom"}"#
        );
        assert_eq!(
            serde_json::to_string(&AppError::not_found("gone")).unwrap(),
            r#"{"kind":"not_found","message":"gone"}"#
        );
    }

    #[test]
    fn provider_errors_keep_their_category() {
        assert_eq!(AppError::from(ProviderError::Timeout), AppError::Timeout);
    }
}
