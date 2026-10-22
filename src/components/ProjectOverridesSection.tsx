import { useState } from "react";
import type { AppConfig, SettingsOverride } from "../lib/api";
import { isEmptyOverride, OverridesEditor } from "./OverridesEditor";

const inputClass =
  "w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100";

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
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          Project overrides
        </h2>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Use different templates or agent commands for a single project. Blank fields fall back
          to the git source's overrides, then to the defaults.
        </p>
      </div>

      {projects.map((projectPath) => (
        <details
          key={projectPath}
          className="rounded-lg border border-zinc-200 px-4 py-2 dark:border-zinc-800"
          open={pending.includes(projectPath)}
        >
          <summary className="cursor-pointer text-sm font-medium text-zinc-900 dark:text-zinc-100">
            {projectPath}
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
        <input
          className={inputClass}
          placeholder="Project path, e.g. group/project"
          value={project}
          onChange={(e) => setProject(e.target.value)}
        />
        <button
          type="button"
          disabled={project.trim() === ""}
          onClick={handleAdd}
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
        >
          Add
        </button>
      </div>
    </section>
  );
}
