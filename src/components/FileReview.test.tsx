import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discardRun,
  type FileDiff,
  getRunDiff,
  handOffRun,
  type RunRecord,
  setFileDecisions,
} from "../lib/api";
import { FileReview } from "./FileReview";

vi.mock("../lib/api", () => ({
  describeError: String,
  discardRun: vi.fn().mockResolvedValue(undefined),
  finishFileReview: vi.fn(),
  getRunDiff: vi.fn(),
  handOffRun: vi.fn().mockResolvedValue(undefined),
  setFileDecisions: vi.fn().mockResolvedValue(undefined),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const run = { id: "r1", commitSha: "c1", fileReview: null } as unknown as RunRecord;

const threeFiles: FileDiff[] = [
  { path: "a.ts", status: "M", patch: "@@ -1 +1 @@\n-old\n+new\n" },
  { path: "b.ts", status: "A", patch: "@@ -0,0 +1 @@\n+added\n" },
  { path: "c.ts", status: "M", patch: "@@ -2 +2 @@\n-x\n+y\n" },
];

const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
const noteField = () =>
  screen.getByPlaceholderText("What's wrong with this file? (optional)") as HTMLInputElement;

async function renderWith(files: FileDiff[]) {
  vi.mocked(getRunDiff).mockResolvedValue(files);
  render(<FileReview run={run} onChanged={() => {}} />);
  await screen.findByRole("heading", { name: files[0].path });
}

async function expectFile(path: string, n: number, of: number) {
  await screen.findByRole("heading", { name: path });
  screen.getByText(`File ${n} of ${of}`);
}

describe("FileReview", () => {
  it("Yes keeps the file and shows the next one", async () => {
    await renderWith(threeFiles);
    screen.getByText("File 1 of 3");
    fireEvent.click(button("Yes"));
    await expectFile("b.ts", 2, 3);
    expect(setFileDecisions).toHaveBeenCalledWith("r1", [
      { path: "a.ts", decision: "keep", note: null },
    ]);
  });

  it("redo sends the note and advances", async () => {
    await renderWith(threeFiles);
    fireEvent.change(noteField(), { target: { value: "  wrong import  " } });
    fireEvent.click(button("No, redo this"));
    await expectFile("b.ts", 2, 3);
    expect(setFileDecisions).toHaveBeenCalledWith("r1", [
      { path: "a.ts", decision: "redo", note: "wrong import" },
    ]);
    expect(noteField().value).toBe("");
  });

  it("Y and N keys decide, but not while typing in the note field", async () => {
    await renderWith(threeFiles);
    fireEvent.keyDown(window, { key: "y" });
    await expectFile("b.ts", 2, 3);
    fireEvent.keyDown(window, { key: "n" });
    await expectFile("c.ts", 3, 3);
    expect(vi.mocked(setFileDecisions).mock.calls).toEqual([
      ["r1", [{ path: "a.ts", decision: "keep", note: null }]],
      ["r1", [{ path: "b.ts", decision: "remove", note: null }]],
    ]);

    fireEvent.keyDown(noteField(), { key: "y" });
    fireEvent.keyDown(noteField(), { key: "n" });
    expect(setFileDecisions).toHaveBeenCalledTimes(2);
    screen.getByText("File 3 of 3");

    fireEvent.keyDown(window, { key: "Y", shiftKey: true });
    await screen.findByTestId("review-summary");
    expect(setFileDecisions).toHaveBeenLastCalledWith("r1", [
      { path: "c.ts", decision: "keep", note: null },
    ]);
  });

  it("a held key (repeat) does not decide", async () => {
    await renderWith(threeFiles);
    fireEvent.keyDown(window, { key: "y", repeat: true });
    fireEvent.keyDown(window, { key: "Y", shiftKey: true, repeat: true });
    expect(setFileDecisions).not.toHaveBeenCalled();
    screen.getByText("File 1 of 3");

    fireEvent.keyDown(window, { key: "y" });
    await expectFile("b.ts", 2, 3);
  });

  it("keys do nothing while the review is in a hidden panel or were already handled", async () => {
    vi.mocked(getRunDiff).mockResolvedValue(threeFiles);
    const { rerender } = render(
      <div hidden>
        <FileReview run={run} onChanged={() => {}} />
      </div>,
    );
    await screen.findByText("File 1 of 3");
    fireEvent.keyDown(window, { key: "y" });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(setFileDecisions).not.toHaveBeenCalled();
    screen.getByText("File 1 of 3");

    rerender(
      <div>
        <FileReview run={run} onChanged={() => {}} />
      </div>,
    );
    const handled = new KeyboardEvent("keydown", { key: "y", cancelable: true });
    handled.preventDefault();
    fireEvent(window, handled);
    expect(setFileDecisions).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "y" });
    await expectFile("b.ts", 2, 3);
  });

  it("clicking a file in the summary goes back to it", async () => {
    await renderWith(threeFiles);
    fireEvent.click(button("Accept all remaining"));
    const summary = await screen.findByTestId("review-summary");
    fireEvent.click(within(summary).getByRole("button", { name: "b.ts" }));
    await expectFile("b.ts", 2, 3);
    expect(screen.queryByTestId("review-summary")).toBeNull();
  });

  it("the general note survives a jump to a file and back", async () => {
    await renderWith(threeFiles);
    fireEvent.click(button("Accept all remaining"));
    const summary = await screen.findByTestId("review-summary");
    fireEvent.change(within(summary).getByPlaceholderText("Anything else the agent should change?"), {
      target: { value: "add tests" },
    });
    button("Apply and redo");
    fireEvent.click(within(summary).getByRole("button", { name: "b.ts" }));
    await expectFile("b.ts", 2, 3);

    fireEvent.click(button("Accept all remaining"));
    await screen.findByTestId("review-summary");
    expect(
      (screen.getByPlaceholderText("Anything else the agent should change?") as HTMLTextAreaElement)
        .value,
    ).toBe("add tests");
    button("Apply and redo");
    expect(screen.queryByRole("button", { name: "Finish review" })).toBeNull();
  });

  it("the general note is cleared when the run's commit changes", async () => {
    vi.mocked(getRunDiff).mockResolvedValue(threeFiles);
    const { rerender } = render(<FileReview run={run} onChanged={() => {}} />);
    await screen.findByRole("heading", { name: "a.ts" });
    fireEvent.click(button("Accept all remaining"));
    await screen.findByTestId("review-summary");
    fireEvent.change(screen.getByPlaceholderText("Anything else the agent should change?"), {
      target: { value: "add tests" },
    });

    const keptAll = {
      commitSha: "c2",
      files: Object.fromEntries(threeFiles.map((f) => [f.path, { decision: "keep", note: null }])),
    };
    rerender(
      <FileReview
        run={{ ...run, commitSha: "c2", fileReview: keptAll } as RunRecord}
        onChanged={() => {}}
      />,
    );
    await screen.findByTestId("review-summary");
    await waitFor(() => button("Finish review"));
    expect(
      (screen.getByPlaceholderText("Anything else the agent should change?") as HTMLTextAreaElement)
        .value,
    ).toBe("");
  });

  it("offers discard and hand off when the diff can't be loaded", async () => {
    vi.mocked(getRunDiff).mockRejectedValue("this run's project folder no longer exists");
    const onChanged = vi.fn();
    render(<FileReview run={run} onChanged={onChanged} />);
    await screen.findByText("this run's project folder no longer exists");
    button("Open in editor / hand off");

    fireEvent.click(button("Discard run"));
    expect(discardRun).not.toHaveBeenCalled();
    screen.getByText(/Discard this run\? Its branch is deleted/);
    fireEvent.click(button("Yes, discard"));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(discardRun).toHaveBeenCalledWith("r1");
  });

  it("offers discard and hand off when the diff is empty", async () => {
    vi.mocked(getRunDiff).mockResolvedValue([]);
    const onChanged = vi.fn();
    render(<FileReview run={run} onChanged={onChanged} />);
    await screen.findByText("No changes.");
    button("Discard run");
    fireEvent.click(button("Open in editor / hand off"));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(handOffRun).toHaveBeenCalledWith("r1");
  });

  it("back returns to the previous file", async () => {
    await renderWith(threeFiles);
    fireEvent.change(noteField(), { target: { value: "rename it" } });
    fireEvent.click(button("No, redo this"));
    await expectFile("b.ts", 2, 3);
    fireEvent.click(button("Back"));
    await expectFile("a.ts", 1, 3);
    expect(noteField().value).toBe("rename it");
    fireEvent.keyDown(window, { key: "ArrowRight" });
    await expectFile("b.ts", 2, 3);
    expect(setFileDecisions).toHaveBeenCalledTimes(1);
  });

  it("accept all remaining keeps every undecided file in one call", async () => {
    await renderWith(threeFiles);
    fireEvent.click(button("No, just remove"));
    await expectFile("b.ts", 2, 3);
    fireEvent.click(button("Accept all remaining"));
    await screen.findByTestId("review-summary");
    expect(vi.mocked(setFileDecisions).mock.calls).toEqual([
      ["r1", [{ path: "a.ts", decision: "remove", note: null }]],
      [
        "r1",
        [
          { path: "b.ts", decision: "keep", note: null },
          { path: "c.ts", decision: "keep", note: null },
        ],
      ],
    ]);
  });

  it("a file with only a notice instead of a patch can still be decided", async () => {
    await renderWith([
      { path: "logo.png", status: "A", patch: "(new binary file)" },
      { path: "dump.sql", status: "M", patch: "(diff too large to display: 300 KB)" },
    ]);
    screen.getByText("(new binary file)");
    fireEvent.click(button("Yes"));
    await expectFile("dump.sql", 2, 2);
    screen.getByText("(diff too large to display: 300 KB)");
    fireEvent.click(button("No, just remove"));
    await screen.findByTestId("review-summary");
    await waitFor(() =>
      expect(setFileDecisions).toHaveBeenLastCalledWith("r1", [
        { path: "dump.sql", decision: "remove", note: null },
      ]),
    );
  });
});
