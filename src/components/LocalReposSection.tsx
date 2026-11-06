import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import type { AppConfig } from "../lib/api";
import { Button, Card, Input, Notice } from "./ui";

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
    <Card
      title="Project checkouts"
      description={
        <>
          Without an entry the app works in its own clone of the project; add an entry to run in
          your own checkout instead.{" "}
          Where each project's work gets done. A run stashes your uncommitted changes, works on a new
          branch in this folder and leaves it on that branch for review; projects without a folder
          are cloned into the app's data folder. One run at a time per project.
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {entries.length > 0 && (
          <ul className="flex flex-col gap-2">
            {entries.map(([projectPath, localPath]) => (
              <li
                key={projectPath}
                className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-800"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
                    {projectPath}
                  </div>
                  <div className="truncate font-mono text-xs text-zinc-500 dark:text-zinc-400">
                    {localPath}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  icon="trash"
                  className="shrink-0"
                  onClick={() => handleRemove(projectPath)}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex flex-col gap-2 rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
          <Input
            mono
            placeholder="Project path, e.g. group/project"
            value={project}
            onChange={(e) => setProject(e.target.value)}
          />
          <div className="flex gap-2">
            <Input
              mono
              placeholder="/absolute/path/to/local/checkout"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
            />
            <Button icon="folder" className="shrink-0" onClick={browse}>
              Browse...
            </Button>
          </div>
          <div>
            <Button variant="primary" disabled={!canAdd} onClick={handleAdd}>
              Add folder
            </Button>
          </div>
        </div>
        {error && <Notice tone="danger">{error}</Notice>}
      </div>
    </Card>
  );
}
