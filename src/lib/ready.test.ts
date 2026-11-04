import { describe, expect, it } from "vitest";
import type { ReadyItem } from "./api";
import { summarizeReady } from "./ready";

const item = (id: string, ok: boolean, blocks: "run" | "plan", message = `${id} message`): ReadyItem => ({
  id,
  ok,
  blocks,
  message,
});

describe("summarizeReady", () => {
  it("reports nothing when every item is ok", () => {
    expect(summarizeReady([item("token", true, "run"), item("plan", true, "plan")])).toEqual({
      problems: [],
      runBlock: null,
      planBlock: null,
    });
  });

  it("handles an empty list", () => {
    expect(summarizeReady([])).toEqual({ problems: [], runBlock: null, planBlock: null });
  });

  it("a failing run item blocks both run and plan with its message", () => {
    const token = item("token", false, "run", "No token");
    const result = summarizeReady([token, item("worker", true, "run")]);
    expect(result.problems).toEqual([token]);
    expect(result.runBlock).toBe("No token");
    expect(result.planBlock).toBe("No token");
  });

  it("uses the first failing run item", () => {
    const result = summarizeReady([
      item("token", false, "run", "No token"),
      item("worker", false, "run", "No worker"),
    ]);
    expect(result.runBlock).toBe("No token");
    expect(result.problems).toHaveLength(2);
  });

  it("a failing plan item blocks only plan runs", () => {
    const result = summarizeReady([item("token", true, "run"), item("plan", false, "plan", "No plan command")]);
    expect(result.runBlock).toBeNull();
    expect(result.planBlock).toBe("No plan command");
  });

  it("a run failure wins over a plan failure for the plan block", () => {
    const result = summarizeReady([
      item("plan", false, "plan", "No plan command"),
      item("worker", false, "run", "No worker"),
    ]);
    expect(result.runBlock).toBe("No worker");
    expect(result.planBlock).toBe("No worker");
  });
});
