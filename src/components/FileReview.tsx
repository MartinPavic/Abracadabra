import { useEffect, useRef, useState } from "react";
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
import { classifyPatch, FileStatusLetter } from "./DiffViewer";
import { ReviewSummary } from "./ReviewSummary";
import { RunEscapeActions } from "./RunEscapeActions";
import { Button, Card, Icon, type IconName, Input, Notice, Spinner } from "./ui";

const markers: Record<Decision | "undecided", { icon: IconName | null; label: string; className: string }> =
  {
    keep: { icon: "check", label: "Keep", className: "text-green-600 dark:text-green-400" },
    remove: { icon: "x", label: "Remove", className: "text-red-600 dark:text-red-400" },
    redo: { icon: "refresh", label: "Redo", className: "text-amber-600 dark:text-amber-400" },
    undecided: { icon: null, label: "Undecided", className: "text-zinc-400 dark:text-zinc-500" },
  };

function isTyping(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

/** One file at a time: keep it, remove it, or ask for a redo; the summary follows once all are decided. */
export function FileReview({ run, onChanged }: { run: RunRecord; onChanged: () => void }) {
  const [files, setFiles] = useState<FileDiff[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [marks, setMarks] = useState<Record<string, FileMark>>({});
  const [generalNote, setGeneralNote] = useState("");
  // null means the summary is shown.
  const [index, setIndex] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

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
    setGeneralNote("");
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
      if (event.repeat || busy || !current || event.metaKey || event.ctrlKey || event.altKey) return;
      // Handled elsewhere (e.g. tab arrow keys), or the review sits in a hidden tab panel.
      if (event.defaultPrevented || root.current?.closest("[hidden]")) return;
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
    <Card padded={false}>
      <div ref={root}>
        {error && (
          <div className="p-4">
            <Notice tone="danger">{error}</Notice>
          </div>
        )}
        {!error && files === null && (
          <p className="flex items-center gap-2 px-4 py-3 text-sm text-zinc-500 dark:text-zinc-400">
            <Spinner decorative />
            Loading diff...
          </p>
        )}
        {files?.length === 0 && (
          <p className="px-4 py-3 text-sm text-zinc-500 dark:text-zinc-400">No changes.</p>
        )}
        {(files === null || files.length === 0) && (
          <div className="px-4 pb-4">
            <RunEscapeActions runId={run.id} onChanged={onChanged} />
          </div>
        )}

        {files && files.length > 0 && (
          <>
            <div className="flex items-center gap-4 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
              <h2 className="shrink-0 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                {index === null ? "Summary" : `File ${index + 1} of ${files.length}`}
              </h2>
              <div
                role="progressbar"
                aria-label="Files decided"
                aria-valuemin={0}
                aria-valuenow={decided}
                aria-valuemax={files.length}
                className="flex min-w-0 flex-1 gap-0.5"
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
              <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">
                {`${decided} of ${files.length} decided`}
              </span>
            </div>

            <div className="flex max-h-[32rem]">
              <ul className="w-56 shrink-0 overflow-auto border-r border-zinc-200 py-1 lg:w-64 dark:border-zinc-800">
                {files.map((file, i) => {
                  const marker = markers[marks[file.path]?.decision ?? "undecided"];
                  return (
                    <li key={file.path}>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => show(i)}
                        title={file.path}
                        aria-current={i === index || undefined}
                        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-500 disabled:cursor-not-allowed ${
                          i === index
                            ? "bg-accent-50 font-medium text-accent-900 dark:bg-accent-950/40 dark:text-accent-100"
                            : "text-zinc-800 hover:bg-zinc-50 dark:text-zinc-200 dark:hover:bg-zinc-800/50"
                        }`}
                      >
                        <span
                          role="img"
                          aria-label={marker.label}
                          title={marker.label}
                          className={`flex size-4 shrink-0 items-center justify-center ${marker.className}`}
                        >
                          {marker.icon ? (
                            <Icon name={marker.icon} className="size-3.5" />
                          ) : (
                            <span className="size-2.5 rounded-full border-[1.5px] border-current" />
                          )}
                        </span>
                        <span className="truncate">{file.path}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>

              {current ? (
                <div className="flex min-w-0 flex-1 flex-col">
                  <div className="flex min-w-0 items-center gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
                    <FileStatusLetter status={current.status} />
                    <h3
                      title={current.path}
                      className="min-w-0 truncate font-mono text-sm text-zinc-800 dark:text-zinc-200"
                    >
                      {current.path}
                    </h3>
                    <div className="ml-auto flex shrink-0 gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy || index === 0}
                        onClick={() => step(-1)}
                      >
                        Back
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy || index === files.length - 1}
                        onClick={() => step(1)}
                      >
                        Next
                      </Button>
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

                  {/* Sticky so the decisions stay in view when the review is taller than the window. */}
                  <div
                    role="group"
                    aria-label="Decide on this file"
                    className="sticky bottom-0 z-10 flex flex-col gap-2 border-t border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900"
                  >
                    <Input
                      type="text"
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="What's wrong with this file? (optional)"
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      <Button icon="refresh" disabled={busy} onClick={() => decide("redo")}>
                        No, redo this
                      </Button>
                      <Button disabled={busy} onClick={() => decide("remove")}>
                        <Icon name="x" className="size-4 text-red-600 dark:text-red-400" />
                        No, just remove
                      </Button>
                      <Button
                        variant="primary"
                        icon="check"
                        disabled={busy}
                        onClick={() => decide("keep")}
                      >
                        Yes
                      </Button>
                      <div className="ml-auto flex flex-wrap gap-2">
                        <Button
                          variant="ghost"
                          disabled={busy}
                          onClick={() => show(nextUndecided(paths, marks, index ?? -1))}
                        >
                          Skip for later
                        </Button>
                        <Button variant="ghost" disabled={busy} onClick={acceptAll}>
                          Accept all remaining
                        </Button>
                      </div>
                    </div>
                    {saveError && <Notice tone="danger">{saveError}</Notice>}
                  </div>
                </div>
              ) : (
                <ReviewSummary
                  run={run}
                  paths={paths}
                  marks={marks}
                  generalNote={generalNote}
                  onGeneralNoteChange={setGeneralNote}
                  onJump={(path) => show(paths.indexOf(path))}
                  onChanged={onChanged}
                />
              )}
            </div>
          </>
        )}
      </div>
    </Card>
  );
}
