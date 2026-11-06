import { type FormEvent, useState } from "react";
import {
  describeError,
  type GitProvider,
  testConnection,
} from "../lib/api";
import { Badge, Button, Field, Input, Notice, Select } from "./ui";

export interface GitSourceFormValues {
  name: string;
  provider: GitProvider;
  baseUrl: string;
  token: string;
  projectFilter: string;
}

const emptyValues: GitSourceFormValues = {
  name: "",
  provider: "gitlab",
  baseUrl: "",
  token: "",
  projectFilter: "",
};

type TestState =
  | { status: "idle" }
  | { status: "testing" }
  | { status: "success" }
  | { status: "error"; message: string };

export function GitSourceForm({
  onAdd,
}: {
  onAdd: (values: GitSourceFormValues) => Promise<void>;
}) {
  const [values, setValues] = useState<GitSourceFormValues>(emptyValues);
  const [testState, setTestState] = useState<TestState>({ status: "idle" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const canTest = values.baseUrl.trim() !== "" && values.token.trim() !== "";
  const isGitHub = values.provider === "github";
  const canSave = values.name.trim() !== "" && canTest;

  function set<K extends keyof GitSourceFormValues>(key: K, value: GitSourceFormValues[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setTestState({ status: "idle" });
  }

  async function handleTestConnection() {
    setTestState({ status: "testing" });
    try {
      await testConnection({
        provider: values.provider,
        baseUrl: values.baseUrl.trim(),
        token: values.token,
      });
      setTestState({ status: "success" });
    } catch (err) {
      const host = (() => {
        try {
          return new URL(values.baseUrl.trim()).host;
        } catch {
          return undefined;
        }
      })();
      setTestState({ status: "error", message: describeError(err, host) });
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onAdd(values);
      setValues(emptyValues);
      setTestState({ status: "idle" });
    } catch (err) {
      setSaveError(String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-4 rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-950/40"
    >
      <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Add git source</h3>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Name" htmlFor="source-name">
          <Input
            id="source-name"
            value={values.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="My GitLab"
          />
        </Field>

        <Field label="Provider" htmlFor="source-provider">
          <Select
            id="source-provider"
            value={values.provider}
            onChange={(e) => set("provider", e.target.value as GitProvider)}
          >
            <option value="gitlab">GitLab</option>
            <option value="github">GitHub</option>
          </Select>
        </Field>

        <div className="col-span-2">
          <Field label="Base URL" htmlFor="source-base-url">
            <Input
              id="source-base-url"
              value={values.baseUrl}
              onChange={(e) => set("baseUrl", e.target.value)}
              placeholder={isGitHub ? "https://github.com" : "https://gitlab.com"}
            />
          </Field>
        </div>

        <div className="col-span-2">
          <Field label="Access token" htmlFor="source-token">
            <Input
              id="source-token"
              type="password"
              mono
              value={values.token}
              onChange={(e) => set("token", e.target.value)}
              placeholder={isGitHub ? "ghp_... or github_pat_..." : "glpat-..."}
            />
          </Field>
        </div>

        <div className="col-span-2">
          <Field label="Project / group filter (optional)" htmlFor="source-project-filter">
            <Input
              id="source-project-filter"
              mono
              value={values.projectFilter}
              onChange={(e) => set("projectFilter", e.target.value)}
              placeholder={isGitHub ? "owner/repo" : "group/project"}
            />
          </Field>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={!canTest || testState.status === "testing"}
          onClick={handleTestConnection}
        >
          {testState.status === "testing" ? "Testing..." : "Test connection"}
        </Button>

        <Button type="submit" variant="primary" disabled={!canSave || saving}>
          {saving ? "Saving..." : "Save source"}
        </Button>

        {testState.status === "success" && (
          <Badge tone="success" dot>
            Connected
          </Badge>
        )}
      </div>

      {testState.status === "error" && <Notice tone="danger">{testState.message}</Notice>}
      {saveError && <Notice tone="danger">{saveError}</Notice>}
    </form>
  );
}
