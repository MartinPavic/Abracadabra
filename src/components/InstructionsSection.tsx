import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import type { AppConfig, InstructionScope } from "../lib/api";
import { describeError, getInstructions, listRuns, readTextFile, setInstructions } from "../lib/api";
import { Badge, Button, Card, Notice, Select, Textarea } from "./ui";

const MAX_CHARS = 50_000;

interface Project {
  sourceId: string;
  project: string;
}

function InstructionsEditor({ scope, label }: { scope: InstructionScope; label: string }) {
  const [saved, setSaved] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const scopeKey = JSON.stringify(scope);

  useEffect(() => {
    let cancelled = false;
    setSaved(null);
    setLoadError(null);
    setError(null);
    setJustSaved(false);
    getInstructions(scope).then(
      (loaded) => {
        if (cancelled) return;
        setSaved(loaded);
        setText(loaded);
      },
      (err) => {
        if (!cancelled) setLoadError(describeError(err));
      },
    );
    return () => {
      cancelled = true;
    };
    // scopeKey is the scope's identity; the scope object itself changes every render.
  }, [scopeKey]);

  async function save() {
    setError(null);
    setJustSaved(false);
    try {
      await setInstructions(scope, text);
      setSaved(text);
      setJustSaved(true);
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function importFile() {
    setError(null);
    try {
      const path = await open({
        multiple: false,
        filters: [{ name: "Markdown or text", extensions: ["md", "txt"] }],
      });
      if (typeof path !== "string") return;
      setText(await readTextFile(path));
      setJustSaved(false);
    } catch (err) {
      setError(describeError(err));
    }
  }

  if (loadError) return <Notice tone="danger">{loadError}</Notice>;
  if (saved === null) return <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading...</p>;

  const count = Array.from(text).length;

  return (
    <div className="flex flex-col gap-2">
      <Textarea
        aria-label={label}
        mono
        rows={12}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setJustSaved(false);
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="primary" disabled={text === saved} onClick={save}>
          Save
        </Button>
        <Button size="sm" onClick={importFile}>
          Import file...
        </Button>
        <span
          className={`text-xs tabular-nums ${
            count > MAX_CHARS ? "font-medium text-red-600 dark:text-red-400" : "text-zinc-500 dark:text-zinc-400"
          }`}
        >
          {count.toLocaleString("en-US")} / {MAX_CHARS.toLocaleString("en-US")}
        </span>
        {justSaved && (
          <Badge tone="success" dot>
            Saved
          </Badge>
        )}
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
    </div>
  );
}

/** User-written text added to the worker, plan and reviewer prompts, globally or per project. */
export function InstructionsSection({ config }: { config: AppConfig }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState("");

  useEffect(() => {
    let cancelled = false;
    listRuns().then(
      (runs) => {
        if (cancelled) return;
        const seen = new Set<string>();
        const distinct: Project[] = [];
        for (const { sourceId, project } of runs) {
          const key = JSON.stringify([sourceId, project]);
          if (seen.has(key)) continue;
          seen.add(key);
          distinct.push({ sourceId, project });
        }
        setProjects(distinct);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const chosen = selected === "" ? undefined : projects[Number(selected)];

  function label({ sourceId, project }: Project) {
    const source = config.gitSources.find((s) => s.id === sourceId);
    return source ? `${source.name} · ${project}` : project;
  }

  return (
    <Card
      title="Agent instructions"
      description="Added to the prompts of the worker, plan and reviewer agents for every run (global) or for one project."
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">Global</h3>
          <InstructionsEditor scope={{ kind: "global" }} label="Global instructions" />
        </div>

        <div className="flex flex-col gap-2 border-t border-zinc-200 pt-4 dark:border-zinc-800">
          <h3 className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">Per project</h3>
          {projects.length === 0 ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              Projects appear here after your first run.
            </p>
          ) : (
            <Select aria-label="Project" value={selected} onChange={(e) => setSelected(e.target.value)}>
              <option value="">Choose a project...</option>
              {projects.map((p, i) => (
                <option key={i} value={String(i)}>
                  {label(p)}
                </option>
              ))}
            </Select>
          )}
          {chosen && (
            <InstructionsEditor
              key={`${chosen.sourceId}\0${chosen.project}`}
              scope={{ kind: "project", sourceId: chosen.sourceId, projectPath: chosen.project }}
              label="Project instructions"
            />
          )}
        </div>
      </div>
    </Card>
  );
}
