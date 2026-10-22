mod agent;
mod commands;
mod config;
mod error;
#[cfg(test)]
mod e2e_tests;
mod git;
mod migrate;
mod providers;
mod run;
mod secrets;
mod shell_env;
mod template;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Debug)
                .max_file_size(5_000_000)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(5))
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("abracadabra".to_string()),
                    }),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                ])
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            shell_env::merge_login_shell_path();
            migrate::adopt_legacy_data(app.handle());
            let runs_path = app.path().app_data_dir()?.join("runs.json");
            app.manage(run::RunStore::load(runs_path));
            app.manage(run::limiter::RunLimiter::default());
            app.manage(run::limiter::ProjectGate::default());
            app.manage(git::locks::RepoLocks::default());
            app.manage(agent::runner::ProcessRegistry::default());
            app.manage(agent::runner::OutputBuffer::default());

            // Clean up after runs the last app exit interrupted.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                run::pipeline::recover_interrupted_runs(&handle).await;
                let keep_days = config::load(&handle).map(|c| c.keep_runs_days).unwrap_or(0);
                if keep_days > 0 {
                    let cutoff = run::now_ms().saturating_sub(u64::from(keep_days) * 86_400_000);
                    let removed = handle.state::<run::RunStore>().purge_finished_before(cutoff);
                    if removed > 0 {
                        log::info!("deleted {removed} finished run(s) older than {keep_days} day(s)");
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::config::get_config,
            commands::config::save_config,
            commands::config::set_token,
            commands::config::has_token,
            commands::config::remove_token,
            commands::providers::test_connection,
            commands::providers::list_tasks,
            commands::runs::start_run,
            commands::runs::list_runs,
            commands::runs::get_run,
            commands::runs::delete_run,
            commands::runs::cancel_run,
            commands::runs::get_run_diff,
            commands::runs::get_redo_diff,
            commands::runs::get_run_diff_live,
            commands::runs::get_run_output,
            commands::runs::approve_run,
            commands::runs::discard_run,
            commands::runs::return_to_original_branch,
            commands::runs::redo_run,
            commands::runs::hand_off_run,
            commands::runs::push_run,
            commands::runs::create_merge_request,
            commands::runs::preview_merge_request,
            commands::runs::retry_run_with_branch,
            commands::stashes::list_orphaned_stashes,
            commands::stashes::restore_orphaned_stash,
            commands::tools::open_in_ide,
            commands::tools::test_agent_command
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Don't leave agents running (and editing worktrees) after the app is gone.
            if let tauri::RunEvent::Exit = event {
                app_handle.state::<agent::runner::ProcessRegistry>().kill_all();
            }
        });
}
