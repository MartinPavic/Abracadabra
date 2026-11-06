import { useEffect, useState } from "react";
import { isCancellable, type RunRecord, type RunStatus } from "../lib/api";
import { StatusBadge } from "./ui/Badge";
import { Icon } from "./ui/Icon";
import { Spinner } from "./ui/Spinner";

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

export function RunStatusPill({ status }: { status: RunStatus }) {
  return <StatusBadge status={status} />;
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

type StepState = "done" | "running" | "waiting" | "failed" | "cancelled" | "pending";

const MARKER: Record<StepState, string> = {
  done: "bg-green-600 text-white dark:bg-green-500 dark:text-zinc-950",
  running: "border-2 border-accent-500 bg-white text-accent-600 dark:border-accent-400 dark:bg-zinc-900 dark:text-accent-400",
  waiting: "border-2 border-amber-500 bg-amber-50 dark:border-amber-400 dark:bg-amber-950/40",
  failed: "bg-red-600 text-white dark:bg-red-500 dark:text-zinc-950",
  cancelled: "bg-zinc-500 text-white dark:bg-zinc-600 dark:text-zinc-100",
  pending: "border border-zinc-300 bg-white text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400",
};

function StepMarker({ state, number }: { state: StepState; number: number }) {
  return (
    <span
      aria-hidden="true"
      className={`flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${MARKER[state]}`}
    >
      {state === "done" && <Icon name="check" className="size-4" />}
      {state === "running" && <Spinner decorative className="size-4" />}
      {state === "waiting" && <span className="size-2 rounded-full bg-amber-500 dark:bg-amber-400" />}
      {state === "failed" && <Icon name="alert" className="size-4" />}
      {state === "cancelled" && <Icon name="x" className="size-4" />}
      {state === "pending" && number}
    </span>
  );
}

/** fetch -> worker -> reviewer -> commit -> approval (fetch -> plan for plan-only runs) */
export function RunStepper({ run }: { run: RunRecord }) {
  const steps = run.planOnly ? PLAN_STEPS : STEPS;
  const { current, failed, cancelled } = progress(run, steps);
  const now = useNow(isCancellable(run.status));
  const durations = statusDurations(run, now);

  return (
    <ol aria-label="Run progress" className="flex min-w-0 items-start text-xs">
      {steps.map((step, index) => {
        const isCurrent = index === current;
        const state: StepState =
          index < current
            ? "done"
            : !isCurrent
              ? "pending"
              : failed
                ? "failed"
                : cancelled
                  ? "cancelled"
                  : step.status === "awaiting_approval"
                    ? "waiting"
                    : "running";
        const stateText = {
          done: "Done",
          running: "Running",
          waiting: "Waiting for you",
          failed: "Failed",
          cancelled: "Cancelled",
          pending: failed || cancelled ? "Not reached" : "Pending",
        }[state];
        const duration = durations.get(step.status) ?? 0;

        return (
          <li
            key={step.status}
            aria-current={isCurrent ? "step" : undefined}
            className="relative flex min-w-0 flex-1 flex-col items-center gap-1.5 px-1 text-center"
          >
            {index > 0 && (
              // Connector from the previous step's marker to this one.
              <span
                aria-hidden="true"
                className={`absolute top-3.5 right-[calc(50%+1.25rem)] left-[calc(-50%+1.25rem)] h-0.5 rounded-full ${
                  index <= current ? "bg-green-500 dark:bg-green-600" : "bg-zinc-200 dark:bg-zinc-800"
                }`}
              />
            )}
            <StepMarker state={state} number={index + 1} />
            <span
              className={
                state === "pending"
                  ? "text-zinc-500 dark:text-zinc-400"
                  : "font-medium text-zinc-900 dark:text-zinc-100"
              }
            >
              {step.label}
            </span>
            <span className="text-zinc-500 dark:text-zinc-400">
              {duration >= 1000 ? `${stateText} · ${formatDuration(duration)}` : stateText}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
