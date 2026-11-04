import { useState } from "react";
import { Link } from "react-router-dom";
import { AgentCommandsSection } from "../components/AgentCommandsSection";
import { AgentSection } from "../components/AgentSection";
import { BaseBranchSection } from "../components/BaseBranchSection";
import { ConnectionsSection } from "../components/ConnectionsSection";
import { InstructionsSection } from "../components/InstructionsSection";
import { LocalReposSection } from "../components/LocalReposSection";
import { ProjectOverridesSection } from "../components/ProjectOverridesSection";
import { TemplatesSection } from "../components/TemplatesSection";
import { useConfig } from "../lib/useConfig";

export const ADVANCED_OPEN_KEY = "settings-advanced-open";

export function Settings() {
  const { config, loading, error, update } = useConfig();
  const [advancedOpen, setAdvancedOpen] = useState(
    () => localStorage.getItem(ADVANCED_OPEN_KEY) === "1",
  );

  function handleAdvancedToggle(open: boolean) {
    setAdvancedOpen(open);
    localStorage.setItem(ADVANCED_OPEN_KEY, open ? "1" : "0");
  }

  if (loading) {
    return <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading...</p>;
  }

  if (error || !config) {
    return (
      <p className="text-sm text-red-600 dark:text-red-400">
        Failed to load settings: {error ?? "unknown error"}
      </p>
    );
  }

  const agent = config.agent;
  // AgentCommandsSection seeds its fields once; remount it when Basics changes the commands.
  const commandsKey = JSON.stringify([
    agent.workerCmd,
    agent.reviewerCmd,
    agent.planCmd,
    agent.descriptionCmd,
    agent.preset,
    agent.credentialEnvVar,
  ]);

  return (
    <div className="flex max-w-2xl flex-col gap-8">
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Settings</h1>
        <Link
          to="/setup"
          className="text-sm text-zinc-600 underline hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
        >
          Run setup again
        </Link>
      </div>

      <ConnectionsSection config={config} onChange={update} />
      <AgentSection config={config} onChange={update} />
      <InstructionsSection config={config} />
      <BaseBranchSection config={config} onChange={update} />

      <details
        open={advancedOpen}
        onToggle={(e) => handleAdvancedToggle(e.currentTarget.open)}
        className="rounded-lg border border-zinc-200 px-4 py-3 dark:border-zinc-800"
      >
        <summary className="cursor-pointer text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          Advanced
        </summary>
        <div className="mt-4 flex flex-col gap-8">
          <AgentCommandsSection key={commandsKey} config={config} onChange={update} />
          <TemplatesSection config={config} onChange={update} />
          <ProjectOverridesSection config={config} onChange={update} />
          <LocalReposSection config={config} onChange={update} />
        </div>
      </details>
    </div>
  );
}
