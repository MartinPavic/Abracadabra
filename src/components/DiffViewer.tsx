import { useEffect, useState } from "react";
import { describeError, type FileDiff, getLiveDiff, getRedoDiff, getRunDiff } from "../lib/api";

const statusBadge: Record<string, string> = {
  A: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  M: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  D: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
};
const defaultBadge = "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";

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
function classifyPatch(patch: string): { text: string; className: string }[] {
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

  return (
    <section className="rounded-lg border border-zinc-200 dark:border-zinc-800">
      <div className="flex items-center gap-4 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
        <h2 className="text-xs font-medium uppercase text-zinc-500 dark:text-zinc-400">
          {activeMode === "live"
            ? "Changes so far"
            : activeMode === "redo"
              ? "Since last redo"
              : "Changes"}
          {files ? ` (${files.length} file${files.length === 1 ? "" : "s"})` : ""}
        </h2>
        {live && (
          <span className="text-xs text-zinc-400 dark:text-zinc-500">updates every 5 seconds</span>
        )}
        {redone && !live && (
          <div className="ml-auto flex gap-1 text-xs">
            {(["all", "redo"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setMode(tab)}
                className={`rounded-md px-2 py-1 font-medium ${
                  activeMode === tab
                    ? "bg-zinc-200 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
                    : "text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900"
                }`}
              >
                {tab === "all" ? "All changes" : "Since last redo"}
              </button>
            ))}
          </div>
        )}
      </div>

      {error && <p className="px-4 py-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
      {!error && files === null && (
        <p className="px-4 py-3 text-sm text-zinc-500 dark:text-zinc-400">Loading diff...</p>
      )}
      {files?.length === 0 && (
        <p className="px-4 py-3 text-sm text-zinc-500 dark:text-zinc-400">No changes.</p>
      )}

      {files && files.length > 0 && (
        <div className="flex max-h-[28rem]">
          <ul className="w-64 shrink-0 overflow-auto border-r border-zinc-200 dark:border-zinc-800">
            {files.map((file) => (
              <li key={file.path}>
                <button
                  type="button"
                  onClick={() => setSelected(file.path)}
                  title={file.path}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs ${
                    file.path === selected
                      ? "bg-zinc-100 dark:bg-zinc-900"
                      : "hover:bg-zinc-50 dark:hover:bg-zinc-900/50"
                  }`}
                >
                  <span
                    className={`rounded px-1.5 py-0.5 font-mono font-medium ${statusBadge[file.status] ?? defaultBadge}`}
                  >
                    {file.status}
                  </span>
                  <span className="truncate text-zinc-800 dark:text-zinc-200">{file.path}</span>
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
    </section>
  );
}
