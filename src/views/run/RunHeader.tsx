import { useState } from "react";
import { Link } from "react-router-dom";
import { agentTime, formatDuration, useNow } from "../../components/RunStatus";
import { Badge, Button, Icon, StatusBadge } from "../../components/ui";
import {
  type AppConfig,
  cancelRun,
  describeError,
  isCancellable,
  openInIde,
  openUrl,
  type RunRecord,
} from "../../lib/api";

export function RunHeader({
  run,
  config,
  reload,
}: {
  run: RunRecord;
  config: AppConfig | null;
  reload: () => Promise<void>;
}) {
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [ideError, setIdeError] = useState<string | null>(null);
  const cancellable = isCancellable(run.status);
  const now = useNow(cancellable);
  const showIde = Boolean(config?.ideCommand && run.workDir && run.branch);

  async function handleCancel(target: RunRecord) {
    setCancelError(null);
    setCancelling(true);
    try {
      await cancelRun(target.id);
      await reload();
    } catch (err) {
      setCancelError(describeError(err));
    } finally {
      setCancelling(false);
    }
  }

  return (
    <header className="flex flex-col gap-2">
      <Link
        to="/tasks"
        className="inline-flex w-fit items-center gap-1 rounded text-xs text-zinc-500 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 dark:text-zinc-400 dark:hover:text-zinc-100"
      >
        <Icon name="chevron-right" className="size-3.5 rotate-180" />
        Tasks
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-3">
            <h1
              title={run.taskTitle}
              className="min-w-0 truncate text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100"
            >
              {run.taskUrl ? (
                <button
                  type="button"
                  onClick={() => openUrl(run.taskUrl)}
                  className="block max-w-full truncate rounded text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
                >
                  {run.taskTitle}
                </button>
              ) : (
                run.taskTitle
              )}
            </h1>
            <StatusBadge status={run.status} />
            {run.testResult && (
              <Badge tone={run.testResult.passed ? "success" : "danger"}>
                {run.testResult.passed ? "tests passed" : "tests failed"}
              </Badge>
            )}
            {run.reviewVerdict && (
              <Badge tone={run.reviewVerdict === "approve" ? "success" : "danger"}>
                {run.reviewVerdict === "approve" ? "review approved" : "review: changes requested"}
              </Badge>
            )}
          </div>
          <p className="mt-1 break-words text-xs text-zinc-500 dark:text-zinc-400">
            {run.project}
            {run.branch ? ` \u00b7 ${run.branch}` : ""}
            {run.baseRef && run.baseCommit
              ? ` \u00b7 from ${run.baseRef} @ ${run.baseCommit.slice(0, 8)}`
              : ""}
            {agentTime(run, now) >= 1000 ? ` \u00b7 agent time ${formatDuration(agentTime(run, now))}` : ""}
            {run.usage.length > 0 ? ` \u00b7 ${run.usage.join(", ")}` : ""}
          </p>
        </div>
        {(showIde || cancellable) && (
          <div className="flex max-w-sm flex-col items-end gap-1 text-right">
            <div className="flex items-center gap-2">
              {showIde && (
                <Button
                  size="sm"
                  icon="external"
                  onClick={() => {
                    setIdeError(null);
                    openInIde(run.id).catch((err) => setIdeError(describeError(err)));
                  }}
                >
                  Open in editor
                </Button>
              )}
              {cancellable && (
                <Button size="sm" variant="danger" icon="stop" disabled={cancelling} onClick={() => handleCancel(run)}>
                  {cancelling ? "Cancelling..." : "Cancel run"}
                </Button>
              )}
            </div>
            {cancellable && (
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                Stops the agent and undoes the run&apos;s changes in your folder.
              </span>
            )}
            {ideError && <span className="text-xs text-red-600 dark:text-red-400">{ideError}</span>}
            {cancelError && <span className="text-sm text-red-600 dark:text-red-400">{cancelError}</span>}
          </div>
        )}
      </div>
    </header>
  );
}
