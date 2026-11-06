import { useId, useState } from "react";
import type { SettingsOverride } from "../lib/api";
import { AutoTextarea } from "./AutoTextarea";
import { Button, Field, Notice } from "./ui";

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
  // Several editors can be on the page at once, so ids must be unique per instance.
  const idPrefix = useId();
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
    <div className="flex flex-col gap-3 pt-3">
      {FIELDS.map(({ key, label }) => (
        <Field key={key} label={label} htmlFor={`${idPrefix}-${key}`}>
          <AutoTextarea
            id={`${idPrefix}-${key}`}
            mono
            placeholder="(use default)"
            value={draft[key] ?? ""}
            onChange={(e) => setDraft((prev) => ({ ...prev, [key]: e.target.value }))}
          />
        </Field>
      ))}
      <div>
        <Button size="sm" disabled={!dirty || saving} onClick={handleSave}>
          {saving ? "Saving..." : "Save overrides"}
        </Button>
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
    </div>
  );
}
