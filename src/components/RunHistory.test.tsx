import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteRun, listRuns, type RunRecord } from "../lib/api";
import { RunHistory } from "./RunHistory";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => undefined) }));
vi.mock("../lib/api", () => ({
  describeError: String,
  listRuns: vi.fn(),
  deleteRun: vi.fn().mockResolvedValue(undefined),
  isFinished: (status: string) =>
    ["approved", "discarded", "handed_off", "planned", "failed", "cancelled"].includes(status),
  isCancellable: () => false,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const record = (id: string, taskTitle: string, project: string, status: string) =>
  ({ id, taskId: id, taskTitle, project, status, branch: null, createdAtMs: 0, updatedAtMs: 0, history: [] }) as unknown as RunRecord;

function renderHistory() {
  vi.mocked(listRuns).mockResolvedValue([
    record("1", "Fix login bug", "web", "failed"),
    record("2", "Add export", "api", "awaiting_approval"),
  ]);
  render(
    <MemoryRouter>
      <RunHistory />
    </MemoryRouter>,
  );
}

describe("RunHistory", () => {
  it("filters by search text", async () => {
    renderHistory();
    await screen.findByText("Fix login bug");
    fireEvent.change(screen.getByLabelText("Search runs"), { target: { value: "export" } });
    expect(screen.queryByText("Fix login bug")).toBeNull();
    expect(screen.getByText("Add export")).toBeTruthy();
  });

  it("filters by status", async () => {
    renderHistory();
    await screen.findByText("Fix login bug");
    fireEvent.change(screen.getByLabelText("Filter by status"), { target: { value: "failed" } });
    expect(screen.queryByText("Add export")).toBeNull();
    expect(screen.getByText("Fix login bug")).toBeTruthy();
  });

  it("only offers delete for finished runs, after confirmation", async () => {
    renderHistory();
    await screen.findByText("Fix login bug");
    expect(screen.queryByLabelText("Delete run Add export")).toBeNull();

    fireEvent.click(screen.getByLabelText("Delete run Fix login bug"));
    expect(deleteRun).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteRun).toHaveBeenCalledWith("1"));
    await waitFor(() => expect(screen.queryByText("Fix login bug")).toBeNull());
  });
});
