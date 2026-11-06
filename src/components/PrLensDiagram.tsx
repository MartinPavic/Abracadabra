import { useEffect, useState } from "react";
import { render } from "@coldtea/pr-lens-renderer";
import { parseGraphDoc } from "@coldtea/pr-lens-schema";
import { describeError, generateRunDiagram, type RunRecord } from "../lib/api";
import { Button, Card, Notice } from "./ui";

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
    <Card padded={false}>
      <div
        className={`flex flex-wrap items-center gap-3 px-4 py-3 ${
          error || svg ? "border-b border-zinc-200 dark:border-zinc-800" : ""
        }`}
      >
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">PR Lens</h2>
        {graph && (
          <div className="ml-auto inline-flex rounded-lg border border-zinc-200 p-0.5 dark:border-zinc-700">
            {(["architecture", "data-flow"] as const)
              .filter((item) => graph.lenses.includes(item))
              .map((item) => (
                <button
                  key={item}
                  type="button"
                  aria-pressed={lens === item}
                  onClick={() => setLens(item)}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 ${
                    lens === item
                      ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
                      : "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                  }`}
                >
                  {item === "architecture" ? "Architecture" : "Data flow"}
                </button>
              ))}
          </div>
        )}
        <Button
          size="sm"
          icon="sparkles"
          loading={busy}
          onClick={generate}
          className={graph ? undefined : "ml-auto"}
        >
          {busy ? "Generating..." : graph ? "Regenerate" : "Generate diagram"}
        </Button>
      </div>
      {error && (
        <div className="p-4">
          <Notice tone="danger">{error}</Notice>
        </div>
      )}
      {svg && (
        <div className="overflow-auto p-4">
          <img
            src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
            alt={`PR Lens ${lens} diagram`}
            className="mx-auto h-auto max-w-full"
          />
        </div>
      )}
    </Card>
  );
}