import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { RunConsole } from "../../components/RunConsole";
import { RunStepper } from "../../components/RunStatus";
import { Button, Card } from "../../components/ui";
import { deleteRun, describeError, isFinished, type RunRecord } from "../../lib/api";

export function ActivityTab({ run }: { run: RunRecord }) {
  const navigate = useNavigate();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function handleDelete(target: RunRecord) {
    setDeleteError(null);
    try {
      await deleteRun(target.id);
      navigate("/tasks");
    } catch (err) {
      setDeleteError(describeError(err));
      setConfirmDelete(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <RunStepper run={run} />
      </Card>

      <RunConsole runId={run.id} />

      {isFinished(run.status) && (
        <div className="flex flex-wrap items-center gap-3">
          {confirmDelete ? (
            <>
              <span className="text-sm text-zinc-700 dark:text-zinc-300">
                Delete this run from the history? Its branch and commits stay in the repository.
              </span>
              <Button variant="danger" icon="trash" onClick={() => handleDelete(run)}>
                Delete run
              </Button>
              <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
            </>
          ) : (
            <Button icon="trash" onClick={() => setConfirmDelete(true)}>
              Delete run
            </Button>
          )}
          {deleteError && <span className="text-sm text-red-600 dark:text-red-400">{deleteError}</span>}
        </div>
      )}
    </div>
  );
}
