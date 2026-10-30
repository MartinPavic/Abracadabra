import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discardRun,
  type FileMark,
  finishFileReview,
  handOffRun,
  type RunRecord,
} from "../lib/api";
import { ReviewSummary } from "./ReviewSummary";

vi.mock("../lib/api", () => ({
  describeError: String,
  discardRun: vi.fn().mockResolvedValue(undefined),
  finishFileReview: vi.fn().mockResolvedValue(undefined),
  handOffRun: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./DiffViewer", () => ({
  DiffViewer: ({ redone }: { redone?: boolean }) => (
    <div data-testid="diff" data-redone={String(Boolean(redone))} />
  ),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const run = { id: "r1", previousCommitSha: null } as unknown as RunRecord;
const paths = ["a.ts", "b.ts", "c.ts"];
const keep: FileMark = { decision: "keep", note: null };
const remove: FileMark = { decision: "remove", note: null };

const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
const generalNote = () =>
  screen.getByPlaceholderText("Anything else the agent should change?") as HTMLTextAreaElement;

function renderSummary(
  marks: Record<string, FileMark>,
  { onJump = vi.fn(), onChanged = vi.fn(), runRecord = run } = {},
) {
  render(
    <ReviewSummary
      run={runRecord}
      paths={paths}
      marks={marks}
      onJump={onJump}
      onChanged={onChanged}
    />,
  );
  return { onJump, onChanged };
}

describe("ReviewSummary", () => {
  it("finish is disabled while a file is undecided", () => {
    renderSummary({ "a.ts": keep, "b.ts": remove });
    expect(button("Finish review").disabled).toBe(true);
    screen.getByRole("heading", { name: "Undecided (1)" });
    fireEvent.click(button("Finish review"));
    expect(finishFileReview).not.toHaveBeenCalled();
  });

  it("finish with only keeps and removes calls finishFileReview without a note", async () => {
    const { onChanged } = renderSummary({ "a.ts": keep, "b.ts": remove, "c.ts": keep });
    screen.getByRole("heading", { name: "Kept (2)" });
    screen.getByRole("heading", { name: "Removed (1)" });
    fireEvent.change(generalNote(), { target: { value: "   " } });
    fireEvent.click(button("Finish review"));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(finishFileReview).toHaveBeenCalledWith("r1", undefined);
  });

  it("redo files change the finish label and the general note is sent", async () => {
    const { onChanged } = renderSummary({
      "a.ts": keep,
      "b.ts": { decision: "redo", note: "wrong import" },
      "c.ts": keep,
    });
    screen.getByRole("heading", { name: "Redo (1)" });
    screen.getByText("wrong import");
    expect(screen.queryByRole("button", { name: "Finish review" })).toBeNull();
    fireEvent.change(generalNote(), { target: { value: "  add tests  " } });
    fireEvent.click(button("Apply and redo"));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(finishFileReview).toHaveBeenCalledWith("r1", "add tests");
  });

  it("a general note alone turns finish into a redo", () => {
    renderSummary({ "a.ts": keep, "b.ts": keep, "c.ts": keep });
    button("Finish review");
    fireEvent.change(generalNote(), { target: { value: "add tests" } });
    button("Apply and redo");
  });

  it("a failed finish shows the error and keeps the summary", async () => {
    vi.mocked(finishFileReview).mockRejectedValueOnce("no changes left; discard the run instead");
    const { onChanged } = renderSummary({ "a.ts": remove, "b.ts": remove, "c.ts": remove });
    fireEvent.click(button("Finish review"));
    await screen.findByText("no changes left; discard the run instead");
    expect(onChanged).not.toHaveBeenCalled();
    expect(button("Finish review").disabled).toBe(false);
    screen.getByRole("heading", { name: "Removed (3)" });
  });

  it("discard asks for confirmation first", async () => {
    const { onChanged } = renderSummary({ "a.ts": keep });
    fireEvent.click(button("Discard run"));
    expect(discardRun).not.toHaveBeenCalled();
    screen.getByText(/Discard this run\? Its branch is deleted/);
    fireEvent.click(button("Cancel"));
    expect(screen.queryByText(/Discard this run\?/)).toBeNull();

    fireEvent.click(button("Discard run"));
    fireEvent.click(button("Yes, discard"));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(discardRun).toHaveBeenCalledWith("r1");
  });

  it("hand off opens the run in the editor", async () => {
    const { onChanged } = renderSummary({ "a.ts": keep });
    fireEvent.click(button("Open in editor / hand off"));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(handOffRun).toHaveBeenCalledWith("r1");
  });

  it("the summary warns that removed files are deleted", () => {
    renderSummary({ "a.ts": keep, "b.ts": keep, "c.ts": keep });
    expect(screen.queryByText(/deleted from the branch/)).toBeNull();
    cleanup();
    renderSummary({ "a.ts": keep, "b.ts": remove, "c.ts": keep });
    screen.getByText(/deleted from the branch when you finish/);
  });

  it("clicking a file jumps back to it", () => {
    const { onJump } = renderSummary({ "a.ts": keep, "b.ts": remove, "c.ts": keep });
    fireEvent.click(button("b.ts"));
    expect(onJump).toHaveBeenCalledWith("b.ts");
  });

  it("shows what the last redo changed only after a redo", () => {
    renderSummary({ "a.ts": keep });
    expect(screen.queryByText("Since last redo")).toBeNull();
    cleanup();
    renderSummary(
      { "a.ts": keep },
      { runRecord: { ...run, previousCommitSha: "p1" } as RunRecord },
    );
    screen.getByText("Since last redo");
    expect(screen.getByTestId("diff").dataset.redone).toBe("true");
  });
});
