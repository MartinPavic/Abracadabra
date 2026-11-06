import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { listen } from "@tauri-apps/api/event";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelRun,
  deleteRun,
  getRun,
  openInIde,
  returnToOriginalBranch,
  type RunRecord,
  type RunStatus,
} from "../lib/api";
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
vi.mock("../lib/useConfig", () => ({ useConfig: vi.fn(() => ({ config: { reviewerGate: "off", ideCommand: "", gitSources: [] } })) }));
vi.mock("../components/FileReview", () => ({ FileReview: () => <div data-testid="file-review" /> }));
vi.mock("../components/DiffViewer", () => ({ DiffViewer: () => <div data-testid="diff" /> }));
vi.mock("../components/PublishActions", () => ({ PublishActions: () => <div data-testid="publish" /> }));
vi.mock("../components/RunConsole", () => ({ RunConsole: () => <div data-testid="console" /> }));
vi.mock("../components/BranchConflictPrompt", () => ({ BranchConflictPrompt: () => <div /> }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function makeRun(status: RunStatus, extra: Partial<RunRecord> = {}): RunRecord {
  return {
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
    removedFiles: [],
    ...extra,
  } as unknown as RunRecord;
}

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Link to="/tasks/r2">other run</Link>
      <Routes>
        <Route path="/tasks/:id" element={<TaskRun />} />
        <Route path="/tasks" element={<p>task list</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

async function renderRun(status: RunStatus, extra: Partial<RunRecord> = {}) {
  vi.mocked(getRun).mockResolvedValue(makeRun(status, extra));
  renderAt("/tasks/r1");
  await screen.findByText("Fix login bug");
}

/** Delivers a `run://status` event for r1, after which the page reloads the run as `status`. */
async function changeStatus(status: RunStatus, extra: Partial<RunRecord> = {}) {
  vi.mocked(getRun).mockResolvedValue(makeRun(status, extra));
  const calls = vi.mocked(listen).mock.calls;
  const handler = calls[calls.length - 1][1] as (event: { payload: { runId: string } }) => void;
  await act(async () => handler({ payload: { runId: "r1" } }));
}

const tab = (name: RegExp) => screen.getByRole("tab", { name });
const selectedTab = () => screen.getByRole("tab", { selected: true });
const panel = (id: string) => document.getElementById(`run-panel-${id}`) as HTMLElement;

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
    expect(screen.queryByRole("button", { name: "Delete run", hidden: true })).toBeNull();
  });

  it("awaiting approval: shows the file review instead of the diff, no cancel", async () => {
    await renderRun("awaiting_approval");
    expect(screen.getByTestId("file-review")).toBeTruthy();
    expect(screen.queryByTestId("diff")).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel run", hidden: true })).toBeNull();
  });

  it("approved: shows the publish actions and the diff, not the file review", async () => {
    await renderRun("approved");
    expect(screen.getByTestId("publish")).toBeTruthy();
    expect(screen.getByTestId("diff")).toBeTruthy();
    expect(screen.queryByTestId("file-review")).toBeNull();
    expect(screen.queryByText(/removed during review/)).toBeNull();
  });

  it("says when tests and review predate files removed during review", async () => {
    await renderRun("approved", { removedFiles: ["a.ts", "b.ts"] } as Partial<RunRecord>);
    screen.getByText(
      "These files were removed during review, after the tests and code review ran: a.ts, b.ts. Run the tests again before publishing.",
    );
  });

  it("planned: offers to run from the plan or the description", async () => {
    await renderRun("planned", { planOnly: true, workerSummary: "1. do it" } as Partial<RunRecord>);
    expect(screen.getByRole("button", { name: "Run from plan" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run from task description" })).toBeTruthy();
    expect(screen.queryByTestId("file-review")).toBeNull();
  });

  it("failed: shows the error and deletes only after confirmation", async () => {
    await renderRun("failed", { error: "agent crashed" });
    expect(screen.getByText("agent crashed")).toBeTruthy();
    fireEvent.click(tab(/Activity/));
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

    vi.mocked(useConfig).mockReturnValue({ config: { reviewerGate: "off", ideCommand: "code {path}", gitSources: [] } } as never);
    await renderRun("awaiting_approval", { workDir: "/tmp/p", branch: "feat/x" } as Partial<RunRecord>);
    fireEvent.click(screen.getByRole("button", { name: "Open in editor" }));
    await waitFor(() => expect(openInIde).toHaveBeenCalledWith("r1"));
  });
});

describe("TaskRun tabs", () => {
  it("an awaiting-approval run opens on the changes tab", async () => {
    await renderRun("awaiting_approval");
    expect(screen.getByRole("tablist", { name: "Run sections" })).toBeTruthy();
    expect(selectedTab().id).toBe("run-tab-changes");
    expect(screen.getByRole("tab", { name: "Changes needs attention" })).toBe(selectedTab());
    expect(panel("changes").hidden).toBe(false);
    expect(panel("changes").contains(screen.getByTestId("file-review"))).toBe(true);
    expect(panel("overview").hidden).toBe(true);
  });

  it("a finished run opens on overview", async () => {
    await renderRun("approved");
    expect(selectedTab().id).toBe("run-tab-overview");
    expect(tab(/Changes/).textContent).not.toContain("needs attention");
    expect(panel("overview").contains(screen.getByTestId("publish"))).toBe(true);
    expect(panel("changes").contains(screen.getByTestId("diff"))).toBe(true);
  });

  it("a plan run opens on overview", async () => {
    await renderRun("working", { planOnly: true });
    expect(selectedTab().id).toBe("run-tab-overview");
    expect(screen.queryByTestId("diff")).toBeNull();
    expect(within(panel("changes")).getByText("No changes to show.")).toBeTruthy();
  });

  it("the default tab follows a status change until the user picks a tab", async () => {
    await renderRun("queued");
    expect(selectedTab().id).toBe("run-tab-overview");
    expect(screen.getByRole("tab", { name: "Activity active" })).toBeTruthy();

    await changeStatus("working");
    expect(selectedTab().id).toBe("run-tab-changes");
    expect(within(panel("changes")).getByTestId("diff")).toBeTruthy();

    await changeStatus("failed");
    expect(selectedTab().id).toBe("run-tab-overview");
    expect(tab(/Activity/).textContent).not.toContain("active");
  });

  it("committing keeps the changes tab, so the default does not flip between reviewing and awaiting approval", async () => {
    await renderRun("reviewing");
    expect(selectedTab().id).toBe("run-tab-changes");
    await changeStatus("committing");
    expect(selectedTab().id).toBe("run-tab-changes");
    await changeStatus("awaiting_approval");
    expect(selectedTab().id).toBe("run-tab-changes");
  });

  it("flags the overview tab when it holds a notice the user must see", async () => {
    await renderRun("awaiting_approval");
    expect(tab(/Overview/).textContent).not.toContain("needs attention");
    cleanup();

    await renderRun("awaiting_approval", { removedFiles: ["a.ts"] } as Partial<RunRecord>);
    expect(selectedTab().id).toBe("run-tab-changes");
    expect(screen.getByRole("tab", { name: "Overview needs attention" })).toBeTruthy();
    cleanup();

    await renderRun("awaiting_approval", { redoError: "boom" } as Partial<RunRecord>);
    expect(screen.getByRole("tab", { name: "Overview needs attention" })).toBeTruthy();
    cleanup();

    vi.mocked(useConfig).mockReturnValue({ config: { reviewerGate: "on", gitSources: [] } } as never);
    await renderRun("awaiting_approval", { reviewVerdict: "changes" } as Partial<RunRecord>);
    expect(screen.getByRole("tab", { name: "Overview needs attention" })).toBeTruthy();
    cleanup();

    await renderRun("failed", { error: "agent crashed" });
    expect(screen.getByRole("tab", { name: "Overview needs attention" })).toBeTruthy();
  });

  it("does not flag overview for a reviewer verdict when the reviewer gate is off", async () => {
    vi.mocked(useConfig).mockReturnValue({ config: { reviewerGate: "off", gitSources: [] } } as never);
    await renderRun("awaiting_approval", { reviewVerdict: "changes" } as Partial<RunRecord>);
    expect(tab(/Overview/).textContent).not.toContain("needs attention");
  });

  it("shows the reviewer verdict in the header", async () => {
    await renderRun("awaiting_approval", { reviewVerdict: "changes" } as Partial<RunRecord>);
    const header = document.querySelector("header") as HTMLElement;
    expect(within(header).getByText("review: changes requested")).toBeTruthy();
  });

  it("choosing a tab is not overridden by later status changes", async () => {
    await renderRun("working");
    expect(selectedTab().id).toBe("run-tab-changes");
    fireEvent.click(tab(/Overview/));
    expect(selectedTab().id).toBe("run-tab-overview");

    await changeStatus("awaiting_approval");
    expect(selectedTab().id).toBe("run-tab-overview");

    // Picking the tab that is already the default still counts as a choice.
    fireEvent.click(tab(/Changes/));
    await changeStatus("approved");
    expect(selectedTab().id).toBe("run-tab-changes");
  });

  it("switching tabs keeps the changes panel mounted", async () => {
    await renderRun("awaiting_approval");
    const review = screen.getByTestId("file-review");
    fireEvent.click(tab(/Overview/));
    expect(panel("changes").hidden).toBe(true);
    expect(screen.getByTestId("file-review")).toBe(review);
    fireEvent.click(tab(/Changes/));
    expect(panel("changes").hidden).toBe(false);
    expect(screen.getByTestId("file-review")).toBe(review);
  });

  it("overview holds the worker summary and reviewer notes", async () => {
    await renderRun("awaiting_approval", {
      workerSummary: "Rewrote the login form.",
      reviewNotes: "Rename the helper.",
      reviewVerdict: "changes",
    } as Partial<RunRecord>);
    const overview = within(panel("overview"));
    expect(overview.getByText("Rewrote the login form.")).toBeTruthy();
    expect(overview.getByText("Rename the helper.")).toBeTruthy();
    expect(overview.getByText("changes requested")).toBeTruthy();
    const apply = overview.getByRole("button", { name: "Apply suggestions", hidden: true }) as HTMLButtonElement;
    expect(apply.disabled).toBe(false);
    expect(within(panel("changes")).queryByText("Rewrote the login form.")).toBeNull();
  });

  it("activity holds the console and delete run", async () => {
    await renderRun("failed");
    const activity = within(panel("activity"));
    expect(activity.getByTestId("console")).toBeTruthy();
    expect(activity.getByText("Worker")).toBeTruthy();
    expect(activity.getByRole("button", { name: "Delete run", hidden: true })).toBeTruthy();
    expect(within(panel("overview")).queryByRole("button", { name: "Delete run", hidden: true })).toBeNull();
  });

  it("a long switch-back error is rendered inside the notice body, not in its actions", async () => {
    const long = `error: ${"checkout failed because local changes would be overwritten ".repeat(4)}`.trim();
    vi.mocked(returnToOriginalBranch).mockRejectedValue(long);
    await renderRun("awaiting_approval", { branch: "feat/x", originalRef: "main" } as Partial<RunRecord>);
    const button = within(panel("overview")).getByRole("button", { name: "Switch back to main", hidden: true });
    fireEvent.click(button);
    const message = await within(panel("overview")).findByText(long, {}, { timeout: 2000 });
    const notice = button.closest("[role='status']") as HTMLElement;
    expect(notice.contains(message)).toBe(true);
    expect((button.parentElement as HTMLElement).contains(message)).toBe(false);
  });

  it("a very long switch-back branch name is truncated in the button, with the full text in the title", async () => {
    const ref = `release/${"x".repeat(200)}`;
    await renderRun("awaiting_approval", { branch: "feat/x", originalRef: ref } as Partial<RunRecord>);
    const button = within(panel("overview")).getByRole("button", { name: `Switch back to ${ref}`, hidden: true });
    expect(button.className).toContain("truncate");
    expect(button.className).toContain("max-w-64");
    expect(button.getAttribute("title")).toBe(`Switch back to ${ref}`);
  });

  it("opening another run resets the default tab", async () => {
    vi.mocked(getRun).mockImplementation(async (id: string) =>
      id === "r2"
        ? makeRun("awaiting_approval", { id: "r2", taskTitle: "Second task" })
        : makeRun("awaiting_approval"),
    );
    renderAt("/tasks/r1");
    await screen.findByText("Fix login bug");
    fireEvent.click(tab(/Overview/));
    expect(selectedTab().id).toBe("run-tab-overview");

    fireEvent.click(screen.getByText("other run"));
    await screen.findByText("Second task");
    expect(selectedTab().id).toBe("run-tab-changes");
  });
});
