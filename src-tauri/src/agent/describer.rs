//! Description step — asks the configured command to write the merge request's
//! summary and reviewer checklist from the run's changes.

use std::path::Path;

use tauri::{AppHandle, Runtime};

use super::runner::{
    run_agent, tail_chars, write_prompt_file, AgentCommand, AgentRole, AgentRunOutput, AgentRuntime,
};

/// Larger diffs are cut so the prompt file stays usable.
const MAX_DIFF_CHARS: usize = 100_000;
/// The checklist is for a human to tick off, so it stays short.
pub const MAX_CHECKLIST_ITEMS: usize = 6;

/// What the command wrote, in the form the description template uses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GeneratedSections {
    pub summary: String,
    /// `- [ ] ...` lines; `None` when the output had no checklist.
    pub checklist: Option<String>,
}

pub struct DescriptionInput<'a> {
    pub title: &'a str,
    pub issue_description: &'a str,
    pub worker_summary: &'a str,
    pub review_notes: &'a str,
    pub diff: &'a str,
}

pub fn build_description_prompt(input: &DescriptionInput) -> String {
    let diff = input.diff.trim_end();
    let shown: String = diff.chars().take(MAX_DIFF_CHARS).collect();
    let cut_note = if shown.len() < diff.len() { "\n... (diff truncated)" } else { "" };
    format!(
        "# Merge request description\n\nWrite two sections for the merge request of the change below, \
         in markdown, with exactly these headings and nothing else:\n\n\
         ## Summary\n2 to 5 short bullet points on what changed and why. No preamble.\n\n\
         ## Checklist\nAt most {MAX_CHECKLIST_ITEMS} items a human reviewer should verify for this change, each as \
         `- [ ] ...`. Make them specific to this diff, not generic.\n\n\
         ## Issue: {}\n\n{}\n\n## Summary written by the developer\n\n{}\n\n## Review notes\n\n{}\n\n\
         ## Diff\n\n```diff\n{}{}\n```\n",
        input.title.trim(),
        input.issue_description.trim(),
        input.worker_summary.trim(),
        input.review_notes.trim(),
        shown,
        cut_note
    )
}

/// `## Summary` / `## Checklist` heading names (markdown marks and a trailing
/// colon ignored), or `None` for any other line.
fn section_of(line: &str) -> Option<&'static str> {
    let plain: String = line.chars().filter(|c| !matches!(c, '#' | '*' | '_')).collect();
    match plain.trim().trim_end_matches(':').to_lowercase().as_str() {
        "summary" => Some("summary"),
        "checklist" => Some("checklist"),
        _ => None,
    }
}

/// Splits the command's output into its Summary and Checklist sections. The
/// checklist is normalised to at most `MAX_CHECKLIST_ITEMS` `- [ ]` lines.
pub fn parse_sections(output: &str) -> Result<GeneratedSections, String> {
    let (mut summary, mut checklist) = (Vec::new(), Vec::new());
    let mut current: Option<&str> = None;
    for line in output.lines() {
        if let Some(section) = section_of(line) {
            current = Some(section);
            continue;
        }
        match current {
            Some("summary") => summary.push(line),
            Some("checklist") => checklist.push(line),
            _ => {}
        }
    }

    let summary = summary.join("\n").trim().to_string();
    if summary.is_empty() {
        return Err("the description command's output has no Summary section".to_string());
    }
    let items: Vec<String> = checklist
        .iter()
        .filter_map(|line| {
            let line = line.trim();
            let text = line.strip_prefix("- [ ]").or_else(|| line.strip_prefix("- [x]"));
            let text = text.or_else(|| line.strip_prefix('-')).or_else(|| line.strip_prefix('*'))?;
            let text = text.trim().trim_start_matches("[ ]").trim();
            (!text.is_empty()).then(|| format!("- [ ] {text}"))
        })
        .take(MAX_CHECKLIST_ITEMS)
        .collect();
    Ok(GeneratedSections {
        summary,
        checklist: (!items.is_empty()).then(|| items.join("\n")),
    })
}

