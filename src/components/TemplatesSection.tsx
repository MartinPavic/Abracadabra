import { useState } from "react";
import type { AppConfig } from "../lib/api";
import { Button, Card, checkboxClass, Field, Input, Notice, Textarea } from "./ui";

/** Global branch, commit and merge-request description templates. */
export function TemplatesSection({
  config,
  onChange,
}: {
  config: AppConfig;
  onChange: (next: AppConfig) => Promise<void>;
}) {
  const [branch, setBranch] = useState(config.branchTemplate);
  const [commit, setCommit] = useState(config.commitTemplate);
  const [mergeRequest, setMergeRequest] = useState(config.mergeRequestTemplate ?? "");
  const [commentMrLink, setCommentMrLink] = useState(config.commentMrLink ?? false);
  const [commentPlan, setCommentPlan] = useState(config.commentPlan ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    branch !== config.branchTemplate ||
    commit !== config.commitTemplate ||
    commentMrLink !== (config.commentMrLink ?? false) ||
    commentPlan !== (config.commentPlan ?? false) ||
    mergeRequest !== (config.mergeRequestTemplate ?? "");

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await onChange({
        ...config,
        branchTemplate: branch,
        commitTemplate: commit,
        mergeRequestTemplate: mergeRequest,
        commentMrLink,
        commentPlan,
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card
      title="Templates"
      description={
        <>
          Branch: <code>{"{type}"}</code>, <code>{"{issue_iid}"}</code>, <code>{"{slug}"}</code>.
          {" "}
          <code>{"{type}"}</code> is feat, fix, chore, refactor, docs, test, perf, ci, build or style,
          taken from a <code>fix:</code>-style title prefix or the issue&apos;s labels (default feat).
          Commit: <code>{"{type}"}</code>, <code>{"{title}"}</code>, <code>{"{issue_ref}"}</code>,{" "}
          <code>{"{worker_summary}"}</code>. A <code>fix:</code>-style prefix is removed from{" "}
          <code>{"{title}"}</code>. Merge request: <code>{"{summary}"}</code> (written by the
          description command, else a few lines of the worker&apos;s summary),{" "}
          <code>{"{checklist}"}</code> (up to 6 check boxes for the reviewer),{" "}
          <code>{"{issue_link}"}</code> (link to the ticket), <code>{"{worker_summary}"}</code> (all
          of the worker&apos;s text), <code>{"{files_changed}"}</code>,{" "}
          <code>{"{review_notes}"}</code>, <code>{"{issue_ref}"}</code>.
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Branch name" htmlFor="branch-template">
          <Input
            id="branch-template"
            mono
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
          />
        </Field>
        <Field label="Commit message" htmlFor="commit-template">
          <Textarea
            id="commit-template"
            mono
            rows={3}
            value={commit}
            onChange={(e) => setCommit(e.target.value)}
          />
        </Field>
        <Field label="Merge / pull request description" htmlFor="mr-template">
          <Textarea
            id="mr-template"
            mono
            rows={7}
            value={mergeRequest}
            onChange={(e) => setMergeRequest(e.target.value)}
          />
        </Field>
        <div className="flex flex-col gap-2 text-sm text-zinc-700 dark:text-zinc-300">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              className={checkboxClass}
              checked={commentMrLink}
              onChange={(e) => setCommentMrLink(e.target.checked)}
            />
            Comment on the issue with the merge request link when it is created
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              className={checkboxClass}
              checked={commentPlan}
              onChange={(e) => setCommentPlan(e.target.checked)}
            />
            Comment on the issue with the plan after a plan run
          </label>
        </div>
        <div>
          <Button variant="primary" disabled={!dirty || saving} onClick={handleSave}>
            {saving ? "Saving..." : "Save templates"}
          </Button>
        </div>
        {error && <Notice tone="danger">{error}</Notice>}
      </div>
    </Card>
  );
}
