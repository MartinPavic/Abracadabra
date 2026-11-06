import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkReady, type ReadyItem } from "../lib/api";
import { clearCachedTasks } from "../lib/taskCache";
import { TaskList } from "./TaskList";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => undefined) }));
vi.mock("../lib/api", () => ({
  listTasks: vi.fn().mockResolvedValue([
    {
      id: "1",
      title: "Fix login bug",
      project: "group/web",
      labels: [],
      url: "",
      updatedAt: "2026-11-01T00:00:00Z",
      status: "opened",
    },
  ]),
  listRuns: vi.fn().mockResolvedValue([]),
  startRun: vi.fn(),
  openUrl: vi.fn(),
  checkReady: vi.fn(),
  describeError: String,
}));
vi.mock("../lib/useConfig", () => {
  const value = { config: { gitSources: [{ id: "s1", name: "Work" }] }, loading: false };
  return { useConfig: () => value };
});

const ok = (id: string, blocks: "run" | "plan" = "run"): ReadyItem => ({
  id,
  ok: true,
  blocks,
  message: `${id} fine`,
});

beforeEach(() => {
  localStorage.clear();
  clearCachedTasks("s1");
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function renderList(items: ReadyItem[] | Error) {
  if (items instanceof Error) vi.mocked(checkReady).mockRejectedValue(items);
  else vi.mocked(checkReady).mockResolvedValue(items);
  render(
    <MemoryRouter>
      <TaskList />
    </MemoryRouter>,
  );
  await screen.findByText("Fix login bug");
  await waitFor(() => expect(checkReady).toHaveBeenCalledWith("s1"));
}

describe("TaskList ready check", () => {
  it("a failing run item disables run buttons with the reason", async () => {
    await renderList([
      { id: "token", ok: false, blocks: "run", message: "No token for Work" },
      ok("plan", "plan"),
    ]);
    await screen.findByText("Before you can run tasks:");
    const run = screen.getByRole("button", { name: "Run" }) as HTMLButtonElement;
    const plan = screen.getByRole("button", { name: "Plan" }) as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    expect(run.title).toBe("No token for Work");
    expect(plan.disabled).toBe(true);
    expect(plan.title).toBe("No token for Work");
    screen.getByRole("checkbox", { name: "Select Fix login bug" }).click();
    const batch = (await screen.findByRole("button", { name: /Run selected/ })) as HTMLButtonElement;
    expect(batch.disabled).toBe(true);
    expect(batch.title).toBe("No token for Work");
  });

  it("a failing plan item disables only the plan button", async () => {
    await renderList([ok("token"), { id: "plan", ok: false, blocks: "plan", message: "No plan command" }]);
    await screen.findByText(/Plan runs need a plan command/);
    const run = screen.getByRole("button", { name: "Run" }) as HTMLButtonElement;
    const plan = screen.getByRole("button", { name: "Plan" }) as HTMLButtonElement;
    expect(run.disabled).toBe(false);
    expect(plan.disabled).toBe(true);
    expect(plan.title).toBe("No plan command");
  });

  it("a failed check leaves the buttons enabled", async () => {
    await renderList(new Error("boom"));
    await waitFor(() => expect(checkReady).toHaveBeenCalled());
    expect((screen.getByRole("button", { name: "Run" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Plan" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText("Before you can run tasks:")).toBeNull();
  });

  it("a custom worker command without a preset shows no banner", async () => {
    await renderList([ok("token"), ok("worker"), ok("plan", "plan")]);
    expect(screen.queryByText("Before you can run tasks:")).toBeNull();
    expect((screen.getByRole("button", { name: "Run" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Plan" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("TaskList toolbar", () => {
  it("the task list toolbar stays pinned while the list scrolls", async () => {
    await renderList([ok("token")]);
    screen.getByRole("checkbox", { name: "Select Fix login bug" }).click();
    const batch = await screen.findByRole("button", { name: /Run selected/ });
    const toolbar = screen.getByLabelText("Search by title").closest(".sticky") as HTMLElement;
    expect(toolbar).not.toBeNull();
    expect(toolbar.contains(batch)).toBe(true);
    expect(toolbar.contains(screen.getByRole("button", { name: "Refresh" }))).toBe(true);
    for (const name of ["top-0", "z-10", "bg-zinc-50", "dark:bg-zinc-950"]) {
      expect(toolbar.classList.contains(name)).toBe(true);
    }
  });
});
