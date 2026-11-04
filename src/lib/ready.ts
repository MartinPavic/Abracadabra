import type { ReadyItem } from "./api";

export interface ReadySummary {
  problems: ReadyItem[];
  runBlock: string | null;
  planBlock: string | null;
}

export function summarizeReady(items: ReadyItem[]): ReadySummary {
  const problems = items.filter((item) => !item.ok);
  const runBlock = problems.find((item) => item.blocks === "run")?.message ?? null;
  // A run-blocking item (missing token or agent CLI) blocks plan runs as well.
  const planBlock = runBlock ?? problems.find((item) => item.blocks === "plan")?.message ?? null;
  return { problems, runBlock, planBlock };
}
