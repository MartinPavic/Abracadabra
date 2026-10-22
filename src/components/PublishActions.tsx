import { useEffect, useState } from "react";
import {
  createMergeRequest,
  describeError,
  openUrl,
  previewMergeRequest,
  pushRun,
  type RunRecord,
} from "../lib/api";

const fieldClass =
  "w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100";

/** Edit the merge request's title and description, then push the branch and open it. */
export function PublishActions({ run, onChanged }: { run: RunRecord; onChanged: () => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const alreadyCreated = Boolean(run.mergeRequestUrl);

  useEffect(() => {
    if (alreadyCreated) return;
    let stale = false;
    setLoaded(false);
    previewMergeRequest(run.id)
      .then((draft) => {
        if (stale) return;
        setTitle(draft.title);
        setDescription(draft.description);
        setNote(draft.note);
        setLoaded(true);
      })
      .catch((err) => {
        if (stale) return;
        setError(describeError(err));
        setLoaded(true);
      });
    return () => {
      stale = true;
    };
  }, [run.id, run.commitSha, alreadyCreated]);

  async function handleRegenerate() {
    setLoaded(false);
    setError(null);
    try {
      const draft = await previewMergeRequest(run.id, true);
      setTitle(draft.title);
      setDescription(draft.description);
      setNote(draft.note);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoaded(true);
    }
  }

  async function handlePublish() {
    setBusy(true);
    setError(null);
    try {
      if (!run.pushed) await pushRun(run.id);
      await createMergeRequest(run.id, { title, description });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
      onChanged();
    }
  }

  if (run.mergeRequestUrl) {
    return (
      <section className="rounded-lg border border-green-300 bg-green-50 px-4 py-3 text-sm dark:border-green-900 dark:bg-green-950/30">
        Merge request created:{" "}
        <button
          type="button"
          onClick={() => run.mergeRequestUrl && openUrl(run.mergeRequestUrl)}
          className="text-green-800 underline dark:text-green-300"
        >
          {run.mergeRequestUrl}
        </button>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <h2 className="text-xs font-medium uppercase text-zinc-500 dark:text-zinc-400">
        Merge / pull request
      </h2>
      {!loaded && (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Preparing the description (a configured description command may take a minute)...
        </p>
      )}
      {note && (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          {note}
        </p>
      )}
      <div>
        <label
          htmlFor="mr-title"
          className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400"
        >
          Title
        </label>
        <input
          id="mr-title"
          className={fieldClass}
          value={title}
          disabled={!loaded}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      <div>
        <label
          htmlFor="mr-description"
          className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400"
        >
          Description (markdown)
        </label>
        <textarea
          id="mr-description"
          rows={10}
          className={`${fieldClass} resize-y font-mono text-xs`}
          value={description}
          disabled={!loaded}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={busy || !loaded}
          onClick={handlePublish}
          className="rounded-md border border-zinc-900 bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          {busy ? "Working..." : run.pushed ? "Create MR / PR" : "Push & create MR / PR"}
        </button>
        {run.pushed && (
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            Branch {run.branch} is pushed.
          </span>
        )}
        <button
          type="button"
          disabled={busy || !loaded}
          onClick={handleRegenerate}
          title="Write the summary and checklist again (replaces your edits)"
          className="ml-auto rounded-md border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
        >
          Regenerate
        </button>
      </div>
      {error && (
        <p className="whitespace-pre-wrap text-sm text-red-600 dark:text-red-400">{error}</p>
      )}
    </section>
  );
}
