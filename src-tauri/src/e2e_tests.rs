//! End-to-end runs of the pipeline against throwaway git repos and fake agent
//! scripts, on Tauri's mock runtime (no window, no network).

use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
use tauri::Manager;

use crate::config::AppConfig;
use crate::git::inplace::undo_run;
use crate::run::limiter::RunLimiter;
use crate::run::pipeline::{enter, execute_redo, execute_run, request_cancel, RunInput};
use crate::run::{NewRun, RunRecord, RunStatus, RunStore};

const RUN_ID: &str = "1-1-100";

struct Env {
    _tmp: tempfile::TempDir,
    origin: PathBuf,
    work: PathBuf,
    scripts: PathBuf,
    app: tauri::App<MockRuntime>,
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").current_dir(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn script(dir: &Path, name: &str, body: &str) -> String {
    let path = dir.join(name);
    std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    format!("sh {} {{prompt_file}}", path.display())
}

/// A bare origin with `main` and `dev`, and the user's clone checked out on `main`.
fn setup() -> Env {
    let tmp = tempfile::tempdir().unwrap();
    let origin = tmp.path().join("origin.git");
    let work = tmp.path().join("work");
    let scripts = tmp.path().join("scripts");
    std::fs::create_dir_all(&scripts).unwrap();
    git(tmp.path(), &["init", "-q", "--bare", "-b", "main", origin.to_str().unwrap()]);
    git(tmp.path(), &["clone", "-q", origin.to_str().unwrap(), work.to_str().unwrap()]);
    git(&work, &["config", "user.email", "test@example.com"]);
    git(&work, &["config", "user.name", "Test"]);
    std::fs::write(work.join("README.md"), "hello\n").unwrap();
    git(&work, &["add", "-A"]);
    git(&work, &["commit", "-q", "-m", "initial"]);
    git(&work, &["push", "-q", "-u", "origin", "main"]);
    git(&work, &["checkout", "-q", "-b", "dev"]);
    std::fs::write(work.join("dev.txt"), "dev\n").unwrap();
    git(&work, &["add", "-A"]);
    git(&work, &["commit", "-q", "-m", "dev work"]);
    git(&work, &["push", "-q", "origin", "dev"]);
    git(&work, &["checkout", "-q", "main"]);

    let app = mock_builder()
        .plugin(tauri_plugin_notification::init())
        .build(mock_context(noop_assets()))
        .expect("mock app");
    app.manage(RunStore::default());
    app.manage(RunLimiter::default());
    app.manage(crate::run::limiter::ProjectGate::default());
    app.manage(crate::git::locks::RepoLocks::default());
    app.manage(crate::agent::runner::ProcessRegistry::default());
    app.manage(crate::agent::runner::OutputBuffer::default());
    Env { _tmp: tmp, origin, work, scripts, app }
}

impl Env {
    fn config(&self, worker: &str) -> AppConfig {
        let mut config = AppConfig::default();
        config.agent.worker_cmd = worker.to_string();
        config.agent.reviewer_cmd = script(&self.scripts, "reviewer.sh", "echo 'looks fine'");
        config.agent.plan_cmd = script(&self.scripts, "plan.sh", "echo '1. edit the file'");
        config.local_repos.insert("group/proj".to_string(), self.work.display().to_string());
        config
    }

    fn good_worker(&self) -> String {
        script(
            &self.scripts,
            "worker.sh",
            "echo 'agent change' >> agent_output.txt\necho '- changed agent_output.txt'",
        )
    }

    fn input(&self, plan_only: bool) -> RunInput {
        RunInput {
            run_id: RUN_ID.to_string(),
            source_id: "s".to_string(),
            project_url: self.origin.display().to_string(),
            token: "t".to_string(),
            project_path: "group/proj".to_string(),
            base_branch: "dev".to_string(),
            fallback_branch: "main".to_string(),
            issue_iid: "1".to_string(),
            issue_ref: "group/proj#1".to_string(),
            title: "Add thing".to_string(),
            description: "do it".to_string(),
            labels: Vec::new(),
            feedback: None,
            branch_override: None,
            plan: None,
            plan_only,
        }
    }

