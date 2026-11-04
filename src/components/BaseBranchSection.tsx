import { useState } from "react";
import type { AppConfig } from "../lib/api";

const inputClass =
  "w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 font-mono text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100";

/** The branch runs start from and merge requests target. */
export function BaseBranchSection({
  config,
  onChange,
}: {
  config: AppConfig;
  onChange: (next: AppConfig) => Promise<void>;
}) {
  const [value, setValue] = useState(config.baseBranch ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = value !== (config.baseBranch ?? "");

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await onChange({ ...config, baseBranch: value.trim() });
      setValue(value.trim());
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Branches</h2>
      <div>
        <label
          className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400"
          htmlFor="base-branch"
        >
          Base branch
        </label>
        <div className="flex gap-2">
          <input
            id="base-branch"
            className={inputClass}
            placeholder="dev"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <button
            type="button"
            aria-label="Save base branch"
            disabled={!dirty || saving}
            onClick={handleSave}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          The branch runs start from and merge requests target. A project that doesn&apos;t have
          it uses its own default branch. Empty uses each project&apos;s default branch. Can be
          overridden per source or project.
        </p>
        {error && <p className="mt-1 text-sm text-red-600 dark:text-red-400">{error}</p>}
      </div>
    </section>
  );
}
