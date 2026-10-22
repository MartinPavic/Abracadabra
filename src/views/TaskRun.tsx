import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApprovalActions } from "../components/ApprovalActions";
import { BranchConflictPrompt } from "../components/BranchConflictPrompt";
import { CopyButton } from "../components/CopyButton";
import { DiffViewer } from "../components/DiffViewer";
import { Markdown } from "../components/Markdown";
import { PublishActions } from "../components/PublishActions";
import { RunConsole } from "../components/RunConsole";
import { agentTime, formatDuration, RunStatusPill, RunStepper, useNow } from "../components/RunStatus";
import { useConfig } from "../lib/useConfig";
import {
  cancelRun,
  deleteRun,
  describeError,
  getRun,
  isCancellable,
  isFinished,
  openInIde,
  openUrl,
  redoRun,
  returnToOriginalBranch,
  startRun,
  type RunRecord,
} from "../lib/api";

const panelClass = "rounded-lg border border-zinc-200 dark:border-zinc-800";
const panelTitleClass =
  "border-b border-zinc-200 px-4 py-2 text-xs font-medium uppercase text-zinc-500 dark:border-zinc-800 dark:text-zinc-400";

export function TaskRun() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { config } = useConfig();
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [ideError, setIdeError] = useState<string | null>(null);
  const [run, setRun] = useState<RunRecord | null>(null);
  const now = useNow(run !== null && isCancellable(run.status));
  const [error, setError] = useState<string | null>(null);
  // Identifies the latest load; slower, older responses must not overwrite newer ones.
  const latestLoad = useRef(0);

  const load = useCallback(async () => {
    if (!id) return;
    const thisLoad = ++latestLoad.current;
    try {
      const loaded = await getRun(id);
      if (thisLoad !== latestLoad.current) return;
      setRun(loaded);
      setError(null);
    } catch (err) {
      if (thisLoad === latestLoad.current) setError(describeError(err));
    }
  }, [id]);

  useEffect(() => {
    // Opening another run must not keep showing the previous one.
    setRun(null);
    setError(null);
    setStartError(null);
    setApplyError(null);
    setSwitchError(null);
    setConfirmDelete(false);
    setDeleteError(null);
    setCancelError(null);

    let disposed = false;
    const unlisten = listen<{ runId: string }>("run://status", ({ payload }) => {
      if (payload.runId === id) void load();
    });
    // Load only once subscribed, so a status change in between can't be missed.
    unlisten.then(
      () => !disposed && void load(),
      () => !disposed && void load(),
    );
    return () => {
      disposed = true;
      unlisten.then((fn) => fn()).catch(() => undefined);
    };
  }, [id, load]);

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

  async function handleCancel(target: RunRecord) {
    setCancelError(null);
    setCancelling(true);
    try {
      await cancelRun(target.id);
      await load();
    } catch (err) {
      setCancelError(describeError(err));
    } finally {
      setCancelling(false);
    }
  }

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

  async function switchBack(target: RunRecord) {
    setSwitchError(null);
    setSwitching(true);
    try {
      await returnToOriginalBranch(target.id);
      await load();
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

  if (!run) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-center text-zinc-500 dark:text-zinc-400">
        <h1 className="mb-2 text-xl font-semibold text-zinc-900 dark:text-zinc-100">
          Run not found
        </h1>
        <p className="max-w-sm text-sm">{error ?? "Loading..."}</p>
        <Link to="/tasks" className="mt-3 text-sm underline">
          Back to tasks
        </Link>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto">
      <div>
        <Link to="/tasks" className="text-xs text-zinc-500 hover:underline dark:text-zinc-400">
          &larr; Tasks
        </Link>
        <div className="mt-1 flex items-center gap-3">
          {run.taskUrl ? (
            <button
              type="button"
              onClick={() => openUrl(run.taskUrl)}
              className="text-left text-xl font-semibold text-zinc-900 hover:underline dark:text-zinc-100"
            >
              {run.taskTitle}
            </button>
          ) : (
            <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
              {run.taskTitle}
            </h1>
          )}
          <RunStatusPill status={run.status} />
          {run.testResult && (
            <span
              className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                run.testResult.passed
                  ? "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300"
                  : "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300"
              }`}
            >
              {run.testResult.passed ? "tests passed" : "tests failed"}
            </span>
          )}
        </div>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          {run.project}
          {run.branch ? ` \u00b7 ${run.branch}` : ""}
          {run.baseRef && run.baseCommit
            ? ` \u00b7 from ${run.baseRef} @ ${run.baseCommit.slice(0, 8)}`
            : ""}
          {agentTime(run, now) >= 1000 ? ` \u00b7 agent time ${formatDuration(agentTime(run, now))}` : ""}
          {run.usage.length > 0 ? ` \u00b7 ${run.usage.join(", ")}` : ""}
        </p>
        {config?.ideCommand && run.workDir && run.branch && (
          <div className="mt-1 flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setIdeError(null);
                openInIde(run.id).catch((err) => setIdeError(describeError(err)));
              }}
              className="rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
            >
              Open in editor
            </button>
            {ideError && <span className="text-xs text-red-600 dark:text-red-400">{ideError}</span>}
          </div>
        )}
      </div>

      <RunStepper run={run} />

      {run.fixAttempts > 0 && (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          The worker was re-run {run.fixAttempts} time{run.fixAttempts === 1 ? "" : "s"} to fix failing
          tests.
        </p>
      )}

      {run.reviewVerdict === "changes" &&
        run.status === "awaiting_approval" &&
        config?.reviewerGate !== "off" && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
            The reviewer asked for changes. Use &quot;Apply suggestions&quot; below, or redo the run.
          </div>
        )}

      {run.status === "queued" && run.blockedBy && (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Waiting for <strong>{run.blockedBy}</strong> to be approved or discarded: runs in the same
          project folder go one at a time.
        </p>
      )}

      {isCancellable(run.status) && (
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={cancelling}
            onClick={() => handleCancel(run)}
            className="rounded-md border border-red-300 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950"
          >
            {cancelling ? "Cancelling..." : "Cancel run"}
          </button>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            Stops the agent and undoes the run&apos;s changes in your folder.
          </span>
          {cancelError && <span className="text-sm text-red-600 dark:text-red-400">{cancelError}</span>}
        </div>
      )}

      {run.error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {run.error}
        </div>
      )}

      {run.redoError && run.status === "awaiting_approval" && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          The last automatic redo didn&apos;t go through; the earlier result is unchanged: {run.redoError}
        </div>
      )}

      {run.originalRef &&
        run.branch &&
        (run.status === "awaiting_approval" ||
          run.status === "approved" ||
          run.status === "handed_off") && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-200 px-4 py-3 text-sm text-zinc-700 dark:border-zinc-800 dark:text-zinc-300">
            <span>
              Your project folder is on <code>{run.branch}</code>.
              {run.stashCommit && " Your earlier uncommitted changes are stashed."}
            </span>
            <button
              type="button"
              disabled={switching}
              onClick={() => switchBack(run)}
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
            >
              {switching ? "Switching..." : `Switch back to ${run.originalRef}`}
            </button>
            {switchError && <span className="text-red-600 dark:text-red-400">{switchError}</span>}
          </div>
        )}

      {run.stashCommit &&
        (run.status === "failed" || run.status === "discarded" || run.status === "cancelled") && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          Your uncommitted changes from before this run are still in the stash (
          <code>git stash list</code> in the project folder).
        </div>
      )}

      {run.status === "failed" && run.branchConflict && (
        <BranchConflictPrompt
          key={run.id}
          runId={run.id}
          branch={run.branchConflict.branch}
          suggestion={run.branchConflict.suggestion}
        />
      )}

      {run.workerSummary?.trim() && !run.planOnly && (
        <section className={panelClass}>
          <h2 className={`${panelTitleClass} flex items-center`}>
            Worker summary
            <CopyButton text={run.workerSummary} />
          </h2>
          <Markdown>{run.workerSummary}</Markdown>
        </section>
      )}

      {run.planOnly && run.workerSummary && (
        <section className={panelClass}>
          <h2 className={`${panelTitleClass} flex items-center`}>
            Plan
            <CopyButton text={run.workerSummary} />
          </h2>
          <Markdown>{run.workerSummary}</Markdown>
        </section>
      )}

      {run.status === "planned" && (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={starting}
            onClick={() => startFromPlanRun(run, true)}
            className="rounded-md border border-zinc-900 bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            Run from plan
          </button>
          <button
            type="button"
            disabled={starting}
            onClick={() => startFromPlanRun(run, false)}
            className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
          >
            Run from task description
          </button>
          {startError && <span className="text-sm text-red-600 dark:text-red-400">{startError}</span>}
        </div>
      )}

      {run.testResult?.output && (
        <details className={panelClass} open={!run.testResult.passed}>
          <summary className="cursor-pointer px-4 py-2 text-xs font-medium uppercase text-zinc-500 dark:text-zinc-400">
            Test output
          </summary>
          <pre className="max-h-64 overflow-auto border-t border-zinc-200 px-4 py-3 font-mono text-xs whitespace-pre-wrap text-zinc-800 dark:border-zinc-800 dark:text-zinc-200">
            {run.testResult.output}
          </pre>
        </details>
      )}

      {run.reviewNotes && (
        <section className={panelClass}>
          <h2 className={`${panelTitleClass} flex items-center gap-2`}>
            Reviewer notes
            {run.reviewVerdict && (
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] normal-case ${
                  run.reviewVerdict === "approve"
                    ? "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300"
                    : "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300"
                }`}
              >
                {run.reviewVerdict === "approve" ? "approve" : "changes requested"}
              </span>
            )}
            <CopyButton text={run.reviewNotes} />
          </h2>
          <Markdown>{run.reviewNotes}</Markdown>
          {!run.planOnly && (
            <div className="flex flex-wrap items-center gap-3 border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
              <button
                type="button"
                disabled={run.status !== "awaiting_approval" || applying}
                onClick={() => applySuggestions(run)}
                title="Redo the changes with these notes as feedback"
                className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
              >
                {applying ? "Applying..." : "Apply suggestions"}
              </button>
              {applyError && <span className="text-sm text-red-600 dark:text-red-400">{applyError}</span>}
            </div>
          )}
        </section>
      )}

      {(run.status === "working" || run.status === "reviewing") && !run.planOnly && (
        <DiffViewer runId={run.id} live />
      )}

      {(run.status === "awaiting_approval" || run.status === "approved") && (
        <DiffViewer runId={run.id} redone={Boolean(run.previousCommitSha)} />
      )}

      {!run.planOnly && <ApprovalActions runId={run.id} status={run.status} />}
      {(run.status === "approved" || run.status === "handed_off") && (
        <PublishActions run={run} onChanged={load} />
      )}

      <RunConsole runId={run.id} />

      {isFinished(run.status) && (
        <div className="flex flex-wrap items-center gap-3">
          {confirmDelete ? (
            <>
              <span className="text-sm text-zinc-700 dark:text-zinc-300">
                Delete this run from the history? Its branch and commits stay in the repository.
              </span>
              <button
                type="button"
                onClick={() => handleDelete(run)}
                className="rounded-md border border-red-600 bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
              >
                Delete run
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
            >
              Delete run
            </button>
          )}
          {deleteError && <span className="text-sm text-red-600 dark:text-red-400">{deleteError}</span>}
        </div>
      )}
    </div>
  );
}
