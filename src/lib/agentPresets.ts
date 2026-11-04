import type { AgentConfig } from "./api";

export type PresetId = "claude" | "codex";

export const agentPresets: { id: PresetId; label: string; worker: string; readOnly: string }[] = [
  {
    id: "claude",
    label: "Claude Code",
    worker: String.raw`sh -c 'exec claude -p --permission-mode acceptEdits < "$1"' abracadabra {prompt_file}`,
    readOnly: String.raw`sh -c 'exec claude -p --permission-mode plan < "$1"' abracadabra {prompt_file}`,
  },
  {
    id: "codex",
    label: "OpenAI Codex (ChatGPT)",
    worker: String.raw`sh -c 'exec codex --ask-for-approval never exec --sandbox workspace-write - < "$1"' abracadabra {prompt_file}`,
    readOnly: String.raw`sh -c 'exec codex --ask-for-approval never exec --sandbox read-only - < "$1"' abracadabra {prompt_file}`,
  },
];

/** The preset whose commands the agent uses exactly, or "" for a custom setup. */
export function inferPreset(
  agent: Pick<AgentConfig, "workerCmd" | "reviewerCmd" | "planCmd" | "descriptionCmd">,
): PresetId | "" {
  return (
    agentPresets.find(
      (preset) =>
        agent.workerCmd === preset.worker &&
        agent.reviewerCmd === preset.readOnly &&
        agent.planCmd === preset.readOnly &&
        agent.descriptionCmd === preset.readOnly,
    )?.id ?? ""
  );
}

export function applyPreset(agent: AgentConfig, id: PresetId): AgentConfig {
  const preset = agentPresets.find((item) => item.id === id);
  if (!preset) throw new Error(`unknown agent preset: ${id}`);
  return {
    ...agent,
    workerCmd: preset.worker,
    reviewerCmd: preset.readOnly,
    planCmd: preset.readOnly,
    descriptionCmd: preset.readOnly,
    preset: id,
  };
}
