import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkReady, listRuns, listTasks, type RunRecord, type Task } from "../lib/api";
import { clearCachedTasks } from "../lib/taskCache";
import { TaskList } from "./TaskList";
import { TasksPage } from "./TasksPage";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => undefined) }));
vi.mock("../lib/api", () => ({
  listTasks: vi.fn(),
  listRuns: vi.fn(),
  startRun: vi.fn(),
  openUrl: vi.fn(),
  checkReady: vi.fn(),
  deleteRun: vi.fn(),
  listOrphanedStashes: vi.fn().mockResolvedValue([]),
  restoreOrphanedStash: vi.fn(),
  isFinished: () => true,
  isCancellable: () => false,
  describeError: String,
}));
const config = vi.hoisted(() => ({ gitSources: [{ id: "s1", name: "Work" }] as { id: string; name: string }[] }));
vi.mock("../lib/useConfig", () => {
  const value = { config, loading: false };
  return { useConfig: () => value };
});

const task: Task = {
  id: "1",
  title: "Fix login bug",
  project: "group/web",
  labels: ["bug"],
  url: "",
  updatedAt: "2026-11-01T00:00:00Z",
  status: "opened",
} as Task;

const run = {
  id: "r1",
  sourceId: "s1",
  taskId: "1",
  taskTitle: "Fix login bug",
  project: "group/web",
  status: "awaiting_approval",
  branch: null,
  createdAtMs: 0,
  updatedAtMs: 0,
  history: [],
} as unknown as RunRecord;

beforeEach(() => {
  localStorage.clear();
  clearCachedTasks("s1");
  config.gitSources = [{ id: "s1", name: "Work" }];
  vi.mocked(listTasks).mockResolvedValue([task]);
  vi.mocked(listRuns).mockResolvedValue([]);
  vi.mocked(checkReady).mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function LocationProbe() {
  return <output data-testid="search">{useLocation().search}</output>;
}

function renderList() {
  render(
    <MemoryRouter>
      <TaskList />
    </MemoryRouter>,
  );
}

describe("TasksPage", () => {
  it("the tasks page tabs switch to history and back", async () => {
    render(
      <MemoryRouter initialEntries={["/tasks"]}>
        <Routes>
          <Route
            path="/tasks"
            element={
              <>
                <TasksPage />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    screen.getByRole("heading", { name: "Tasks" });
    screen.getByRole("tablist", { name: "Tasks and history" });
    const tasksTab = screen.getByRole("tab", { name: "Tasks" });
    const historyTab = screen.getByRole("tab", { name: "History" });
    expect(tasksTab.getAttribute("aria-selected")).toBe("true");
    await screen.findByText("Fix login bug");
    expect(screen.getByTestId("search").textContent).toBe("");

    fireEvent.click(historyTab);
    expect(historyTab.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("search").textContent).toBe("?tab=history");
    await screen.findByLabelText("Search runs");
    expect(screen.queryByLabelText("Search by title")).toBeNull();
    expect(screen.getByRole("tabpanel", { name: "History" })).toBeTruthy();

    fireEvent.click(tasksTab);
    expect(tasksTab.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("search").textContent).toBe("");
    await screen.findByLabelText("Search by title");
    expect(screen.queryByLabelText("Search runs")).toBeNull();
  });

  it("opens on the history tab from the query string", async () => {
    render(
      <MemoryRouter initialEntries={["/tasks?tab=history"]}>
        <TasksPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole("tab", { name: "History" }).getAttribute("aria-selected")).toBe("true");
    await screen.findByLabelText("Search runs");
  });
});

describe("TaskList rows", () => {
  it("a task row shows its status badge and links to the run", async () => {
    vi.mocked(listRuns).mockResolvedValue([run]);
    renderList();
    const title = await screen.findByRole("button", { name: "Fix login bug" });
    const row = title.closest("li") as HTMLElement;
    expect(row).toBeTruthy();
    const link = await within(row).findByTitle("Open the latest run for this task");
    expect(link.getAttribute("href")).toBe("/tasks/r1");
    expect(link.textContent).toBe("awaiting approval");
    within(row).getByText("group/web");
    within(row).getByText("bug");
    within(row).getByRole("button", { name: "Plan" });
    within(row).getByRole("button", { name: "Run" });
  });

  it("empty state when there are no tasks", async () => {
    vi.mocked(listTasks).mockResolvedValue([]);
    renderList();
    await screen.findByText("No tasks match the current filters.");
    expect(screen.queryByRole("checkbox", { name: "Select all shown tasks" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Run" })).toBeNull();
  });

  it("empty state when no git source is configured links to settings", async () => {
    config.gitSources = [];
    renderList();
    screen.getByText("No tasks yet");
    expect(screen.getByRole("link", { name: "Settings" }).getAttribute("href")).toBe("/settings");
    await waitFor(() => expect(listTasks).not.toHaveBeenCalled());
  });
});
