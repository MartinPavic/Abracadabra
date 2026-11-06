import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { BranchConflictPrompt } from "../../components/BranchConflictPrompt";
import { CopyButton } from "../../components/CopyButton";
import { Markdown } from "../../components/Markdown";
import { PrLensDiagram } from "../../components/PrLensDiagram";
import { PublishActions } from "../../components/PublishActions";
import { Badge, Button, Card, Notice } from "../../components/ui";
import {
  type AppConfig,
  describeError,
  redoRun,
  returnToOriginalBranch,
  startRun,
  type RunRecord,
} from "../../lib/api";

export function OverviewTab({
  run,
  config,
  reload,
}: {
  run: RunRecord;
  config: AppConfig | null;
  reload: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);

  async function startFromPlanRun(planRun: RunRecord, usePlan: boolean) {
    setStartError(null);
    setStarting(true);
    try {
      const newRunId = await startRun(
        planRun.sourceId,
        planRun.taskId,
        false,
        usePlan ? planRun.id : undefined,
      );
      navigate(`/tasks/${newRunId}`);
    } catch (err) {
      setStartError(describeError(err));
    } finally {
      setStarting(false);
    }
  }

  async function switchBack(target: RunRecord) {
    setSwitchError(null);
    setSwitching(true);
    try {
      await returnToOriginalBranch(target.id);
      await reload();
    } catch (err) {
      setSwitchError(describeError(err));
    } finally {
      setSwitching(false);
    }
  }

  async function applySuggestions(reviewed: RunRecord) {
    setApplyError(null);
    setApplying(true);
    try {
      await redoRun(
        reviewed.id,
        `Apply the suggestions from this code review to the current changes. Skip any that are wrong or out of scope for the task.\n\n${reviewed.reviewNotes ?? ""}`,
      );
    } catch (err) {
      setApplyError(describeError(err));
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {run.status === "queued" && run.blockedBy && (
        <Notice>
          Waiting for <strong>{run.blockedBy}</strong> to be approved or discarded: runs in the same
          project folder go one at a time.
        </Notice>
      )}

      {run.error && <Notice tone="danger">{run.error}</Notice>}

      {run.reviewVerdict === "changes" &&
        run.status === "awaiting_approval" &&
        config?.reviewerGate !== "off" && (
          <Notice tone="danger">
            The reviewer asked for changes. Use &quot;Apply suggestions&quot; below, or redo the run.
          </Notice>
        )}

      {run.redoError && run.status === "awaiting_approval" && (
        <Notice tone="warning">
          The last automatic redo didn&apos;t go through; the earlier result is unchanged: {run.redoError}
        </Notice>
      )}

      {run.originalRef &&
        run.branch &&
        (run.status === "awaiting_approval" ||
          run.status === "approved" ||
          run.status === "handed_off") && (
          <Notice
            actions={
              <>
                {switchError && <span className="text-red-600 dark:text-red-400">{switchError}</span>}
                <Button size="sm" disabled={switching} onClick={() => switchBack(run)}>
                  {switching ? "Switching..." : `Switch back to ${run.originalRef}`}
                </Button>
              </>
            }
          >
            Your project folder is on <code className="break-all font-mono">{run.branch}</code>.
            {run.stashCommit && " Your earlier uncommitted changes are stashed."}
          </Notice>
        )}

      {run.stashCommit &&
        (run.status === "failed" || run.status === "discarded" || run.status === "cancelled") && (
          <Notice tone="warning">
            Your uncommitted changes from before this run are still in the stash (
            <code className="font-mono">git stash list</code> in the project folder).
          </Notice>
        )}

      {run.removedFiles.length > 0 && (
        <Notice tone="warning">
          These files were removed during review, after the tests and code review ran:{" "}
          {run.removedFiles.join(", ")}. Run the tests again before publishing.
        </Notice>
      )}

      {run.fixAttempts > 0 && (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          The worker was re-run {run.fixAttempts} time{run.fixAttempts === 1 ? "" : "s"} to fix failing
          tests.
        </p>
      )}

      {run.status === "failed" && run.branchConflict && (
        <BranchConflictPrompt
          key={run.id}
          runId={run.id}
          branch={run.branchConflict.branch}
          suggestion={run.branchConflict.suggestion}
        />
      )}

      {(run.status === "approved" || run.status === "handed_off") && (
        <PublishActions run={run} onChanged={reload} />
      )}

      {run.workerSummary?.trim() && !run.planOnly && (
        <Card title="Worker summary" actions={<CopyButton text={run.workerSummary} />} padded={false}>
          <Markdown>{run.workerSummary}</Markdown>
        </Card>
      )}

      {run.planOnly && run.workerSummary && (
        <Card title="Plan" actions={<CopyButton text={run.workerSummary} />} padded={false}>
          <Markdown>{run.workerSummary}</Markdown>
        </Card>
      )}

      {run.status === "planned" && (
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" icon="play" disabled={starting} onClick={() => startFromPlanRun(run, true)}>
            Run from plan
          </Button>
          <Button disabled={starting} onClick={() => startFromPlanRun(run, false)}>
            Run from task description
          </Button>
          {startError && <span className="text-sm text-red-600 dark:text-red-400">{startError}</span>}
        </div>
      )}

      {run.reviewNotes && (
        <Card
          title={
            <span className="flex items-center gap-2">
              Reviewer notes
              {run.reviewVerdict && (
                <Badge tone={run.reviewVerdict === "approve" ? "success" : "danger"}>
                  {run.reviewVerdict === "approve" ? "approve" : "changes requested"}
                </Badge>
              )}
            </span>
          }
          actions={<CopyButton text={run.reviewNotes} />}
          padded={false}
        >
          <Markdown>{run.reviewNotes}</Markdown>
          {!run.planOnly && (
            <div className="flex flex-wrap items-center gap-3 border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
              <Button
                disabled={run.status !== "awaiting_approval" || applying}
                onClick={() => applySuggestions(run)}
                title="Redo the changes with these notes as feedback"
              >
                {applying ? "Applying..." : "Apply suggestions"}
              </Button>
              {applyError && <span className="text-sm text-red-600 dark:text-red-400">{applyError}</span>}
            </div>
          )}
        </Card>
      )}

      {run.testResult?.output && (
        <details
          className="rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
          open={!run.testResult.passed}
        >
          <summary className="cursor-pointer rounded-xl px-4 py-3 text-sm font-semibold text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 dark:text-zinc-100">
            Test output
          </summary>
          <pre className="max-h-64 overflow-auto border-t border-zinc-200 px-4 py-3 font-mono text-xs whitespace-pre-wrap text-zinc-800 dark:border-zinc-800 dark:text-zinc-200">
            {run.testResult.output}
          </pre>
        </details>
      )}

      {(run.status === "awaiting_approval" || run.status === "approved" || run.status === "handed_off") &&
        !run.planOnly && (
          <PrLensDiagram
            run={run}
            baseUrl={config?.gitSources.find((source) => source.id === run.sourceId)?.baseUrl}
          />
        )}
    </div>
  );
}
