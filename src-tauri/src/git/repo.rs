//! Local repo manager — clone-or-fetch project repos into an app-data
//! subfolder, or prepare a user-provided checkout.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime};

use super::{run_git_env, token_auth_env};

/// Directory under the app's data dir holding the cloned projects.
pub fn repos_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("could not resolve app data dir: {err}"))?
        .join("repos");
    std::fs::create_dir_all(&dir).map_err(|err| format!("could not create {}: {err}", dir.display()))?;
    Ok(dir)
}

/// Where the app-managed clone of a project lives. Scoped by git source, so the
/// same project path on two hosts (or two accounts) never shares a clone, and
/// suffixed with a hash so differently-spelled paths can't slug to the same name.
pub fn managed_repo_dir<R: Runtime>(
    app: &AppHandle<R>,
    source_id: &str,
    project_path: &str,
) -> Result<PathBuf, String> {
    Ok(repos_dir(app)?
        .join(slugify_project_path(source_id))
        .join(project_dir_name(project_path)))
}

fn project_dir_name(project_path: &str) -> String {
    // FNV-1a: stable across restarts and Rust versions, unlike `DefaultHasher`.
    let hash = project_path
        .bytes()
        .fold(0xcbf29ce484222325u64, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3));
    format!("{}-{:08x}", slugify_project_path(project_path), hash as u32)
}

/// Turns a project path like "group/subgroup/project" into a filesystem-safe
/// directory name, since a single path segment can't contain `/`.
pub fn slugify_project_path(project_path: &str) -> String {
    project_path
        .trim_matches('/')
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect()
}

/// Clones `project_url` into `local_path` if it doesn't exist yet, otherwise
/// fetches the latest refs into the existing clone. `token`, if given, is
/// passed to git via env (see `token_auth_env`) and never logged or persisted.
pub async fn ensure_clone(project_url: &str, local_path: &Path, token: Option<&str>) -> Result<(), String> {
    let env = token.map(token_auth_env).unwrap_or_default();
    if local_path.join(".git").exists() {
        log::info!("repo already cloned at {}; fetching latest", local_path.display());
        run_git_env(local_path, &["fetch", "--all", "--prune", "--no-recurse-submodules"], &env)
            .await
            .map(|_| ())
    } else {
        log::info!("cloning into {}", local_path.display());
        let parent = local_path
            .parent()
            .ok_or_else(|| "local_path has no parent directory".to_string())?;
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("could not create {}: {err}", parent.display()))?;
        let path_str = local_path
            .to_str()
            .ok_or_else(|| "local_path is not valid UTF-8".to_string())?;
        run_git_env(parent, &["clone", "--", project_url, path_str], &env)
            .await
            .map(|_| ())
    }
}

/// Normalizes a remote URL to `host/path` (no scheme, credentials, port or `.git`)
/// so HTTPS and SSH spellings of the same project compare equal.
fn normalize_remote(url: &str) -> Option<String> {
    let url = url.trim();
    let (host, path) = if let Some((_, rest)) = url.split_once("://") {
        let (authority, path) = rest.split_once('/')?;
        let host = authority.rsplit('@').next()?.split(':').next()?;
        (host, path)
    } else {
        // scp-like: [user@]host:path
        let (authority, path) = url.split_once(':')?;
        (authority.rsplit('@').next()?, path)
    };
    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    Some(format!("{}/{}", host.to_lowercase(), path.to_lowercase()))
}

fn same_remote(a: &str, b: &str) -> bool {
    match (normalize_remote(a), normalize_remote(b)) {
        (Some(a), Some(b)) => a == b,
        // Not URL-shaped (e.g. a local path): compare as written.
        _ => a.trim() == b.trim(),
    }
}

