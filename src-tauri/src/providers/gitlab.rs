//! GitLab REST v4 implementation of the `Provider` trait.

use async_trait::async_trait;
use serde::de::DeserializeOwned;
use serde::Deserialize;

use super::{
    describe_failure, http_client, next_page_url, rate_limit_error, same_origin, with_retry, IssueDetails,
    MergeRequestRequest, Provider, ProviderError, Task, MAX_PAGES,
};

pub struct GitLabProvider {
    client: reqwest::Client,
    base_url: String,
    token: String,
    retry_attempts: u32,
}

impl GitLabProvider {
    pub fn new(
        base_url: impl Into<String>,
        token: impl Into<String>,
        connect_timeout_secs: u64,
        retry_attempts: u32,
    ) -> Self {
        Self {
            client: http_client(connect_timeout_secs),
            base_url: base_url.into().trim_end_matches('/').to_string(),
            token: token.into(),
            retry_attempts,
        }
    }

    fn api_url(&self, path: &str) -> String {
        format!("{}/api/v4{}", self.base_url, path)
    }

    /// Sends an authenticated GET, retrying on connect/timeout errors only —
    /// 4xx/5xx responses are returned as-is for the caller to classify.
    async fn get(&self, url: &str) -> Result<reqwest::Response, ProviderError> {
        log::debug!("GET {url}");
        with_retry(self.retry_attempts, || async {
            self.client
                .get(url)
                .header("PRIVATE-TOKEN", &self.token)
                .send()
                .await
                .map_err(ProviderError::from_reqwest)
        })
        .await
    }

    /// GET + status classification + JSON decode for single-resource endpoints.
    async fn get_json<T: DeserializeOwned>(&self, path: &str) -> Result<T, ProviderError> {
        let url = self.api_url(path);
        let response = check(&url, self.get(&url).await?)?;
        response.json().await.map_err(|err| ProviderError::Other(err.to_string()))
    }

