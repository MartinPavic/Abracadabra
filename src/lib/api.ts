import { invoke } from "@tauri-apps/api/core";
import { openUrl as pluginOpenUrl } from "@tauri-apps/plugin-opener";

export type GitProvider = "gitlab" | "github";

export interface GitSourceConfig {
  id: string;
  name: string;
  provider: GitProvider;
  baseUrl: string;
  projectFilter?: string | null;
  /** Applies to this source's projects unless a project override wins. */
  overrides?: SettingsOverride;
}

/** Replacements for global settings; blank/null falls back to the next level. */
export interface SettingsOverride {
  baseBranch?: string | null;
  branchTemplate?: string | null;
  commitTemplate?: string | null;
  workerCmd?: string | null;
  reviewerCmd?: string | null;
  planCmd?: string | null;
  descriptionCmd?: string | null;
  testCmd?: string | null;
  workerPromptFile?: string | null;
  reviewerPromptFile?: string | null;
  planPromptFile?: string | null;
}

export interface AgentConfig {
  workerCmd: string;
  reviewerCmd: string;
  /** Worker command for plan-only runs; empty disables them. */
  planCmd: string;
  /** Command that writes the MR summary and reviewer checklist; empty uses the worker summary. */
  descriptionCmd: string;
  /** Env var the agent CLI reads its credential from; the secret is in the OS keychain. */
  credentialEnvVar: string;
  /** Longest an agent or test process may run, in seconds; 0 means no limit. */
  timeoutSecs: number;
  /** System prompt files for `{system_prompt}`; a project's `.task-doer/<role>.md` wins. */
  workerPromptFile: string;
  reviewerPromptFile: string;
  planPromptFile: string;
  /** Regex that picks a cost or token figure out of an agent's output; empty records nothing. */
  usageRegex: string;
}

export type ReviewerGate = "off" | "warn" | "auto_redo";

/** Keychain id for the agent credential (see `AGENT_CREDENTIAL_ID` in secrets.rs). */
export const AGENT_CREDENTIAL_ID = "agent-credential";

export interface TimeoutConfig {
  connectTimeoutSecs: number;
  retryAttempts: number;
}

export interface AppConfig {
  gitSources: GitSourceConfig[];
  agent: AgentConfig;
  /** Branch runs start from; a project without it uses its own default branch. */
  baseBranch: string;
  branchTemplate: string;
  commitTemplate: string;
  /** MR/PR description; placeholders {worker_summary}, {files_changed}, {review_notes}, {issue_ref}. */
  mergeRequestTemplate: string;
  /** Command run in the project folder after the worker; its result goes to the reviewer. */
  testCmd: string;
  /** How many times the worker may be re-run to fix failing tests (0 to 3). */
  autoFixAttempts: number;
  reviewerGate: ReviewerGate;
  /** Comment on the issue with the merge request link once it is created. */
  commentMrLink: boolean;
  /** Comment on the issue with the plan after a plan run. */
  commentPlan: boolean;
  /** Finished runs older than this many days are deleted at startup; 0 keeps them all. */
  keepRunsDays: number;
  /** Command that opens a run's project folder in your editor, e.g. `code {path}`. */
  ideCommand: string;
  /** Project path ("group/project") -> absolute local checkout folder. */
  localRepos: Record<string, string>;
  /** Project path -> overrides; these win over the git source's overrides. */
  projectOverrides: Record<string, SettingsOverride>;
  /** How many runs may execute at once; the rest wait as `queued`. */
  maxParallelRuns: number;
  timeouts: TimeoutConfig;
}

export async function getConfig(): Promise<AppConfig> {
  return invoke("get_config");
}

export async function saveConfig(config: AppConfig): Promise<void> {
  return invoke("save_config", { config });
}

export async function setToken(sourceId: string, token: string): Promise<void> {
  return invoke("set_token", { sourceId, token });
}

export async function hasToken(sourceId: string): Promise<boolean> {
  return invoke("has_token", { sourceId });
}

export async function removeToken(sourceId: string): Promise<void> {
  return invoke("remove_token", { sourceId });
}

/** Mirrors the Rust `AppError`, which most run, provider and stash commands fail with. */
export type AppError =
  | { kind: "auth" }
  | { kind: "timeout" }
  | { kind: "not_found" | "conflict" | "git" | "other"; message: string };

