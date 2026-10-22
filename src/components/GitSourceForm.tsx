import { type FormEvent, useState } from "react";
import {
  describeError,
  type GitProvider,
  testConnection,
} from "../lib/api";

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

const inputClass =
  "w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100";
const labelClass = "mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400";

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
      className="flex flex-col gap-4 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
    >
      <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
        Add git source
      </h2>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelClass} htmlFor="source-name">
            Name
          </label>
          <input
            id="source-name"
            className={inputClass}
            value={values.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="My GitLab"
          />
        </div>

        <div>
          <label className={labelClass} htmlFor="source-provider">
            Provider
          </label>
          <select
            id="source-provider"
            className={inputClass}
            value={values.provider}
            onChange={(e) => set("provider", e.target.value as GitProvider)}
          >
            <option value="gitlab">GitLab</option>
            <option value="github">GitHub</option>
          </select>
        </div>

        <div className="col-span-2">
          <label className={labelClass} htmlFor="source-base-url">
            Base URL
          </label>
          <input
            id="source-base-url"
            className={inputClass}
            value={values.baseUrl}
            onChange={(e) => set("baseUrl", e.target.value)}
            placeholder={isGitHub ? "https://github.com" : "https://gitlab.com"}
          />
        </div>

        <div className="col-span-2">
          <label className={labelClass} htmlFor="source-token">
            Access token
          </label>
          <input
            id="source-token"
            type="password"
            className={inputClass}
            value={values.token}
            onChange={(e) => set("token", e.target.value)}
            placeholder={isGitHub ? "ghp_... or github_pat_..." : "glpat-..."}
          />
        </div>

        <div className="col-span-2">
          <label className={labelClass} htmlFor="source-project-filter">
            Project / group filter (optional)
          </label>
          <input
            id="source-project-filter"
            className={inputClass}
            value={values.projectFilter}
            onChange={(e) => set("projectFilter", e.target.value)}
            placeholder={isGitHub ? "owner/repo" : "group/project"}
          />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={!canTest || testState.status === "testing"}
          onClick={handleTestConnection}
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
        >
          {testState.status === "testing" ? "Testing..." : "Test connection"}
        </button>

        <button
          type="submit"
          disabled={!canSave || saving}
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          {saving ? "Saving..." : "Save source"}
        </button>

        {testState.status === "success" && (
          <span className="text-sm text-green-600 dark:text-green-400">Connected</span>
        )}
        {testState.status === "error" && (
          <span className="text-sm text-red-600 dark:text-red-400">{testState.message}</span>
        )}
        {saveError && <span className="text-sm text-red-600 dark:text-red-400">{saveError}</span>}
      </div>
    </form>
  );
}
