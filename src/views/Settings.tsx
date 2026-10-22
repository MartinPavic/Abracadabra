import { useState } from "react";
import { AgentCommandsSection } from "../components/AgentCommandsSection";
import { GitSourceForm, type GitSourceFormValues } from "../components/GitSourceForm";
import { LocalReposSection } from "../components/LocalReposSection";
import { OverridesEditor } from "../components/OverridesEditor";
import { ProjectOverridesSection } from "../components/ProjectOverridesSection";
import { TemplatesSection } from "../components/TemplatesSection";
import type { GitSourceConfig } from "../lib/api";
import { removeToken, setToken } from "../lib/api";
import { clearCachedTasks } from "../lib/taskCache";
import { useConfig } from "../lib/useConfig";

export function Settings() {
  const { config, loading, error, update } = useConfig();
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  /** Throws on failure, so the form can show why the source wasn't added. */
  async function handleAdd(values: GitSourceFormValues) {
    if (!config) return;

    const source: GitSourceConfig = {
      id: crypto.randomUUID(),
      name: values.name.trim(),
      provider: values.provider,
      baseUrl: values.baseUrl.trim(),
      projectFilter: values.projectFilter.trim() || null,
    };

    await setToken(source.id, values.token);
    try {
      await update({ ...config, gitSources: [...config.gitSources, source] });
    } catch (err) {
      // Don't leave a token in the keychain for a source that was never saved.
      await removeToken(source.id).catch(() => undefined);
      throw err;
    }
  }

  async function handleRemove(source: GitSourceConfig) {
    if (!config) return;
    setRemovingId(source.id);
    setRemoveError(null);
    try {
      // Config first: if saving fails the source keeps its token and keeps working.
      await update({
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

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Git sources</h1>
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
                    update({
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

      <LocalReposSection config={config} onChange={update} />
      <ProjectOverridesSection config={config} onChange={update} />
      <AgentCommandsSection config={config} onChange={update} />
      <TemplatesSection config={config} onChange={update} />
    </div>
  );
}
