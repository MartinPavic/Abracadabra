import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { describeError, retryRunWithBranch } from "../lib/api";
import { Button, Input, Notice } from "./ui";

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
    <Notice tone="warning" role="status">
      <div className="flex flex-col gap-3">
        <p>
          The branch <code className="break-all font-mono">{branch}</code> already exists. Create a
          new branch and run again?
        </p>
        <Input mono value={name} onChange={(e) => setName(e.target.value)} aria-label="New branch name" />
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            icon="branch"
            loading={busy}
            disabled={name.trim() === ""}
            onClick={handleCreate}
          >
            {busy ? "Starting..." : "Create new branch & run"}
          </Button>
          <Button variant="ghost" onClick={() => setDismissed(true)}>
            No, keep it failed
          </Button>
        </div>
        {error && <p className="font-medium text-red-700 dark:text-red-300">{error}</p>}
      </div>
    </Notice>
  );
}
