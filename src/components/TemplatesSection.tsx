import { useState } from "react";
import type { AppConfig } from "../lib/api";

const inputClass =
  "w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 font-mono text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100";
const labelClass = "mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400";

/** Global branch, commit and merge-request description templates. */
export function TemplatesSection({
  config,
  onChange,
}: {
  config: AppConfig;
  onChange: (next: AppConfig) => Promise<void>;
}) {
  const [baseBranch, setBaseBranch] = useState(config.baseBranch ?? "");
  const [branch, setBranch] = useState(config.branchTemplate);
  const [commit, setCommit] = useState(config.commitTemplate);
  const [mergeRequest, setMergeRequest] = useState(config.mergeRequestTemplate ?? "");
  const [commentMrLink, setCommentMrLink] = useState(config.commentMrLink ?? false);
  const [commentPlan, setCommentPlan] = useState(config.commentPlan ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    baseBranch !== (config.baseBranch ?? "") ||
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
        baseBranch: baseBranch.trim(),
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
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Templates</h2>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
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
        </p>
      </div>
      <div>
        <label className={labelClass} htmlFor="base-branch">
          Base branch
        </label>
        <input
          id="base-branch"
          className={inputClass}
          placeholder="dev"
          value={baseBranch}
          onChange={(e) => setBaseBranch(e.target.value)}
        />
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          Runs branch off <code>origin/&lt;this&gt;</code> and merge requests target it. A project
          that doesn&apos;t have it uses its own default branch. Can be overridden per source or
          project. Blank always uses each project&apos;s default branch.
        </p>
      </div>
      <div>
        <label className={labelClass} htmlFor="branch-template">
          Branch name
        </label>
        <input
          id="branch-template"
          className={inputClass}
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
        />
      </div>
      <div>
        <label className={labelClass} htmlFor="commit-template">
          Commit message
        </label>
        <textarea
          id="commit-template"
          rows={3}
          className={inputClass}
          value={commit}
          onChange={(e) => setCommit(e.target.value)}
        />
      </div>
      <div>
        <label className={labelClass} htmlFor="mr-template">
          Merge / pull request description
        </label>
        <textarea
          id="mr-template"
          rows={7}
          className={inputClass}
          value={mergeRequest}
          onChange={(e) => setMergeRequest(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1 text-sm text-zinc-700 dark:text-zinc-300">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={commentMrLink}
            onChange={(e) => setCommentMrLink(e.target.checked)}
          />
          Comment on the issue with the merge request link when it is created
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={commentPlan}
            onChange={(e) => setCommentPlan(e.target.checked)}
          />
          Comment on the issue with the plan after a plan run
        </label>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={!dirty || saving}
          onClick={handleSave}
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
        >
          {saving ? "Saving..." : "Save templates"}
        </button>
        {error && <span className="text-sm text-red-600 dark:text-red-400">{error}</span>}
      </div>
    </section>
  );
}
