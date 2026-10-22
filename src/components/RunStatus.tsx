import { useEffect, useState } from "react";
import { isCancellable, type RunRecord, type RunStatus } from "../lib/api";

/** "45s", "3m 12s", "1h 05m". */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * Time spent in each status, summed over redos. The status a run is in right
 * now counts up to `now`; finished runs and a run awaiting a decision stop at
 * their last transition.
 */
export function statusDurations(run: RunRecord, now: number): Map<RunStatus, number> {
  const totals = new Map<RunStatus, number>();
  run.history.forEach((entry, index) => {
    const next = run.history[index + 1];
    const end = next ? next.atMs : isCancellable(entry.status) ? now : entry.atMs;
    totals.set(entry.status, (totals.get(entry.status) ?? 0) + Math.max(0, end - entry.atMs));
  });
  return totals;
}

/** Time the agent steps took (fetch, worker, reviewer, commit), excluding queueing and waiting for you. */
export function agentTime(run: RunRecord, now: number): number {
  const totals = statusDurations(run, now);
  return (["cloning", "working", "reviewing", "committing"] as const).reduce(
    (sum, status) => sum + (totals.get(status) ?? 0),
    0,
  );
}

/** Re-renders every second while `active`, so running steps show a live time. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

const pillClass: Record<RunStatus, string> = {
  queued: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  cloning: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  working: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  reviewing: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  committing: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  awaiting_approval: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  approved: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  discarded: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-400",
  handed_off: "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300",
  planned: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300",
  failed: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  cancelled: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-400",
};

export function RunStatusPill({ status }: { status: RunStatus }) {
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${pillClass[status]}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

type Step = { label: string; status: RunStatus };

const STEPS: Step[] = [
  { label: "Fetch", status: "cloning" },
  { label: "Worker", status: "working" },
  { label: "Reviewer", status: "reviewing" },
  { label: "Commit", status: "committing" },
  { label: "Approval", status: "awaiting_approval" },
];

const PLAN_STEPS: Step[] = [
  { label: "Fetch", status: "cloning" },
  { label: "Plan", status: "working" },
];

/** Index of the step a run is on (steps.length once every step is behind it), and whether it failed or was cancelled there. */
function progress(
  run: RunRecord,
  steps: Step[],
): { current: number; failed: boolean; cancelled: boolean } {
  const stepIndex = (status: RunStatus) => steps.findIndex((s) => s.status === status);
  if (
    run.status === "approved" ||
    run.status === "discarded" ||
    run.status === "handed_off" ||
    run.status === "planned"
  ) {
    return { current: steps.length, failed: false, cancelled: false };
  }
  if (run.status === "failed" || run.status === "cancelled") {
    // The last step it reached that this run's steps include (a redo adds `queued`, which isn't one).
    const reached = run.history
      .filter((h) => h.status !== run.status && stepIndex(h.status) >= 0)
      .map((h) => stepIndex(h.status));
    return {
      current: reached.length > 0 ? reached[reached.length - 1] : -1,
      failed: run.status === "failed",
      cancelled: run.status === "cancelled",
    };
  }
  return { current: stepIndex(run.status), failed: false, cancelled: false };
}

/** fetch -> worker -> reviewer -> commit -> approval (fetch -> plan for plan-only runs) */
export function RunStepper({ run }: { run: RunRecord }) {
  const steps = run.planOnly ? PLAN_STEPS : STEPS;
  const { current, failed, cancelled } = progress(run, steps);
  const now = useNow(isCancellable(run.status));
  const durations = statusDurations(run, now);

  return (
    <ol className="flex items-center gap-2 text-xs">
      {steps.map((step, index) => {
        const isDone = index < current;
        const isCurrent = index === current;
        const dot = isCurrent && failed
          ? "bg-red-500"
          : isCurrent && cancelled
            ? "bg-zinc-400"
            : isDone
            ? "bg-green-500"
            : isCurrent
              ? "animate-pulse bg-blue-500"
              : "bg-zinc-300 dark:bg-zinc-700";
        const text = isCurrent || isDone
          ? "font-medium text-zinc-900 dark:text-zinc-100"
          : "text-zinc-500 dark:text-zinc-400";

        return (
          <li key={step.status} className="flex items-center gap-2">
            {index > 0 && <span className="h-px w-6 bg-zinc-300 dark:bg-zinc-700" />}
            <span className={`h-2 w-2 rounded-full ${dot}`} />
            <span className={text}>{step.label}</span>
            {(durations.get(step.status) ?? 0) >= 1000 && (
              <span className="text-zinc-400 dark:text-zinc-500">
                {formatDuration(durations.get(step.status) ?? 0)}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
