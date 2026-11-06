import { useState } from "react";
import { type AgentTestResult, testAgentCommand } from "../lib/api";
import { Badge, Button, Notice } from "./ui";

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
    <div className="mt-1.5 flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={running || command.trim() === ""}
          onClick={handleTest}
          title="Runs this command once with the prompt “Reply with the single word OK”"
        >
          {running ? "Testing (up to 2 min)..." : "Test command"}
        </Button>
        {result && (
          <Badge tone={result.ok ? "success" : result.timedOut ? "warning" : "danger"} dot>
            {result.ok ? "Works" : result.timedOut ? "Timed out" : "Failed"}
          </Badge>
        )}
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
      {result?.error && <Notice tone="danger">{result.error}</Notice>}
      {result && result.output.trim() !== "" && (
        <pre className="max-h-40 overflow-auto rounded-lg border border-zinc-200 bg-zinc-50 p-2 font-mono text-xs whitespace-pre-wrap break-all text-zinc-800 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200">
          {result.output}
        </pre>
      )}
    </div>
  );
}