    /// Fetches every page of a GitLab issues endpoint, following pagination
    /// via the `Link` header (falling back to `X-Next-Page`). Next-page links on
    /// another host are refused, since requests carry the token.
    async fn fetch_all_issues(&self, path: &str) -> Result<Vec<Task>, ProviderError> {
        let mut tasks = Vec::new();
        let first_url = self.api_url(path);
        let mut url = first_url.clone();

        for page in 1..=MAX_PAGES {
            log::debug!("fetching issues page {page} from {url}");
            let response = check(&url, self.get(&url).await?)?;
            let next_url = next_page_url(&url, response.headers());

            let issues: Vec<GitLabIssue> = response
                .json()
                .await
                .map_err(|err| ProviderError::Other(err.to_string()))?;
            log::debug!("page {page} returned {} issue(s)", issues.len());
            tasks.extend(issues.into_iter().map(Task::from));

            match next_url {
                Some(next) if same_origin(&first_url, &next) => url = next,
                Some(_) => {
                    return Err(ProviderError::Other(
                        "GitLab pagination pointed at a different host; refusing to follow it".to_string(),
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

/// Maps a non-success response to the shared error taxonomy.
fn check(url: &str, response: reqwest::Response) -> Result<reqwest::Response, ProviderError> {
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        log::warn!("GitLab returned {status} for {url} — treating as auth failure");
        return Err(ProviderError::Auth);
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        log::warn!("GitLab rate-limited {url}");
        return Err(rate_limit_error("GitLab", response.headers()));
    }
    if !status.is_success() {
        log::warn!("GitLab returned {status} for {url}");
        return Err(ProviderError::Other(format!("GitLab returned {status}")));
    }
    Ok(response)
}

#[async_trait]
impl Provider for GitLabProvider {
    async fn list_my_issues(&self) -> Result<Vec<Task>, ProviderError> {
        self.fetch_all_issues("/issues?scope=assigned_to_me&per_page=50")
            .await
    }

    async fn list_project_issues(&self, project: &str) -> Result<Vec<Task>, ProviderError> {
        // Project path segments (e.g. "group/subproject") must be percent-encoded as one segment.
        let encoded_project = project.replace('/', "%2F");
        self.fetch_all_issues(&format!("/projects/{encoded_project}/issues?per_page=50"))
            .await
    }

    async fn get_issue_details(&self, task_id: &str) -> Result<IssueDetails, ProviderError> {
        let (project_id, iid) = parse_task_id(task_id)
            .ok_or_else(|| ProviderError::Other(format!("malformed task id {task_id}")))?;
        let issue: GitLabIssueDetail = self.get_json(&format!("/projects/{project_id}/issues/{iid}")).await?;
        let project: GitLabProject = self.get_json(&format!("/projects/{project_id}")).await?;
        details_from(issue, project)
    }

    async fn create_merge_request(&self, request: &MergeRequestRequest) -> Result<String, ProviderError> {
        let encoded_project = request.project_path.replace('/', "%2F");
        let url = self.api_url(&format!("/projects/{encoded_project}/merge_requests"));
        let body = serde_json::json!({
            "source_branch": request.source_branch,
            "target_branch": request.target_branch,
            "title": request.title,
            "description": request.description,
        });
        log::debug!("POST {url}");
        let response = with_retry(self.retry_attempts, || async {
            self.client
                .post(&url)
                .header("PRIVATE-TOKEN", &self.token)
                .json(&body)
                .send()
                .await
                .map_err(ProviderError::from_reqwest_creating)
        })
        .await?;

        let status = response.status();
        if !status.is_success()
            && status != reqwest::StatusCode::UNAUTHORIZED
            && status != reqwest::StatusCode::FORBIDDEN
            && status != reqwest::StatusCode::TOO_MANY_REQUESTS
        {
            // Validation failures carry the useful message, e.g. "another open merge request already exists".
            let text = response.text().await.unwrap_or_default();
            log::warn!("GitLab returned {status} creating a merge request");
            return Err(ProviderError::Other(describe_failure("GitLab", status, &text)));
        }
        let created: GitLabMergeRequest = check(&url, response)?
            .json()
            .await
            .map_err(|err| ProviderError::Other(err.to_string()))?;
        Ok(created.web_url)
    }

    async fn create_issue_comment(&self, task_id: &str, body: &str) -> Result<(), ProviderError> {
        let (project_id, iid) = parse_task_id(task_id)
            .ok_or_else(|| ProviderError::Other(format!("malformed task id {task_id}")))?;
        let url = self.api_url(&format!("/projects/{project_id}/issues/{iid}/notes"));
        log::debug!("POST {url}");
        let response = with_retry(self.retry_attempts, || async {
            self.client
                .post(&url)
                .header("PRIVATE-TOKEN", &self.token)
                .json(&serde_json::json!({ "body": body }))
                .send()
                .await
                .map_err(ProviderError::from_reqwest_creating)
        })
        .await?;
        let status = response.status();
        if !status.is_success()
            && status != reqwest::StatusCode::UNAUTHORIZED
            && status != reqwest::StatusCode::FORBIDDEN
            && status != reqwest::StatusCode::TOO_MANY_REQUESTS
        {
            let text = response.text().await.unwrap_or_default();
            return Err(ProviderError::Other(describe_failure("GitLab", status, &text)));
        }
        check(&url, response).map(|_| ())
    }

    async fn test_connection(&self) -> Result<(), ProviderError> {
        log::debug!("testing connection to {}", self.base_url);
        let url = self.api_url("/user");
        check(&url, self.get(&url).await?)?;
        log::info!("test_connection succeeded for {}", self.base_url);
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
struct GitLabIssue {
    iid: u64,
    project_id: u64,
    title: String,
    #[serde(default)]
    labels: Vec<String>,
    web_url: String,
    updated_at: String,
    references: Option<GitLabReferences>,
    /// GitLab's issue state: "opened" or "closed".
    state: String,
}

#[derive(Debug, Deserialize)]
struct GitLabReferences {
    full: String,
}

#[derive(Debug, Deserialize)]
struct GitLabMergeRequest {
    web_url: String,
}

#[derive(Debug, Deserialize)]
struct GitLabIssueDetail {
    iid: u64,
    web_url: String,
    title: String,
    description: Option<String>,
    #[serde(default)]
    labels: Vec<String>,
    references: Option<GitLabReferences>,
}

#[derive(Debug, Deserialize)]
struct GitLabProject {
    path_with_namespace: String,
    http_url_to_repo: String,
    /// Absent for empty repositories.
    default_branch: Option<String>,
}

/// Splits a task id of the form "<project_id>-<iid>" (see `From<GitLabIssue> for Task`).
fn parse_task_id(task_id: &str) -> Option<(u64, u64)> {
    let (project_id, iid) = task_id.split_once('-')?;
    Some((project_id.parse().ok()?, iid.parse().ok()?))
}

fn details_from(issue: GitLabIssueDetail, project: GitLabProject) -> Result<IssueDetails, ProviderError> {
    let default_branch = project.default_branch.filter(|b| !b.is_empty()).ok_or_else(|| {
        ProviderError::Other(format!("{} has no default branch (empty repository?)", project.path_with_namespace))
    })?;
    let issue_ref = issue
        .references
        .map(|refs| refs.full)
        .unwrap_or_else(|| format!("{}#{}", project.path_with_namespace, issue.iid));

    Ok(IssueDetails {
        iid: issue.iid.to_string(),
        url: issue.web_url,
        issue_ref,
        title: issue.title,
        description: issue.description.unwrap_or_default(),
        labels: issue.labels,
        project_path: project.path_with_namespace,
        clone_url: project.http_url_to_repo,
        default_branch,
    })
}

impl From<GitLabIssue> for Task {
    fn from(issue: GitLabIssue) -> Self {
        let project = issue
            .references
            .and_then(|refs| refs.full.split('#').next().map(str::to_string))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| issue.project_id.to_string());

        Task {
            id: format!("{}-{}", issue.project_id, issue.iid),
            title: issue.title,
            project,
            labels: issue.labels,
            url: issue.web_url,
            updated_at: issue.updated_at,
            status: issue.state.to_lowercase(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_task_id() {
        assert_eq!(parse_task_id("7-42"), Some((7, 42)));
        assert_eq!(parse_task_id("nope"), None);
        assert_eq!(parse_task_id("a-b"), None);
    }

    #[test]
    fn builds_issue_details_from_issue_and_project() {
        let issue = GitLabIssueDetail {
            iid: 42,
            web_url: "https://gitlab.example.com/group/project/-/issues/42".to_string(),
            title: "Fix".to_string(),
            description: None,
            labels: vec!["bug".to_string()],
            references: None,
        };
        let project = GitLabProject {
            path_with_namespace: "group/project".to_string(),
            http_url_to_repo: "https://gitlab.example.com/group/project.git".to_string(),
            default_branch: Some("main".to_string()),
        };
        let details = details_from(issue, project).unwrap();
        assert_eq!(details.issue_ref, "group/project#42");
        assert_eq!(details.url, "https://gitlab.example.com/group/project/-/issues/42");
        assert_eq!(details.description, "");
        assert_eq!(details.labels, vec!["bug"]);
        assert_eq!(details.default_branch, "main");
    }

    #[test]
    fn issue_details_error_when_project_has_no_default_branch() {
        let issue = GitLabIssueDetail {
            iid: 1,
            web_url: "u".to_string(),
            title: "t".to_string(),
            description: None,
            labels: vec![],
            references: None,
        };
        let project = GitLabProject {
            path_with_namespace: "g/p".to_string(),
            http_url_to_repo: "u".to_string(),
            default_branch: None,
        };
        assert!(details_from(issue, project).is_err());
    }

    #[test]
    fn maps_gitlab_issue_to_task() {
        let issue = GitLabIssue {
            iid: 42,
            project_id: 7,
            title: "Fix the thing".to_string(),
            labels: vec!["bug".to_string()],
            web_url: "https://gitlab.example.com/group/project/-/issues/42".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
            references: Some(GitLabReferences {
                full: "group/project#42".to_string(),
            }),
            state: "opened".to_string(),
        };
        let task: Task = issue.into();
        assert_eq!(task.id, "7-42");
        assert_eq!(task.project, "group/project");
        assert_eq!(task.title, "Fix the thing");
        assert_eq!(task.status, "opened");
    }

    #[test]
    fn falls_back_to_project_id_when_references_missing() {
        let issue = GitLabIssue {
            iid: 1,
            project_id: 99,
            title: "Task".to_string(),
            labels: vec![],
            web_url: "https://gitlab.example.com/x/y/-/issues/1".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
            references: None,
            state: "closed".to_string(),
        };
        let task: Task = issue.into();
        assert_eq!(task.project, "99");
        assert_eq!(task.status, "closed");
    }
}
