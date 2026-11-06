import { useEffect, useState } from "react";
import {
  type AgentTestResult,
  type AppConfig,
  describeError,
  detectAgentClis,
  testAgentCommand,
} from "../lib/api";
import { agentPresets, applyPreset, inferPreset, type PresetId } from "../lib/agentPresets";
import { Badge, Button, Card, Icon, Notice } from "./ui";

const OUTPUT_TAIL_CHARS = 1000;

const tileClass = (selected: boolean) =>
  `relative flex min-w-0 flex-col items-start gap-1.5 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-zinc-900 ${
    selected
      ? "border-accent-500 bg-accent-50 dark:border-accent-400 dark:bg-accent-950/40"
      : "border-zinc-200 hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:border-zinc-700 dark:hover:bg-zinc-800/50"
  }`;

function SelectedMark() {
  return (
    <span className="absolute top-2 right-2 flex size-5 items-center justify-center rounded-full bg-accent-600 text-white dark:bg-accent-500 dark:text-zinc-950">
      <Icon name="check" className="size-3.5" />
    </span>
  );
}

/** Picks which coding agent CLI runs use, and checks that its command works. */
export function AgentSection({
  config,
  onChange,
}: {
  config: AppConfig;
  onChange: (next: AppConfig) => Promise<void>;
}) {
  const [detected, setDetected] = useState<Set<string> | null>(null);
  const [pending, setPending] = useState<PresetId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<AgentTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    detectAgentClis()
      .then((found) => active && setDetected(new Set(found.map((agent) => agent.id))))
      .catch(() => active && setDetected(new Set()));
    return () => {
      active = false;
    };
  }, []);

  const agent = config.agent;
  // Configs saved before presets existed have an empty preset; infer it from the commands.
  const preset = agent.preset || inferPreset(agent);
  const isCustom = preset === "" && agent.workerCmd.trim() !== "";
  const anyCommandSet = [agent.workerCmd, agent.reviewerCmd, agent.planCmd, agent.descriptionCmd]
    .some((cmd) => (cmd ?? "").trim() !== "");
  const handEdited = anyCommandSet && inferPreset(agent) === "";

  async function apply(id: PresetId) {
    setPending(null);
    setError(null);
    try {
      await onChange({ ...config, agent: applyPreset(agent, id) });
    } catch (err) {
      setError(describeError(err));
    }
  }

  function choose(id: PresetId) {
    if (id === preset) return;
    if (handEdited) setPending(id);
    else void apply(id);
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    setTestError(null);
    try {
      setTestResult(await testAgentCommand(agent.workerCmd));
    } catch (err) {
      setTestError(describeError(err));
    } finally {
      setTesting(false);
    }
  }

  const output = testResult?.output.trim() ?? "";

  return (
    <Card title="Agent">
      <div className="flex flex-col gap-4">
        <div className="grid gap-2 sm:grid-cols-2">
          {agentPresets.map((item) => {
            const selected = preset === item.id;
            return (
              <button
                key={item.id}
                type="button"
                aria-pressed={selected}
                className={tileClass(selected)}
                onClick={() => choose(item.id)}
              >
                <span className="truncate pr-6 font-medium text-zinc-900 dark:text-zinc-100">
                  {item.label}
                </span>
                {detected && (
                  <Badge tone={detected.has(item.id) ? "success" : "neutral"}>
                    {detected.has(item.id) ? "Detected" : "Not found on PATH"}
                  </Badge>
                )}
                {selected && <SelectedMark />}
              </button>
            );
          })}
          {isCustom && (
            <div className={tileClass(true)}>
              <span className="pr-6 font-medium text-zinc-900 dark:text-zinc-100">Custom</span>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                Edit the commands under Advanced
              </span>
              <SelectedMark />
            </div>
          )}
        </div>
        {pending && (
          <Notice
            tone="warning"
            actions={
              <>
                <Button size="sm" variant="primary" onClick={() => void apply(pending)}>
                  Replace
                </Button>
                <Button size="sm" onClick={() => setPending(null)}>
                  Cancel
                </Button>
              </>
            }
          >
            Replace your edited commands?
          </Notice>
        )}
        {error && <Notice tone="danger">{error}</Notice>}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              disabled={testing || agent.workerCmd.trim() === ""}
              onClick={handleTest}
              title="Runs the worker command once with the prompt “Reply with the single word OK”"
            >
              {testing ? "Testing (up to 2 min)..." : "Test agent"}
            </Button>
            {testResult && (
              <Badge tone={testResult.ok ? "success" : testResult.timedOut ? "warning" : "danger"} dot>
                {testResult.ok ? "OK" : testResult.timedOut ? "Timed out" : "Failed"}
              </Badge>
            )}
          </div>
          {testError && <Notice tone="danger">{testError}</Notice>}
          {testResult?.error && <Notice tone="danger">{testResult.error}</Notice>}
          {output !== "" && (
            <pre className="max-h-40 overflow-auto rounded-lg border border-zinc-200 bg-zinc-50 p-2 font-mono text-xs whitespace-pre-wrap break-all text-zinc-800 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200">
              {output.slice(-OUTPUT_TAIL_CHARS)}
            </pre>
          )}
        </div>
      </div>
    </Card>
  );
}