    fn store(&self) -> tauri::State<'_, RunStore> {
        self.app.state::<RunStore>()
    }

    /// Registers the run record the way `start_run` does, then runs the pipeline.
    async fn run(&self, config: &AppConfig, plan_only: bool) -> RunRecord {
        self.store().create_for_task(NewRun {
            run_id: RUN_ID,
            task_id: "1-1",
            task_title: "Add thing",
            source_id: "s",
            project: "group/proj",
            plan_only,
            ..NewRun::default()
        });
        execute_run(self.app.handle(), config, self.input(plan_only)).await;
        self.store().get(RUN_ID).unwrap()
    }

    fn head(&self) -> String {
        git(&self.work, &["rev-parse", "--abbrev-ref", "HEAD"])
    }

    fn branches(&self) -> String {
        git(&self.work, &["branch", "--format=%(refname:short)"])
    }
}

#[tokio::test]
async fn a_run_ends_awaiting_approval_on_a_typed_branch_with_one_commit() {
    let env = setup();
    let record = env.run(&env.config(&env.good_worker()), false).await;

    assert_eq!(record.status, RunStatus::AwaitingApproval, "{:?}", record.error);
    assert_eq!(record.branch.as_deref(), Some("feat/1-add-thing"));
    assert_eq!(record.base_branch, "dev");
    assert_eq!(env.head(), "feat/1-add-thing");
    assert_eq!(git(&env.work, &["rev-list", "--count", "origin/dev..HEAD"]), "1");
    assert_eq!(git(&env.work, &["log", "-1", "--format=%s"]), "feat: Add thing");
    assert!(env.work.join("agent_output.txt").exists());
    assert!(env.work.join("dev.txt").exists(), "the branch starts from dev");
    assert_eq!(git(&env.work, &["status", "--porcelain"]), "");
    assert_eq!(record.worker_summary.as_deref(), Some("- changed agent_output.txt"));
    assert_eq!(record.review_notes.as_deref(), Some("looks fine"));
}

#[tokio::test]
async fn usage_printed_by_the_agents_is_recorded_when_a_regex_is_set() {
    let env = setup();
    let worker = script(
        &env.scripts,
        "usage_worker.sh",
        "echo 'agent change' >> agent_output.txt\necho '- changed'\necho 'cost: $0.42' >&2",
    );
    let mut config = env.config(&worker);
    config.agent.usage_regex = r"cost: \$([0-9.]+)".to_string();
    let record = env.run(&config, false).await;

    assert_eq!(record.status, RunStatus::AwaitingApproval, "{:?}", record.error);
    assert_eq!(record.usage, vec!["worker: 0.42".to_string()]);

    let plain = setup();
    let record = plain.run(&plain.config(&plain.good_worker()), false).await;
    assert!(record.usage.is_empty());
}

#[tokio::test]
async fn uncommitted_changes_are_stashed_for_the_run_and_restored_on_discard() {
    let env = setup();
    std::fs::write(env.work.join("README.md"), "mine\n").unwrap();
    std::fs::write(env.work.join("scratch.txt"), "notes\n").unwrap();

    let record = env.run(&env.config(&env.good_worker()), false).await;
    assert_eq!(record.status, RunStatus::AwaitingApproval, "{:?}", record.error);
    assert!(record.stash_commit.is_some());
    assert!(!env.work.join("scratch.txt").exists(), "stashed away while the run is on its branch");

    let note = undo_run(
        record.repo_path.as_deref().unwrap(),
        record.branch.as_deref(),
        record.original_ref.as_deref(),
        record.stash_commit.as_deref(),
    )
    .await
    .unwrap();
    assert_eq!(note, None);
    assert_eq!(env.head(), "main");
    assert_eq!(env.branches(), "dev\nmain");
    assert_eq!(std::fs::read_to_string(env.work.join("README.md")).unwrap(), "mine\n");
    assert_eq!(std::fs::read_to_string(env.work.join("scratch.txt")).unwrap(), "notes\n");
    assert!(!env.work.join("agent_output.txt").exists());
}

