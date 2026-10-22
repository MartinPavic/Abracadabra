import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { describeError, retryRunWithBranch } from "../lib/api";

/** Offers a new branch name when a run failed because its branch already exists. */
export function BranchConflictPrompt({
  runId,
  branch,
  suggestion,
}: {
  runId: string;
  branch: string;
  suggestion: string;
}) {
  const navigate = useNavigate();
  const [name, setName] = useState(suggestion);
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (dismissed) return null;

  async function handleCreate() {
    setBusy(true);
    setError(null);
    try {
      navigate(`/tasks/${await retryRunWithBranch(runId, name)}`);
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/30">
      <p className="text-sm text-amber-900 dark:text-amber-200">
        The branch <code className="font-mono">{branch}</code> already exists. Create a new branch
        and run again?
      </p>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        aria-label="New branch name"
        className="w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 font-mono text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
      />
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy || name.trim() === ""}
          onClick={handleCreate}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          {busy ? "Starting..." : "Create new branch & run"}
        </button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="rounded-md px-3 py-1.5 text-sm text-zinc-600 hover:underline dark:text-zinc-400"
        >
          No, keep it failed
        </button>
      </div>
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
    </section>
  );
}
