import { useState } from "react";
import { describeError, discardRun, handOffRun } from "../lib/api";

const buttonClass =
  "rounded-md border px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50";
const neutralButton = `${buttonClass} border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900`;

/** Discard (after confirmation) or hand off a run awaiting approval. */
export function RunEscapeActions({
  runId,
  onChanged,
  disabled = false,
}: {
  runId: string;
  onChanged: () => void;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

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
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={disabled || busy}
          onClick={() => setConfirmDiscard(true)}
          className={`${buttonClass} border-red-300 text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950`}
        >
          Discard run
        </button>
        <button
          type="button"
          disabled={disabled || busy}
          onClick={() => perform(() => handOffRun(runId))}
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
            onClick={() => perform(() => discardRun(runId))}
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
    </div>
  );
}
