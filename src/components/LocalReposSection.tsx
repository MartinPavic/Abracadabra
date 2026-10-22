import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import type { AppConfig } from "../lib/api";

const inputClass =
  "w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100";
const buttonClass =
  "rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900";

/** Maps project paths (e.g. group/project) to the user's local checkouts where runs do their work. */
export function LocalReposSection({
  config,
  onChange,
}: {
  config: AppConfig;
  onChange: (next: AppConfig) => Promise<void>;
}) {
  const [project, setProject] = useState("");
  const [folder, setFolder] = useState("");
  const [error, setError] = useState<string | null>(null);

  const entries = Object.entries(config.localRepos ?? {});
  const canAdd = project.trim() !== "" && folder.trim() !== "";

  async function browse() {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") setFolder(selected);
  }

  async function save(localRepos: Record<string, string>) {
    setError(null);
    try {
      await onChange({ ...config, localRepos });
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleAdd() {
    await save({ ...config.localRepos, [project.trim()]: folder.trim() });
    setProject("");
    setFolder("");
  }

  async function handleRemove(projectPath: string) {
    const { [projectPath]: _removed, ...rest } = config.localRepos;
    await save(rest);
  }

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          Local project folders
        </h2>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Where each project's work gets done. A run stashes your uncommitted changes, works on a new
          branch in this folder and leaves it on that branch for review; projects without a folder
          are cloned into the app's data folder. One run at a time per project.
        </p>
      </div>

      {entries.length > 0 && (
        <ul className="flex flex-col gap-2">
          {entries.map(([projectPath, localPath]) => (
            <li
              key={projectPath}
              className="flex items-center justify-between rounded-lg border border-zinc-200 px-4 py-2 dark:border-zinc-800"
            >
              <div className="min-w-0">
                <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                  {projectPath}
                </div>
                <div className="truncate text-xs text-zinc-500 dark:text-zinc-400">{localPath}</div>
              </div>
              <button
                type="button"
                onClick={() => handleRemove(projectPath)}
                className="rounded-md px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-2 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <input
          className={inputClass}
          placeholder="Project path, e.g. group/project"
          value={project}
          onChange={(e) => setProject(e.target.value)}
        />
        <div className="flex gap-2">
          <input
            className={inputClass}
            placeholder="/absolute/path/to/local/checkout"
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
          />
          <button type="button" onClick={browse} className={buttonClass}>
            Browse...
          </button>
        </div>
        <div className="flex items-center gap-3">
          <button type="button" disabled={!canAdd} onClick={handleAdd} className={buttonClass}>
            Add folder
          </button>
          {error && <span className="text-sm text-red-600 dark:text-red-400">{error}</span>}
        </div>
      </div>
    </section>
  );
}
