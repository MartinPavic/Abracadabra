//! Git provider abstraction — a shared `Provider` trait implemented per backend
//! (GitLab and GitHub) so the rest of the app isn't coupled to one API.

use std::future::Future;
use std::time::Duration;

use async_trait::async_trait;
use reqwest::header::{HeaderMap, LINK};
use serde::{Deserialize, Serialize};

use crate::config::{AppConfig, GitProvider, TimeoutConfig};

pub mod github;
pub mod gitlab;

/// Overall limit for one API request (the connect timeout is configured separately).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// Pagination safety net against a server that keeps returning a next page.
pub(crate) const MAX_PAGES: usize = 200;

/// HTTP client for provider APIs. Redirects are not followed: the token goes in a
/// header that would otherwise travel to wherever a (misconfigured or hostile)
/// server redirects to.
pub(crate) fn http_client(connect_timeout_secs: u64) -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(connect_timeout_secs))
        .timeout(REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("HTTP client configuration is valid")
}

/// Whether `candidate` is on the same scheme, host and port as `base`. Used to
/// refuse following a pagination link that would send the token elsewhere.
pub(crate) fn same_origin(base: &str, candidate: &str) -> bool {
    match (reqwest::Url::parse(base), reqwest::Url::parse(candidate)) {
        (Ok(a), Ok(b)) => {
            a.scheme() == b.scheme()
                && a.host_str() == b.host_str()
                && a.port_or_known_default() == b.port_or_known_default()
        }
        _ => false,
    }
}

/// The error for an HTTP 429 (or GitHub's secondary rate limit), with the
/// server's `Retry-After` hint if it gave one.
pub(crate) fn rate_limit_error(service: &str, headers: &HeaderMap) -> ProviderError {
    let wait = headers
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .map(|secs| format!(" (retry after {secs}s)"))
        .unwrap_or_default();
    ProviderError::Other(format!("{service} rate limit reached{wait} — try again later"))
}

/// The `Provider` implementation for a configured git source.
pub fn build(provider: GitProvider, base_url: &str, token: &str, timeouts: &TimeoutConfig) -> Box<dyn Provider> {
    match provider {
        GitProvider::GitLab => Box::new(gitlab::GitLabProvider::new(
            base_url,
            token,
            timeouts.connect_timeout_secs,
            timeouts.retry_attempts,
        )),
        GitProvider::GitHub => Box::new(github::GitHubProvider::new(
            base_url,
            token,
            timeouts.connect_timeout_secs,
            timeouts.retry_attempts,
        )),
    }
}

/// Posts a comment on an issue of a configured git source. A failure is only
/// logged: commenting is a courtesy and must never fail the run or the merge
/// request it is about.
pub async fn comment_on_issue(config: &AppConfig, source_id: &str, token: &str, task_id: &str, body: &str) {
    let Some(source) = config.git_sources.iter().find(|s| s.id == source_id) else {
        log::warn!("could not comment on {task_id}: git source {source_id} not found");
        return;
    };
    let provider = build(source.provider, &source.base_url, token, &config.timeouts);
    if let Err(err) = provider.create_issue_comment(task_id, body).await {
        log::warn!("could not comment on issue {task_id}: {err}");
    }
}

/// Resolves the next page's URL from the pagination headers, preferring the
/// standard `Link: <url>; rel="next"` header and falling back to GitLab's
/// legacy `X-Next-Page` header (which only gives a page number).
pub(crate) fn next_page_url(current_url: &str, headers: &HeaderMap) -> Option<String> {
    if let Some(link_header) = headers.get(LINK).and_then(|v| v.to_str().ok()) {
        if let Some(next) = parse_link_next(link_header) {
            return Some(next);
        }
    }

    let next_page = headers.get("x-next-page").and_then(|v| v.to_str().ok())?;
    if next_page.is_empty() {
        return None;
    }

    let mut url = reqwest::Url::parse(current_url).ok()?;
    let remaining_pairs: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(key, _)| key != "page")
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    url.query_pairs_mut().clear();
    for (key, value) in remaining_pairs {
        url.query_pairs_mut().append_pair(&key, &value);
    }
    url.query_pairs_mut().append_pair("page", next_page);
    Some(url.to_string())
}

