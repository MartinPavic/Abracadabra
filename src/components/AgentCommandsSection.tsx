import { useEffect, useState } from "react";
import {
  AGENT_CREDENTIAL_ID,
  type AppConfig,
  hasToken,
  removeToken,
  type ReviewerGate,
  setToken,
} from "../lib/api";
import { inferPreset } from "../lib/agentPresets";
import { AutoTextarea } from "./AutoTextarea";
import { TestCommandButton } from "./TestCommandButton";
import { Button, Card, Field, Input, Notice, Select } from "./ui";

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
          preset: inferPreset({ workerCmd, reviewerCmd, planCmd, descriptionCmd }),
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

  const fields = (
    <div className="flex flex-col gap-4">
      <Notice tone="info">
        Agents and test commands run with this app's full environment (your PATH, SSH agent and
        any tokens set in it) and act on issue text written by whoever can edit the issue. Only
        use issues and agents you trust, and keep secrets out of the environment you launch the
        app from.
      </Notice>
      <Field label="Worker command" htmlFor="worker-cmd">
        <AutoTextarea
          id="worker-cmd"
          mono
          placeholder="my-agent --prompt {prompt_file} --cwd {cwd}"
          value={workerCmd}
          onChange={(e) => setWorkerCmd(e.target.value)}
        />
        <TestCommandButton command={workerCmd} systemPrompt={workerPrompt} />
      </Field>
      <Field label="Reviewer command" htmlFor="reviewer-cmd">
        <AutoTextarea
          id="reviewer-cmd"
          mono
          placeholder="my-agent --prompt {prompt_file} --cwd {cwd}"
          value={reviewerCmd}
          onChange={(e) => setReviewerCmd(e.target.value)}
        />
        <TestCommandButton command={reviewerCmd} systemPrompt={reviewerPrompt} />
      </Field>
      <Field
        label={'Plan command (for "Plan" runs)'}
        htmlFor="plan-cmd"
        hint={
          <>
            Same as the worker command but in the CLI's read-only plan mode (Claude Code:{" "}
            <code>--permission-mode plan</code>). Plan runs create no commit.
          </>
        }
      >
        <AutoTextarea
          id="plan-cmd"
          mono
          aria-describedby="plan-cmd-hint"
          placeholder="my-agent --plan-mode --prompt {prompt_file} --cwd {cwd}"
          value={planCmd}
          onChange={(e) => setPlanCmd(e.target.value)}
        />
        <TestCommandButton command={planCmd} systemPrompt={planPrompt} />
      </Field>
      <Field
        label="Description command (optional, writes the MR summary and reviewer checklist)"
        htmlFor="description-cmd"
        hint={
          <>
            Run when you open an approved run&apos;s merge request, with the change and the issue in
            the prompt. It must print a <code>## Summary</code> and a <code>## Checklist</code>{" "}
            section, and should be read-only (same flags as the plan command) because it runs in your
            project folder. Empty uses the worker&apos;s summary and a generic checklist.
          </>
        }
      >
        <AutoTextarea
          id="description-cmd"
          mono
          aria-describedby="description-cmd-hint"
          placeholder="my-agent --plan-mode --prompt {prompt_file} --cwd {cwd}"
          value={descriptionCmd}
          onChange={(e) => setDescriptionCmd(e.target.value)}
        />
        <TestCommandButton command={descriptionCmd} />
      </Field>
      <Field
        label="Test command (optional)"
        htmlFor="test-cmd"
        hint={
          <>
            Runs in the project folder after the worker; the result is shown on the run and given to the
            reviewer. Failing tests don&apos;t stop the run. Commands aren&apos;t run in a shell, so
            wrap chains in <code>sh -c</code>; they already start in the project folder. Can be
            overridden per source or project.
          </>
        }
      >
        <AutoTextarea
          id="test-cmd"
          mono
          aria-describedby="test-cmd-hint"
          placeholder={'sh -c "pnpm test && pnpm lint"'}
          value={testCmd}
          onChange={(e) => setTestCmd(e.target.value)}
        />
      </Field>
      <Field
        label="Max parallel runs"
        htmlFor="max-parallel"
        hint={
          <>
            Extra runs wait as &quot;queued&quot; until a slot frees up. A change also applies to runs
            that are already waiting.
          </>
        }
      >
        <div className="w-24">
          <Input
            id="max-parallel"
            type="number"
            min={1}
            aria-describedby="max-parallel-hint"
            value={maxParallel}
            onChange={(e) => setMaxParallel(e.target.value)}
          />
        </div>
      </Field>
      <Field
        label="Time limit per agent or test run (minutes)"
        htmlFor="agent-timeout"
        hint="A process that runs longer is killed together with its child processes, and the run fails. 0 means no limit."
      >
        <div className="w-24">
          <Input
            id="agent-timeout"
            type="number"
            min={0}
            aria-describedby="agent-timeout-hint"
            value={timeoutMinutes}
            onChange={(e) => setTimeoutMinutes(e.target.value)}
          />
        </div>
      </Field>
      <fieldset className="flex min-w-0 flex-col gap-1" aria-describedby="system-prompt-files-hint">
        <legend className="mb-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
          System prompt files
        </legend>
        <div className="flex flex-col gap-2">
          {(
            [
              ["Worker", workerPrompt, setWorkerPrompt, "worker.md"],
              ["Reviewer", reviewerPrompt, setReviewerPrompt, "reviewer.md"],
              ["Plan", planPrompt, setPlanPrompt, "plan.md"],
            ] as const
          ).map(([label, value, setValue, file]) => (
            <Input
              key={label}
              aria-label={`${label} system prompt file`}
              mono
              placeholder={`${label}: /path/to/${file}`}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          ))}
        </div>
        <p id="system-prompt-files-hint" className="text-xs text-zinc-500 dark:text-zinc-400">
          Put <code>{"{system_prompt}"}</code> in a command (Claude Code:{" "}
          <code>--append-system-prompt-file {"{system_prompt}"}</code>) to pass the matching file. A
          project&apos;s own <code>.task-doer/worker.md</code>, <code>reviewer.md</code> or{" "}
          <code>plan.md</code> is used instead when it exists. Can also be set per source or project.
        </p>
      </fieldset>
      <div className="flex flex-wrap gap-6">
        <div className="max-w-sm">
          <Field
            label="Auto-fix attempts for failing tests (0 to 3)"
            htmlFor="auto-fix"
            hint="The worker is re-run with the test output as feedback. Needs a test command."
          >
            <div className="w-24">
              <Input
                id="auto-fix"
                type="number"
                min={0}
                max={3}
                aria-describedby="auto-fix-hint"
                value={autoFix}
                onChange={(e) => setAutoFix(e.target.value)}
              />
            </div>
          </Field>
        </div>
        <Field label="When the reviewer asks for changes" htmlFor="reviewer-gate">
          <Select
            id="reviewer-gate"
            value={gate}
            onChange={(e) => setGate(e.target.value as ReviewerGate)}
          >
            <option value="auto_redo">Redo once automatically (default)</option>
            <option value="warn">Warn me</option>
            <option value="off">Only show the verdict</option>
          </Select>
        </Field>
      </div>
      <div className="flex flex-wrap gap-6">
        <div className="min-w-64 flex-1">
          <Field label="Open runs in your editor (optional)" htmlFor="ide-command">
            <Input
              id="ide-command"
              mono
              placeholder={'code {path}   or   open -a "Visual Studio Code" {path}'}
              value={ideCommand}
              onChange={(e) => setIdeCommand(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Delete finished runs after (days, 0 = keep)" htmlFor="keep-days">
          <div className="w-24">
            <Input
              id="keep-days"
              type="number"
              min={0}
              value={keepDays}
              onChange={(e) => setKeepDays(e.target.value)}
            />
          </div>
        </Field>
      </div>
      <Field
        label="Cost or token figure in agent output (regex, optional)"
        htmlFor="usage-regex"
        hint="Matched against each output line; the first capture group (or the whole match) is shown on the run page."
      >
        <Input
          id="usage-regex"
          mono
          aria-describedby="usage-regex-hint"
          placeholder={String.raw`cost: \$([0-9.]+)`}
          value={usageRegex}
          onChange={(e) => setUsageRegex(e.target.value)}
        />
      </Field>
      <Field label="Credential environment variable" htmlFor="credential-env">
        <Input
          id="credential-env"
          list="credential-env-options"
          mono
          placeholder="CLAUDE_CODE_OAUTH_TOKEN"
          value={credentialEnvVar}
          onChange={(e) => setCredentialEnvVar(e.target.value)}
        />
        <datalist id="credential-env-options">
          <option value="CLAUDE_CODE_OAUTH_TOKEN" />
          <option value="ANTHROPIC_API_KEY" />
        </datalist>
      </Field>
      <Field
        label={`Credential ${hasCredential ? "(saved in the OS keychain)" : "(not saved)"}`}
        htmlFor="credential-secret"
        hint={
          <>
            Passed to the agent as that environment variable. For a Claude subscription, run{" "}
            <code>claude setup-token</code> in a terminal and paste the token here; otherwise use an API
            key.
          </>
        }
      >
        <div className="flex gap-2">
          <Input
            id="credential-secret"
            type="password"
            autoComplete="off"
            mono
            aria-describedby="credential-secret-hint"
            placeholder={hasCredential ? "Enter a new value to replace it" : "Token or API key"}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
          {hasCredential && (
            <Button variant="ghost" icon="trash" className="shrink-0" onClick={handleRemoveCredential}>
              Remove
            </Button>
          )}
        </div>
      </Field>
      <div>
        <Button variant="primary" disabled={!dirty || saving} onClick={handleSave}>
          {saving ? "Saving..." : "Save commands"}
        </Button>
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
    </div>
  );

  return (
    <Card
      title="Agent commands"
      description={
        <>
          Use <code>{"{prompt_file}"}</code> for the generated prompt and <code>{"{cwd}"}</code> for
          the project folder the run works in.
        </>
      }
    >
      {fields}
    </Card>
  );
}
