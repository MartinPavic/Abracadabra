import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AgentSection } from "../components/AgentSection";
import { SETUP_SKIPPED_KEY } from "../components/FirstRunGate";
import {
  type AppConfig,
  describeError,
  detectAgentClis,
  type GitProvider,
  type GitSourceConfig,
  testConnection,
} from "../lib/api";
import { agentPresets, inferPreset } from "../lib/agentPresets";
import { addGitSource } from "../lib/gitSources";
import { useConfig } from "../lib/useConfig";
import { ADVANCED_OPEN_KEY } from "./Settings";

type Step = 1 | 2 | 3;

const stepTitles: Record<Step, string> = {
  1: "Connect a git source",
  2: "Choose your coding agent",
  3: "All set",
};

const defaultUrls: Record<GitProvider, string> = {
  gitlab: "https://gitlab.com",
  github: "https://github.com",
};

const scopeHints: Record<GitProvider, string> = {
  gitlab:
    "Scopes: read_api to list issues, api to comment and open merge requests, write_repository to push.",
  github: "Needs repo access (read and write) to the repositories you work on.",
};

interface ConnectValues {
  provider: GitProvider;
  baseUrl: string;
  token: string;
}

type TestState =
  | { status: "idle" }
  | { status: "testing" | "success"; key: string }
  | { status: "error"; key: string; message: string };

const inputClass =
  "w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100";
const labelClass = "mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400";
const secondaryButtonClass =
  "rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900";
const primaryButtonClass =
  "rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300";

function hostOf(url: string): string | undefined {
  try {
    return new URL(url.trim()).host;
  } catch {
    return undefined;
  }
}

/** Identifies the values a connection test or a save was done for. */
function connectionKey(values: ConnectValues): string {
  return JSON.stringify([values.provider, values.baseUrl.trim(), values.token]);
}

