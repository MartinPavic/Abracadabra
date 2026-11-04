import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AppConfig, getConfig, saveConfig } from "../lib/api";
import { agentPresets } from "../lib/agentPresets";
import { Settings } from "./Settings";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("../lib/api", () => ({
  AGENT_CREDENTIAL_ID: "agent-credential",
  getConfig: vi.fn(),
  saveConfig: vi.fn(),
  setToken: vi.fn().mockResolvedValue(undefined),
  removeToken: vi.fn().mockResolvedValue(undefined),
  hasToken: vi.fn().mockResolvedValue(false),
  listRuns: vi.fn().mockResolvedValue([]),
  detectAgentClis: vi.fn().mockResolvedValue([{ id: "claude", path: "/bin/claude" }]),
  testAgentCommand: vi.fn(),
  testConnection: vi.fn(),
  getInstructions: vi.fn().mockResolvedValue(""),
  setInstructions: vi.fn(),
  readTextFile: vi.fn(),
  describeError: String,
}));

const baseConfig: AppConfig = {
  gitSources: [],
  agent: {
    workerCmd: "",
    reviewerCmd: "",
    planCmd: "",
    descriptionCmd: "",
    preset: "",
    credentialEnvVar: "",
    timeoutSecs: 1800,
    workerPromptFile: "",
    reviewerPromptFile: "",
    planPromptFile: "",
    usageRegex: "",
  },
  baseBranch: "dev",
  branchTemplate: "{type}/{issue_iid}-{slug}",
  commitTemplate: "{type}: {title}",
  mergeRequestTemplate: "",
  testCmd: "",
  autoFixAttempts: 0,
  reviewerGate: "auto_redo",
  commentMrLink: false,
  commentPlan: false,
  keepRunsDays: 0,
  ideCommand: "",
  localRepos: {},
  projectOverrides: {},
  maxParallelRuns: 2,
  timeouts: {},
} as unknown as AppConfig;

const ADVANCED_KEY = "settings-advanced-open";

async function renderSettings(config: AppConfig = baseConfig) {
  vi.mocked(getConfig).mockResolvedValue(config);
  const view = render(
    <MemoryRouter>
      <Settings />
    </MemoryRouter>,
  );
  await screen.findByText("Detected");
  await screen.findByLabelText("Global instructions");
  return view;
}

function advanced() {
  const details = screen.getByText("Advanced").closest("details");
  if (!details) throw new Error("no Advanced <details>");
  return details;
}

function lastSaved(): AppConfig {
  const calls = vi.mocked(saveConfig).mock.calls;
  return calls[calls.length - 1][0];
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(saveConfig).mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Settings", () => {
  it("basics are visible and advanced is collapsed by default", async () => {
    await renderSettings({
      ...baseConfig,
      gitSources: [
        { id: "s1", name: "Work GitLab", provider: "gitlab", baseUrl: "https://gl", projectFilter: null },
      ],
    });
    expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Run setup again" }).getAttribute("href")).toBe("/setup");
    expect(screen.getByRole("heading", { name: "Git sources" })).toBeTruthy();
    expect(screen.getByText("Work GitLab")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Agent" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Agent instructions" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save base branch" })).toBeTruthy();
    expect(advanced().open).toBe(false);
  });

  it("every previous section is reachable inside advanced", async () => {
    await renderSettings();
    const details = within(advanced());
    for (const heading of ["Agent commands", "Templates", "Project overrides", "Project checkouts"]) {
      expect(details.getByText(heading)).toBeTruthy();
    }
  });

  it("the advanced state is remembered", async () => {
    const first = await renderSettings();
    const details = advanced();
    details.open = true;
    fireEvent(details, new Event("toggle"));
    expect(localStorage.getItem(ADVANCED_KEY)).toBe("1");
    first.unmount();

    await renderSettings();
    expect(advanced().open).toBe(true);
  });

  it("base branch saves from basics", async () => {
    await renderSettings();
    fireEvent.change(screen.getByLabelText("Base branch"), { target: { value: " main " } });
    fireEvent.click(screen.getByRole("button", { name: "Save base branch" }));
    await waitFor(() => expect(saveConfig).toHaveBeenCalledOnce());
    expect(lastSaved()).toEqual({ ...baseConfig, baseBranch: "main" });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save base branch" }).hasAttribute("disabled")).toBe(true),
    );

    fireEvent.change(screen.getByLabelText("Branch name"), { target: { value: "feature/{slug}" } });
    fireEvent.click(screen.getByRole("button", { name: "Save templates" }));
    await waitFor(() => expect(saveConfig).toHaveBeenCalledTimes(2));
    expect(lastSaved()).toMatchObject({ baseBranch: "main", branchTemplate: "feature/{slug}" });
  });

  it("choosing a preset updates the commands shown in advanced", async () => {
    const claude = agentPresets.find((preset) => preset.id === "claude")!;
    await renderSettings();
    fireEvent.click(screen.getByRole("button", { name: /Claude Code/ }));
    await waitFor(() =>
      expect((screen.getByLabelText("Worker command") as HTMLTextAreaElement).value).toBe(claude.worker),
    );
    expect((screen.getByLabelText("Reviewer command") as HTMLTextAreaElement).value).toBe(
      claude.readOnly,
    );

    fireEvent.change(screen.getByLabelText("Max parallel runs"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Save commands" }));
    await waitFor(() => expect(saveConfig).toHaveBeenCalledTimes(2));
    expect(lastSaved().maxParallelRuns).toBe(3);
    expect(lastSaved().agent).toMatchObject({
      workerCmd: claude.worker,
      reviewerCmd: claude.readOnly,
      planCmd: claude.readOnly,
      descriptionCmd: claude.readOnly,
      preset: "claude",
    });
  });
});
