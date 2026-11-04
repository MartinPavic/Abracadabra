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
});