#[tokio::test]
async fn a_failing_worker_leaves_the_folder_as_it_was() {
    let env = setup();
    std::fs::write(env.work.join("README.md"), "mine\n").unwrap();

    let record = env.run(&env.config("sh -c \"exit 3\""), false).await;

    assert_eq!(record.status, RunStatus::Failed);
    assert!(record.error.is_some());
    assert_eq!(env.head(), "main");
    assert_eq!(env.branches(), "dev\nmain");
    assert_eq!(std::fs::read_to_string(env.work.join("README.md")).unwrap(), "mine\n");
}

#[tokio::test]
async fn a_worker_that_changes_nothing_fails_the_run_cleanly() {
    let env = setup();
    let record = env.run(&env.config(&script(&env.scripts, "idle.sh", "echo done")), false).await;

    assert_eq!(record.status, RunStatus::Failed);
    assert!(record.error.unwrap().contains("no changes"));
    assert_eq!(env.head(), "main");
    assert_eq!(env.branches(), "dev\nmain");
}

#[tokio::test]
async fn a_missing_base_branch_falls_back_to_the_project_default() {
    let env = setup();
    let mut input = env.input(false);
    input.base_branch = "nope".to_string();
    env.store().create_for_task(NewRun {
        run_id: RUN_ID,
        task_id: "1-1",
        source_id: "s",
        project: "group/proj",
        ..NewRun::default()
    });
    execute_run(env.app.handle(), &env.config(&env.good_worker()), input).await;

    let record = env.store().get(RUN_ID).unwrap();
    assert_eq!(record.status, RunStatus::AwaitingApproval, "{:?}", record.error);
    assert_eq!(record.base_branch, "main");
    assert!(!env.work.join("dev.txt").exists(), "cut from main, not dev");
}

#[tokio::test]
async fn an_existing_branch_name_is_reported_as_a_conflict() {
    let env = setup();
    git(&env.work, &["branch", "feat/1-add-thing"]);

    let record = env.run(&env.config(&env.good_worker()), false).await;

    assert_eq!(record.status, RunStatus::Failed);
    let conflict = record.branch_conflict.expect("conflict recorded");
    assert_eq!(conflict.branch, "feat/1-add-thing");
    assert_eq!(conflict.suggestion, "feat/1-add-thing-2");
    assert_eq!(env.head(), "main");
    assert!(env.branches().contains("feat/1-add-thing"), "the user's branch is left alone");
}

#[tokio::test]
async fn a_repo_in_the_middle_of_a_merge_is_not_touched() {
    let env = setup();
    std::fs::write(env.work.join(".git/MERGE_HEAD"), "abc\n").unwrap();

    let record = env.run(&env.config(&env.good_worker()), false).await;

    assert_eq!(record.status, RunStatus::Failed);
    assert!(record.error.unwrap().contains("merge in progress"));
    assert_eq!(env.head(), "main");
    assert_eq!(env.branches(), "dev\nmain");
}

#[tokio::test]
async fn a_failed_redo_restores_the_earlier_commit() {
    let env = setup();
    let record = env.run(&env.config(&env.good_worker()), false).await;
    assert_eq!(record.status, RunStatus::AwaitingApproval, "{:?}", record.error);
    let good_commit = git(&env.work, &["rev-parse", "HEAD"]);
    assert_eq!(record.commit_sha.as_deref(), Some(good_commit.as_str()));

    enter(env.app.handle(), RUN_ID, RunStatus::Queued, None).unwrap();
    execute_redo(env.app.handle(), &env.config("sh -c \"exit 3\""), RUN_ID.to_string(), "again".to_string()).await;

    let record = env.store().get(RUN_ID).unwrap();
    assert_eq!(record.status, RunStatus::AwaitingApproval);
    assert!(record.redo_error.is_some());
    assert_eq!(git(&env.work, &["rev-parse", "HEAD"]), good_commit);
    assert_eq!(git(&env.work, &["status", "--porcelain"]), "");
}

