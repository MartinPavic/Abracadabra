import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { open } from "@tauri-apps/plugin-dialog";
import type { AppConfig } from "../lib/api";
import { getInstructions, listRuns, readTextFile, setInstructions } from "../lib/api";
import { InstructionsSection } from "./InstructionsSection";

vi.mock("../lib/api", () => ({
  getInstructions: vi.fn(),
  setInstructions: vi.fn(),
  readTextFile: vi.fn(),
  listRuns: vi.fn(),
  describeError: (err: unknown) => String(err),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

const config = {
  gitSources: [{ id: "src-1", name: "Work GitLab" }],
} as AppConfig;

beforeEach(() => {
  vi.mocked(getInstructions).mockResolvedValue("");
  vi.mocked(setInstructions).mockResolvedValue(undefined);
  vi.mocked(listRuns).mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function globalBox() {
  const box = (await screen.findByLabelText("Global instructions")) as HTMLTextAreaElement;
  return box;
}

describe("InstructionsSection", () => {
  it("loads and saves the global instructions", async () => {
    vi.mocked(getInstructions).mockResolvedValue("be terse");
    render(<InstructionsSection config={config} />);
    const box = await globalBox();
    expect(getInstructions).toHaveBeenCalledWith({ kind: "global" });
    expect(box.value).toBe("be terse");
    fireEvent.change(box, { target: { value: "be very terse" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(setInstructions).toHaveBeenCalledWith({ kind: "global" }, "be very terse"),
    );
    expect(await screen.findByText("Saved")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Save is disabled until the text changes", async () => {
    vi.mocked(getInstructions).mockResolvedValue("hello");
    render(<InstructionsSection config={config} />);
    const box = await globalBox();
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(box, { target: { value: "hello!" } });
    expect(save.disabled).toBe(false);
    fireEvent.change(box, { target: { value: "hello" } });
    expect(save.disabled).toBe(true);
  });

  it("import fills the editor but does not save", async () => {
    vi.mocked(open).mockResolvedValue("/notes/rules.md");
    vi.mocked(readTextFile).mockResolvedValue("# imported rules");
    render(<InstructionsSection config={config} />);
    const box = await globalBox();
    fireEvent.click(screen.getByRole("button", { name: "Import file..." }));
    await waitFor(() => expect(box.value).toBe("# imported rules"));
    expect(open).toHaveBeenCalledWith({
      multiple: false,
      filters: [{ name: "Markdown or text", extensions: ["md", "txt"] }],
    });
    expect(readTextFile).toHaveBeenCalledWith("/notes/rules.md");
    expect(setInstructions).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(setInstructions).toHaveBeenCalledWith({ kind: "global" }, "# imported rules"),
    );
  });

  it("a project editor uses the source and project path scope", async () => {
    vi.mocked(listRuns).mockResolvedValue([
      { sourceId: "src-1", project: "group/app" },
      { sourceId: "src-1", project: "group/app" },
    ] as Awaited<ReturnType<typeof listRuns>>);
    vi.mocked(getInstructions).mockImplementation(async (scope) =>
      scope.kind === "project" ? "app rules" : "global rules",
    );
    render(<InstructionsSection config={config} />);
    await globalBox();
    const select = (await screen.findByLabelText("Project")) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(2));
    expect(select.options[1].textContent).toBe("Work GitLab · group/app");
    fireEvent.change(select, { target: { value: select.options[1].value } });
    const scope = { kind: "project", sourceId: "src-1", projectPath: "group/app" };
    await waitFor(() => expect(getInstructions).toHaveBeenCalledWith(scope));
    const box = (await screen.findByLabelText("Project instructions")) as HTMLTextAreaElement;
    await waitFor(() => expect(box.value).toBe("app rules"));
    fireEvent.change(box, { target: { value: "new app rules" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[1]);
    await waitFor(() => expect(setInstructions).toHaveBeenCalledWith(scope, "new app rules"));
  });

  it("switching projects reloads and discards unsaved edits", async () => {
    vi.mocked(listRuns).mockResolvedValue([
      { sourceId: "src-1", project: "a/one" },
      { sourceId: "src-1", project: "b/two" },
    ] as Awaited<ReturnType<typeof listRuns>>);
    vi.mocked(getInstructions).mockImplementation(async (scope) =>
      scope.kind === "project" ? `rules for ${scope.projectPath}` : "",
    );
    render(<InstructionsSection config={config} />);
    const select = (await screen.findByLabelText("Project")) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(3));
    fireEvent.change(select, { target: { value: select.options[1].value } });
    const box = (await screen.findByLabelText("Project instructions")) as HTMLTextAreaElement;
    await waitFor(() => expect(box.value).toBe("rules for a/one"));
    fireEvent.change(box, { target: { value: "unsaved" } });
    fireEvent.change(select, { target: { value: select.options[2].value } });
    await waitFor(() =>
      expect((screen.getByLabelText("Project instructions") as HTMLTextAreaElement).value).toBe(
        "rules for b/two",
      ),
    );
    expect(setInstructions).not.toHaveBeenCalled();
  });

  it("a save error keeps the text and shows the message", async () => {
    vi.mocked(setInstructions).mockRejectedValue("Instructions are limited to 50,000 characters");
    render(<InstructionsSection config={config} />);
    const box = await globalBox();
    fireEvent.change(box, { target: { value: "too long" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/limited to 50,000 characters/)).toBeTruthy();
    expect(box.value).toBe("too long");
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("projects appear after the first run message when there are none", async () => {
    render(<InstructionsSection config={config} />);
    expect(await screen.findByText("Projects appear here after your first run.")).toBeTruthy();
    expect(screen.queryByLabelText("Project")).toBeNull();
  });

  it("treats a listRuns failure as no projects", async () => {
    vi.mocked(listRuns).mockRejectedValue("boom");
    render(<InstructionsSection config={config} />);
    expect(await screen.findByText("Projects appear here after your first run.")).toBeTruthy();
  });
});
