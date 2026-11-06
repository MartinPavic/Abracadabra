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
import { buttonClasses, Icon, Notice, PageHeader } from "../components/ui";
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
    return <Notice tone="danger">Failed to load settings: {error ?? "unknown error"}</Notice>;
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
    <div className="mx-auto w-full max-w-3xl">
      <PageHeader
        title="Settings"
        description="Git sources, the coding agent and how runs work."
        actions={
          <Link to="/setup" className={buttonClasses("secondary", "sm")}>
            Run setup again
          </Link>
        }
      />

      <div className="flex flex-col gap-6">
        <ConnectionsSection config={config} onChange={update} />
        <AgentSection config={config} onChange={update} />
        <InstructionsSection config={config} />
        <BaseBranchSection config={config} onChange={update} />

        <details
          open={advancedOpen}
          onToggle={(e) => handleAdvancedToggle(e.currentTarget.open)}
          className="group/advanced"
        >
          <summary className="flex cursor-pointer list-none items-center gap-2 rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm font-semibold text-zinc-900 hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800/60 [&::-webkit-details-marker]:hidden">
            <Icon
              name="chevron-right"
              className="size-4 text-zinc-500 transition-transform group-open/advanced:rotate-90 motion-reduce:transition-none dark:text-zinc-400"
            />
            Advanced
          </summary>
          <div className="mt-6 flex flex-col gap-6">
            <AgentCommandsSection key={commandsKey} config={config} onChange={update} />
            <TemplatesSection config={config} onChange={update} />
            <ProjectOverridesSection config={config} onChange={update} />
            <LocalReposSection config={config} onChange={update} />
          </div>
        </details>
      </div>
    </div>
  );
}
