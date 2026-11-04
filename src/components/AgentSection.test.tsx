import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectAgentClis, testAgentCommand, type AppConfig } from "../lib/api";
import { agentPresets } from "../lib/agentPresets";
import { AgentSection } from "./AgentSection";

vi.mock("../lib/api", () => ({
  detectAgentClis: vi.fn(),
  testAgentCommand: vi.fn(),
  describeError: (err: unknown) => String(err),
}));

const claude = agentPresets[0];

function configWith(agent: Partial<AppConfig["agent"]>): AppConfig {
  return {
    agent: {
      workerCmd: "", reviewerCmd: "", planCmd: "", descriptionCmd: "", preset: "",
      credentialEnvVar: "KEEP_ME", timeoutSecs: 1800,
      ...agent,
    },
    testCmd: "pnpm test",
  } as AppConfig;
}

const handEdited = configWith({
  workerCmd: "my worker", reviewerCmd: "my reviewer", planCmd: "my plan", descriptionCmd: "my desc",
});

beforeEach(() => {
  vi.mocked(detectAgentClis).mockResolvedValue([{ id: "claude", path: "/bin/claude" }]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AgentSection", () => {
  it("choosing a preset saves its commands and preset", async () => {
    const config = configWith({});
    const onChange = vi.fn().mockResolvedValue(undefined);
    render(<AgentSection config={config} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /Claude Code/ }));
    await waitFor(() => expect(onChange).toHaveBeenCalledOnce());
    expect(onChange).toHaveBeenCalledWith({
      ...config,
      agent: {
        ...config.agent,
        workerCmd: claude.worker,
        reviewerCmd: claude.readOnly,
        planCmd: claude.readOnly,
        descriptionCmd: claude.readOnly,
        preset: "claude",
      },
    });
    await screen.findByText("Detected");
  });

  it("choosing a preset over hand-edited commands asks first and does nothing on cancel", async () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    render(<AgentSection config={handEdited} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /Claude Code/ }));
    expect(screen.getByText("Replace your edited commands?")).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Replace your edited commands?")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Claude Code/ }));
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledOnce());
    expect(onChange.mock.calls[0][0].agent).toMatchObject({
      workerCmd: claude.worker,
      preset: "claude",
    });
    await screen.findByText("Detected");
  });

  it("choosing a preset over partly-filled commands asks first", async () => {
    const partly = configWith({ workerCmd: "my worker", reviewerCmd: "my reviewer" });
    const onChange = vi.fn().mockResolvedValue(undefined);
    render(<AgentSection config={partly} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /Claude Code/ }));
    expect(screen.getByText("Replace your edited commands?")).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
    await screen.findByText("Detected");
  });

  it("a preset that is not on PATH is labelled", async () => {
    render(<AgentSection config={configWith({})} onChange={vi.fn()} />);
    expect(await screen.findByText("Detected")).toBeTruthy();
    expect(screen.getAllByText("Not found on PATH")).toHaveLength(agentPresets.length - 1);
  });

  it("treats a failed detection as nothing detected", async () => {
    vi.mocked(detectAgentClis).mockRejectedValue(new Error("boom"));
    render(<AgentSection config={configWith({})} onChange={vi.fn()} />);
    expect(await screen.findAllByText("Not found on PATH")).toHaveLength(agentPresets.length);
  });

  it("selecting the current preset does nothing", async () => {
    const config = configWith({ workerCmd: claude.worker, preset: "claude" });
    const onChange = vi.fn().mockResolvedValue(undefined);
    render(<AgentSection config={config} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /Claude Code/ }));
    expect(onChange).not.toHaveBeenCalled();
    await screen.findByText("Detected");
  });

  it("a custom setup shows the custom card", async () => {
    render(<AgentSection config={handEdited} onChange={vi.fn()} />);
    expect(screen.getByText("Custom")).toBeTruthy();
    expect(screen.getByText("Edit the commands under Advanced")).toBeTruthy();
    await screen.findByText("Detected");
  });

  it("shows an error from saving a preset", async () => {
    const onChange = vi.fn().mockRejectedValue("disk full");
    render(<AgentSection config={configWith({})} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /Claude Code/ }));
    expect(await screen.findByText("disk full")).toBeTruthy();
  });

  it("test agent runs the worker command and shows the result", async () => {
    vi.mocked(testAgentCommand).mockResolvedValue({
      ok: true, timedOut: false, output: "OK from agent", error: null,
    });
    const config = configWith({ workerCmd: claude.worker });
    render(<AgentSection config={config} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Test agent" }));
    expect(await screen.findByText("OK from agent")).toBeTruthy();
    expect(testAgentCommand).toHaveBeenCalledWith(claude.worker);
    expect(screen.getByText("OK")).toBeTruthy();
  });

  it("test agent is disabled without a worker command", async () => {
    render(<AgentSection config={configWith({})} onChange={vi.fn()} />);
    expect((screen.getByRole("button", { name: "Test agent" }) as HTMLButtonElement).disabled).toBe(true);
    await screen.findByText("Detected");
  });
});