/// Validates a user-provided local checkout and fetches `origin` so
/// `origin/<base>` is current. `origin` must be the project the run is for
/// (`expected_url`): otherwise the worktree would be cut from, and later pushed
/// to, the wrong repository, and the token would go to the wrong host. The
/// working tree and local branches are untouched; fetching updates
/// remote-tracking refs (pruning stale ones).
pub async fn prepare_local_repo(local_path: &Path, expected_url: &str, token: Option<&str>) -> Result<(), String> {
    if !local_path.is_absolute() {
        return Err(format!("local folder {} must be an absolute path", local_path.display()));
    }
    if !local_path.is_dir() {
        return Err(format!("local folder {} does not exist", local_path.display()));
    }
    run_git_env(local_path, &["rev-parse", "--git-dir"], &[])
        .await
        .map_err(|_| format!("{} is not a git repository", local_path.display()))?;

    let origin = run_git_env(local_path, &["remote", "get-url", "origin"], &[])
        .await
        .map_err(|_| format!("{} has no remote named origin", local_path.display()))?;
    if !same_remote(&origin, expected_url) {
        return Err(format!(
            "the origin of {} ({}) is not this project ({}); point the local folder at a checkout of it",
            local_path.display(),
            super::redact_credentials(origin.trim()),
            super::redact_credentials(expected_url),
        ));
    }

    let env = token.map(token_auth_env).unwrap_or_default();
    log::info!("fetching origin in local repo {}", local_path.display());
    run_git_env(local_path, &["fetch", "origin", "--prune", "--no-recurse-submodules"], &env)
        .await
        .map(|_| ())
}

