//! The user's per-file decisions on a run's diff, and the pure helpers around them.

use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};

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
}
