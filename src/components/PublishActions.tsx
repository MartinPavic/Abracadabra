import { useEffect, useState } from "react";
import {
  createMergeRequest,
  describeError,
  openUrl,
  previewMergeRequest,
  pushRun,
  type RunRecord,
} from "../lib/api";
import { Button, Card, Field, Input, Notice, Spinner, Textarea } from "./ui";

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
      <Notice tone="success">
        Merge request created:{" "}
        <button
          type="button"
          onClick={() => run.mergeRequestUrl && openUrl(run.mergeRequestUrl)}
          title={run.mergeRequestUrl}
          className="inline-block max-w-full truncate rounded-sm align-bottom text-green-800 underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 dark:text-green-300"
        >
          {run.mergeRequestUrl}
        </button>
      </Notice>
    );
  }

  return (
    <Card title="Merge / pull request">
      <div className="flex flex-col gap-3">
        {!loaded && (
          <p className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
            <Spinner decorative />
            Preparing the description (a configured description command may take a minute)...
          </p>
        )}
        {note && <Notice tone="warning">{note}</Notice>}
        <Field label="Title" htmlFor="mr-title">
          <Input
            id="mr-title"
            value={title}
            disabled={!loaded}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <Field label="Description (markdown)" htmlFor="mr-description">
          <Textarea
            id="mr-description"
            rows={10}
            mono
            className="resize-y"
            value={description}
            disabled={!loaded}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <div className="flex min-w-0 items-center gap-3">
          <Button
            variant="primary"
            icon="merge"
            loading={busy}
            disabled={!loaded}
            onClick={handlePublish}
          >
            {busy ? "Working..." : run.pushed ? "Create MR / PR" : "Push & create MR / PR"}
          </Button>
          {run.pushed && (
            <span
              title={run.branch ?? undefined}
              className="min-w-0 truncate text-xs text-zinc-500 dark:text-zinc-400"
            >
              Branch {run.branch} is pushed.
            </span>
          )}
          <Button
            icon="refresh"
            disabled={busy || !loaded}
            onClick={handleRegenerate}
            title="Write the summary and checklist again (replaces your edits)"
            className="ml-auto shrink-0"
          >
            Regenerate
          </Button>
        </div>
        {error && (
          <Notice tone="danger">
            <span className="whitespace-pre-wrap break-words">{error}</span>
          </Notice>
        )}
      </div>
    </Card>
  );
}
