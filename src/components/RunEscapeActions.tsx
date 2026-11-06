import { useState } from "react";
import { describeError, discardRun, handOffRun } from "../lib/api";
import { Button, Notice } from "./ui";

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
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="danger"
          icon="trash"
          disabled={disabled || busy}
          onClick={() => setConfirmDiscard(true)}
        >
          Discard run
        </Button>
        <Button
          icon="external"
          disabled={disabled || busy}
          onClick={() => perform(() => handOffRun(runId))}
        >
          Open in editor / hand off
        </Button>
      </div>

      {confirmDiscard && !busy && (
        <Notice
          tone="danger"
          actions={
            <>
              <Button variant="danger" size="sm" onClick={() => perform(() => discardRun(runId))}>
                Yes, discard
              </Button>
              <Button size="sm" onClick={() => setConfirmDiscard(false)}>
                Cancel
              </Button>
            </>
          }
        >
          Discard this run? Its branch is deleted and your folder goes back to how it was (stashed
          changes restored). Uncommitted edits on the branch are lost.
        </Notice>
      )}

      {error && <Notice tone="danger">{error}</Notice>}
    </div>
  );
}
