import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cancelRun, deleteRun, getRun, openInIde, type RunRecord, type RunStatus } from "../lib/api";
import { useConfig } from "../lib/useConfig";
import { TaskRun } from "./TaskRun";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => undefined) }));
vi.mock("../lib/api", () => ({
  getRun: vi.fn(),
  cancelRun: vi.fn().mockResolvedValue(undefined),
  deleteRun: vi.fn().mockResolvedValue(undefined),
  redoRun: vi.fn(),
  startRun: vi.fn(),
  openUrl: vi.fn(),
  openInIde: vi.fn().mockResolvedValue(undefined),
  returnToOriginalBranch: vi.fn(),
  describeError: String,
  isCancellable: (status: string) => ["queued", "cloning", "working", "reviewing", "committing"].includes(status),
  isFinished: (status: string) =>
    ["approved", "discarded", "handed_off", "planned", "failed", "cancelled"].includes(status),
}));
vi.mock("../lib/useConfig", () => ({ useConfig: vi.fn(() => ({ config: { reviewerGate: "off", ideCommand: "" } })) }));
vi.mock("../components/ApprovalActions", () => ({ ApprovalActions: () => <div data-testid="approval" /> }));
vi.mock("../components/DiffViewer", () => ({ DiffViewer: () => <div data-testid="diff" /> }));
vi.mock("../components/PublishActions", () => ({ PublishActions: () => <div data-testid="publish" /> }));
vi.mock("../components/RunConsole", () => ({ RunConsole: () => <div data-testid="console" /> }));
vi.mock("../components/BranchConflictPrompt", () => ({ BranchConflictPrompt: () => <div /> }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function renderRun(status: RunStatus, extra: Partial<RunRecord> = {}) {
  vi.mocked(getRun).mockResolvedValue({
    id: "r1",
    taskId: "1",
    taskTitle: "Fix login bug",
    taskUrl: "",
    project: "group/web",
    sourceId: "s",
    status,
    history: [],
    fixAttempts: 0,
    usage: [],
    planOnly: false,
    ...extra,
  } as unknown as RunRecord);
  render(
    <MemoryRouter initialEntries={["/tasks/r1"]}>
      <Routes>
        <Route path="/tasks/:id" element={<TaskRun />} />
        <Route path="/tasks" element={<p>task list</p>} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByText("Fix login bug");
}

describe("TaskRun buttons per status", () => {
  it("queued: can be cancelled and says what it waits for", async () => {
    await renderRun("queued", { blockedBy: "Other task" } as Partial<RunRecord>);
    expect(screen.getByText("Other task")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    await waitFor(() => expect(cancelRun).toHaveBeenCalledWith("r1"));
  });

  it("working: can be cancelled, has no approval or delete buttons", async () => {
    await renderRun("working");
    expect(screen.getByRole("button", { name: "Cancel run" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete run" })).toBeNull();
  });

  it("awaiting approval: shows the approval actions and the diff, no cancel", async () => {
    await renderRun("awaiting_approval");
    expect(screen.getByTestId("approval")).toBeTruthy();
    expect(screen.getByTestId("diff")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel run" })).toBeNull();
  });

  it("approved: shows the publish actions", async () => {
    await renderRun("approved");
    expect(screen.getByTestId("publish")).toBeTruthy();
  });

  it("planned: offers to run from the plan or the description", async () => {
    await renderRun("planned", { planOnly: true, workerSummary: "1. do it" } as Partial<RunRecord>);
    expect(screen.getByRole("button", { name: "Run from plan" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run from task description" })).toBeTruthy();
    expect(screen.queryByTestId("approval")).toBeNull();
  });

  it("failed: shows the error and deletes only after confirmation", async () => {
    await renderRun("failed", { error: "agent crashed" });
    expect(screen.getByText("agent crashed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete run" }));
    expect(deleteRun).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete run" }));
    await waitFor(() => expect(deleteRun).toHaveBeenCalledWith("r1"));
    await screen.findByText("task list");
  });

  it("shows the editor button only when an IDE command is configured", async () => {
    await renderRun("awaiting_approval", { workDir: "/tmp/p", branch: "feat/x" } as Partial<RunRecord>);
    expect(screen.queryByRole("button", { name: "Open in editor" })).toBeNull();
    cleanup();

    vi.mocked(useConfig).mockReturnValue({ config: { reviewerGate: "off", ideCommand: "code {path}" } } as never);
    await renderRun("awaiting_approval", { workDir: "/tmp/p", branch: "feat/x" } as Partial<RunRecord>);
    fireEvent.click(screen.getByRole("button", { name: "Open in editor" }));
    await waitFor(() => expect(openInIde).toHaveBeenCalledWith("r1"));
  });
});