fn parse_link_next(link_header: &str) -> Option<String> {
    link_header.split(',').find_map(|part| {
        let mut segments = part.split(';');
        let url_segment = segments.next()?.trim();
        let url = url_segment.strip_prefix('<')?.strip_suffix('>')?;
        let is_next = segments.any(|seg| seg.trim() == "rel=\"next\"");
        is_next.then(|| url.to_string())
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub title: String,
    pub project: String,
    pub labels: Vec<String>,
    pub url: String,
    pub updated_at: String,
    /// Provider's raw issue state, lowercased (e.g. "opened"/"closed" for GitLab).
    /// Kept as a free-form string rather than a closed enum so any state value
    /// the API adds in the future is surfaced as-is instead of being dropped.
    pub status: String,
}

/// Error taxonomy shared across providers so the frontend gets consistent,
/// categorized messages instead of raw HTTP/transport errors.
#[derive(Debug)]
pub enum ProviderError {
    /// Bad/missing/expired token (HTTP 401/403).
    Auth,
    /// Connect/request timeout — frontend should suggest checking the VPN.
    Timeout,
    /// Anything else (unexpected status code, malformed response, ...).
    Other(String),
}

impl std::fmt::Display for ProviderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProviderError::Auth => write!(f, "authentication failed"),
            ProviderError::Timeout => write!(f, "could not reach the server"),
            ProviderError::Other(msg) => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for ProviderError {}

impl ProviderError {
    fn from_reqwest(err: reqwest::Error) -> Self {
        if err.is_timeout() || err.is_connect() {
            ProviderError::Timeout
        } else {
            ProviderError::Other(err.to_string())
        }
    }

    /// For requests that create something (an MR/PR): only a failure to connect
    /// is safe to retry. A timeout after the request was sent may mean it was
    /// processed, so it is reported as such instead of being retried.
    fn from_reqwest_creating(err: reqwest::Error) -> Self {
        if err.is_connect() {
            ProviderError::Timeout
        } else if err.is_timeout() {
            ProviderError::Other(
                "the request timed out; it may still have been processed — check before retrying".to_string(),
            )
        } else {
            ProviderError::Other(err.to_string())
        }
    }
}

/// Everything a run needs about an issue beyond what the task list shows.
#[derive(Debug, Clone)]
pub struct IssueDetails {
    pub iid: String,
    pub url: String,
    /// Human-readable reference, e.g. "group/project#42".
    pub issue_ref: String,
    pub title: String,
    pub description: String,
    pub labels: Vec<String>,
    /// Namespaced project path, e.g. "group/project".
    pub project_path: String,
    pub clone_url: String,
    pub default_branch: String,
}

/// A merge/pull request to open for a pushed branch.
#[derive(Debug, Clone)]
pub struct MergeRequestRequest {
    /// Namespaced project path, e.g. "group/project".
    pub project_path: String,
    pub source_branch: String,
    pub target_branch: String,
    pub title: String,
    pub description: String,
}

/// "<service> returned <status>: <body>" with the body trimmed, so API
/// validation messages (e.g. "already exists") reach the user.
pub(crate) fn describe_failure(service: &str, status: reqwest::StatusCode, body: &str) -> String {
    let body = body.trim();
    if body.is_empty() {
        return format!("{service} returned {status}");
    }
    let shown: String = body.chars().take(300).collect();
    let ellipsis = if body.chars().count() > 300 { "..." } else { "" };
    format!("{service} returned {status}: {shown}{ellipsis}")
}

#[async_trait]
pub trait Provider: Send + Sync {
    async fn list_my_issues(&self) -> Result<Vec<Task>, ProviderError>;
    async fn list_project_issues(&self, project: &str) -> Result<Vec<Task>, ProviderError>;
    async fn get_issue_details(&self, task_id: &str) -> Result<IssueDetails, ProviderError>;
    /// Opens a merge/pull request and returns its web URL.
    async fn create_merge_request(&self, request: &MergeRequestRequest) -> Result<String, ProviderError>;
    /// Adds a comment to the issue `task_id` (a `Task::id`). Never retried after
    /// the request was sent, since a second attempt could post it twice.
    async fn create_issue_comment(&self, task_id: &str, body: &str) -> Result<(), ProviderError>;
    async fn test_connection(&self) -> Result<(), ProviderError>;
}

/// Retries `operation` up to `max_attempts` times with exponential backoff
/// (200ms, 400ms, 800ms, ...), but only on `ProviderError::Timeout` — auth and
/// other 4xx/non-retryable failures are returned immediately.
pub async fn with_retry<T, F, Fut>(max_attempts: u32, mut operation: F) -> Result<T, ProviderError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, ProviderError>>,
{
    let attempts = max_attempts.max(1);

    for attempt in 0..attempts {
        match operation().await {
            Ok(value) => return Ok(value),
            Err(ProviderError::Timeout) if attempt + 1 < attempts => {
                let backoff = Duration::from_millis(200 * 2u64.pow(attempt));
                log::warn!(
                    "request timed out (attempt {}/{attempts}), retrying in {backoff:?}",
                    attempt + 1
                );
                tokio::time::sleep(backoff).await;
            }
            Err(err) => return Err(err),
        }
    }

    log::error!("request timed out after {attempts} attempt(s), giving up");
    Err(ProviderError::Timeout)
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::HeaderValue;
    use std::sync::atomic::{AtomicU32, Ordering};

    #[test]
    fn same_origin_compares_scheme_host_and_port() {
        assert!(same_origin("https://gitlab.com/api/v4/issues", "https://gitlab.com/api/v4/issues?page=2"));
        assert!(same_origin("https://gitlab.com/a", "https://gitlab.com:443/b"));
        assert!(!same_origin("https://gitlab.com/a", "https://evil.example.com/a"));
        assert!(!same_origin("https://gitlab.com/a", "http://gitlab.com/a"));
        assert!(!same_origin("https://gitlab.com/a", "https://gitlab.com:8443/a"));
        assert!(!same_origin("https://gitlab.com/a", "not a url"));
    }

    #[test]
    fn rate_limit_errors_mention_retry_after() {
        let mut headers = HeaderMap::new();
        headers.insert("retry-after", HeaderValue::from_static("30"));
        assert!(rate_limit_error("GitLab", &headers).to_string().contains("retry after 30s"));
        assert!(rate_limit_error("GitLab", &HeaderMap::new()).to_string().contains("rate limit"));
    }

    #[test]
    fn describe_failure_includes_and_truncates_the_body() {
        let status = reqwest::StatusCode::CONFLICT;
        assert_eq!(describe_failure("GitLab", status, ""), "GitLab returned 409 Conflict");
        assert_eq!(
            describe_failure("GitLab", status, " already exists "),
            "GitLab returned 409 Conflict: already exists"
        );
        let long = "x".repeat(400);
        assert!(describe_failure("GitLab", status, &long).ends_with("..."));
    }

    #[test]
    fn parses_next_link_from_link_header() {
        let header = r#"<https://gitlab.example.com/api/v4/issues?page=2>; rel="next", <https://gitlab.example.com/api/v4/issues?page=5>; rel="last""#;
        assert_eq!(
            parse_link_next(header),
            Some("https://gitlab.example.com/api/v4/issues?page=2".to_string())
        );
    }

    #[test]
    fn returns_none_when_no_next_link() {
        let header = r#"<https://gitlab.example.com/api/v4/issues?page=1>; rel="first""#;
        assert_eq!(parse_link_next(header), None);
    }

    #[test]
    fn falls_back_to_x_next_page_header_preserving_query() {
        let mut headers = HeaderMap::new();
        headers.insert("x-next-page", HeaderValue::from_static("2"));
        let next = next_page_url(
            "https://gitlab.example.com/api/v4/issues?scope=assigned_to_me&per_page=50",
            &headers,
        )
        .unwrap();
        assert!(next.contains("page=2"));
        assert!(next.contains("scope=assigned_to_me"));
        assert!(next.contains("per_page=50"));
    }

    #[test]
    fn no_next_page_header_means_no_next_url() {
        let headers = HeaderMap::new();
        assert_eq!(
            next_page_url("https://gitlab.example.com/api/v4/issues", &headers),
            None
        );
    }

    #[tokio::test]
    async fn retries_on_timeout_until_success() {
        let calls = AtomicU32::new(0);
        let result = with_retry(3, || async {
            let attempt = calls.fetch_add(1, Ordering::SeqCst);
            if attempt < 2 {
                Err(ProviderError::Timeout)
            } else {
                Ok::<_, ProviderError>("ok")
            }
        })
        .await;

        assert_eq!(result.unwrap(), "ok");
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn gives_up_after_max_attempts() {
        let calls = AtomicU32::new(0);
        let result = with_retry(2, || async {
            calls.fetch_add(1, Ordering::SeqCst);
            Err::<(), _>(ProviderError::Timeout)
        })
        .await;

        assert!(matches!(result, Err(ProviderError::Timeout)));
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn does_not_retry_non_timeout_errors() {
        let calls = AtomicU32::new(0);
        let result = with_retry(5, || async {
            calls.fetch_add(1, Ordering::SeqCst);
            Err::<(), _>(ProviderError::Auth)
        })
        .await;

        assert!(matches!(result, Err(ProviderError::Auth)));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