#[tokio::test]
async fn a_redo_replaces_the_commit_with_a_new_one() {
    let env = setup();
    let record = env.run(&env.config(&env.good_worker()), false).await;
    assert_eq!(record.status, RunStatus::AwaitingApproval, "{:?}", record.error);
    let first_commit = record.commit_sha.clone().unwrap();

    enter(env.app.handle(), RUN_ID, RunStatus::Queued, None).unwrap();
    execute_redo(env.app.handle(), &env.config(&env.good_worker()), RUN_ID.to_string(), "again".to_string()).await;

    let record = env.store().get(RUN_ID).unwrap();
    assert_eq!(record.status, RunStatus::AwaitingApproval, "{:?}", record.redo_error);
    assert_eq!(record.previous_commit_sha.as_deref(), Some(first_commit.as_str()));
    assert_ne!(record.commit_sha.as_deref(), Some(first_commit.as_str()));
    let changed = crate::git::diff::redo_diff(&env.work, &first_commit, record.commit_sha.as_deref().unwrap())
        .await
        .unwrap();
    assert_eq!(changed.len(), 1, "only the redo's own change differs");
    assert_eq!(git(&env.work, &["rev-list", "--count", "origin/dev..HEAD"]), "1");
    assert_eq!(std::fs::read_to_string(env.work.join("agent_output.txt")).unwrap().lines().count(), 2);
}

#[tokio::test]
async fn a_plan_run_reads_the_folder_without_touching_git() {
    let env = setup();
    std::fs::write(env.work.join("README.md"), "mine\n").unwrap();

    let record = env.run(&env.config(&env.good_worker()), true).await;

    assert_eq!(record.status, RunStatus::Planned, "{:?}", record.error);
    assert_eq!(record.worker_summary.as_deref(), Some("1. edit the file"));
    assert!(record.branch.is_none() && record.stash_commit.is_none());
    assert_eq!(env.head(), "main");
    assert_eq!(std::fs::read_to_string(env.work.join("README.md")).unwrap(), "mine\n");
}

#[tokio::test]
async fn a_plan_run_that_changes_files_fails() {
    let env = setup();
    let mut config = env.config(&env.good_worker());
    config.agent.plan_cmd = script(&env.scripts, "bad_plan.sh", "echo oops >> README.md\necho plan");

    let record = env.run(&config, true).await;

    assert_eq!(record.status, RunStatus::Failed);
    assert!(record.error.unwrap().contains("plan command changed files"));
}

