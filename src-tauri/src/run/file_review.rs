//! The user's per-file decisions on a run's diff, and the pure helpers around them.

use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use super::pipeline::{base_of, enter};
use super::{RunStatus, RunStore};
use crate::error::AppError;
use crate::git::commit::{remove_files_from_commit, restore_to};
use crate::git::diff::run_diff;
use crate::git::inplace::{ensure_on_branch, require_clean};
use crate::git::locks::RepoLocks;
use crate::git::rev_parse;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Decision {
    Keep,
    Remove,
    Redo,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMark {
    #[serde(default)]
    pub decision: Option<Decision>,
    #[serde(default)]
    pub note: Option<String>,
}

/// Marks against one commit; `commit_sha` is the commit they were made on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileReview {
    pub commit_sha: String,
    pub files: BTreeMap<String, FileMark>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkChange {
    pub path: String,
    pub decision: Option<Decision>,
    pub note: Option<String>,
}

/// Carries marks over to a new commit: decisions on files the redo touched are
/// stale and dropped, but a redo note on an untouched file is kept as a note.
pub fn rebase(
    mut review: FileReview,
    changed: &HashSet<String>,
    current: &HashSet<String>,
    new_commit: &str,
) -> FileReview {
    review.files.retain(|path, _| current.contains(path) && !changed.contains(path));
    for mark in review.files.values_mut() {
        if mark.decision == Some(Decision::Redo) {
            mark.decision = None;
        }
    }
    review.commit_sha = new_commit.to_string();
    review
}

/// The paths that still have no decision, in the order given.
pub fn undecided(paths: &[String], review: Option<&FileReview>) -> Vec<String> {
    paths
        .iter()
        .filter(|path| {
            review
                .and_then(|r| r.files.get(path.as_str()))
                .is_none_or(|mark| mark.decision.is_none())
        })
        .cloned()
        .collect()
}

/// The instructions for a redo, or `None` when there is nothing to tell the worker.
pub fn build_feedback(general_note: Option<&str>, review: &FileReview) -> Option<String> {
    let paths_with = |wanted: Decision| {
        review
            .files
            .iter()
            .filter(|(_, mark)| mark.decision == Some(wanted))
            .map(|(path, _)| path.as_str())
            .collect::<Vec<_>>()
    };

    let general = general_note.map(str::trim).filter(|note| !note.is_empty());
    let redo = paths_with(Decision::Redo);
    if general.is_none() && redo.is_empty() {
        return None;
    }

    let mut sections: Vec<String> = general.map(str::to_string).into_iter().collect();
    if !redo.is_empty() {
        let lines: Vec<String> = redo
            .iter()
            .map(|path| {
                let note = review.files[*path].note.as_deref().map(str::trim).unwrap_or("");
                format!("{path}: {}", if note.is_empty() { "redo this file" } else { note })
            })
            .collect();
        sections.push(lines.join("\n"));
    }
    let kept = paths_with(Decision::Keep);
    if !kept.is_empty() {
        sections.push(format!(
            "Keep these files unchanged unless the task requires changing them: {}",
            kept.join(", ")
        ));
    }
    let removed = paths_with(Decision::Remove);
    if !removed.is_empty() {
        sections.push(format!(
            "The user removed these files; do not add them back: {}",
            removed.join(", ")
        ));
    }
    Some(sections.join("\n\n"))
}

/// Applies the user's decisions: removes the files marked `Remove` from the run's
/// commit, then either approves the run (`None`) or returns the feedback for a
/// redo (`Some`), leaving the run awaiting approval. Safe to call again after a failure.
pub async fn finish_review<R: Runtime>(
    app: &AppHandle<R>,
    run_id: &str,
    general_note: Option<&str>,
) -> Result<Option<String>, AppError> {
    let store = app.state::<RunStore>();
    let get = || store.get(run_id).ok_or_else(|| AppError::not_found(format!("unknown run {run_id}")));
    let no_commit = || AppError::conflict("this run has no commit to review");
    let lock_dir = get()?.work_dir.ok_or_else(no_commit)?;
    let _guard = app.state::<RepoLocks>().lock(&lock_dir).await;
    // Read only now: a redo may have started while Finish waited for the lock.
    let record = get()?;
    if record.status != RunStatus::AwaitingApproval {
        return Err(AppError::conflict(format!("run is {:?}, not awaiting approval", record.status)));
    }
    let (Some(work_dir), Some(base), Some(branch), Some(commit)) =
        (record.work_dir.as_deref(), base_of(&record), record.branch.as_deref(), record.commit_sha.as_deref())
    else {
        return Err(no_commit());
    };

    let paths: Vec<String> =
        run_diff(work_dir, base, branch).await.map_err(AppError::git)?.into_iter().map(|file| file.path).collect();
    // Marks made on an earlier commit can't be trusted: they count as undecided.
    let current = record.file_review.as_ref().filter(|review| review.commit_sha == commit);
    let missing = undecided(&paths, current);
    if !missing.is_empty() {
        return Err(AppError::conflict(format!("decide on these files first: {}", missing.join(", "))));
    }
    let mut review =
        current.cloned().unwrap_or_else(|| FileReview { commit_sha: commit.to_string(), files: BTreeMap::new() });
    review.files.retain(|path, _| paths.contains(path));

    let feedback = build_feedback(general_note, &review);
    let removals: Vec<String> = review
        .files
        .iter()
        .filter(|(_, mark)| mark.decision == Some(Decision::Remove))
        .map(|(path, _)| path.clone())
        .collect();

    if !removals.is_empty() {
        ensure_on_branch(work_dir, branch).await.map_err(AppError::git)?;
        require_clean(work_dir).await.map_err(AppError::git)?;
        if rev_parse(work_dir, "HEAD").await.map_err(AppError::git)? != commit {
            return Err(AppError::conflict(format!(
                "{branch} has commits on top of the run's commit that the app didn't make; move them off \
                 the branch or hand the run off before finishing the review"
            )));
        }
        if let Err(err) = remove_files_from_commit(work_dir, base, &removals).await {
            let err = match restore_to(work_dir, commit).await {
                Ok(()) => err,
                Err(restore_err) => format!("{err} (and restoring the earlier commit failed: {restore_err})"),
            };
            return Err(AppError::git(err));
        }
        let new_commit = rev_parse(work_dir, "HEAD").await.map_err(AppError::git)?;
        store.set_previous_commit(run_id, commit.to_string())?;
        store.set_commit_sha(run_id, new_commit.clone())?;
        review.files.retain(|_, mark| mark.decision != Some(Decision::Remove));
        review.commit_sha = new_commit;
        store.set_file_review(run_id, Some(review))?;
        let mut removed = record.removed_files.clone();
        for path in removals {
            if !removed.contains(&path) {
                removed.push(path);
            }
        }
        store.set_removed_files(run_id, removed)?;
    }

    if feedback.is_some() {
        return Ok(feedback);
    }
    enter(app, run_id, RunStatus::Approved, None)?;
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mark(decision: Option<Decision>, note: Option<&str>) -> FileMark {
        FileMark { decision, note: note.map(str::to_string) }
    }

    fn review(files: &[(&str, FileMark)]) -> FileReview {
        FileReview {
            commit_sha: "old".into(),
            files: files.iter().map(|(path, m)| (path.to_string(), m.clone())).collect(),
        }
    }

    fn set(paths: &[&str]) -> HashSet<String> {
        paths.iter().map(|p| p.to_string()).collect()
    }

    #[test]
    fn rebase_keeps_untouched_decisions_and_clears_changed_ones() {
        let before = review(&[
            ("a", mark(Some(Decision::Keep), None)),
            ("b", mark(Some(Decision::Keep), Some("note"))),
            ("c", mark(Some(Decision::Remove), None)),
        ]);
        let after = rebase(before, &set(&["b"]), &set(&["a", "b", "c"]), "new");

        assert_eq!(after.commit_sha, "new");
        assert_eq!(after.files.get("a"), Some(&mark(Some(Decision::Keep), None)));
        assert_eq!(after.files.get("b"), None);
        assert_eq!(after.files.get("c"), Some(&mark(Some(Decision::Remove), None)));
    }

    #[test]
    fn rebase_keeps_the_note_of_an_unchanged_redo_file_without_a_decision() {
        let before = review(&[("a", mark(Some(Decision::Redo), Some("use a map")))]);
        let after = rebase(before, &set(&[]), &set(&["a"]), "new");

        assert_eq!(after.files.get("a"), Some(&mark(None, Some("use a map"))));
    }

    #[test]
    fn rebase_drops_files_that_left_the_diff() {
        let before = review(&[
            ("a", mark(Some(Decision::Keep), None)),
            ("gone", mark(Some(Decision::Redo), Some("x"))),
        ]);
        let after = rebase(before, &set(&[]), &set(&["a"]), "new");

        assert_eq!(after.files.keys().collect::<Vec<_>>(), ["a"]);
    }

    #[test]
    fn feedback_lists_notes_kept_and_removed_files_in_order() {
        let r = review(&[
            ("a", mark(Some(Decision::Keep), None)),
            ("b", mark(Some(Decision::Redo), Some("fix the loop"))),
            ("c", mark(Some(Decision::Remove), None)),
            ("d", mark(Some(Decision::Redo), Some("  "))),
            ("e", mark(Some(Decision::Keep), None)),
        ]);
        let text = build_feedback(Some(" Be careful. "), &r).unwrap();

        assert_eq!(
            text,
            "Be careful.\n\n\
             b: fix the loop\nd: redo this file\n\n\
             Keep these files unchanged unless the task requires changing them: a, e\n\n\
             The user removed these files; do not add them back: c"
        );
    }

    #[test]
    fn feedback_is_none_without_redo_marks_or_a_general_note() {
        let r = review(&[
            ("a", mark(Some(Decision::Keep), None)),
            ("c", mark(Some(Decision::Remove), None)),
        ]);
        assert_eq!(build_feedback(None, &r), None);
        assert_eq!(build_feedback(Some("   "), &r), None);
    }

    #[test]
    fn a_general_note_alone_gives_feedback() {
        let r = review(&[]);
        assert_eq!(build_feedback(Some("  tidy up "), &r).as_deref(), Some("tidy up"));
    }

    #[test]
    fn undecided_lists_files_without_a_decision() {
        let paths: Vec<String> = ["a", "b", "c"].iter().map(|p| p.to_string()).collect();
        let r = review(&[
            ("a", mark(Some(Decision::Keep), None)),
            ("b", mark(None, Some("just a note"))),
        ]);

        assert_eq!(undecided(&paths, Some(&r)), ["b", "c"]);
        assert_eq!(undecided(&paths, None), ["a", "b", "c"]);
    }

    #[test]
    fn marks_are_stored_and_cleared() {
        use crate::run::RunStore;

        let store = RunStore::default();
        store.create("r1");
        assert!(store.apply_mark_changes("r1", vec![]).is_err(), "run has no commit yet");

        store.set_commit_sha("r1", "abc".into()).unwrap();
        let change = |path: &str, decision, note: Option<&str>| MarkChange {
            path: path.into(),
            decision,
            note: note.map(str::to_string),
        };
        store
            .apply_mark_changes(
                "r1",
                vec![
                    change("a", Some(Decision::Keep), None),
                    change("b", None, Some("hmm")),
                    change("c", Some(Decision::Remove), None),
                ],
            )
            .unwrap();

        let stored = store.get("r1").unwrap().file_review.unwrap();
        assert_eq!(stored.commit_sha, "abc");
        assert_eq!(stored.files.len(), 3);

        store
            .apply_mark_changes("r1", vec![change("a", None, None), change("b", None, Some("  "))])
            .unwrap();
        let stored = store.get("r1").unwrap().file_review.unwrap();
        assert_eq!(stored.files.keys().collect::<Vec<_>>(), ["c"]);

        store.set_file_review("r1", None).unwrap();
        assert!(store.get("r1").unwrap().file_review.is_none());
        assert!(store.apply_mark_changes("nope", vec![]).is_err());
    }

    #[test]
    fn marks_on_top_of_a_review_for_an_older_commit_replace_it() {
        use crate::run::RunStore;

        let store = RunStore::default();
        store.create("r1");
        store.set_commit_sha("r1", "new".into()).unwrap();
        let stale = review(&[
            ("a", mark(Some(Decision::Keep), None)),
            ("b", mark(Some(Decision::Redo), Some("x"))),
        ]);
        store.set_file_review("r1", Some(stale)).unwrap();

        let change = MarkChange { path: "c".into(), decision: Some(Decision::Remove), note: None };
        store.apply_mark_changes("r1", vec![change]).unwrap();

        let stored = store.get("r1").unwrap().file_review.unwrap();
        assert_eq!(stored.commit_sha, "new");
        assert_eq!(stored.files.keys().collect::<Vec<_>>(), ["c"]);
        assert_eq!(undecided(&["c".to_string()], Some(&stored)), Vec::<String>::new());
    }
}
