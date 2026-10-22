//! GitHub REST v3 implementation of the `Provider` trait.

use async_trait::async_trait;
use reqwest::header::HeaderMap;
use serde::de::DeserializeOwned;
use serde::Deserialize;

use super::{
    describe_failure, http_client, next_page_url, rate_limit_error, same_origin, with_retry, IssueDetails,
    MergeRequestRequest, Provider, ProviderError, Task, MAX_PAGES,
};

pub struct GitHubProvider {
    client: reqwest::Client,
    api_base: String,
    token: String,
    retry_attempts: u32,
}

impl GitHubProvider {
    pub fn new(
        base_url: impl AsRef<str>,
        token: impl Into<String>,
        connect_timeout_secs: u64,
        retry_attempts: u32,
    ) -> Self {
        Self {
            client: http_client(connect_timeout_secs),
            api_base: api_base(base_url.as_ref()),
            token: token.into(),
            retry_attempts,
        }
    }

    fn api_url(&self, path: &str) -> String {
        format!("{}{}", self.api_base, path)
    }

    /// Sends an authenticated GET, retrying on connect/timeout errors only.
    async fn get(&self, url: &str) -> Result<reqwest::Response, ProviderError> {
        log::debug!("GET {url}");
        with_retry(self.retry_attempts, || async {
            self.client
                .get(url)
                .bearer_auth(&self.token)
                .header("Accept", "application/vnd.github+json")
                .header("X-GitHub-Api-Version", "2022-11-28")
                // GitHub rejects requests without a User-Agent.
                .header("User-Agent", "abracadabra")
                .send()
                .await
                .map_err(ProviderError::from_reqwest)
        })
        .await
    }

    /// GET + status classification, returning the response for the caller to decode.
    async fn get_checked(&self, url: &str) -> Result<reqwest::Response, ProviderError> {
        let response = self.get(url).await?;
        classify(response.status(), response.headers()).inspect_err(|err| {
            log::warn!("GitHub request to {url} failed: {err}");
        })?;
        Ok(response)
    }

    async fn get_json<T: DeserializeOwned>(&self, url: &str) -> Result<T, ProviderError> {
        self.get_checked(url)
            .await?
            .json()
            .await
            .map_err(|err| ProviderError::Other(err.to_string()))
    }

    /// Fetches every page of an issues endpoint, following the `Link` header
    /// (never to another host: requests carry the token). Pull requests, which
    /// GitHub lists as issues, are skipped.
    async fn fetch_all_issues(&self, path: &str) -> Result<Vec<Task>, ProviderError> {
        let mut tasks = Vec::new();
        let first_url = self.api_url(path);
        let mut url = first_url.clone();

        for _ in 0..MAX_PAGES {
            let response = self.get_checked(&url).await?;
            let next_url = next_page_url(&url, response.headers());
            let issues: Vec<GitHubIssue> = response
                .json()
                .await
                .map_err(|err| ProviderError::Other(err.to_string()))?;
            tasks.extend(issues.into_iter().filter_map(task_from));

            match next_url {
                Some(next) if same_origin(&first_url, &next) => url = next,
                Some(_) => {
                    return Err(ProviderError::Other(
                        "GitHub pagination pointed at a different host; refusing to follow it".to_string(),
                    ))
                }
                None => {
                    log::info!("fetched {} task(s) total from {path}", tasks.len());
                    return Ok(tasks);
                }
            }
        }
        Err(ProviderError::Other(format!("more than {MAX_PAGES} pages of issues; narrow the project filter")))
    }
}

#[async_trait]
impl Provider for GitHubProvider {
    async fn list_my_issues(&self) -> Result<Vec<Task>, ProviderError> {
        self.fetch_all_issues("/issues?filter=assigned&state=all&per_page=50").await
    }

    async fn list_project_issues(&self, project: &str) -> Result<Vec<Task>, ProviderError> {
        self.fetch_all_issues(&format!("/repos/{project}/issues?state=all&per_page=50"))
            .await
    }

    async fn get_issue_details(&self, task_id: &str) -> Result<IssueDetails, ProviderError> {
        let (owner, repo, number) = parse_task_id(task_id)
            .ok_or_else(|| ProviderError::Other(format!("malformed task id {task_id}")))?;
        let issue: GitHubIssueDetail = self
            .get_json(&self.api_url(&format!("/repos/{owner}/{repo}/issues/{number}")))
            .await?;
        let repository: GitHubRepo = self.get_json(&self.api_url(&format!("/repos/{owner}/{repo}"))).await?;
        Ok(details_from(issue, repository))
    }

