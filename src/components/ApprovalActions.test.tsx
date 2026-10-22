import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { approveRun, discardRun, redoRun } from "../lib/api";
import { ApprovalActions } from "./ApprovalActions";

vi.mock("../lib/api", () => ({
  describeError: String,
  approveRun: vi.fn().mockResolvedValue(undefined),
  discardRun: vi.fn().mockResolvedValue(undefined),
  handOffRun: vi.fn().mockResolvedValue(undefined),
  redoRun: vi.fn().mockResolvedValue(undefined),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

describe("ApprovalActions", () => {
  it("is disabled unless the run awaits approval", () => {
    render(<ApprovalActions runId="r1" status="working" />);
    expect(button("Yes").disabled).toBe(true);
    expect(button("No").disabled).toBe(true);
  });

  it("approves with one click", async () => {
    render(<ApprovalActions runId="r1" status="awaiting_approval" />);
    fireEvent.click(button("Yes"));
    await waitFor(() => expect(approveRun).toHaveBeenCalledWith("r1"));
  });

  it("asks for confirmation before discarding", async () => {
    render(<ApprovalActions runId="r1" status="awaiting_approval" />);
    fireEvent.click(button("No"));
    expect(discardRun).not.toHaveBeenCalled();
    fireEvent.click(button("Yes, discard"));
    await waitFor(() => expect(discardRun).toHaveBeenCalledWith("r1"));
  });

  it("cancelling the confirmation keeps the run", () => {
    render(<ApprovalActions runId="r1" status="awaiting_approval" />);
    fireEvent.click(button("No"));
    fireEvent.click(button("Cancel"));
    expect(screen.queryByText("Yes, discard")).toBeNull();
    expect(discardRun).not.toHaveBeenCalled();
  });

  it("redo needs feedback text and sends it trimmed", async () => {
    render(<ApprovalActions runId="r1" status="awaiting_approval" />);
    fireEvent.click(button("Redo automatically"));
    expect(button("Run again").disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "  use tabs  " } });
    fireEvent.click(button("Run again"));
    await waitFor(() => expect(redoRun).toHaveBeenCalledWith("r1", "use tabs"));
  });

  it("shows the error when an action fails", async () => {
    vi.mocked(approveRun).mockRejectedValueOnce("push rejected");
    render(<ApprovalActions runId="r1" status="awaiting_approval" />);
    fireEvent.click(button("Yes"));
    await screen.findByText("push rejected");
  });
});