/** First-run wizard: connect a git source, pick an agent, then go to the task list. */
export function Setup() {
  const navigate = useNavigate();
  const { config, loading, error, update } = useConfig();
  const [step, setStep] = useState<Step>(1);
  const [values, setValues] = useState<ConnectValues>({
    provider: "gitlab",
    baseUrl: defaultUrls.gitlab,
    token: "",
  });
  const [urlEdited, setUrlEdited] = useState(false);
  const [testState, setTestState] = useState<TestState>({ status: "idle" });
  const [saved, setSaved] = useState<{ key: string; source: GitSourceConfig } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  function skip() {
    localStorage.setItem(SETUP_SKIPPED_KEY, "1");
    navigate("/settings");
  }

  const skipButton = (
    <button type="button" className={secondaryButtonClass} onClick={skip}>
      I'll set it up myself
    </button>
  );

  if (loading) {
    return <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading...</p>;
  }

  if (error || !config) {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-sm text-red-600 dark:text-red-400">
          Failed to load settings: {error ?? "unknown error"}
        </p>
        {skipButton}
      </div>
    );
  }

  const key = connectionKey(values);
  // A result for values the user has since changed no longer counts.
  const current: TestState =
    testState.status !== "idle" && testState.key === key ? testState : { status: "idle" };
  const host = hostOf(values.baseUrl);
  const name = host ?? values.baseUrl.trim();
  const alreadySaved = saved?.key === key;
  const canTest =
    values.baseUrl.trim() !== "" && values.token.trim() !== "" && current.status !== "testing";
  const canContinue = (current.status === "success" || alreadySaved) && !saving;

  function changeProvider(provider: GitProvider) {
    setValues((prev) => ({
      ...prev,
      provider,
      baseUrl: urlEdited ? prev.baseUrl : defaultUrls[provider],
    }));
  }

  async function handleTest() {
    const testedKey = key;
    setTestState({ status: "testing", key: testedKey });
    let next: TestState;
    try {
      await testConnection({
        provider: values.provider,
        baseUrl: values.baseUrl.trim(),
        token: values.token,
      });
      next = { status: "success", key: testedKey };
    } catch (err) {
      next = { status: "error", key: testedKey, message: describeError(err, host) };
    }
    // A newer test for other values wins.
    setTestState((prev) => (prev.status === "testing" && prev.key === testedKey ? next : prev));
  }

  async function handleConnect(event: FormEvent) {
    event.preventDefault();
    if (!canContinue || !config) return;
    if (alreadySaved) {
      setStep(2);
      return;
    }
    const savedKey = key;
    setSaving(true);
    setSaveError(null);
    try {
      const source = await addGitSource(config, update, { ...values, name }, saved?.source.id);
      setSaved({ key: savedKey, source });
      setStep(2);
    } catch (err) {
      setSaveError(describeError(err));
    } finally {
      setSaving(false);
    }
  }

  const preset = agentPresets.find(
    (item) => item.id === (config.agent.preset || inferPreset(config.agent)),
  );
  const agentSummary =
    preset?.label ?? (config.agent.workerCmd.trim() !== "" ? "Custom commands" : "Not set up");
  // Offered only when the sources predate this wizard session.
  const canKeepSources = config.gitSources.length > 0 && !saved;
  const sourceSummary = saved
    ? `${saved.source.name} (${saved.source.baseUrl})`
    : config.gitSources.map((source) => source.name).join(", ") || "None";

  return (
    <div className="flex max-w-xl flex-col gap-6">
      <div>
        <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
          Step {step} of 3 &middot; {stepTitles[step]}
        </p>
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
          {stepTitles[step]}
        </h1>
      </div>

      {step === 1 && (
        <form onSubmit={handleConnect} className="flex flex-col gap-4">
          <div>
            <label className={labelClass} htmlFor="setup-provider">
              Provider
            </label>
            <select
              id="setup-provider"
              className={inputClass}
              value={values.provider}
              onChange={(e) => changeProvider(e.target.value as GitProvider)}
            >
              <option value="gitlab">GitLab</option>
              <option value="github">GitHub</option>
            </select>
          </div>

          <div>
            <label className={labelClass} htmlFor="setup-base-url">
              Base URL
            </label>
            <input
              id="setup-base-url"
              className={inputClass}
              value={values.baseUrl}
              onChange={(e) => {
                setUrlEdited(true);
                setValues((prev) => ({ ...prev, baseUrl: e.target.value }));
              }}
            />
            {name !== "" && (
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">Saved as “{name}”.</p>
            )}
          </div>

          <div>
            <label className={labelClass} htmlFor="setup-token">
              Access token
            </label>
            <input
              id="setup-token"
              type="password"
              className={inputClass}
              value={values.token}
              onChange={(e) => setValues((prev) => ({ ...prev, token: e.target.value }))}
              placeholder={values.provider === "github" ? "ghp_... or github_pat_..." : "glpat-..."}
            />
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              {scopeHints[values.provider]}
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              className={secondaryButtonClass}
              disabled={!canTest}
              onClick={handleTest}
            >
              {current.status === "testing" ? "Testing..." : "Test connection"}
            </button>
            {current.status === "success" && (
              <span className="text-sm text-green-600 dark:text-green-400">Connected</span>
            )}
            {current.status === "error" && (
              <span className="text-sm text-red-600 dark:text-red-400">{current.message}</span>
            )}
          </div>

          {saveError && <p className="text-sm text-red-600 dark:text-red-400">{saveError}</p>}

          <Footer skip={skipButton}>
            {canKeepSources && (
              <button type="button" className={secondaryButtonClass} onClick={() => setStep(2)}>
                Keep my existing sources
              </button>
            )}
            <button type="submit" className={primaryButtonClass} disabled={!canContinue}>
              {saving ? "Saving..." : "Continue"}
            </button>
          </Footer>
        </form>
      )}

      {step === 2 && (
        <AgentStep
          config={config}
          onChange={update}
          skip={skipButton}
          onBack={() => setStep(1)}
          onContinue={() => setStep(3)}
        />
      )}

      {step === 3 && (
        <div className="flex flex-col gap-4">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-zinc-500 dark:text-zinc-400">Git source</dt>
            <dd className="text-zinc-900 dark:text-zinc-100">{sourceSummary}</dd>
            <dt className="text-zinc-500 dark:text-zinc-400">Agent</dt>
            <dd className="text-zinc-900 dark:text-zinc-100">{agentSummary}</dd>
          </dl>
          <Footer skip={skipButton} onBack={() => setStep(2)}>
            <button type="button" className={primaryButtonClass} onClick={() => navigate("/tasks")}>
              Go to tasks
            </button>
          </Footer>
        </div>
      )}
    </div>
  );
}

function Footer({
  skip,
  onBack,
  children,
}: {
  skip: ReactNode;
  onBack?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-zinc-200 pt-4 dark:border-zinc-800">
      {skip}
      <div className="flex items-center gap-3">
        {onBack && (
          <button type="button" className={secondaryButtonClass} onClick={onBack}>
            Back
          </button>
        )}
        {children}
      </div>
    </div>
  );
}

function AgentStep({
  config,
  onChange,
  skip,
  onBack,
  onContinue,
}: {
  config: AppConfig;
  onChange: (next: AppConfig) => Promise<void>;
  skip: ReactNode;
  onBack: () => void;
  onContinue: () => void;
}) {
  const [noneDetected, setNoneDetected] = useState(false);

  useEffect(() => {
    let active = true;
    detectAgentClis()
      .then((found) => active && setNoneDetected(found.length === 0))
      .catch(() => active && setNoneDetected(true));
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <AgentSection config={config} onChange={onChange} />
      <div className="flex flex-col gap-1 text-sm text-zinc-700 dark:text-zinc-300">
        {noneDetected && <p>No supported agent CLI was found on your PATH.</p>}
        <Link
          to="/settings"
          onClick={() => localStorage.setItem(ADVANCED_OPEN_KEY, "1")}
          className="text-zinc-600 underline hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
        >
          Use custom commands in Settings
        </Link>
      </div>

      <Footer skip={skip} onBack={onBack}>
        <button type="button" className={primaryButtonClass} onClick={onContinue}>
          Continue
        </button>
      </Footer>
    </div>
  );
}