/// Pushes `branch` to `origin` from the run's worktree, setting it as upstream.
/// The error carries git's stderr (protected branch, rejected, auth, ...).
/// `token` is passed via env like for clone/fetch, so SSH remotes keep using
/// the user's own keys.
pub async fn push_branch(work_dir: &Path, branch: &str, token: Option<&str>) -> Result<(), String> {
    let env = token.map(token_auth_env).unwrap_or_default();
    log::info!("pushing branch {branch} from {}", work_dir.display());
    run_git_env(work_dir, &["push", "--set-upstream", "--", "origin", branch], &env)
        .await
        .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command as StdCommand;

    fn init_bare_origin(dir: &Path) {
        let status = StdCommand::new("git")
            .args(["init", "--bare", "-q"])
            .arg(dir)
            .status()
            .expect("failed to run git init");
        assert!(status.success());
    }

    #[test]
    fn slugify_replaces_unsafe_characters() {
        assert_eq!(slugify_project_path("group/sub group/project"), "group-sub-group-project");
    }

    #[test]
    fn slugify_trims_leading_and_trailing_slashes() {
        assert_eq!(slugify_project_path("/group/project/"), "group-project");
    }

    #[tokio::test]
    async fn clones_when_missing_then_fetches_when_present() {
        let tmp = tempfile::tempdir().unwrap();
        let origin = tmp.path().join("origin.git");
        init_bare_origin(&origin);

        let local_path = tmp.path().join("clone");
        ensure_clone(origin.to_str().unwrap(), &local_path, None)
            .await
            .expect("clone should succeed");
        assert!(local_path.join(".git").exists());

        // Second call hits the fetch branch instead of re-cloning.
        ensure_clone(origin.to_str().unwrap(), &local_path, None)
            .await
            .expect("fetch should succeed");
    }

    #[tokio::test]
    async fn pushes_a_branch_to_origin() {
        let tmp = tempfile::tempdir().unwrap();
        let origin = tmp.path().join("origin.git");
        init_bare_origin(&origin);
        let clone = tmp.path().join("clone");
        ensure_clone(origin.to_str().unwrap(), &clone, None).await.unwrap();

        let git = |args: &[&str]| {
            let status = StdCommand::new("git").current_dir(&clone).args(args).status().unwrap();
            assert!(status.success(), "git {args:?} failed");
        };
        git(&["config", "user.email", "test@example.com"]);
        git(&["config", "user.name", "Test"]);
        git(&["checkout", "-q", "-b", "feature"]);
        std::fs::write(clone.join("a.txt"), "x\n").unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-q", "-m", "work"]);

        push_branch(&clone, "feature", None).await.expect("push should succeed");

        let listed = StdCommand::new("git")
            .arg("--git-dir")
            .arg(&origin)
            .args(["branch", "--list", "feature"])
            .output()
            .unwrap();
        assert!(!String::from_utf8_lossy(&listed.stdout).trim().is_empty());
    }

    #[tokio::test]
    async fn push_errors_surface_git_stderr() {
        let tmp = tempfile::tempdir().unwrap();
        let err = push_branch(tmp.path(), "feature", None).await.unwrap_err();
        assert!(err.contains("git push failed"));
    }

    #[tokio::test]
    async fn prepares_an_existing_local_clone() {
        let tmp = tempfile::tempdir().unwrap();
        let origin = tmp.path().join("origin.git");
        init_bare_origin(&origin);
        let local_path = tmp.path().join("clone");
        ensure_clone(origin.to_str().unwrap(), &local_path, None).await.unwrap();

        prepare_local_repo(&local_path, origin.to_str().unwrap(), None)
            .await
            .expect("valid clone should prepare");
    }

    #[tokio::test]
    async fn refuses_a_local_clone_of_a_different_project() {
        let tmp = tempfile::tempdir().unwrap();
        let origin = tmp.path().join("origin.git");
        init_bare_origin(&origin);
        let local_path = tmp.path().join("clone");
        ensure_clone(origin.to_str().unwrap(), &local_path, None).await.unwrap();

        let err = prepare_local_repo(&local_path, "https://gitlab.example.com/acme/other.git", Some("secret-token"))
            .await
            .unwrap_err();
        assert!(err.contains("is not this project"));
        assert!(!err.contains("secret-token"));
    }

    #[test]
    fn https_and_ssh_spellings_of_a_project_match() {
        let with_userinfo = format!("https://{}:{}@gitlab.com/acme/app.git", "user", "pw");
        assert!(same_remote("git@gitlab.com:Acme/App.git", &with_userinfo));
        assert!(same_remote("ssh://git@gitlab.com:2222/acme/app", "https://gitlab.com/acme/app/"));
        assert!(!same_remote("https://github.com/acme/app.git", "https://gitlab.com/acme/app.git"));
        assert!(!same_remote("https://gitlab.com/acme/app.git", "https://gitlab.com/acme/other.git"));
        assert!(same_remote("/tmp/origin.git", "/tmp/origin.git"));
    }

    #[test]
    fn managed_clone_names_are_distinct_for_colliding_slugs() {
        assert_ne!(project_dir_name("a/b-c"), project_dir_name("a-b/c"));
        assert_eq!(project_dir_name("a/b"), project_dir_name("a/b"));
        assert!(project_dir_name("a/b").starts_with("a-b-"));
    }

    #[tokio::test]
    async fn rejects_invalid_local_folders() {
        let tmp = tempfile::tempdir().unwrap();

        let relative = prepare_local_repo(Path::new("relative/dir"), "u", None).await.unwrap_err();
        assert!(relative.contains("absolute"));

        let missing = prepare_local_repo(&tmp.path().join("missing"), "u", None).await.unwrap_err();
        assert!(missing.contains("does not exist"));

        let not_git = prepare_local_repo(tmp.path(), "u", None).await.unwrap_err();
        assert!(not_git.contains("not a git repository"));
    }

    #[tokio::test]
    async fn surfaces_git_stderr_on_failure() {
        let tmp = tempfile::tempdir().unwrap();
        let local_path = tmp.path().join("clone");

        let err = ensure_clone("/nonexistent/origin.git", &local_path, None)
            .await
            .expect_err("cloning a nonexistent origin should fail");
        assert!(err.contains("git clone failed"));
    }
}
