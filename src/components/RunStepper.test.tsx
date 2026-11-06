import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { RunRecord, RunStatus } from "../lib/api";
import { RunStepper } from "./RunStatus";

afterEach(cleanup);

function renderStepper(status: RunStatus, history: RunStatus[], planOnly = false) {
  const start = Date.now() - 60_000;
  const run = {
    status,
    planOnly,
    history: history.map((s, i) => ({ status: s, atMs: start + i * 10_000 })),
  } as unknown as RunRecord;
  render(<RunStepper run={run} />);
  return screen.getAllByRole("listitem");
}

function expectStep(item: HTMLElement, label: string, state: RegExp) {
  within(item).getByText(label);
  within(item).getByText(state);
}

describe("RunStepper", () => {
  it("the stepper marks completed, current and pending steps with text", () => {
    const items = renderStepper("reviewing", ["cloning", "working", "reviewing"]);
    expect(items).toHaveLength(5);
    expectStep(items[0], "Fetch", /^Done · 10s$/);
    expectStep(items[1], "Worker", /^Done · 10s$/);
    expectStep(items[2], "Reviewer", /^Running/);
    expectStep(items[3], "Commit", /^Pending$/);
    expectStep(items[4], "Approval", /^Pending$/);
    expect(items[2].getAttribute("aria-current")).toBe("step");
    expect(items.filter((item) => item.hasAttribute("aria-current"))).toHaveLength(1);
  });

  it("says when the run waits for the user", () => {
    const items = renderStepper("awaiting_approval", ["cloning", "working", "reviewing", "committing", "awaiting_approval"]);
    expectStep(items[3], "Commit", /^Done/);
    expectStep(items[4], "Approval", /^Waiting for you/);
    expect(items[4].getAttribute("aria-current")).toBe("step");
  });

  it("marks the step a run failed at, and the steps after it as not reached", () => {
    const items = renderStepper("failed", ["cloning", "working", "failed"]);
    expectStep(items[0], "Fetch", /^Done/);
    expectStep(items[1], "Worker", /^Failed/);
    expectStep(items[2], "Reviewer", /^Not reached$/);
    expectStep(items[4], "Approval", /^Not reached$/);
  });

  it("marks the step a run was cancelled at", () => {
    const items = renderStepper("cancelled", ["cloning", "working", "cancelled"]);
    expectStep(items[1], "Worker", /^Cancelled/);
  });

  it("shows the plan steps, all done once planned", () => {
    const items = renderStepper("planned", ["cloning", "working", "planned"], true);
    expect(items).toHaveLength(2);
    expectStep(items[0], "Fetch", /^Done/);
    expectStep(items[1], "Plan", /^Done/);
    expect(items.some((item) => item.hasAttribute("aria-current"))).toBe(false);
  });
});
