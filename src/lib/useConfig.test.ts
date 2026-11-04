import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AppConfig, getConfig, saveConfig } from "./api";
import { agentPresets } from "./agentPresets";
import { useConfig } from "./useConfig";

vi.mock("./api", () => ({ getConfig: vi.fn(), saveConfig: vi.fn() }));

const claude = agentPresets[0];

function configWith(agent: Partial<AppConfig["agent"]>): AppConfig {
  return {
    gitSources: [],
    agent: {
      workerCmd: "", reviewerCmd: "", planCmd: "", descriptionCmd: "", preset: "",
      credentialEnvVar: "", timeoutSecs: 1800,
      ...agent,
    },
  } as unknown as AppConfig;
}

const claudeCommands = {
  workerCmd: claude.worker,
  reviewerCmd: claude.readOnly,
  planCmd: claude.readOnly,
  descriptionCmd: claude.readOnly,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function loaded() {
  vi.mocked(getConfig).mockResolvedValue(configWith({}));
  vi.mocked(saveConfig).mockResolvedValue(undefined);
  const hook = renderHook(() => useConfig());
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  return hook;
}

describe("useConfig", () => {
  it("update saves the preset inferred from the commands", async () => {
    const { result } = await loaded();
    const next = configWith({ ...claudeCommands, preset: "" });
    await act(() => result.current.update(next));
    expect(saveConfig).toHaveBeenCalledExactlyOnceWith(configWith({ ...claudeCommands, preset: "claude" }));
    expect(result.current.config?.agent.preset).toBe("claude");
    expect(next.agent.preset).toBe("");
  });

  it("update clears a preset the commands no longer match", async () => {
    const { result } = await loaded();
    await act(() =>
      result.current.update(configWith({ ...claudeCommands, workerCmd: "my worker", preset: "claude" })),
    );
    expect(vi.mocked(saveConfig).mock.calls[0][0].agent.preset).toBe("");
    expect(result.current.config?.agent.preset).toBe("");
  });
});
