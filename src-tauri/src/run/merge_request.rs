//! Merge/pull request description rendering.

use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

use super::pipeline::{agent_runtime, base_of};
use super::{RunRecord, RunStore};
use crate::agent::describer::{run_describer, DescriptionInput, GeneratedSections};
use crate::agent::runner::remove_prompt_files;
use crate::config::AppConfig;
use crate::git::diff::{branch_patch, changed_files};
use crate::git::inplace::snapshot;
use crate::git::worktree::classify_title;
use crate::template::substitute;

/// The MR/PR title: the issue title as a conventional subject, `fix: Login
/// crash`, with the type taken from the title prefix or the issue's labels.
pub fn default_title(issue_title: &str, labels: &[String]) -> String {
    let (kind, title) = classify_title(issue_title, labels);
    format!("{kind}: {}", title.trim())
}

/// Everything the description template can draw on.
pub struct DescriptionParts<'a> {
    pub issue_ref: &'a str,
    pub issue_url: &'a str,
    pub worker_summary: &'a str,
    pub review_notes: &'a str,
    pub files_changed: &'a [(String, String)],
    /// Written by the description command; `{summary}` falls back to a cut-down
    /// worker summary without it.
    pub summary: Option<&'a str>,
    /// Written by the description command; `{checklist}` falls back to a generic list.
    pub checklist: Option<&'a str>,
}

const DEFAULT_CHECKLIST: &str = "- [ ] The change does what the issue asks\n\
- [ ] No unrelated changes slipped in\n\
- [ ] Tests cover the new behaviour\n\
- [ ] Error cases are handled";

/// Fills the configurable MR/PR description template. `{summary}` is the
/// generated (or else cut-down worker) summary, `{worker_summary}` the worker's
/// full text, `{issue_link}` a markdown link to the ticket and `{checklist}` the
/// reviewer's check boxes.
pub fn render_description(template: &str, parts: &DescriptionParts) -> String {
    let summary = parts.summary.map(str::to_string).unwrap_or_else(|| short_summary(parts.worker_summary));
    let issue_link = if parts.issue_url.trim().is_empty() {
        parts.issue_ref.to_string()
    } else {
        format!("[{}]({})", parts.issue_ref, parts.issue_url.trim())
    };
    substitute(
        template,
        &[
            ("summary", or_none(&summary)),
            ("worker_summary", or_none(parts.worker_summary)),
            ("files_changed", &format_files(parts.files_changed)),
            ("review_notes", or_none(parts.review_notes)),
            ("issue_ref", parts.issue_ref),
            ("issue_link", &issue_link),
            ("checklist", parts.checklist.unwrap_or(DEFAULT_CHECKLIST)),
        ],
    )
}

const SUMMARY_MAX_LINES: usize = 8;
const SUMMARY_MAX_CHARS: usize = 800;

/// The first few non-empty lines of `text`, capped in length, so a chatty agent
/// still yields a short description.
fn short_summary(text: &str) -> String {
    let lines: Vec<&str> = text.lines().map(str::trim_end).filter(|l| !l.trim().is_empty()).collect();
    let mut summary = lines.iter().take(SUMMARY_MAX_LINES).copied().collect::<Vec<_>>().join("\n");
    let mut cut = lines.len() > SUMMARY_MAX_LINES;
    if summary.chars().count() > SUMMARY_MAX_CHARS {
        summary = summary.chars().take(SUMMARY_MAX_CHARS).collect();
        cut = true;
    }
    if cut {
        summary.push('…');
    }
    summary
}

fn or_none(text: &str) -> &str {
    if text.trim().is_empty() {
        "(none)"
    } else {
        text.trim()
    }
}

