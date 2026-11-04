import { describe, expect, it } from "vitest";
import type { AgentConfig } from "./api";
import { agentPresets, applyPreset, inferPreset } from "./agentPresets";

const base: AgentConfig = {
  workerCmd: "w",
  reviewerCmd: "r",
  planCmd: "p",
  descriptionCmd: "d",
  credentialEnvVar: "MY_TOKEN",
  timeoutSecs: 600,
  workerPromptFile: "/prompts/worker.md",
  reviewerPromptFile: "/prompts/reviewer.md",
  planPromptFile: "/prompts/plan.md",
  usageRegex: "cost: ([0-9.]+)",
  preset: "",
};

describe("agent presets", () => {
  it("inferPreset recognises each preset and returns an empty string for edited commands", () => {
    for (const preset of agentPresets) {
      const commands = {
        workerCmd: preset.worker,
        reviewerCmd: preset.readOnly,
        planCmd: preset.readOnly,
        descriptionCmd: preset.readOnly,
      };
      expect(inferPreset(commands)).toBe(preset.id);
      expect(inferPreset({ ...commands, workerCmd: `${preset.worker} --extra` })).toBe("");
      expect(inferPreset({ ...commands, descriptionCmd: "" })).toBe("");
    }
    expect(inferPreset(base)).toBe("");
  });

  it("applyPreset sets the four commands and the preset and leaves prompt files and the credential alone", () => {
    for (const preset of agentPresets) {
      const next = applyPreset(base, preset.id);
      expect(next).toEqual({
        ...base,
        workerCmd: preset.worker,
        reviewerCmd: preset.readOnly,
        planCmd: preset.readOnly,
        descriptionCmd: preset.readOnly,
        preset: preset.id,
      });
      expect(inferPreset(next)).toBe(preset.id);
    }
    expect(base.workerCmd).toBe("w");
  });
});