/// Cancels the run once it has left `queued`.
async fn cancel_when_started(env: &Env) {
    for _ in 0..200 {
        if env.store().get(RUN_ID).is_some_and(|run| run.status != RunStatus::Queued) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    request_cancel(env.app.handle(), RUN_ID).unwrap();
}

#[tokio::test]
async fn cancelling_a_running_worker_undoes_the_run() {
    let env = setup();
    std::fs::write(env.work.join("README.md"), "mine\n").unwrap();
    let config = env.config(&script(&env.scripts, "slow.sh", "sleep 30"));

    let started = std::time::Instant::now();
    let (record, ()) = tokio::join!(env.run(&config, false), cancel_when_started(&env));

    assert_eq!(record.status, RunStatus::Cancelled, "{:?}", record.error);
    assert!(started.elapsed().as_secs() < 20, "the agent should have been killed");
    assert_eq!(env.head(), "main");
    assert_eq!(env.branches(), "dev\nmain");
    assert_eq!(std::fs::read_to_string(env.work.join("README.md")).unwrap(), "mine\n");
}

#[tokio::test]
async fn a_run_cancelled_while_queued_never_touches_git() {
    let env = setup();
    env.store().create_for_task(NewRun {
        run_id: RUN_ID,
        task_id: "1-1",
        source_id: "s",
        project: "group/proj",
        ..NewRun::default()
    });

    request_cancel(env.app.handle(), RUN_ID).unwrap();
    assert_eq!(env.store().get(RUN_ID).unwrap().status, RunStatus::Cancelled);

    execute_run(env.app.handle(), &env.config(&env.good_worker()), env.input(false)).await;

    assert_eq!(env.store().get(RUN_ID).unwrap().status, RunStatus::Cancelled);
    assert_eq!(env.head(), "main");
    assert_eq!(env.branches(), "dev\nmain");
    assert!(request_cancel(env.app.handle(), RUN_ID).is_err(), "finished runs can't be cancelled");
}

#[tokio::test]
async fn cancelling_a_redo_keeps_the_earlier_result() {
    let env = setup();
    let record = env.run(&env.config(&env.good_worker()), false).await;
    assert_eq!(record.status, RunStatus::AwaitingApproval, "{:?}", record.error);
    let good_commit = git(&env.work, &["rev-parse", "HEAD"]);

    enter(env.app.handle(), RUN_ID, RunStatus::Queued, None).unwrap();
    let slow = env.config(&script(&env.scripts, "slow.sh", "sleep 30"));
    let redo = execute_redo(env.app.handle(), &slow, RUN_ID.to_string(), "again".to_string());
    let ((), ()) = tokio::join!(redo, cancel_when_started(&env));

    let record = env.store().get(RUN_ID).unwrap();
    assert_eq!(record.status, RunStatus::AwaitingApproval);
    assert_eq!(record.redo_error.as_deref(), Some("cancelled by you"));
    assert_eq!(git(&env.work, &["rev-parse", "HEAD"]), good_commit);
    assert_eq!(git(&env.work, &["status", "--porcelain"]), "");
}

#[tokio::test]
async fn a_second_run_in_the_same_project_waits_for_the_first() {
    let env = setup();
    let config = env.config(&env.good_worker());
    let second_id = "1-2-200";
    let register = |run_id: &str, task_id: &str, title: &str| {
        env.store().create_for_task(NewRun {
            run_id,
            task_id,
            task_title: title,
            source_id: "s",
            project: "group/proj",
            ..NewRun::default()
        });
    };
    register(RUN_ID, "1-1", "Add thing");
    register(second_id, "1-2", "Second thing");

    let mut second_input = env.input(false);
    second_input.run_id = second_id.to_string();
    second_input.issue_iid = "2".to_string();
    second_input.issue_ref = "group/proj#2".to_string();
    second_input.title = "Second thing".to_string();

    let first = execute_run(env.app.handle(), &config, env.input(false));
    let second = execute_run(env.app.handle(), &config, second_input);
    let driver = async {
        for _ in 0..400 {
            if env.store().get(RUN_ID).unwrap().status == RunStatus::AwaitingApproval {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let waiting = env.store().get(second_id).unwrap();
        assert_eq!(waiting.status, RunStatus::Queued, "waits while the first is awaiting approval");
        assert_eq!(waiting.blocked_by.as_deref(), Some("Add thing"));

        // What discarding the first run does.
        let first = env.store().get(RUN_ID).unwrap();
        undo_run(
            first.repo_path.as_deref().unwrap(),
            first.branch.as_deref(),
            first.original_ref.as_deref(),
            first.stash_commit.as_deref(),
        )
        .await
        .unwrap();
        enter(env.app.handle(), RUN_ID, RunStatus::Discarded, None).unwrap();
    };
    tokio::join!(first, second, driver);

    let second = env.store().get(second_id).unwrap();
    assert_eq!(second.status, RunStatus::AwaitingApproval, "{:?}", second.error);
    assert_eq!(second.blocked_by, None);
    assert_eq!(env.head(), "feat/2-second-thing");
}

#[tokio::test]
async fn cancelling_a_waiting_run_releases_it_without_running() {
    let env = setup();
    let config = env.config(&env.good_worker());
    let second_id = "1-2-200";
    for (run_id, task_id, title) in [(RUN_ID, "1-1", "Add thing"), (second_id, "1-2", "Second thing")] {
        env.store().create_for_task(NewRun {
            run_id,
            task_id,
            task_title: title,
            source_id: "s",
            project: "group/proj",
            ..NewRun::default()
        });
    }
    // The first run stays unfinished, so the second one waits behind it.
    let mut input = env.input(false);
    input.run_id = second_id.to_string();

    let second = execute_run(env.app.handle(), &config, input);
    let driver = async {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert_eq!(env.store().get(second_id).unwrap().status, RunStatus::Queued);
        request_cancel(env.app.handle(), second_id).unwrap();
    };
    tokio::join!(second, driver);

    assert_eq!(env.store().get(second_id).unwrap().status, RunStatus::Cancelled);
    assert_eq!(env.head(), "main");
    assert_eq!(env.branches(), "dev\nmain");
}

fn fixing_worker(env: &Env) -> String {
    script(
        &env.scripts,
        "fixing_worker.sh",
        "echo 'agent change' >> agent_output.txt\nif grep -q 'tests failed' \"$1\"; then echo fixed > fix.txt; fi\necho '- done'",
    )
}

#[tokio::test]
async fn failing_tests_send_the_worker_back_to_fix_them() {
    let env = setup();
    let mut config = env.config(&fixing_worker(&env));
    config.test_cmd = "sh -c \"test -f fix.txt\"".to_string();
    config.auto_fix_attempts = 2;

    let record = env.run(&config, false).await;

    assert_eq!(record.status, RunStatus::AwaitingApproval, "{:?}", record.error);
    assert_eq!(record.fix_attempts, 1);
    assert!(record.test_result.as_ref().is_some_and(|t| t.passed));
    assert!(env.work.join("fix.txt").exists());
    assert_eq!(git(&env.work, &["rev-list", "--count", "origin/dev..HEAD"]), "1");
}

#[tokio::test]
async fn auto_fix_gives_up_after_its_attempts_and_the_run_still_reaches_review() {
    let env = setup();
    let mut config = env.config(&env.good_worker());
    config.test_cmd = "sh -c \"exit 1\"".to_string();
    config.auto_fix_attempts = 1;

    let record = env.run(&config, false).await;

    assert_eq!(record.status, RunStatus::AwaitingApproval, "{:?}", record.error);
    assert_eq!(record.fix_attempts, 1);
    assert!(record.test_result.as_ref().is_some_and(|t| !t.passed));
}

#[tokio::test]
async fn without_auto_fix_failing_tests_are_only_reported() {
    let env = setup();
    let mut config = env.config(&env.good_worker());
    config.test_cmd = "sh -c \"exit 1\"".to_string();

    let record = env.run(&config, false).await;

    assert_eq!(record.fix_attempts, 0);
    assert_eq!(std::fs::read_to_string(env.work.join("agent_output.txt")).unwrap().lines().count(), 1);
}

fn verdict_reviewer(env: &Env) -> String {
    let marker = env.scripts.join("seen");
    script(
        &env.scripts,
        "verdict_reviewer.sh",
        &format!(
            "if [ -f {m} ]; then echo 'all good'; echo 'VERDICT: approve'; else touch {m}; echo '- a bug'; echo 'VERDICT: changes'; fi",
            m = marker.display()
        ),
    )
}

#[tokio::test]
async fn the_verdict_is_recorded_without_its_line() {
    let env = setup();
    let mut config = env.config(&env.good_worker());
    config.agent.reviewer_cmd = verdict_reviewer(&env);
    config.reviewer_gate = crate::config::ReviewerGate::Off;

    let record = env.run(&config, false).await;

    assert_eq!(record.review_verdict.as_deref(), Some("changes"));
    assert_eq!(record.review_notes.as_deref(), Some("- a bug"));
}

#[tokio::test]
async fn the_reviewer_gate_can_redo_once_on_a_changes_verdict() {
    let env = setup();
    let mut config = env.config(&env.good_worker());
    config.agent.reviewer_cmd = verdict_reviewer(&env);
    assert_eq!(config.reviewer_gate, crate::config::ReviewerGate::AutoRedo, "redo is the default");

    let record = env.run(&config, false).await;

    assert_eq!(record.status, RunStatus::AwaitingApproval, "{:?}", record.error);
    assert_eq!(record.review_verdict.as_deref(), Some("approve"));
    assert_eq!(record.review_notes.as_deref(), Some("all good"));
    let output = std::fs::read_to_string(env.work.join("agent_output.txt")).unwrap();
    assert_eq!(output.lines().count(), 2, "the worker ran a second time");
    assert_eq!(git(&env.work, &["rev-list", "--count", "origin/dev..HEAD"]), "1");
}

#[tokio::test]
async fn a_system_prompt_file_fills_its_placeholder() {
    let env = setup();
    let prompt = env.scripts.join("system.md");
    std::fs::write(&prompt, "SYSTEM RULES").unwrap();
    let worker = script(&env.scripts, "system_worker.sh", "cat \"$2\" >> agent_output.txt\necho '- done'")
        .replace("{prompt_file}", "{prompt_file} {system_prompt}");
    let mut config = env.config(&worker);
    config.agent.worker_prompt_file = prompt.display().to_string();

    let record = env.run(&config, false).await;

    assert_eq!(record.status, RunStatus::AwaitingApproval, "{:?}", record.error);
    assert!(std::fs::read_to_string(env.work.join("agent_output.txt")).unwrap().contains("SYSTEM RULES"));
}

#[tokio::test]
async fn a_command_using_the_system_prompt_fails_clearly_when_none_is_set() {
    let env = setup();
    let worker = script(&env.scripts, "system_worker.sh", "echo hi").replace("{prompt_file}", "{system_prompt}");

    let record = env.run(&env.config(&worker), false).await;

    assert_eq!(record.status, RunStatus::Failed);
    assert!(record.error.unwrap().contains("{system_prompt}"));
    assert_eq!(env.head(), "main");
}

async fn approved_run(env: &Env) -> RunRecord {
    let record = env.run(&env.config(&env.good_worker()), false).await;
    assert_eq!(record.status, RunStatus::AwaitingApproval, "{:?}", record.error);
    record
}

#[tokio::test]
async fn the_description_command_writes_the_summary_and_checklist_once_per_commit() {
    let env = setup();
    let record = approved_run(&env).await;
    let mut config = env.config(&env.good_worker());
    config.agent.description_cmd = script(
        &env.scripts,
        "describe.sh",
        "printf '## Summary\\n- generated one\\n\\n## Checklist\\n- [ ] check a\\n- [ ] check b\\n'",
    );

    let draft = crate::run::merge_request::draft_for_run(env.app.handle(), &config, &record, false).await.unwrap();
    assert_eq!(draft.note, None);
    assert_eq!(draft.title, "feat: Add thing");
    assert!(draft.description.starts_with("## Summary\n- generated one\n\n## Related issue\n"));
    assert!(draft.description.contains("## Checklist (filled by reviewer)\n- [ ] check a\n- [ ] check b"));
    assert!(draft.description.contains("## Test evidence"));

    // Cached on the run: a different command isn't called again.
    config.agent.description_cmd = script(&env.scripts, "other.sh", "printf '## Summary\\n- other\\n'");
    let cached = env.store().get(RUN_ID).unwrap();
    assert_eq!(cached.generated_summary.as_deref(), Some("- generated one"));
    let again = crate::run::merge_request::draft_for_run(env.app.handle(), &config, &cached, false).await.unwrap();
    assert!(again.description.contains("- generated one"));

    let regenerated = crate::run::merge_request::draft_for_run(env.app.handle(), &config, &cached, true).await.unwrap();
    assert!(regenerated.description.contains("- other"));
    assert!(regenerated.description.contains("- [ ] The change does what the issue asks"), "default checklist");
}

#[tokio::test]
async fn a_failing_description_command_falls_back_with_a_note() {
    let env = setup();
    let record = approved_run(&env).await;
    let mut config = env.config(&env.good_worker());
    config.agent.description_cmd = "sh -c \"echo broken >&2; exit 2\"".to_string();

    let draft = crate::run::merge_request::draft_for_run(env.app.handle(), &config, &record, false).await.unwrap();

    assert!(draft.note.as_deref().unwrap().contains("broken"));
    assert!(draft.description.contains("- changed agent_output.txt"), "the worker's summary stands in");
    assert!(env.store().get(RUN_ID).unwrap().generated_summary.is_none());
}

#[tokio::test]
async fn a_description_command_that_edits_files_is_rejected() {
    let env = setup();
    let record = approved_run(&env).await;
    let mut config = env.config(&env.good_worker());
    config.agent.description_cmd = script(
        &env.scripts,
        "editing_describe.sh",
        "echo oops >> README.md\nprintf '## Summary\\n- x\\n'",
    );

    let draft = crate::run::merge_request::draft_for_run(env.app.handle(), &config, &record, false).await.unwrap();

    assert!(draft.note.as_deref().unwrap().contains("changed files"));
    assert!(env.store().get(RUN_ID).unwrap().generated_summary.is_none());
}
