import type { FileMark } from "./api";

/** Index of the next file without a decision after `from`, wrapping around; null when all are decided. */
export function nextUndecided(
  paths: string[],
  marks: Record<string, FileMark>,
  from: number,
): number | null {
  for (let step = 1; step <= paths.length; step++) {
    const i = (((from + step) % paths.length) + paths.length) % paths.length;
    if (!marks[paths[i]]?.decision) return i;
  }
  return null;
}

/** Split `paths` by decision, keeping their order; files without a decision are `undecided`. */
export function groupMarks(paths: string[], marks: Record<string, FileMark>) {
  const groups: Record<"keep" | "remove" | "redo" | "undecided", string[]> = {
    keep: [],
    remove: [],
    redo: [],
    undecided: [],
  };
  for (const path of paths) groups[marks[path]?.decision ?? "undecided"].push(path);
  return groups;
}
