import { useState } from "react";
import type { AppConfig } from "../lib/api";
import { Button, Card, Field, Input } from "./ui";

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
    <Card title="Branches">
      <Field
        label="Base branch"
        htmlFor="base-branch"
        hint={
          <>
            The branch runs start from and merge requests target. A project that doesn&apos;t have
            it uses its own default branch. Empty uses each project&apos;s default branch. Can be
            overridden per source or project.
          </>
        }
        error={error}
      >
        <div className="flex gap-2">
          <Input
            id="base-branch"
            mono
            placeholder="dev"
            aria-describedby={error ? "base-branch-hint base-branch-error" : "base-branch-hint"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <Button
            aria-label="Save base branch"
            className="shrink-0"
            disabled={!dirty || saving}
            onClick={handleSave}
          >
            {saving ? "Saving..." : "Save"}
          </Button>
        </div>
      </Field>
    </Card>
  );
}
