//! Thin wrappers around the system `git` CLI used by the run pipeline.

use std::path::Path;
use std::time::Duration;

pub mod commit;
pub mod diff;
pub mod inplace;
pub mod locks;
pub mod repo;
pub mod worktree;

/// Upper bound for any single git command, so a stalled network, a signing
/// prompt or an SSH passphrase prompt can't hang a run (and its slot) forever.
const GIT_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// Runs `git <args>` in `cwd`, never logging the args themselves — only the
/// subcommand name and cwd.
pub(crate) async fn run_git(cwd: &Path, args: &[&str]) -> Result<(), String> {
    run_git_output(cwd, args).await.map(|_| ())
}

/// Like `run_git`, but returns the command's stdout.
pub(crate) async fn run_git_output(cwd: &Path, args: &[&str]) -> Result<String, String> {
    run_git_env(cwd, args, &[]).await
}

/// The commit `rev` points to, as a full SHA.
pub async fn rev_parse(cwd: &Path, rev: &str) -> Result<String, String> {
    let target = format!("{rev}^{{commit}}");
    let sha = run_git_output(cwd, &["rev-parse", "--verify", "--end-of-options", &target]).await?;
    Ok(sha.trim().to_string())
}

/// Masks `user:password@` in any `scheme://` URL, for messages that may be
/// logged, stored or shown to the user.
pub(crate) fn redact_credentials(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(pos) = rest.find("://") {
        let (head, tail) = rest.split_at(pos + 3);
        out.push_str(head);
        let end = tail
            .find(|c: char| c == '/' || c == '\'' || c == '"' || c.is_whitespace())
            .unwrap_or(tail.len());
        let authority = &tail[..end];
        match authority.rfind('@') {
            Some(at) => {
                out.push_str("***");
                out.push_str(&authority[at..]);
            }
            None => out.push_str(authority),
        }
        rest = &tail[end..];
    }
    out.push_str(rest);
    out
}

/// Env vars that make git send `token` as HTTP basic auth for this process
/// only, so the token is never written to `.git/config` or the command line.
pub(crate) fn token_auth_env(token: &str) -> Vec<(String, String)> {
    use base64::Engine;
    let basic = base64::engine::general_purpose::STANDARD.encode(format!("oauth2:{token}"));
    vec![
        ("GIT_TERMINAL_PROMPT".into(), "0".into()),
        ("GIT_CONFIG_COUNT".into(), "1".into()),
        ("GIT_CONFIG_KEY_0".into(), "http.extraHeader".into()),
        ("GIT_CONFIG_VALUE_0".into(), format!("Authorization: Basic {basic}")),
    ]
}

pub(crate) async fn run_git_env(cwd: &Path, args: &[&str], env: &[(String, String)]) -> Result<String, String> {
    let subcommand = args.first().copied().unwrap_or("");
    log::debug!("running git {subcommand} in {}", cwd.display());

    let command = tokio::process::Command::new("git")
        .current_dir(cwd)
        .args(args)
        // Automated runs can't answer prompts; fail instead of waiting.
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .envs(env.iter().map(|(k, v)| (k, v)))
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .output();
    let output = tokio::time::timeout(GIT_TIMEOUT, command)
        .await
        .map_err(|_| format!("git {subcommand} timed out after {} minutes", GIT_TIMEOUT.as_secs() / 60))?
        .map_err(|err| format!("could not run git {subcommand}: {err}"))?;

    if !output.status.success() {
        let stderr = redact_credentials(String::from_utf8_lossy(&output.stderr).trim());
        log::warn!("git {subcommand} failed in {}: {stderr}", cwd.display());
        return Err(format!("git {subcommand} failed: {stderr}"));
    }

    log::debug!("git {subcommand} succeeded in {}", cwd.display());
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Picks the branch a run starts from: `preferred` if `origin/<preferred>`
/// exists, else `fallback`. Returns the branch name, its `origin/` ref and the
/// commit it points at (pinned, because later fetches move the ref).
pub async fn resolve_base(repo: &Path, preferred: &str, fallback: &str) -> Result<(String, String, String), String> {
    let mut candidates = vec![preferred];
    if fallback != preferred {
        candidates.push(fallback);
    }
    for name in &candidates {
        let base_ref = format!("origin/{name}");
        if let Ok(commit) = rev_parse(repo, &base_ref).await {
            if *name != preferred {
                log::warn!("origin/{preferred} doesn't exist; starting from origin/{name} instead");
            }
            return Ok((name.to_string(), base_ref, commit));
        }
    }
    Err(format!("none of origin/{} exists", candidates.join(", origin/")))
}

/// Stages everything in the worktree (including new files) and returns the
/// diff against `base`, so reviewers see the run's full change set even
/// when an earlier attempt was already committed.
pub async fn staged_diff(work_dir: &Path, base: &str) -> Result<String, String> {
    run_git(work_dir, &["add", "-A"]).await?;
    run_git_output(work_dir, &["diff", "--cached", base]).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_userinfo_in_urls() {
        // Built at runtime so secret scanners don't flag a credentialed URL literal.
        let url = format!("https://{}:{}@gitlab.com/a/b.git/", "user", "pw");
        assert_eq!(
            redact_credentials(&format!("fatal: unable to access '{url}': 403")),
            "fatal: unable to access 'https://***@gitlab.com/a/b.git/': 403"
        );
        assert_eq!(
            redact_credentials("clone https://user@host/x and https://h/y"),
            "clone https://***@host/x and https://h/y"
        );
    }

    #[test]
    fn leaves_other_text_alone() {
        let text = "git@github.com: Permission denied (publickey). see https://docs.example.com/ssh";
        assert_eq!(redact_credentials(text), text);
    }

    #[tokio::test]
    async fn rev_parse_resolves_refs_and_rejects_unknown_ones() {
        let tmp = tempfile::tempdir().unwrap();
        let run = |args: &[&str]| {
            let status = std::process::Command::new("git")
                .current_dir(tmp.path())
                .args(args)
                .status()
                .unwrap();
            assert!(status.success());
        };
        run(&["init", "-q", "-b", "main"]);
        run(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "i"]);

        let sha = rev_parse(tmp.path(), "main").await.unwrap();
        assert_eq!(sha.len(), 40);
        assert_eq!(rev_parse(tmp.path(), "HEAD").await.unwrap(), sha);
        assert!(rev_parse(tmp.path(), "nope").await.is_err());
    }

    #[tokio::test]
    async fn resolve_base_prefers_the_configured_branch_and_falls_back() {
        let tmp = tempfile::tempdir().unwrap();
        let git = |args: &[&str]| {
            let status = std::process::Command::new("git")
                .current_dir(tmp.path())
                .args(args)
                .status()
                .unwrap();
            assert!(status.success());
        };
        git(&["init", "-q", "-b", "main"]);
        git(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "i"]);
        git(&["update-ref", "refs/remotes/origin/main", "HEAD"]);

        let (name, base_ref, commit) = resolve_base(tmp.path(), "dev", "main").await.unwrap();
        assert_eq!((name.as_str(), base_ref.as_str()), ("main", "origin/main"));
        assert_eq!(commit.len(), 40);

        git(&["update-ref", "refs/remotes/origin/dev", "HEAD"]);
        let (name, base_ref, _) = resolve_base(tmp.path(), "dev", "main").await.unwrap();
        assert_eq!((name.as_str(), base_ref.as_str()), ("dev", "origin/dev"));

        assert!(resolve_base(tmp.path(), "x", "y").await.is_err());
    }
}
