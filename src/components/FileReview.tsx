import { useEffect, useState } from "react";
import {
  type Decision,
  describeError,
  type FileDiff,
  type FileMark,
  getRunDiff,
  type RunRecord,
  setFileDecisions,
} from "../lib/api";
import { nextUndecided } from "../lib/fileReview";
import { classifyPatch } from "./DiffViewer";

const statusBadge: Record<string, string> = {
  A: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  M: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  D: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
};
const defaultBadge = "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";

const markers: Record<Decision | "undecided", { glyph: string; label: string; className: string }> =
  {
    keep: { glyph: "✓", label: "Keep", className: "text-green-600 dark:text-green-400" },
    remove: { glyph: "✗", label: "Remove", className: "text-red-600 dark:text-red-400" },
    redo: { glyph: "↻", label: "Redo", className: "text-amber-600 dark:text-amber-400" },
    undecided: { glyph: "○", label: "Undecided", className: "text-zinc-400 dark:text-zinc-500" },
  };

const buttonClass =
  "rounded-md border px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50";
const neutralButton = `${buttonClass} border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900`;
const noButton = `${buttonClass} border-red-300 text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950`;

function isTyping(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

/** One file at a time: keep it, remove it, or ask for a redo; the summary follows once all are decided. */
export function FileReview({ run }: { run: RunRecord; onChanged: () => void }) {
  const [files, setFiles] = useState<FileDiff[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [marks, setMarks] = useState<Record<string, FileMark>>({});
  // null means the summary is shown.
  const [index, setIndex] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const paths = files?.map((f) => f.path) ?? [];
  const current = files && index !== null ? files[index] : null;

  function show(i: number | null, from: Record<string, FileMark> = marks) {
    setIndex(i);
    setNote(i === null ? "" : (from[paths[i]]?.note ?? ""));
    setSaveError(null);
  }

  // Only the run and its commit decide what to load; fileReview is read once as the seed.
  useEffect(() => {
    let cancelled = false;
    const seed = run.fileReview?.commitSha === run.commitSha ? run.fileReview.files : {};
    setMarks(seed);
    setFiles(null);
    setError(null);
    getRunDiff(run.id)
      .then((result) => {
        if (cancelled) return;
        const start = nextUndecided(
          result.map((f) => f.path),
          seed,
          -1,
        );
        setFiles(result);
        setIndex(start);
        setNote(start === null ? "" : (seed[result[start].path]?.note ?? ""));
      })
      .catch((err) => !cancelled && setError(describeError(err)));
    return () => {
      cancelled = true;
    };
  }, [run.id, run.commitSha]);

  async function save(changes: { path: string; decision: Decision; note: string | null }[]) {
    setBusy(true);
    setSaveError(null);
    try {
      await setFileDecisions(run.id, changes);
      const next = { ...marks };
      for (const c of changes) next[c.path] = { decision: c.decision, note: c.note };
      setMarks(next);
      show(nextUndecided(paths, next, index ?? -1), next);
    } catch (err) {
      setSaveError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  function decide(decision: Decision) {
    if (!current) return;
    const trimmed = note.trim();
    void save([
      { path: current.path, decision, note: decision === "redo" && trimmed ? trimmed : null },
    ]);
  }

  function acceptAll() {
    const undecided = paths.filter((p) => !marks[p]?.decision);
    if (undecided.length === 0) show(null);
    else void save(undecided.map((path) => ({ path, decision: "keep", note: null })));
  }

  function step(delta: number) {
    if (index === null) return;
    const target = Math.min(Math.max(index + delta, 0), paths.length - 1);
    if (target !== index) show(target);
  }

  // Re-subscribed after every render so the handler always sees the current state.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (busy || !current || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTyping(event.target)) return;
      const key = event.key.toLowerCase();
      if (event.key === "ArrowLeft") step(-1);
      else if (event.key === "ArrowRight") step(1);
      else if (key === "y" && event.shiftKey) acceptAll();
      else if (key === "y") decide("keep");
      else if (key === "n") decide("remove");
      else return;
      event.preventDefault();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const decided = paths.filter((p) => marks[p]?.decision).length;

  return (
    <section className="rounded-lg border border-zinc-200 dark:border-zinc-800">
      {error && <p className="px-4 py-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
      {!error && files === null && (
        <p className="px-4 py-3 text-sm text-zinc-500 dark:text-zinc-400">Loading diff...</p>
      )}
      {files?.length === 0 && (
        <p className="px-4 py-3 text-sm text-zinc-500 dark:text-zinc-400">No changes.</p>
      )}

      {files && files.length > 0 && (
        <>
          <div className="flex items-center gap-4 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
            <h2 className="shrink-0 text-xs font-medium uppercase text-zinc-500 dark:text-zinc-400">
              {index === null ? "Summary" : `File ${index + 1} of ${files.length}`}
            </h2>
            <div
              role="progressbar"
              aria-label="Files decided"
              aria-valuemin={0}
              aria-valuenow={decided}
              aria-valuemax={files.length}
              className="flex flex-1 gap-0.5"
            >
              {paths.map((path) => (
                <div
                  key={path}
                  className={`h-1.5 flex-1 rounded-full ${
                    marks[path]?.decision
                      ? "bg-green-500 dark:bg-green-600"
                      : "bg-zinc-200 dark:bg-zinc-800"
                  }`}
                />
              ))}
            </div>
          </div>

          <div className="flex max-h-[32rem]">
            <ul className="w-64 shrink-0 overflow-auto border-r border-zinc-200 dark:border-zinc-800">
              {files.map((file, i) => {
                const marker = markers[marks[file.path]?.decision ?? "undecided"];
                return (
                  <li key={file.path}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => show(i)}
                      title={file.path}
                      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs ${
                        i === index
                          ? "bg-zinc-100 dark:bg-zinc-900"
                          : "hover:bg-zinc-50 dark:hover:bg-zinc-900/50"
                      }`}
                    >
                      <span
                        role="img"
                        aria-label={marker.label}
                        title={marker.label}
                        className={marker.className}
                      >
                        {marker.glyph}
                      </span>
                      <span className="truncate text-zinc-800 dark:text-zinc-200">{file.path}</span>
                    </button>
                  </li>
                );
              })}
            </ul>

            {current ? (
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex items-center gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
                  <span
                    className={`rounded px-1.5 py-0.5 font-mono text-xs font-medium ${statusBadge[current.status] ?? defaultBadge}`}
                  >
                    {current.status}
                  </span>
                  <h3 className="truncate font-mono text-sm text-zinc-800 dark:text-zinc-200">
                    {current.path}
                  </h3>
                  <div className="ml-auto flex shrink-0 gap-1">
                    <button
                      type="button"
                      disabled={busy || index === 0}
                      onClick={() => step(-1)}
                      className={neutralButton}
                    >
                      Back
                    </button>
                    <button
                      type="button"
                      disabled={busy || index === files.length - 1}
                      onClick={() => step(1)}
                      className={neutralButton}
                    >
                      Next
                    </button>
                  </div>
                </div>

                <pre className="min-h-0 flex-1 overflow-auto py-2 font-mono text-xs">
                  {classifyPatch(current.patch).map((line, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: static lines of a fixed patch
                    <div key={i} className={`whitespace-pre px-3 ${line.className}`}>
                      {line.text || " "}
                    </div>
                  ))}
                </pre>

                <div className="flex flex-col gap-2 border-t border-zinc-200 p-3 dark:border-zinc-800">
                  <input
                    type="text"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="What's wrong with this file? (optional)"
                    className="w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => decide("redo")}
                      className={noButton}
                    >
                      No, redo this
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => decide("remove")}
                      className={noButton}
                    >
                      No, just remove
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => decide("keep")}
                      className={`${buttonClass} border-green-600 bg-green-600 text-white hover:bg-green-700`}
                    >
                      Yes
                    </button>
                    <div className="ml-auto flex gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => show(nextUndecided(paths, marks, index ?? -1))}
                        className={neutralButton}
                      >
                        Skip for later
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={acceptAll}
                        className={neutralButton}
                      >
                        Accept all remaining
                      </button>
                    </div>
                  </div>
                  {saveError && (
                    <p className="text-sm text-red-600 dark:text-red-400">{saveError}</p>
                  )}
                </div>
              </div>
            ) : (
              <div data-testid="review-summary" className="flex-1 p-4" />
            )}
          </div>
        </>
      )}
    </section>
  );
}