fn into_sections(output: AgentRunOutput) -> Result<GeneratedSections, String> {
    if output.timed_out {
        return Err("the description command timed out and was stopped".to_string());
    }
    if !output.success {
        let stderr = tail_chars(&output.stderr.join("\n"), 2000);
        return Err(if stderr.is_empty() {
            "the description command exited with a non-zero status".to_string()
        } else {
            format!("the description command failed: {stderr}")
        });
    }
    parse_sections(&output.stdout.join("\n"))
}

/// Runs the description command in the project folder and parses what it wrote.
pub async fn run_describer<R: Runtime>(
    app: &AppHandle<R>,
    run_id: &str,
    describer_cmd: &str,
    input: &DescriptionInput<'_>,
    cwd: &Path,
    runtime: &AgentRuntime,
) -> Result<GeneratedSections, String> {
    let prompt = build_description_prompt(input);
    let prompt_file = write_prompt_file(app, run_id, AgentRole::Describer, &prompt)?;
    let command = AgentCommand {
        role: AgentRole::Describer,
        template: describer_cmd,
        prompt_file: Some(&prompt_file),
        system_prompt: None,
        cwd,
        runtime,
    };
    into_sections(run_agent(app, run_id, &command).await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_prompt_asks_for_both_sections_and_includes_the_change() {
        let prompt = build_description_prompt(&DescriptionInput {
            title: "Fix crash",
            issue_description: "It crashes.",
            worker_summary: "- fixed a.rs",
            review_notes: "fine",
            diff: "+added\n",
        });
        assert!(prompt.contains("## Summary") && prompt.contains("## Checklist"));
        assert!(prompt.contains("At most 6 items"));
        assert!(prompt.contains("## Issue: Fix crash") && prompt.contains("```diff\n+added\n```"));
    }

    #[test]
    fn sections_are_split_out_of_the_output() {
        let output = "Sure!\n\n## Summary\n- Fixes the crash\n- Adds a test\n\n## Checklist\n- [ ] Crash is gone\n- [ ] Test is meaningful\n";
        let sections = parse_sections(output).unwrap();
        assert_eq!(sections.summary, "- Fixes the crash\n- Adds a test");
        assert_eq!(sections.checklist.as_deref(), Some("- [ ] Crash is gone\n- [ ] Test is meaningful"));
    }

    #[test]
    fn headings_and_list_markers_are_normalised() {
        let output = "**Summary:**\nDid it.\n\n### Checklist\n* edge case handled\n- [x] already ticked\n-  \n- [ ] real item\n";
        let sections = parse_sections(output).unwrap();
        assert_eq!(sections.summary, "Did it.");
        assert_eq!(
            sections.checklist.as_deref(),
            Some("- [ ] edge case handled\n- [ ] already ticked\n- [ ] real item")
        );
    }

    #[test]
    fn the_checklist_is_capped_and_optional() {
        let items = (1..=9).map(|n| format!("- [ ] item {n}")).collect::<Vec<_>>().join("\n");
        let sections = parse_sections(&format!("## Summary\nx\n## Checklist\n{items}")).unwrap();
        assert_eq!(sections.checklist.unwrap().lines().count(), MAX_CHECKLIST_ITEMS);

        assert_eq!(parse_sections("## Summary\nx").unwrap().checklist, None);
        assert!(parse_sections("no sections here").is_err());
    }

    fn output(success: bool, stdout: &[&str], stderr: &[&str]) -> AgentRunOutput {
        AgentRunOutput {
            success,
            timed_out: false,
            stdout: stdout.iter().map(|s| s.to_string()).collect(),
            stderr: stderr.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn failures_carry_the_commands_stderr() {
        let err = into_sections(output(false, &[], &["boom"])).unwrap_err();
        assert_eq!(err, "the description command failed: boom");
    }
}