    async fn create_merge_request(&self, request: &MergeRequestRequest) -> Result<String, ProviderError> {
        let url = self.api_url(&format!("/repos/{}/pulls", request.project_path));
        let body = serde_json::json!({
            "title": request.title,
            "head": request.source_branch,
            "base": request.target_branch,
            "body": request.description,
        });
        log::debug!("POST {url}");
        let response = with_retry(self.retry_attempts, || async {
            self.client
                .post(&url)
                .bearer_auth(&self.token)
                .header("Accept", "application/vnd.github+json")
                .header("X-GitHub-Api-Version", "2022-11-28")
                .header("User-Agent", "abracadabra")
                .json(&body)
                .send()
                .await
                .map_err(ProviderError::from_reqwest_creating)
        })
        .await?;

        let status = response.status();
        // Validation failures (422) carry the useful message, e.g. "A pull request already exists".
        let is_auth = status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN;
        if !status.is_success() && !is_auth {
            let text = response.text().await.unwrap_or_default();
            log::warn!("GitHub returned {status} creating a pull request");
            return Err(ProviderError::Other(describe_failure("GitHub", status, &text)));
        }
        classify(status, response.headers())?;
        let created: GitHubPullRequest = response
            .json()
            .await
            .map_err(|err| ProviderError::Other(err.to_string()))?;
        Ok(created.html_url)
    }

    async fn create_issue_comment(&self, task_id: &str, body: &str) -> Result<(), ProviderError> {
        let (owner, repo, number) = parse_task_id(task_id)
            .ok_or_else(|| ProviderError::Other(format!("malformed task id {task_id}")))?;
        let url = self.api_url(&format!("/repos/{owner}/{repo}/issues/{number}/comments"));
        log::debug!("POST {url}");
        let response = with_retry(self.retry_attempts, || async {
            self.client
                .post(&url)
                .bearer_auth(&self.token)
                .header("Accept", "application/vnd.github+json")
                .header("X-GitHub-Api-Version", "2022-11-28")
                .header("User-Agent", "abracadabra")
                .json(&serde_json::json!({ "body": body }))
                .send()
                .await
                .map_err(ProviderError::from_reqwest_creating)
        })
        .await?;
        let status = response.status();
        let is_auth = status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN;
        if !status.is_success() && !is_auth {
            let text = response.text().await.unwrap_or_default();
            return Err(ProviderError::Other(describe_failure("GitHub", status, &text)));
        }
        classify(status, response.headers())
    }

    async fn test_connection(&self) -> Result<(), ProviderError> {
        self.get_checked(&self.api_url("/user")).await?;
        log::info!("test_connection succeeded for {}", self.api_base);
        Ok(())
    }
}

/// GitHub.com's API lives on its own host; Enterprise Server serves it under `/api/v3`.
fn api_base(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    let host = trimmed.split("://").nth(1).unwrap_or(trimmed);
    if matches!(host, "github.com" | "www.github.com" | "api.github.com") {
        "https://api.github.com".to_string()
    } else if trimmed.ends_with("/api/v3") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/api/v3")
    }
}

