import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import { describeError, listOrphanedStashes, type OrphanedStash, restoreOrphanedStash } from "../lib/api";

const DISMISSED_KEY = "dismissedStashes";

function loadDismissed(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/** Warns about changes the app stashed for a run that no run refers to any more. */
export function OrphanedStashes() {
  const [stashes, setStashes] = useState<OrphanedStash[]>([]);
  const [dismissed, setDismissed] = useState<string[]>(loadDismissed);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    listOrphanedStashes()
      .then(setStashes)
      .catch(() => setStashes([]));
  }, []);

  useEffect(() => {
    refresh();
    const unlisten = listen("run://status", refresh);
    return () => {
      unlisten.then((fn) => fn()).catch(() => undefined);
    };
  }, [refresh]);

  const visible = stashes.filter((stash) => !dismissed.includes(stash.commit));
  if (visible.length === 0) return null;

  function dismiss(commit: string) {
    const next = [...dismissed, commit];
    setDismissed(next);
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(next));
  }

  async function restore(stash: OrphanedStash) {
    setError(null);
    setBusy(true);
    try {
      await restoreOrphanedStash(stash.repoPath, stash.commit);
      refresh();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
      <p className="font-medium">Changes stashed before a run are still waiting</p>
      <ul className="mt-2 flex flex-col gap-2">
        {visible.map((stash) => (
          <li key={stash.commit} className="flex flex-wrap items-center gap-3">
            <span className="font-mono text-xs">{stash.repoPath}</span>
            <button
              type="button"
              disabled={busy}
              onClick={() => restore(stash)}
              className="rounded-md border border-amber-400 px-3 py-1 text-xs font-medium hover:bg-amber-100 disabled:opacity-50 dark:border-amber-800 dark:hover:bg-amber-900/40"
            >
              Restore
            </button>
            <button
              type="button"
              onClick={() => dismiss(stash.commit)}
              className="rounded-md px-3 py-1 text-xs font-medium hover:bg-amber-100 dark:hover:bg-amber-900/40"
            >
              Dismiss
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs">
        Restore applies them to the folder, which must have no uncommitted changes. Dismiss only hides
        this notice; the stash stays in <code>git stash list</code>.
      </p>
      {error && <p className="mt-1 text-xs text-red-700 dark:text-red-400">{error}</p>}
    </div>
  );
}