/// Markdown list of `(status, path)` pairs, e.g. "- `src/a.rs` (modified)".
fn format_files(files: &[(String, String)]) -> String {
    if files.is_empty() {
        return "(none)".to_string();
    }
    files
        .iter()
        .map(|(status, path)| {
            let label = match status.as_str() {
                "A" => "added",
                "D" => "deleted",
                "M" => "modified",
                other => other,
            };
            format!("- `{path}` ({label})")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Title and description a merge/pull request would be opened with.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeRequestDraft {
    pub title: String,
    pub description: String,
    /// Set when a description command is configured but its output couldn't be used.
    pub note: Option<String>,
}

/// Builds the draft for an approved run. With a description command configured,
/// its summary and checklist are written once per commit and cached on the run
/// (`regenerate` writes them again); if it fails the draft falls back to the
/// worker's summary and a generic checklist, with a note saying why.
pub async fn draft_for_run<R: Runtime>(
    app: &AppHandle<R>,
    config: &AppConfig,
    record: &RunRecord,
    regenerate: bool,
) -> Result<MergeRequestDraft, String> {
    let base = base_of(record).map(str::to_string);
    let (Some(folder), Some(branch), Some(base)) =
        (record.work_dir.clone().filter(|p| p.is_dir()), record.branch.clone(), base)
    else {
        return Err("this run's project folder no longer exists".to_string());
    };
    let files = changed_files(&folder, &base, &branch).await?;

    let mut generated = match (&record.generated_summary, regenerate) {
        (Some(summary), false) => Some((summary.clone(), record.generated_checklist.clone())),
        _ => None,
    };
    let mut note = None;
    if generated.is_none() && !config.agent.description_cmd.trim().is_empty() {
        match generate(app, config, record, &folder, &base, &branch).await {
            Ok(sections) => {
                app.state::<RunStore>().set_generated_description(
                    &record.id,
                    sections.summary.clone(),
                    sections.checklist.clone(),
                )?;
                generated = Some((sections.summary, sections.checklist));
            }
            Err(err) => {
                note = Some(format!(
                    "Could not write the summary and checklist ({err}); using the worker's summary and a generic checklist."
                ));
            }
        }
    }

    let parts = DescriptionParts {
        issue_ref: &record.issue_ref,
        issue_url: &record.task_url,
        worker_summary: record.worker_summary.as_deref().unwrap_or_default(),
        review_notes: record.review_notes.as_deref().unwrap_or_default(),
        files_changed: &files,
        summary: generated.as_ref().map(|(summary, _)| summary.as_str()),
        checklist: generated.as_ref().and_then(|(_, checklist)| checklist.as_deref()),
    };
    Ok(MergeRequestDraft {
        title: default_title(&record.task_title, &record.labels),
        description: render_description(&config.merge_request_template, &parts),
        note,
    })
}

/// Runs the description command on the run's branch. It must not touch the
/// project folder; if it does, its output is discarded.
async fn generate<R: Runtime>(
    app: &AppHandle<R>,
    config: &AppConfig,
    record: &RunRecord,
    folder: &Path,
    base: &str,
    branch: &str,
) -> Result<GeneratedSections, String> {
    let diff = branch_patch(folder, base, branch).await?;
    let runtime = agent_runtime(config)?;
    let input = DescriptionInput {
        title: &record.task_title,
        issue_description: &record.description,
        worker_summary: record.worker_summary.as_deref().unwrap_or_default(),
        review_notes: record.review_notes.as_deref().unwrap_or_default(),
        diff: &diff,
    };
    let before = snapshot(folder).await?;
    let result = run_describer(app, &record.id, &config.agent.description_cmd, &input, folder, &runtime).await;
    remove_prompt_files(app, &record.id);
    if snapshot(folder).await? != before {
        return Err("the command changed files in your project folder; use a read-only mode".to_string());
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parts<'a>(worker_summary: &'a str, files: &'a [(String, String)]) -> DescriptionParts<'a> {
        DescriptionParts {
            issue_ref: "group/proj#7",
            issue_url: "https://gitlab.example.com/group/proj/-/issues/7",
            worker_summary,
            review_notes: "Looks good",
            files_changed: files,
            summary: None,
            checklist: None,
        }
    }

    #[test]
    fn fills_every_placeholder() {
        let files = [("M".to_string(), "src/a.rs".to_string()), ("A".to_string(), "b.txt".to_string())];
        let description = render_description(
            "{worker_summary}\n\n{files_changed}\n\n{review_notes}\n\nCloses {issue_ref}",
            &parts("Did the thing", &files),
        );
        assert_eq!(
            description,
            "Did the thing\n\n- `src/a.rs` (modified)\n- `b.txt` (added)\n\nLooks good\n\nCloses group/proj#7"
        );
    }

    #[test]
    fn the_default_template_has_the_four_sections() {
        let mut p = parts("- did it", &[]);
        p.summary = Some("- generated summary");
        p.checklist = Some("- [ ] check a\n- [ ] check b");
        let description = render_description(crate::config::AppConfig::default().merge_request_template.as_str(), &p);

        assert!(description.starts_with("## Summary\n- generated summary\n\n## Related issue\n"));
        assert!(description.contains("[group/proj#7](https://gitlab.example.com/group/proj/-/issues/7)"));
        assert!(description.contains("## Checklist (filled by reviewer)\n- [ ] check a\n- [ ] check b\n"));
        assert!(description.contains("## Test evidence\n<!--"));
        assert!(!description.contains("Looks good"), "no reviewer output in the description");
    }

    #[test]
    fn without_generated_text_the_summary_and_checklist_fall_back() {
        let description = render_description("{summary}|{checklist}", &parts("- did it", &[]));
        assert!(description.starts_with("- did it|- [ ] The change does what the issue asks"));
        assert!(description.lines().count() <= 4);
    }

    #[test]
    fn title_is_a_conventional_subject() {
        assert_eq!(default_title("Login crash", &["bug".to_string()]), "fix: Login crash");
        assert_eq!(default_title("refactor(api): split module", &[]), "refactor: split module");
        assert_eq!(default_title("Add export", &[]), "feat: Add export");
    }

    #[test]
    fn summary_is_cut_to_a_few_lines() {
        let long = (1..=12).map(|n| format!("- change {n}")).collect::<Vec<_>>().join("\n\n");
        let description = render_description("{summary}", &parts(&long, &[]));
        assert_eq!(description.lines().count(), SUMMARY_MAX_LINES);
        assert!(description.starts_with("- change 1\n- change 2"));
        assert!(description.ends_with("- change 8…"));

        let short = render_description("{summary}", &parts("- one\n- two", &[]));
        assert_eq!(short, "- one\n- two");
    }

    #[test]
    fn empty_sections_read_as_none() {
        let mut p = parts("  ", &[]);
        p.review_notes = "";
        let description = render_description("{worker_summary}|{review_notes}|{files_changed}|{summary}", &p);
        assert_eq!(description, "(none)|(none)|(none)|(none)");
    }
}
