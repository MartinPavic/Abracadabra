import type { ReadyItem } from "./api";

export interface ReadySummary {
  problems: ReadyItem[];
  runBlock: string | null;
  planBlock: string | null;
}

export function summarizeReady(items: ReadyItem[]): ReadySummary {
  const problems = items.filter((item) => !item.ok);
  const runBlock = problems.find((item) => item.blocks === "run")?.message ?? null;
  // A plan run needs the worker too, so a run problem blocks it as well.
  const planBlock = runBlock ?? problems.find((item) => item.blocks === "plan")?.message ?? null;
  return { problems, runBlock, planBlock };
}
