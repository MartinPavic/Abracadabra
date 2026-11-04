import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../lib/api";
import { agentPresets } from "../lib/agentPresets";
import { AgentCommandsSection } from "./AgentCommandsSection";

vi.mock("../lib/api", () => ({
  AGENT_CREDENTIAL_ID: "agent-credential",
  hasToken: vi.fn().mockResolvedValue(false),
  removeToken: vi.fn(),
  setToken: vi.fn(),
}));
vi.mock("./TestCommandButton", () => ({ TestCommandButton: () => null }));

afterEach(cleanup);

const config = {
  agent: {
    workerCmd: "custom worker", reviewerCmd: "custom reviewer", planCmd: "", descriptionCmd: "",
    credentialEnvVar: "EXISTING_TOKEN", timeoutSecs: 1800,
    workerPromptFile: "/prompts/worker.md", reviewerPromptFile: "", planPromptFile: "", usageRegex: "",
  },
  testCmd: "pnpm test",
} as AppConfig;

describe("AgentCommandsSection presets", () => {
  it.each([ ["claude", "claude -p", "--permission-mode plan"],
    ["codex", "codex --ask-for-approval never exec", "--sandbox read-only"] ])(
    "populates and saves all agent commands for %s without changing other settings",
    async (preset, executable, readOnly) => {
      const onChange = vi.fn().mockResolvedValue(undefined);
      render(<AgentCommandsSection config={config} onChange={onChange} />);
      fireEvent.change(screen.getByLabelText("Agent preset"), { target: { value: preset } });
      expect(onChange).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Save commands" }));
      await waitFor(() => expect(onChange).toHaveBeenCalledOnce());
      const saved = onChange.mock.calls[0][0] as AppConfig;
      expect(saved.agent.workerCmd).toContain(executable);
      expect(saved.agent.workerCmd).toContain('{prompt_file}');
      expect(saved.agent.reviewerCmd).toContain(readOnly);
      expect(saved.agent.planCmd).toBe(saved.agent.reviewerCmd);
      expect(saved.agent.descriptionCmd).toBe(saved.agent.reviewerCmd);
      expect(saved.agent.credentialEnvVar).toBe("EXISTING_TOKEN");
      expect(saved.agent.workerPromptFile).toBe("/prompts/worker.md");
      expect(saved.testCmd).toBe("pnpm test");
    },
  );

  it("saving agent commands stores the inferred preset", async () => {
    const preset = agentPresets[0];
    const onChange = vi.fn().mockResolvedValue(undefined);
    const presetConfig = {
      ...config,
      agent: {
        ...config.agent,
        workerCmd: preset.worker,
        reviewerCmd: preset.readOnly,
        planCmd: preset.readOnly,
        descriptionCmd: preset.readOnly,
      },
    } as AppConfig;
    render(<AgentCommandsSection config={presetConfig} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Credential environment variable"), {
      target: { value: "OTHER_TOKEN" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save commands" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledOnce());
    expect((onChange.mock.calls[0][0] as AppConfig).agent.preset).toBe(preset.id);

    onChange.mockClear();
    fireEvent.change(screen.getByLabelText("Worker command"), { target: { value: "my-agent" } });
    fireEvent.click(screen.getByRole("button", { name: "Save commands" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledOnce());
    expect((onChange.mock.calls[0][0] as AppConfig).agent.preset).toBe("");
  });

  it("returns to custom when a preset command is edited", () => {
    render(<AgentCommandsSection config={config} onChange={vi.fn()} />);
    const select = screen.getByLabelText("Agent preset") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "claude" } });
    expect(select.value).toBe("claude");
    fireEvent.change(screen.getByLabelText("Worker command"), { target: { value: "my-agent" } });
    expect(select.value).toBe("");
  });
});