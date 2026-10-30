import { useState } from "react";
import { describeError, type FileMark, finishFileReview, type RunRecord } from "../lib/api";
import { groupMarks } from "../lib/fileReview";
import { DiffViewer } from "./DiffViewer";
import { RunEscapeActions } from "./RunEscapeActions";

const buttonClass =
  "rounded-md border px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50";

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
  generalNote,
  onGeneralNoteChange,
  onJump,
  onChanged,
}: {
  run: RunRecord;
  paths: string[];
  marks: Record<string, FileMark>;
  generalNote: string;
  onGeneralNoteChange: (note: string) => void;
  onJump: (path: string) => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const grouped = groupMarks(paths, marks);
  const note = generalNote.trim();
  const redoes = grouped.redo.length > 0 || note !== "";

  async function finish() {
    setBusy(true);
    setError(null);
    try {
      await finishFileReview(run.id, note || undefined);
      onChanged();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
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
        onChange={(e) => onGeneralNoteChange(e.target.value)}
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

      <div className="flex flex-wrap items-start gap-2">
        <button
          type="button"
          disabled={busy || grouped.undecided.length > 0}
          onClick={finish}
          className={`${buttonClass} border-green-600 bg-green-600 text-white hover:bg-green-700`}
        >
          {redoes ? "Apply and redo" : "Finish review"}
        </button>
        <RunEscapeActions runId={run.id} onChanged={onChanged} disabled={busy} />
      </div>

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
