import { useState } from "react";
import type { AppConfig, GitSourceConfig } from "../lib/api";
import { removeToken } from "../lib/api";
import { addGitSource } from "../lib/gitSources";
import { clearCachedTasks } from "../lib/taskCache";
import { GitSourceForm, type GitSourceFormValues } from "./GitSourceForm";
import { OverridesEditor } from "./OverridesEditor";
import { Button, Card, Icon, Notice } from "./ui";

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
    <Card
      title="Git sources"
      description="Connect a GitLab or GitHub instance to start fetching your assigned issues."
    >
      <div className="flex flex-col gap-4">
        {removeError && <Notice tone="danger">{removeError}</Notice>}

        {config.gitSources.length > 0 && (
          <ul className="flex flex-col gap-2">
            {config.gitSources.map((source) => (
              <li
                key={source.id}
                className="rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-800"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
                      {source.name}
                    </div>
                    <div className="truncate text-xs text-zinc-500 dark:text-zinc-400">
                      {source.provider} &middot; {source.baseUrl}
                      {source.projectFilter ? ` \u00b7 ${source.projectFilter}` : ""}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="trash"
                    className="shrink-0"
                    disabled={removingId === source.id}
                    onClick={() => handleRemove(source)}
                  >
                    {removingId === source.id ? "Removing..." : "Remove"}
                  </Button>
                </div>
                <details className="group mt-1">
                  <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded text-xs text-zinc-600 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 dark:text-zinc-400 dark:hover:text-zinc-100 [&::-webkit-details-marker]:hidden">
                    <Icon
                      name="chevron-right"
                      className="size-3.5 transition-transform group-open:rotate-90 motion-reduce:transition-none"
                    />
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
      </div>
    </Card>
  );
}
