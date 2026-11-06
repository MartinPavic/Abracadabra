import { useState } from "react";
import type { AppConfig, SettingsOverride } from "../lib/api";
import { isEmptyOverride, OverridesEditor } from "./OverridesEditor";
import { Button, Card, Icon, Input } from "./ui";

/** Per-project overrides of templates and agent commands (win over per-source ones). */
export function ProjectOverridesSection({
  config,
  onChange,
}: {
  config: AppConfig;
  onChange: (next: AppConfig) => Promise<void>;
}) {
  const [project, setProject] = useState("");
  const [pending, setPending] = useState<string[]>([]);
  const overrides = config.projectOverrides ?? {};

  async function save(projectPath: string, value: SettingsOverride) {
    const next = { ...overrides };
    if (isEmptyOverride(value)) delete next[projectPath];
    else next[projectPath] = value;
    await onChange({ ...config, projectOverrides: next });
  }

  async function handleAdd() {
    const path = project.trim();
    if (path === "") return;
    // An empty entry isn't persisted; the editor appears and saves on first real value.
    setPending((prev) => (prev.includes(path) ? prev : [...prev, path]));
    setProject("");
  }

  const projects = Array.from(new Set([...Object.keys(overrides), ...pending]));

  return (
    <Card
      title="Project overrides"
      description="Use different templates or agent commands for a single project. Blank fields fall back to the git source's overrides, then to the defaults."
    >
      <div className="flex flex-col gap-3">
        {projects.map((projectPath) => (
          <details
            key={projectPath}
            className="group rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-800"
            open={pending.includes(projectPath)}
          >
            <summary className="flex min-w-0 cursor-pointer list-none items-center gap-1.5 rounded text-sm font-medium text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 dark:text-zinc-100 [&::-webkit-details-marker]:hidden">
              <Icon
                name="chevron-right"
                className="size-3.5 shrink-0 text-zinc-500 transition-transform group-open:rotate-90 motion-reduce:transition-none dark:text-zinc-400"
              />
              <span className="truncate font-mono">{projectPath}</span>
            </summary>
            <OverridesEditor
              value={overrides[projectPath] ?? {}}
              onSave={async (value) => {
                await save(projectPath, value);
                if (isEmptyOverride(value)) return;
                setPending((prev) => prev.filter((p) => p !== projectPath));
              }}
            />
          </details>
        ))}

        <div className="flex gap-2">
          <Input
            mono
            placeholder="Project path, e.g. group/project"
            value={project}
            onChange={(e) => setProject(e.target.value)}
          />
          <Button className="shrink-0" disabled={project.trim() === ""} onClick={handleAdd}>
            Add
          </Button>
        </div>
      </div>
    </Card>
  );
}
