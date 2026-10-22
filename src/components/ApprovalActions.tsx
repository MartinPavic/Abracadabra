import { useState } from "react";
import { approveRun, describeError, discardRun, handOffRun, redoRun, type RunStatus } from "../lib/api";

const buttonClass =
  "rounded-md border px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50";
const neutralButton = `${buttonClass} border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900`;

/** Yes / No / Redo automatically / Redo manually — enabled only while the run awaits approval. */
export function ApprovalActions({ runId, status }: { runId: string; status: RunStatus }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [redoOpen, setRedoOpen] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const enabled = status === "awaiting_approval" && !busy;

  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setRedoOpen(false);
      setFeedback("");
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
      setConfirmDiscard(false);
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={!enabled}
          onClick={() => perform(() => approveRun(runId))}
          className={`${buttonClass} border-green-600 bg-green-600 text-white hover:bg-green-700`}
        >
          Yes
        </button>
        <button
          type="button"
          disabled={!enabled}
          onClick={() => setConfirmDiscard(true)}
          className={`${buttonClass} border-red-300 text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950`}
        >
          No
        </button>
        <button
          type="button"
          disabled={!enabled}
          onClick={() => setRedoOpen((open) => !open)}
          className={neutralButton}
        >
          Redo automatically
        </button>
        <button
          type="button"
          disabled={!enabled}
          onClick={() => perform(() => handOffRun(runId))}
          className={neutralButton}
        >
          Redo manually
        </button>
        {status !== "awaiting_approval" && (
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            Available once the run is awaiting approval.
          </span>
        )}
      </div>

      {confirmDiscard && enabled && (
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

      {redoOpen && enabled && (
        <div className="flex flex-col gap-2">
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            rows={3}
            placeholder="What should the agent change? This is added to the worker prompt."
            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          />
          <div>
            <button
              type="button"
              disabled={feedback.trim() === ""}
              onClick={() => perform(() => redoRun(runId, feedback.trim()))}
              className={neutralButton}
            >
              Run again
            </button>
          </div>
        </div>
      )}

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
    </section>
  );
}
