import { useEffect, useState } from "react";
import {
  AGENT_CREDENTIAL_ID,
  type AppConfig,
  hasToken,
  removeToken,
  type ReviewerGate,
  setToken,
} from "../lib/api";
import { AutoTextarea } from "./AutoTextarea";
import { TestCommandButton } from "./TestCommandButton";

const inputClass =
  "w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 font-mono text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100";
const labelClass = "mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400";

/** Command templates for the worker and reviewer CLIs that runs shell out to. */
export function AgentCommandsSection({
  config,
  onChange,
}: {
  config: AppConfig;
  onChange: (next: AppConfig) => Promise<void>;
}) {
  const [workerCmd, setWorkerCmd] = useState(config.agent.workerCmd);
  const [reviewerCmd, setReviewerCmd] = useState(config.agent.reviewerCmd);
  const [planCmd, setPlanCmd] = useState(config.agent.planCmd ?? "");
  const [descriptionCmd, setDescriptionCmd] = useState(config.agent.descriptionCmd ?? "");
  const [testCmd, setTestCmd] = useState(config.testCmd ?? "");
  const [credentialEnvVar, setCredentialEnvVar] = useState(config.agent.credentialEnvVar ?? "");
  const [secret, setSecret] = useState("");
  const [maxParallel, setMaxParallel] = useState(String(config.maxParallelRuns ?? 2));
  const [timeoutMinutes, setTimeoutMinutes] = useState(
    String(Math.round((config.agent.timeoutSecs ?? 1800) / 60)),
  );
  const [hasCredential, setHasCredential] = useState(false);
  const [workerPrompt, setWorkerPrompt] = useState(config.agent.workerPromptFile ?? "");
  const [reviewerPrompt, setReviewerPrompt] = useState(config.agent.reviewerPromptFile ?? "");
  const [planPrompt, setPlanPrompt] = useState(config.agent.planPromptFile ?? "");
  const [autoFix, setAutoFix] = useState(String(config.autoFixAttempts ?? 0));
  const [gate, setGate] = useState<ReviewerGate>(config.reviewerGate ?? "auto_redo");
  const [ideCommand, setIdeCommand] = useState(config.ideCommand ?? "");
  const [keepDays, setKeepDays] = useState(String(config.keepRunsDays ?? 0));
  const [usageRegex, setUsageRegex] = useState(config.agent.usageRegex ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    hasToken(AGENT_CREDENTIAL_ID)
      .then(setHasCredential)
      .catch(() => setHasCredential(false));
  }, []);

  const dirty =
    workerCmd !== config.agent.workerCmd ||
    reviewerCmd !== config.agent.reviewerCmd ||
    planCmd !== (config.agent.planCmd ?? "") ||
    descriptionCmd !== (config.agent.descriptionCmd ?? "") ||
    testCmd !== (config.testCmd ?? "") ||
    credentialEnvVar !== (config.agent.credentialEnvVar ?? "") ||
    maxParallel !== String(config.maxParallelRuns ?? 2) ||
    timeoutMinutes !== String(Math.round((config.agent.timeoutSecs ?? 1800) / 60)) ||
    workerPrompt !== (config.agent.workerPromptFile ?? "") ||
    reviewerPrompt !== (config.agent.reviewerPromptFile ?? "") ||
    planPrompt !== (config.agent.planPromptFile ?? "") ||
    autoFix !== String(config.autoFixAttempts ?? 0) ||
    gate !== (config.reviewerGate ?? "auto_redo") ||
    ideCommand !== (config.ideCommand ?? "") ||
    keepDays !== String(config.keepRunsDays ?? 0) ||
    usageRegex !== (config.agent.usageRegex ?? "") ||
    secret !== "";

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      if (secret !== "") {
        await setToken(AGENT_CREDENTIAL_ID, secret);
        setHasCredential(true);
        setSecret("");
      }
      const minutes = Number(timeoutMinutes);
      const timeoutSecs = Number.isFinite(minutes) && minutes >= 0 ? Math.round(minutes * 60) : 1800;
      await onChange({
        ...config,
        testCmd,
        maxParallelRuns: Math.max(1, Math.floor(Number(maxParallel)) || 1),
        autoFixAttempts: Math.min(3, Math.max(0, Math.floor(Number(autoFix)) || 0)),
        reviewerGate: gate,
        ideCommand: ideCommand.trim(),
        keepRunsDays: Math.max(0, Math.floor(Number(keepDays)) || 0),
        agent: {
          workerCmd,
          reviewerCmd,
          planCmd,
          descriptionCmd,
          credentialEnvVar: credentialEnvVar.trim(),
          timeoutSecs,
          workerPromptFile: workerPrompt.trim(),
          reviewerPromptFile: reviewerPrompt.trim(),
          planPromptFile: planPrompt.trim(),
          usageRegex: usageRegex.trim(),
        },
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleRemoveCredential() {
    setError(null);
    try {
      await removeToken(AGENT_CREDENTIAL_ID);
      setHasCredential(false);
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Agent commands</h2>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Use <code>{"{prompt_file}"}</code> for the generated prompt and <code>{"{cwd}"}</code> for
          the project folder the run works in.
        </p>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          Agents and test commands run with this app's full environment (your PATH, SSH agent and
          any tokens set in it) and act on issue text written by whoever can edit the issue. Only
          use issues and agents you trust, and keep secrets out of the environment you launch the
          app from.
        </p>
      </div>
      <div>
        <label className={labelClass} htmlFor="worker-cmd">
          Worker command
        </label>
        <AutoTextarea
          id="worker-cmd"
          className={inputClass}
          placeholder="my-agent --prompt {prompt_file} --cwd {cwd}"
          value={workerCmd}
          onChange={(e) => setWorkerCmd(e.target.value)}
        />
        <TestCommandButton command={workerCmd} systemPrompt={workerPrompt} />
      </div>
      <div>
        <label className={labelClass} htmlFor="reviewer-cmd">
          Reviewer command
        </label>
        <AutoTextarea
          id="reviewer-cmd"
          className={inputClass}
          placeholder="my-agent --prompt {prompt_file} --cwd {cwd}"
          value={reviewerCmd}
          onChange={(e) => setReviewerCmd(e.target.value)}
        />
        <TestCommandButton command={reviewerCmd} systemPrompt={reviewerPrompt} />
      </div>
      <div>
        <label className={labelClass} htmlFor="plan-cmd">
          Plan command (for "Plan" runs)
        </label>
        <AutoTextarea
          id="plan-cmd"
          className={inputClass}
          placeholder="my-agent --plan-mode --prompt {prompt_file} --cwd {cwd}"
          value={planCmd}
          onChange={(e) => setPlanCmd(e.target.value)}
        />
        <TestCommandButton command={planCmd} systemPrompt={planPrompt} />
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          Same as the worker command but in the CLI's read-only plan mode (Claude Code:{" "}
          <code>--permission-mode plan</code>). Plan runs create no commit.
        </p>
      </div>
      <div>
        <label className={labelClass} htmlFor="description-cmd">
          Description command (optional, writes the MR summary and reviewer checklist)
        </label>
        <AutoTextarea
          id="description-cmd"
          className={inputClass}
          placeholder="my-agent --plan-mode --prompt {prompt_file} --cwd {cwd}"
          value={descriptionCmd}
          onChange={(e) => setDescriptionCmd(e.target.value)}
        />
        <TestCommandButton command={descriptionCmd} />
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          Run when you open an approved run&apos;s merge request, with the change and the issue in
          the prompt. It must print a <code>## Summary</code> and a <code>## Checklist</code>{" "}
          section, and should be read-only (same flags as the plan command) because it runs in your
          project folder. Empty uses the worker&apos;s summary and a generic checklist.
        </p>
      </div>
      <div>
        <label className={labelClass} htmlFor="test-cmd">
          Test command (optional)
        </label>
        <AutoTextarea
          id="test-cmd"
          className={inputClass}
          placeholder={'sh -c "pnpm test && pnpm lint"'}
          value={testCmd}
          onChange={(e) => setTestCmd(e.target.value)}
        />
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          Runs in the project folder after the worker; the result is shown on the run and given to the
          reviewer. Failing tests don&apos;t stop the run. Commands aren&apos;t run in a shell, so
          wrap chains in <code>sh -c</code>; they already start in the project folder. Can be
          overridden per source or project.
        </p>
      </div>
      <div>
        <label className={labelClass} htmlFor="max-parallel">
          Max parallel runs
        </label>
        <input
          id="max-parallel"
          type="number"
          min={1}
          className={`${inputClass} w-24`}
          value={maxParallel}
          onChange={(e) => setMaxParallel(e.target.value)}
        />
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          Extra runs wait as &quot;queued&quot; until a slot frees up. A change also applies to runs
          that are already waiting.
        </p>
      </div>
      <div>
        <label className={labelClass} htmlFor="agent-timeout">
          Time limit per agent or test run (minutes)
        </label>
        <input
          id="agent-timeout"
          type="number"
          min={0}
          className={`${inputClass} w-24`}
          value={timeoutMinutes}
          onChange={(e) => setTimeoutMinutes(e.target.value)}
        />
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          A process that runs longer is killed together with its child processes, and the run fails.
          0 means no limit.
        </p>
      </div>
      <div>
        <p className={labelClass}>System prompt files</p>
        <div className="flex flex-col gap-2">
          {(
            [
              ["Worker", workerPrompt, setWorkerPrompt, "worker.md"],
              ["Reviewer", reviewerPrompt, setReviewerPrompt, "reviewer.md"],
              ["Plan", planPrompt, setPlanPrompt, "plan.md"],
            ] as const
          ).map(([label, value, setValue, file]) => (
            <input
              key={label}
              aria-label={`${label} system prompt file`}
              className={inputClass}
              placeholder={`${label}: /path/to/${file}`}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          ))}
        </div>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          Put <code>{"{system_prompt}"}</code> in a command (Claude Code:{" "}
          <code>--append-system-prompt-file {"{system_prompt}"}</code>) to pass the matching file. A
          project&apos;s own <code>.task-doer/worker.md</code>, <code>reviewer.md</code> or{" "}
          <code>plan.md</code> is used instead when it exists. Can also be set per source or project.
        </p>
      </div>
      <div className="flex flex-wrap gap-6">
        <div>
          <label className={labelClass} htmlFor="auto-fix">
            Auto-fix attempts for failing tests (0 to 3)
          </label>
          <input
            id="auto-fix"
            type="number"
            min={0}
            max={3}
            className={`${inputClass} w-24`}
            value={autoFix}
            onChange={(e) => setAutoFix(e.target.value)}
          />
          <p className="mt-1 max-w-sm text-xs text-zinc-500 dark:text-zinc-400">
            The worker is re-run with the test output as feedback. Needs a test command.
          </p>
        </div>
        <div>
          <label className={labelClass} htmlFor="reviewer-gate">
            When the reviewer asks for changes
          </label>
          <select
            id="reviewer-gate"
            className={inputClass}
            value={gate}
            onChange={(e) => setGate(e.target.value as ReviewerGate)}
          >
            <option value="auto_redo">Redo once automatically (default)</option>
            <option value="warn">Warn me</option>
            <option value="off">Only show the verdict</option>
          </select>
        </div>
      </div>
      <div className="flex flex-wrap gap-6">
        <div className="min-w-64 flex-1">
          <label className={labelClass} htmlFor="ide-command">
            Open runs in your editor (optional)
          </label>
          <input
            id="ide-command"
            className={inputClass}
            placeholder={'code {path}   or   open -a "Visual Studio Code" {path}'}
            value={ideCommand}
            onChange={(e) => setIdeCommand(e.target.value)}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="keep-days">
            Delete finished runs after (days, 0 = keep)
          </label>
          <input
            id="keep-days"
            type="number"
            min={0}
            className={`${inputClass} w-24`}
            value={keepDays}
            onChange={(e) => setKeepDays(e.target.value)}
          />
        </div>
      </div>
      <div>
        <label className={labelClass} htmlFor="usage-regex">
          Cost or token figure in agent output (regex, optional)
        </label>
        <input
          id="usage-regex"
          className={inputClass}
          placeholder={String.raw`cost: \$([0-9.]+)`}
          value={usageRegex}
          onChange={(e) => setUsageRegex(e.target.value)}
        />
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          Matched against each output line; the first capture group (or the whole match) is shown on the
          run page.
        </p>
      </div>
      <div>
        <label className={labelClass} htmlFor="credential-env">
          Credential environment variable
        </label>
        <input
          id="credential-env"
          list="credential-env-options"
          className={inputClass}
          placeholder="CLAUDE_CODE_OAUTH_TOKEN"
          value={credentialEnvVar}
          onChange={(e) => setCredentialEnvVar(e.target.value)}
        />
        <datalist id="credential-env-options">
          <option value="CLAUDE_CODE_OAUTH_TOKEN" />
          <option value="ANTHROPIC_API_KEY" />
        </datalist>
      </div>
      <div>
        <label className={labelClass} htmlFor="credential-secret">
          Credential {hasCredential ? "(saved in the OS keychain)" : "(not saved)"}
        </label>
        <div className="flex gap-2">
          <input
            id="credential-secret"
            type="password"
            autoComplete="off"
            className={inputClass}
            placeholder={hasCredential ? "Enter a new value to replace it" : "Token or API key"}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
          {hasCredential && (
            <button
              type="button"
              onClick={handleRemoveCredential}
              className="rounded-md px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950"
            >
              Remove
            </button>
          )}
        </div>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          Passed to the agent as that environment variable. For a Claude subscription, run{" "}
          <code>claude setup-token</code> in a terminal and paste the token here; otherwise use an API
          key.
        </p>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={!dirty || saving}
          onClick={handleSave}
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
        >
          {saving ? "Saving..." : "Save commands"}
        </button>
        {error && <span className="text-sm text-red-600 dark:text-red-400">{error}</span>}
      </div>
    </section>
  );
}
