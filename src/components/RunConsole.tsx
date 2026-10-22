import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getRunOutput } from "../lib/api";

interface RunStatusEvent {
  runId: string;
  status: string;
  atMs: number;
  error?: string | null;
}

interface AgentOutputEvent {
  runId: string;
  stream: "stdout" | "stderr";
  line: string;
}

interface ConsoleLine {
  id: number;
  text: string;
  isError: boolean;
}

const MAX_LINES = 2000;

/** Live log of a run's status changes and its worker, test and reviewer output. */
export function RunConsole({ runId }: { runId?: string }) {
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const nextId = useRef(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  // Lines are collected here and rendered in batches, so chatty output doesn't re-render per line.
  const pending = useRef<ConsoleLine[]>([]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (pending.current.length === 0) return;
      const batch = pending.current;
      pending.current = [];
      setLines((prev) => [...prev, ...batch].slice(-MAX_LINES));
    }, 100);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let disposed = false;
    let ready = !runId; // with a run id, wait for the buffered backlog first
    pending.current = [];
    setLines([]);

    function toLine(text: string, isError: boolean): ConsoleLine {
      return { id: nextId.current++, text, isError };
    }
    function append(text: string, isError = false) {
      if (ready) pending.current.push(toLine(text, isError));
    }

    const unlisten = Promise.all([
      listen<RunStatusEvent>("run://status", ({ payload }) => {
        if (runId && payload.runId !== runId) return;
        append(
          `[${payload.runId}] status -> ${payload.status}${payload.error ? `: ${payload.error}` : ""}`,
          payload.status === "failed",
        );
      }),
      listen<AgentOutputEvent>("agent://worker-output", ({ payload }) => {
        if (runId && payload.runId !== runId) return;
        append(`[worker] ${payload.line}`, payload.stream === "stderr");
      }),
      listen<AgentOutputEvent>("agent://test-output", ({ payload }) => {
        if (runId && payload.runId !== runId) return;
        append(`[tests] ${payload.line}`, payload.stream === "stderr");
      }),
      listen<AgentOutputEvent>("agent://reviewer-output", ({ payload }) => {
        if (runId && payload.runId !== runId) return;
        append(`[reviewer] ${payload.line}`, payload.stream === "stderr");
      }),
    ]);

    // Output emitted before this view opened comes from the backend's buffer.
    if (runId) {
      unlisten
        .then(() => getRunOutput(runId))
        .then((backlog) => {
          if (disposed) return;
          pending.current = [];
          setLines(backlog.map((b) => toLine(`[${b.role}] ${b.line}`, b.stream === "stderr")));
        })
        .catch(() => undefined)
        .finally(() => {
          ready = true;
        });
    }

    return () => {
      disposed = true;
      unlisten.then((fns) => fns.forEach((fn) => fn())).catch(() => undefined);
    };
  }, [runId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [lines]);

  if (lines.length === 0) return null;

  return (
    <div className="flex max-h-56 flex-col rounded-lg border border-zinc-200 dark:border-zinc-800">
      <div className="flex items-center justify-between border-b border-zinc-200 px-3 py-1.5 text-xs font-medium uppercase text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
        <span>Run console</span>
        <button type="button" onClick={() => setLines([])} className="normal-case hover:underline">
          Clear
        </button>
      </div>
      <div className="flex-1 overflow-auto bg-zinc-50 p-3 font-mono text-xs dark:bg-zinc-950">
        {lines.map((line) => (
          <div
            key={line.id}
            className={
              line.isError
                ? "whitespace-pre-wrap text-red-600 dark:text-red-400"
                : "whitespace-pre-wrap text-zinc-700 dark:text-zinc-300"
            }
          >
            {line.text}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
