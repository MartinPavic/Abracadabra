import { useState } from "react";
import { type AgentTestResult, testAgentCommand } from "../lib/api";

/** Tries an agent command once with a trivial prompt and shows what it printed. */
export function TestCommandButton({
  command,
  systemPrompt,
}: {
  command: string;
  systemPrompt?: string;
}) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<AgentTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleTest() {
    setRunning(true);
    setResult(null);
    setError(null);
    try {
      setResult(await testAgentCommand(command, systemPrompt));
    } catch (err) {
      setError(String(err));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="mt-1 flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={running || command.trim() === ""}
          onClick={handleTest}
          title="Runs this command once with the prompt “Reply with the single word OK”"
          className="rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
        >
          {running ? "Testing (up to 2 min)..." : "Test command"}
        </button>
        {result && (
          <span
            className={`text-xs font-medium ${
              result.ok ? "text-green-700 dark:text-green-400" : "text-red-600 dark:text-red-400"
            }`}
          >
            {result.ok ? "Works" : result.timedOut ? "Timed out" : "Failed"}
          </span>
        )}
      </div>
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      {result?.error && <p className="text-xs text-red-600 dark:text-red-400">{result.error}</p>}
      {result && result.output.trim() !== "" && (
        <pre className="max-h-40 overflow-auto rounded-md bg-zinc-100 p-2 font-mono text-xs whitespace-pre-wrap text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
          {result.output}
        </pre>
      )}
    </div>
  );
}
