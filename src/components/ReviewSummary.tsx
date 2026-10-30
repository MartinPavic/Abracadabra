import { useState } from "react";
import {
  describeError,
  discardRun,
  type FileMark,
  finishFileReview,
  handOffRun,
  type RunRecord,
} from "../lib/api";
import { groupMarks } from "../lib/fileReview";
import { DiffViewer } from "./DiffViewer";

const buttonClass =
  "rounded-md border px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50";
const neutralButton = `${buttonClass} border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900`;

const groups = [
  { key: "keep", title: "Kept" },
  { key: "remove", title: "Removed" },
  { key: "redo", title: "Redo" },
  { key: "undecided", title: "Undecided" },
] as const;

/** End of the per-file review: what will happen, plus Finish / Discard / hand off. */
export function ReviewSummary({
  run,
  paths,
  marks,
  onJump,
  onChanged,
}: {
  run: RunRecord;
  paths: string[];
  marks: Record<string, FileMark>;
  onJump: (path: string) => void;
  onChanged: () => void;
}) {
  const [generalNote, setGeneralNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const grouped = groupMarks(paths, marks);
  const note = generalNote.trim();
  const redoes = grouped.redo.length > 0 || note !== "";

  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
      setConfirmDiscard(false);
    }
  }

  return (
    <div data-testid="review-summary" className="flex flex-1 flex-col gap-4 overflow-auto p-4">
      {groups.map(
        ({ key, title }) =>
          grouped[key].length > 0 && (
            <div key={key}>
              <h3 className="mb-1 text-xs font-medium uppercase text-zinc-500 dark:text-zinc-400">
                {title} ({grouped[key].length})
              </h3>
              <ul>
                {grouped[key].map((path) => (
                  <li key={path}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onJump(path)}
                      className="w-full rounded px-2 py-1 text-left hover:bg-zinc-50 dark:hover:bg-zinc-900/50"
                    >
                      <span className="block truncate font-mono text-xs text-zinc-800 dark:text-zinc-200">
                        {path}
                      </span>
                      {key === "redo" && marks[path]?.note && (
                        <span className="block text-xs text-zinc-600 dark:text-zinc-400">
                          {marks[path].note}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ),
      )}

      <textarea
        value={generalNote}
        onChange={(e) => setGeneralNote(e.target.value)}
        rows={3}
        placeholder="Anything else the agent should change?"
        className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
      />

      {grouped.remove.length > 0 && (
        <p className="text-sm text-amber-800 dark:text-amber-300">
          Removed files are deleted from the branch when you finish and can&apos;t be brought back
          from the app.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy || grouped.undecided.length > 0}
          onClick={() => perform(() => finishFileReview(run.id, note || undefined))}
          className={`${buttonClass} border-green-600 bg-green-600 text-white hover:bg-green-700`}
        >
          {redoes ? "Apply and redo" : "Finish review"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => setConfirmDiscard(true)}
          className={`${buttonClass} border-red-300 text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950`}
        >
          Discard run
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => perform(() => handOffRun(run.id))}
          className={neutralButton}
        >
          Open in editor / hand off
        </button>
      </div>

      {confirmDiscard && !busy && (
        <div className="flex items-center gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200">
          <span>
            Discard this run? Its branch is deleted and your folder goes back to how it was
            (stashed changes restored). Uncommitted edits on the branch are lost.
          </span>
          <button
            type="button"
            onClick={() => perform(() => discardRun(run.id))}
            className={`${buttonClass} border-red-600 bg-red-600 text-white hover:bg-red-700`}
          >
            Yes, discard
          </button>
          <button type="button" onClick={() => setConfirmDiscard(false)} className={neutralButton}>
            Cancel
          </button>
        </div>
      )}

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {run.previousCommitSha && (
        <details className="rounded-lg border border-zinc-200 dark:border-zinc-800">
          <summary className="cursor-pointer px-4 py-2 text-xs font-medium uppercase text-zinc-500 dark:text-zinc-400">
            Since last redo
          </summary>
          <DiffViewer runId={run.id} redone />
        </details>
      )}
    </div>
  );
}
