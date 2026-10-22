import { describe, expect, it } from "vitest";
import type { RunRecord } from "../lib/api";
import { agentTime, formatDuration, statusDurations } from "./RunStatus";

const run = (history: RunRecord["history"]) => ({ history }) as RunRecord;

describe("formatDuration", () => {
  it("formats seconds, minutes and hours", () => {
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(192_000)).toBe("3m 12s");
    expect(formatDuration(3_900_000)).toBe("1h 05m");
  });

  it("never goes negative", () => {
    expect(formatDuration(-5_000)).toBe("0s");
  });
});

describe("statusDurations", () => {
  it("sums time per status across redos and stops at the last transition when finished", () => {
    const r = run([
      { status: "working", atMs: 0 },
      { status: "reviewing", atMs: 10_000 },
      { status: "working", atMs: 15_000 },
      { status: "awaiting_approval", atMs: 25_000 },
    ]);
    const totals = statusDurations(r, 999_999);
    expect(totals.get("working")).toBe(20_000);
    expect(totals.get("reviewing")).toBe(5_000);
    expect(totals.get("awaiting_approval")).toBe(0);
  });

  it("counts the current running step up to now", () => {
    const r = run([{ status: "working", atMs: 1_000 }]);
    expect(statusDurations(r, 6_000).get("working")).toBe(5_000);
  });
});

describe("agentTime", () => {
  it("excludes time spent waiting for the user", () => {
    const r = run([
      { status: "working", atMs: 0 },
      { status: "awaiting_approval", atMs: 30_000 },
      { status: "committing", atMs: 90_000 },
      { status: "approved", atMs: 92_000 },
    ]);
    expect(agentTime(r, 100_000)).toBe(32_000);
  });
});
