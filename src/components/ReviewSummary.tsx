import { useState } from "react";
import { describeError, type FileMark, finishFileReview, type RunRecord } from "../lib/api";
import { groupMarks } from "../lib/fileReview";
import { DiffViewer } from "./DiffViewer";
import { RunEscapeActions } from "./RunEscapeActions";
import { Button, Icon, Notice, Textarea } from "./ui";

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
    <div data-testid="review-summary" className="flex min-w-0 flex-1 flex-col gap-4 overflow-auto p-4">
      {groups.map(
        ({ key, title }) =>
          grouped[key].length > 0 && (
            <div key={key}>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                {title} ({grouped[key].length})
              </h3>
              <ul>
                {grouped[key].map((path) => (
                  <li key={path}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onJump(path)}
                      className="w-full rounded-lg px-2 py-1 text-left hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 disabled:cursor-not-allowed dark:hover:bg-zinc-800/50"
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

      <Textarea
        value={generalNote}
        onChange={(e) => onGeneralNoteChange(e.target.value)}
        rows={3}
        placeholder="Anything else the agent should change?"
      />

      {grouped.remove.length > 0 && (
        <Notice tone="warning">
          Removed files are deleted from the branch when you finish and can&apos;t be brought back
          from the app.
        </Notice>
      )}

      <div className="flex flex-wrap items-start gap-2">
        <Button
          variant="primary"
          icon={redoes ? "refresh" : "check"}
          disabled={busy || grouped.undecided.length > 0}
          onClick={finish}
        >
          {redoes ? "Apply and redo" : "Finish review"}
        </Button>
        <RunEscapeActions runId={run.id} onChanged={onChanged} disabled={busy} />
      </div>

      {error && <Notice tone="danger">{error}</Notice>}

      {run.previousCommitSha && (
        <details className="group">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-lg px-1 py-0.5 text-xs font-semibold uppercase tracking-wide text-zinc-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 dark:text-zinc-400 [&::-webkit-details-marker]:hidden">
            <Icon name="chevron-right" className="size-3.5 transition-transform group-open:rotate-90 motion-reduce:transition-none" />
            Since last redo
          </summary>
          <div className="mt-2">
            <DiffViewer runId={run.id} redone />
          </div>
        </details>
      )}
    </div>
  );
}
