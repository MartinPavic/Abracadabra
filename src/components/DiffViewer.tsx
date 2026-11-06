import { useEffect, useState } from "react";
import { describeError, type FileDiff, getLiveDiff, getRedoDiff, getRunDiff } from "../lib/api";
import { Card, Notice, Spinner } from "./ui";

const statusLetter: Record<string, string> = {
  A: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  M: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  D: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
};

/** Git's status letter for a file (A, M, D, ...). */
export function FileStatusLetter({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex min-w-5 shrink-0 justify-center rounded px-1 py-0.5 font-mono text-xs font-semibold ${
        statusLetter[status] ?? "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
      }`}
    >
      {status}
    </span>
  );
}

const headerClass = "text-zinc-400 dark:text-zinc-500";
const hunkClass = "bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300";
const addedClass = "bg-green-50 text-green-800 dark:bg-green-950/40 dark:text-green-300";
const removedClass = "bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300";
const contextClass = "text-zinc-700 dark:text-zinc-300";

/**
 * Styles each line of a unified diff. Everything before the first hunk is git's
 * header; inside hunks only the first character matters, so a removed line
 * "-- comment" (shown as "--- comment") is not mistaken for a header.
 */
export function classifyPatch(patch: string): { text: string; className: string }[] {
  let inHunk = false;
  const inHeader = patch.startsWith("diff --git");
  return patch
    .replace(/\n$/, "")
    .split("\n")
    .map((text) => {
      if (text.startsWith("@@")) {
        inHunk = true;
        return { text, className: hunkClass };
      }
      if (!inHunk) return { text, className: inHeader ? headerClass : contextClass };
      if (text.startsWith("+")) return { text, className: addedClass };
      if (text.startsWith("-")) return { text, className: removedClass };
      return { text, className: contextClass };
    });
}

/**
 * File list + unified diff of a run's committed changes; after a redo, also what
 * the redo changed. With `live`, shows the uncommitted changes of a run that is
 * still working and refreshes them every few seconds.
 */
export function DiffViewer({
  runId,
  redone = false,
  live = false,
}: {
  runId: string;
  redone?: boolean;
  live?: boolean;
}) {
  const [mode, setMode] = useState<"all" | "redo">("all");
  const [files, setFiles] = useState<FileDiff[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const activeMode = live ? "live" : redone ? mode : "all";

  useEffect(() => {
    let cancelled = false;
    setFiles(null);
    setError(null);
    const fetchDiff = () =>
      activeMode === "live"
        ? getLiveDiff(runId)
        : activeMode === "redo"
          ? getRedoDiff(runId)
          : getRunDiff(runId);
    const load = (keepSelection: boolean) =>
      fetchDiff()
        .then((result) => {
          if (cancelled) return;
          setFiles(result);
          setError(null);
          setSelected((current) =>
            keepSelection && result.some((f) => f.path === current)
              ? current
              : (result[0]?.path ?? null),
          );
        })
        .catch((err) => !cancelled && setError(describeError(err)));
    void load(false);
    const timer = activeMode === "live" ? setInterval(() => void load(true), 5000) : null;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [runId, activeMode]);

  const current = files?.find((f) => f.path === selected) ?? null;
  const title =
    (activeMode === "live" ? "Changes so far" : activeMode === "redo" ? "Since last redo" : "Changes") +
    (files ? ` (${files.length} file${files.length === 1 ? "" : "s"})` : "");

  return (
    <Card
      padded={false}
      title={title}
      description={live ? "updates every 5 seconds" : undefined}
      actions={
        redone &&
        !live && (
          <div className="inline-flex rounded-lg border border-zinc-200 p-0.5 dark:border-zinc-700">
            {(["all", "redo"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                aria-pressed={activeMode === tab}
                onClick={() => setMode(tab)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 ${
                  activeMode === tab
                    ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
                    : "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                }`}
              >
                {tab === "all" ? "All changes" : "Since last redo"}
              </button>
            ))}
          </div>
        )
      }
    >
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

      {files && files.length > 0 && (
        <div className="flex max-h-[28rem]">
          <ul className="w-56 shrink-0 overflow-auto border-r border-zinc-200 py-1 lg:w-64 dark:border-zinc-800">
            {files.map((file) => (
              <li key={file.path}>
                <button
                  type="button"
                  onClick={() => setSelected(file.path)}
                  title={file.path}
                  aria-current={file.path === selected || undefined}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-500 ${
                    file.path === selected
                      ? "bg-accent-50 font-medium text-accent-900 dark:bg-accent-950/40 dark:text-accent-100"
                      : "text-zinc-800 hover:bg-zinc-50 dark:text-zinc-200 dark:hover:bg-zinc-800/50"
                  }`}
                >
                  <FileStatusLetter status={file.status} />
                  <span className="truncate">{file.path}</span>
                </button>
              </li>
            ))}
          </ul>

          <pre className="min-w-0 flex-1 overflow-auto py-2 font-mono text-xs">
            {current &&
              classifyPatch(current.patch).map((line, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static lines of a fixed patch
                <div key={index} className={`whitespace-pre px-3 ${line.className}`}>
                  {line.text || " "}
                </div>
              ))}
          </pre>
        </div>
      )}
    </Card>
  );
}
