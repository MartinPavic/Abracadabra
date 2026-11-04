import { useEffect, useState } from "react";
import {
  type AgentTestResult,
  type AppConfig,
  describeError,
  detectAgentClis,
  testAgentCommand,
} from "../lib/api";
import { agentPresets, applyPreset, inferPreset, type PresetId } from "../lib/agentPresets";

const OUTPUT_TAIL_CHARS = 1000;

const cardClass = (selected: boolean) =>
  `flex flex-col gap-0.5 rounded-md border px-3 py-2 text-left text-sm ${
    selected
      ? "border-zinc-900 bg-zinc-100 dark:border-zinc-100 dark:bg-zinc-900"
      : "border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
  }`;
const smallButtonClass =
  "rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900";

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
  const isCustom = agent.preset === "" && agent.workerCmd.trim() !== "";
  const allCommandsSet = [agent.workerCmd, agent.reviewerCmd, agent.planCmd, agent.descriptionCmd]
    .every((cmd) => (cmd ?? "").trim() !== "");
  const handEdited = allCommandsSet && inferPreset(agent) === "";

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
    if (id === agent.preset) return;
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
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Agent</h2>
      <div className="grid gap-2 sm:grid-cols-2">
        {agentPresets.map((preset) => (
          <button
            key={preset.id}
            type="button"
            aria-pressed={agent.preset === preset.id}
            className={cardClass(agent.preset === preset.id)}
            onClick={() => choose(preset.id)}
          >
            <span className="font-medium text-zinc-900 dark:text-zinc-100">{preset.label}</span>
            {detected && (
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                {detected.has(preset.id) ? "Detected" : "Not found on PATH"}
              </span>
            )}
          </button>
        ))}
        {isCustom && (
          <div className={cardClass(true)}>
            <span className="font-medium text-zinc-900 dark:text-zinc-100">Custom</span>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              Edit the commands under Advanced
            </span>
          </div>
        )}
      </div>
      {pending && (
        <div className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
          <span>Replace your edited commands?</span>
          <button type="button" className={smallButtonClass} onClick={() => void apply(pending)}>
            Replace
          </button>
          <button type="button" className={smallButtonClass} onClick={() => setPending(null)}>
            Cancel
          </button>
        </div>
      )}
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <button
            type="button"
            className={smallButtonClass}
            disabled={testing || agent.workerCmd.trim() === ""}
            onClick={handleTest}
            title="Runs the worker command once with the prompt “Reply with the single word OK”"
          >
            {testing ? "Testing (up to 2 min)..." : "Test agent"}
          </button>
          {testResult && (
            <span
              className={`text-xs font-medium ${
                testResult.ok ? "text-green-700 dark:text-green-400" : "text-red-600 dark:text-red-400"
              }`}
            >
              {testResult.ok ? "OK" : testResult.timedOut ? "Timed out" : "Failed"}
            </span>
          )}
        </div>
        {testError && <p className="text-xs text-red-600 dark:text-red-400">{testError}</p>}
        {testResult?.error && (
          <p className="text-xs text-red-600 dark:text-red-400">{testResult.error}</p>
        )}
        {output !== "" && (
          <pre className="max-h-40 overflow-auto rounded-md bg-zinc-100 p-2 font-mono text-xs whitespace-pre-wrap text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
            {output.slice(-OUTPUT_TAIL_CHARS)}
          </pre>
        )}
      </div>
    </section>
  );
}
