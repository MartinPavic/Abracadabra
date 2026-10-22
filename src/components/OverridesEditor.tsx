import { useState } from "react";
import type { SettingsOverride } from "../lib/api";
import { AutoTextarea } from "./AutoTextarea";

const FIELDS: { key: keyof SettingsOverride; label: string }[] = [
  { key: "baseBranch", label: "Base branch" },
  { key: "branchTemplate", label: "Branch template" },
  { key: "commitTemplate", label: "Commit template" },
  { key: "workerCmd", label: "Worker command" },
  { key: "reviewerCmd", label: "Reviewer command" },
  { key: "planCmd", label: "Plan command" },
  { key: "descriptionCmd", label: "Description command" },
  { key: "testCmd", label: "Test command" },
  { key: "workerPromptFile", label: "Worker system prompt file" },
  { key: "reviewerPromptFile", label: "Reviewer system prompt file" },
  { key: "planPromptFile", label: "Plan system prompt file" },
];

const inputClass =
  "w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 font-mono text-xs text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100";

/** Normalizes blank fields to null so they fall back to the next level. */
export function cleanOverride(value: SettingsOverride): SettingsOverride {
  const entries = FIELDS.map(({ key }) => [key, value[key]?.trim() ? value[key] : null]);
  return Object.fromEntries(entries) as SettingsOverride;
}

export function isEmptyOverride(value: SettingsOverride): boolean {
  return FIELDS.every(({ key }) => !value[key]?.trim());
}

/** Editable overrides; leave a field blank to use the default. */
export function OverridesEditor({
  value,
  onSave,
}: {
  value: SettingsOverride;
  onSave: (next: SettingsOverride) => Promise<void>;
}) {
  const [draft, setDraft] = useState<SettingsOverride>(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = FIELDS.some(({ key }) => (draft[key] ?? "") !== (value[key] ?? ""));

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await onSave(cleanOverride(draft));
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 pt-2">
      {FIELDS.map(({ key, label }) => (
        <label key={key} className="block text-xs text-zinc-600 dark:text-zinc-400">
          {label}
          <AutoTextarea
            className={`${inputClass} mt-1`}
            placeholder="(use default)"
            value={draft[key] ?? ""}
            onChange={(e) => setDraft((prev) => ({ ...prev, [key]: e.target.value }))}
          />
        </label>
      ))}
      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={!dirty || saving}
          onClick={handleSave}
          className="rounded-md border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
        >
          {saving ? "Saving..." : "Save overrides"}
        </button>
        {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
      </div>
    </div>
  );
}
