import type { ReactNode } from "react";
import type { RunStatus } from "../../lib/api";

export type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "accent" | "violet";

const TONES: Record<Tone, { badge: string; dot: string }> = {
  neutral: {
    badge: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
    dot: "bg-zinc-500 dark:bg-zinc-400",
  },
  info: {
    badge: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
    dot: "bg-blue-500 dark:bg-blue-400",
  },
  success: {
    badge: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
    dot: "bg-green-500 dark:bg-green-400",
  },
  warning: {
    badge: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
    dot: "bg-amber-500 dark:bg-amber-400",
  },
  danger: {
    badge: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
    dot: "bg-red-500 dark:bg-red-400",
  },
  accent: {
    badge: "bg-accent-100 text-accent-800 dark:bg-accent-900/40 dark:text-accent-300",
    dot: "bg-accent-500 dark:bg-accent-400",
  },
  violet: {
    badge: "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300",
    dot: "bg-violet-500 dark:bg-violet-400",
  },
};

export function Badge({
  tone = "neutral",
  dot,
  children,
}: {
  tone?: Tone;
  dot?: boolean | "pulse";
  children: ReactNode;
}) {
  const { badge, dot: dotClass } = TONES[tone];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${badge}`}
    >
      {dot && (
        <span
          aria-hidden="true"
          className={`size-1.5 rounded-full ${dotClass}${dot === "pulse" ? " animate-pulse motion-reduce:animate-none" : ""}`}
        />
      )}
      {children}
    </span>
  );
}

const STATUS_TONE: Record<RunStatus, Tone> = {
  queued: "neutral",
  cloning: "info",
  working: "info",
  reviewing: "info",
  committing: "info",
  awaiting_approval: "warning",
  approved: "success",
  discarded: "neutral",
  handed_off: "violet",
  planned: "accent",
  failed: "danger",
  cancelled: "neutral",
};

const ACTIVE: ReadonlySet<RunStatus> = new Set(["cloning", "working", "reviewing", "committing"]);

export function StatusBadge({ status }: { status: RunStatus }) {
  return (
    <Badge tone={STATUS_TONE[status]} dot={ACTIVE.has(status) ? "pulse" : true}>
      {status.replace(/_/g, " ")}
    </Badge>
  );
}
