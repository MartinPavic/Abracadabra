import { useState } from "react";
import type { AppConfig, GitSourceConfig } from "../lib/api";
import { removeToken } from "../lib/api";
import { addGitSource } from "../lib/gitSources";
import { clearCachedTasks } from "../lib/taskCache";
import { GitSourceForm, type GitSourceFormValues } from "./GitSourceForm";
import { OverridesEditor } from "./OverridesEditor";

/** Git sources: list, per-source overrides, remove and add. */
export function ConnectionsSection({
  config,
  onChange,
}: {
  config: AppConfig;
  onChange: (next: AppConfig) => Promise<void>;
}) {
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  /** Throws on failure, so the form can show why the source wasn't added. */
  async function handleAdd(values: GitSourceFormValues) {
    await addGitSource(config, onChange, values);
  }

  async function handleRemove(source: GitSourceConfig) {
    setRemovingId(source.id);
    setRemoveError(null);
    try {
      // Config first: if saving fails the source keeps its token and keeps working.
      await onChange({
        ...config,
        gitSources: config.gitSources.filter((s) => s.id !== source.id),
      });
      clearCachedTasks(source.id);
      await removeToken(source.id).catch(() => undefined);
    } catch (err) {
      setRemoveError(String(err));
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Git sources</h2>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Connect a GitLab or GitHub instance to start fetching your assigned issues.
        </p>
      </div>

      {removeError && <p className="text-sm text-red-600 dark:text-red-400">{removeError}</p>}

      {config.gitSources.length > 0 && (
        <ul className="flex flex-col gap-2">
          {config.gitSources.map((source) => (
            <li
              key={source.id}
              className="rounded-lg border border-zinc-200 px-4 py-2 dark:border-zinc-800"
            >
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                    {source.name}
                  </div>
                  <div className="text-xs text-zinc-500 dark:text-zinc-400">
                    {source.provider} &middot; {source.baseUrl}
                    {source.projectFilter ? ` \u00b7 ${source.projectFilter}` : ""}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={removingId === source.id}
                  onClick={() => handleRemove(source)}
                  className="rounded-md px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-950"
                >
                  {removingId === source.id ? "Removing..." : "Remove"}
                </button>
              </div>
              <details className="mt-1">
                <summary className="cursor-pointer text-xs text-zinc-600 dark:text-zinc-400">
                  Overrides for this source
                </summary>
                <OverridesEditor
                  value={source.overrides ?? {}}
                  onSave={(overrides) =>
                    onChange({
                      ...config,
                      gitSources: config.gitSources.map((s) =>
                        s.id === source.id ? { ...s, overrides } : s,
                      ),
                    })
                  }
                />
              </details>
            </li>
          ))}
        </ul>
      )}

      <GitSourceForm onAdd={handleAdd} />
    </section>
  );
}
