import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AgentSection } from "../components/AgentSection";
import { SETUP_SKIPPED_KEY } from "../components/FirstRunGate";
import { Badge, Button, Card, Field, Input, Notice, Select } from "../components/ui";
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
    <Button variant="ghost" onClick={skip}>
      I'll set it up myself
    </Button>
  );

  if (loading) {
    return <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading...</p>;
  }

  if (error || !config) {
    return (
      <div className="mx-auto w-full max-w-xl">
        <Notice tone="danger" actions={skipButton}>
          Failed to load settings: {error ?? "unknown error"}
        </Notice>
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
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4 py-4">
      <h1 className="sr-only">Set up Abracadabra</h1>
      <StepProgress step={step} />
      <Card title={stepTitles[step]}>
        {step === 1 && (
          <form onSubmit={handleConnect} className="flex flex-col gap-4">
            <Field label="Provider" htmlFor="setup-provider">
              <Select
                id="setup-provider"
                value={values.provider}
                onChange={(e) => changeProvider(e.target.value as GitProvider)}
              >
                <option value="gitlab">GitLab</option>
                <option value="github">GitHub</option>
              </Select>
            </Field>

            <Field
              label="Base URL"
              htmlFor="setup-base-url"
              hint={name !== "" ? `Saved as “${name}”.` : undefined}
            >
              <Input
                id="setup-base-url"
                aria-describedby={name !== "" ? "setup-base-url-hint" : undefined}
                value={values.baseUrl}
                onChange={(e) => {
                  setUrlEdited(true);
                  setValues((prev) => ({ ...prev, baseUrl: e.target.value }));
                }}
              />
            </Field>

            <Field label="Access token" htmlFor="setup-token" hint={scopeHints[values.provider]}>
              <Input
                id="setup-token"
                type="password"
                mono
                aria-describedby="setup-token-hint"
                value={values.token}
                onChange={(e) => setValues((prev) => ({ ...prev, token: e.target.value }))}
                placeholder={values.provider === "github" ? "ghp_... or github_pat_..." : "glpat-..."}
              />
            </Field>

            <div className="flex items-center gap-3">
              <Button disabled={!canTest} onClick={handleTest}>
                {current.status === "testing" ? "Testing..." : "Test connection"}
              </Button>
              {current.status === "success" && (
                <Badge tone="success" dot>
                  Connected
                </Badge>
              )}
            </div>
            {current.status === "error" && <Notice tone="danger">{current.message}</Notice>}

            {saveError && <Notice tone="danger">{saveError}</Notice>}

            <Footer skip={skipButton}>
              {canKeepSources && <Button onClick={() => setStep(2)}>Keep my existing sources</Button>}
              <Button type="submit" variant="primary" disabled={!canContinue}>
                {saving ? "Saving..." : "Continue"}
              </Button>
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
            <dl className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 text-sm dark:divide-zinc-800 dark:border-zinc-800">
              <div className="flex gap-4 px-3 py-2">
                <dt className="w-24 shrink-0 text-zinc-500 dark:text-zinc-400">Git source</dt>
                <dd className="min-w-0 break-words text-zinc-900 dark:text-zinc-100">{sourceSummary}</dd>
              </div>
              <div className="flex gap-4 px-3 py-2">
                <dt className="w-24 shrink-0 text-zinc-500 dark:text-zinc-400">Agent</dt>
                <dd className="min-w-0 break-words text-zinc-900 dark:text-zinc-100">{agentSummary}</dd>
              </div>
            </dl>
            <Footer skip={skipButton} onBack={() => setStep(2)}>
              <Button variant="primary" onClick={() => navigate("/tasks")}>
                Go to tasks
              </Button>
            </Footer>
          </div>
        )}
      </Card>
    </div>
  );
}

function StepProgress({ step }: { step: Step }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
        Step {step} of 3
      </p>
      <div
        role="progressbar"
        aria-label="Setup progress"
        aria-valuemin={1}
        aria-valuemax={3}
        aria-valuenow={step}
        aria-valuetext={`Step ${step} of 3: ${stepTitles[step]}`}
        className="flex gap-1.5"
      >
        {([1, 2, 3] as const).map((n) => (
          <div
            key={n}
            className={`h-1.5 flex-1 rounded-full ${
              n <= step ? "bg-accent-600 dark:bg-accent-500" : "bg-zinc-200 dark:bg-zinc-800"
            }`}
          />
        ))}
      </div>
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
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-200 pt-4 dark:border-zinc-800">
      {skip}
      <div className="flex items-center gap-2">
        {onBack && <Button onClick={onBack}>Back</Button>}
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
      {noneDetected && (
        <Notice tone="warning" role="status">
          No supported agent CLI was found on your PATH.
        </Notice>
      )}
      <Link
        to="/settings"
        onClick={() => localStorage.setItem(ADVANCED_OPEN_KEY, "1")}
        className="w-fit rounded text-sm text-accent-700 underline underline-offset-2 hover:text-accent-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 dark:text-accent-400 dark:hover:text-accent-300"
      >
        Use custom commands in Settings
      </Link>

      <Footer skip={skip} onBack={onBack}>
        <Button variant="primary" onClick={onContinue}>
          Continue
        </Button>
      </Footer>
    </div>
  );
}