fn classify(status: reqwest::StatusCode, headers: &HeaderMap) -> Result<(), ProviderError> {
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(ProviderError::Auth);
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(rate_limit_error("GitHub", headers));
    }
    if status == reqwest::StatusCode::FORBIDDEN {
        // Primary limits report no remaining quota; secondary limits send Retry-After.
        let rate_limited = headers.get("x-ratelimit-remaining").and_then(|v| v.to_str().ok()) == Some("0")
            || headers.contains_key("retry-after");
        return Err(if rate_limited {
            rate_limit_error("GitHub", headers)
        } else {
            ProviderError::Auth
        });
    }
    if !status.is_success() {
        return Err(ProviderError::Other(format!("GitHub returned {status}")));
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
struct GitHubLabel {
    name: String,
}

#[derive(Debug, Deserialize)]
struct GitHubIssue {
    number: u64,
    title: String,
    #[serde(default)]
    labels: Vec<GitHubLabel>,
    html_url: String,
    updated_at: String,
    state: String,
    /// e.g. "https://api.github.com/repos/owner/repo".
    repository_url: String,
    /// Present when the "issue" is really a pull request.
    pull_request: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct GitHubIssueDetail {
    number: u64,
    title: String,
    body: Option<String>,
    #[serde(default)]
    labels: Vec<GitHubLabel>,
    html_url: String,
}

#[derive(Debug, Deserialize)]
struct GitHubPullRequest {
    html_url: String,
}

#[derive(Debug, Deserialize)]
struct GitHubRepo {
    full_name: String,
    clone_url: String,
    default_branch: String,
}

/// Task ids are "owner~repo~number": `~` can't appear in owner/repo names, and
/// the id ends up in run ids, file names and URLs where `/` and `#` can't go.
fn task_id(project: &str, number: u64) -> String {
    format!("{}~{number}", project.replace('/', "~"))
}

fn parse_task_id(task_id: &str) -> Option<(&str, &str, u64)> {
    let mut parts = task_id.split('~');
    let (owner, repo, number) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() || owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some((owner, repo, number.parse().ok()?))
}

fn task_from(issue: GitHubIssue) -> Option<Task> {
    if issue.pull_request.is_some() {
        return None;
    }
    let project = issue.repository_url.split("/repos/").nth(1)?.to_string();
    Some(Task {
        id: task_id(&project, issue.number),
        title: issue.title,
        project,
        labels: issue.labels.into_iter().map(|l| l.name).collect(),
        url: issue.html_url,
        updated_at: issue.updated_at,
        status: issue.state.to_lowercase(),
    })
}

fn details_from(issue: GitHubIssueDetail, repository: GitHubRepo) -> IssueDetails {
    IssueDetails {
        iid: issue.number.to_string(),
        issue_ref: format!("{}#{}", repository.full_name, issue.number),
        url: issue.html_url,
        title: issue.title,
        description: issue.body.unwrap_or_default(),
        labels: issue.labels.into_iter().map(|l| l.name).collect(),
        project_path: repository.full_name,
        clone_url: repository.clone_url,
        default_branch: repository.default_branch,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn issue(pull_request: Option<serde_json::Value>) -> GitHubIssue {
        GitHubIssue {
            number: 12,
            title: "Fix it".to_string(),
            labels: vec![GitHubLabel { name: "bug".to_string() }],
            html_url: "https://github.com/acme/widgets/issues/12".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
            state: "OPEN".to_string(),
            repository_url: "https://api.github.com/repos/acme/widgets".to_string(),
            pull_request,
        }
    }

    #[test]
    fn maps_issue_to_task() {
        let task = task_from(issue(None)).unwrap();
        assert_eq!(task.id, "acme~widgets~12");
        assert_eq!(task.project, "acme/widgets");
        assert_eq!(task.status, "open");
        assert_eq!(task.labels, vec!["bug"]);
    }

    #[test]
    fn skips_pull_requests() {
        assert!(task_from(issue(Some(serde_json::json!({})))).is_none());
    }

    #[test]
    fn task_ids_round_trip() {
        assert_eq!(parse_task_id("acme~widgets~12"), Some(("acme", "widgets", 12)));
        assert_eq!(parse_task_id("acme~widgets"), None);
        assert_eq!(parse_task_id("acme~widgets~x"), None);
        assert_eq!(parse_task_id("a~b~1~2"), None);
    }

    #[test]
    fn derives_api_base_for_github_com_and_enterprise() {
        assert_eq!(api_base("https://github.com"), "https://api.github.com");
        assert_eq!(api_base("https://github.com/"), "https://api.github.com");
        assert_eq!(api_base("https://ghe.example.com"), "https://ghe.example.com/api/v3");
        assert_eq!(api_base("https://ghe.example.com/api/v3/"), "https://ghe.example.com/api/v3");
    }

    #[test]
    fn rate_limited_403_is_not_an_auth_error() {
        let mut headers = HeaderMap::new();
        headers.insert("x-ratelimit-remaining", "0".parse().unwrap());
        assert!(matches!(
            classify(reqwest::StatusCode::FORBIDDEN, &headers),
            Err(ProviderError::Other(_))
        ));
        assert!(matches!(
            classify(reqwest::StatusCode::FORBIDDEN, &HeaderMap::new()),
            Err(ProviderError::Auth)
        ));
        assert!(matches!(
            classify(reqwest::StatusCode::UNAUTHORIZED, &HeaderMap::new()),
            Err(ProviderError::Auth)
        ));
    }

    #[test]
    fn builds_issue_details() {
        let details = details_from(
            GitHubIssueDetail {
                number: 12,
                title: "Fix it".to_string(),
                body: None,
                labels: vec![GitHubLabel { name: "bug".to_string() }],
                html_url: "https://github.com/acme/widgets/issues/12".to_string(),
            },
            GitHubRepo {
                full_name: "acme/widgets".to_string(),
                clone_url: "https://github.com/acme/widgets.git".to_string(),
                default_branch: "main".to_string(),
            },
        );
        assert_eq!(details.issue_ref, "acme/widgets#12");
        assert_eq!(details.description, "");
        assert_eq!(details.default_branch, "main");
    }
}
