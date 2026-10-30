import { useEffect, useState } from "react";
import { render } from "@coldtea/pr-lens-renderer";
import { parseGraphDoc } from "@coldtea/pr-lens-schema";
import { describeError, generateRunDiagram, type RunRecord } from "../lib/api";

type Lens = "architecture" | "data-flow";

// The agent can't know commit shas or the host, so provenance always comes from the run.
function parseDiagramResponse(response: string, run: RunRecord, baseUrl?: string) {
  if (!run.baseCommit || !run.commitSha) throw new Error("this run has no commits to diagram");
  const json = response
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const parts = run.project.split("/");
  const name = parts.pop() || run.project;
  const host = baseUrl ? new URL(baseUrl).hostname : "";
  return parseGraphDoc({
    ...JSON.parse(json),
    provenance: {
      repo: { owner: parts.join("/") || name, name, ...(host && { host }) },
      base: { sha: run.baseCommit },
      head: { sha: run.commitSha },
    },
  });
}

export function PrLensDiagram({ run, baseUrl }: { run: RunRecord; baseUrl?: string }) {
  const [graph, setGraph] = useState<ReturnType<typeof parseGraphDoc> | null>(null);
  const [lens, setLens] = useState<Lens>("architecture");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [svg, setSvg] = useState<string | null>(null);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const nextGraph = parseDiagramResponse(await generateRunDiagram(run.id), run, baseUrl);
      setGraph(nextGraph);
      setLens(nextGraph.lenses.includes("architecture") ? "architecture" : "data-flow");
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!graph || !graph.lenses.includes(lens)) {
      setSvg(null);
      return;
    }
    try {
      setSvg(render(graph, { lens, theme: "neutral" }).svg);
    } catch (err) {
      setError(describeError(err));
    }
  }, [graph, lens]);

  return (
    <section className="rounded-lg border border-zinc-200 dark:border-zinc-800">
      <div className="flex flex-wrap items-center gap-3 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
        <h2 className="text-xs font-medium uppercase text-zinc-500 dark:text-zinc-400">PR Lens</h2>
        {graph && (
          <div className="ml-auto flex gap-1 text-xs">
            {(["architecture", "data-flow"] as const)
              .filter((item) => graph.lenses.includes(item))
              .map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setLens(item)}
                  className={`rounded-md px-2 py-1 font-medium ${
                    lens === item
                      ? "bg-zinc-200 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
                      : "text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900"
                  }`}
                >
                  {item === "architecture" ? "Architecture" : "Data flow"}
                </button>
              ))}
          </div>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={generate}
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
        >
          {busy ? "Generating..." : graph ? "Regenerate" : "Generate diagram"}
        </button>
      </div>
      {error && <p className="px-4 py-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
      {svg && (
        <div className="overflow-auto p-4">
          <img
            src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
            alt={`PR Lens ${lens} diagram`}
            className="mx-auto h-auto max-w-full"
          />
        </div>
      )}
    </section>
  );
}