export async function testConnection(params: {
  provider: GitProvider;
  baseUrl: string;
  token: string;
}): Promise<void> {
  return invoke("test_connection", params);
}

export function describeError(err: unknown, host?: string): string {
  const payload = err as Partial<AppError> | undefined;
  switch (payload?.kind) {
    case "auth":
      return "Authentication failed — check the token in Settings.";
    case "timeout":
      return `Could not reach ${host ?? "the server"} — check your VPN connection.`;
    case "not_found":
    case "conflict":
    case "git":
    case "other":
      return payload.message ?? "Something went wrong.";
    default:
      return String(err);
  }
}

export interface Task {
  id: string;
  title: string;
  project: string;
  labels: string[];
  url: string;
  updatedAt: string;
  /** Provider's raw issue status (e.g. "opened"/"closed" for GitLab) — not a closed set. */
  status: string;
}

export async function listTasks(sourceId: string): Promise<Task[]> {
  return invoke("list_tasks", { sourceId });
}

/** Starts an agent run for a task; returns the run id. Progress arrives via Tauri events. */
export async function startRun(
  sourceId: string,
  taskId: string,
  planOnly = false,
  fromPlanRunId?: string,
): Promise<string> {
  return invoke("start_run", { sourceId, taskId, planOnly, fromPlanRunId });
}

export type RunStatus =
  | "queued"
  | "cloning"
  | "working"
  | "reviewing"
  | "committing"
  | "awaiting_approval"
  | "approved"
  | "discarded"
  | "handed_off"
  | "planned"
  | "failed"
  | "cancelled";

export interface RunRecord {
  id: string;
  taskId: string;
  taskTitle: string;
  taskUrl: string;
  sourceId: string;
  /** Plan-only run: ends in `planned` with the plan as its worker summary. */
  planOnly: boolean;
  /** The run's branch has been pushed to the remote. */
  pushed: boolean;
  mergeRequestUrl: string | null;
  /** Outcome of the test/lint hook, when one is configured. */
  testResult: { passed: boolean; output: string } | null;
  project: string;
  status: RunStatus;
  history: { status: RunStatus; atMs: number }[];
  error: string | null;
  reviewNotes: string | null;
  workerSummary: string | null;
  repoPath: string | null;
  branch: string | null;
  baseRef: string | null;
  /** Title of the earlier run in the same project folder this queued run waits for. */
  blockedBy: string | null;
  /** How many times the worker was re-run automatically to fix failing tests. */
  fixAttempts: number;
  /** The reviewer's overall call, when it gave one. */
  reviewVerdict: "approve" | "changes" | null;
  /** Cost or token figures the agents printed, as "step: value". */
  usage: string[];
  /** The commit a successful redo replaced; set once the run has been redone. */
  previousCommitSha: string | null;
  /** The run's current commit. */
  commitSha: string | null;
  /** The commit of `baseRef` the run's branch was cut from. */
  baseCommit: string | null;
  /** The project folder the run works in. */
  workDir: string | null;
  /** Branch (or commit) the project folder was on before the run. */
  originalRef: string | null;
  /** Set while the folder's uncommitted changes from before the run are still stashed. */
  stashCommit: string | null;
  /** Set when the run failed because its branch name already exists. */
  branchConflict: { branch: string; suggestion: string } | null;
  /** Why the last automatic redo failed; the run itself stays approvable. */
  redoError: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export async function listRuns(): Promise<RunRecord[]> {
  return invoke("list_runs");
}

export async function getRun(runId: string): Promise<RunRecord> {
  return invoke("get_run", { runId });
}

const FINISHED_STATUSES: RunStatus[] = [
  "approved",
  "discarded",
  "handed_off",
  "planned",
  "failed",
  "cancelled",
];

/** Only finished runs can be deleted. */
export function isFinished(status: RunStatus): boolean {
  return FINISHED_STATUSES.includes(status);
}

/** Statuses in which a run can still be cancelled (it is queued or an agent step is running). */
export function isCancellable(status: RunStatus): boolean {
  return ["queued", "cloning", "working", "reviewing", "committing"].includes(status);
}

/** Stop a queued or running run; its changes are undone. */
export async function cancelRun(runId: string): Promise<void> {
  return invoke("cancel_run", { runId });
}

/** Open the run's project folder with the configured IDE command. */
export async function openInIde(runId: string): Promise<void> {
  return invoke("open_in_ide", { runId });
}

/** Outcome of trying an agent command once with a trivial prompt. */
export interface AgentTestResult {
  ok: boolean;
  timedOut: boolean;
  output: string;
  /** Why the command couldn't be started at all. */
  error: string | null;
}

export async function testAgentCommand(
  command: string,
  systemPrompt?: string,
): Promise<AgentTestResult> {
  return invoke("test_agent_command", { command, systemPrompt });
}

/** Remove a finished run from the history (its branch and commits stay in the repo). */
export async function deleteRun(runId: string): Promise<void> {
  return invoke("delete_run", { runId });
}

/** A stash the app made before a run that no run refers to any more. */
export interface OrphanedStash {
  repoPath: string;
  commit: string;
  message: string;
}

export async function listOrphanedStashes(): Promise<OrphanedStash[]> {
  return invoke("list_orphaned_stashes");
}

/** Apply a forgotten stash onto the project folder (which must be clean). */
export async function restoreOrphanedStash(repoPath: string, commit: string): Promise<void> {
  return invoke("restore_orphaned_stash", { repoPath, commit });
}

export interface FileDiff {
  path: string;
  /** Git status letter: A(dded), M(odified), D(eleted), T(ype changed). */
  status: string;
  /** Unified diff for the file, including git's header lines. */
  patch: string;
}

export async function getRunDiff(runId: string): Promise<FileDiff[]> {
  return invoke("get_run_diff", { runId });
}

/** What the worker has changed so far, while a run is still working. */
export async function getLiveDiff(runId: string): Promise<FileDiff[]> {
  return invoke("get_run_diff_live", { runId });
}

/** What the last redo changed (the commit it replaced vs the current one). */
export async function getRedoDiff(runId: string): Promise<FileDiff[]> {
  return invoke("get_redo_diff", { runId });
}

/** One buffered line of agent output (worker, reviewer or test run). */
export interface RunOutputLine {
  role: "worker" | "reviewer" | "tests";
  stream: "stdout" | "stderr";
  line: string;
}

/** Recent console output of a run, for views opened after it was emitted. */
export async function getRunOutput(runId: string): Promise<RunOutputLine[]> {
  return invoke("get_run_output", { runId });
}

/** After a branch-name conflict: start a new run for the same task on `branch`; returns its id. */
export async function retryRunWithBranch(runId: string, branch: string): Promise<string> {
  return invoke("retry_run_with_branch", { runId, branch });
}

/** Push an approved run's branch to origin; rejects with git's own error text. */
export async function pushRun(runId: string): Promise<void> {
  return invoke("push_run", { runId });
}

/** Open a merge/pull request for a pushed run; returns its URL. */
export async function createMergeRequest(
  runId: string,
  edits?: { title?: string; description?: string },
): Promise<string> {
  return invoke("create_merge_request", {
    runId,
    title: edits?.title,
    description: edits?.description,
  });
}

/** Title and description a merge/pull request would be opened with. */
export interface MergeRequestDraft {
  title: string;
  description: string;
  /** Set when a description command is configured but its output couldn't be used. */
  note: string | null;
}

/** `regenerate` asks the description command to write the summary and checklist again. */
export async function previewMergeRequest(
  runId: string,
  regenerate = false,
): Promise<MergeRequestDraft> {
  return invoke("preview_merge_request", { runId, regenerate });
}

/** "Yes": accept the run's commit. */
export async function approveRun(runId: string): Promise<void> {
  return invoke("approve_run", { runId });
}

/** "No": delete the run's branch and put the project folder back as it was. */
export async function discardRun(runId: string): Promise<void> {
  return invoke("discard_run", { runId });
}

/** Switch the project folder back to its earlier branch and restore the stashed changes. */
export async function returnToOriginalBranch(runId: string): Promise<void> {
  return invoke("return_to_original_branch", { runId });
}

/** "Redo automatically": re-run the agent on the run's branch with extra feedback. */
export async function redoRun(runId: string, feedback: string): Promise<void> {
  return invoke("redo_run", { runId, feedback });
}

/** "Redo manually": open the project folder on the run's branch and stop managing the run. */
export async function handOffRun(runId: string): Promise<void> {
  return invoke("hand_off_run", { runId });
}

export async function openUrl(url: string): Promise<void> {
  return pluginOpenUrl(url);
}
