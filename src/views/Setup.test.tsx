import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AppConfig,
  detectAgentClis,
  getConfig,
  removeToken,
  saveConfig,
  setToken,
  testAgentCommand,
  testConnection,
} from "../lib/api";
import { agentPresets, applyPreset } from "../lib/agentPresets";
import { FirstRunGate } from "../components/FirstRunGate";
import { Setup } from "./Setup";

vi.mock("../lib/api", () => ({
  getConfig: vi.fn(),
  saveConfig: vi.fn(),
  setToken: vi.fn(),
  removeToken: vi.fn(),
  testConnection: vi.fn(),
  detectAgentClis: vi.fn(),
  testAgentCommand: vi.fn(),
  describeError: (err: unknown, host?: string) => `${String(err)} (${host ?? "no host"})`,
}));

const baseConfig = {
  gitSources: [],
  agent: {
    workerCmd: "",
    reviewerCmd: "",
    planCmd: "",
    descriptionCmd: "",
    preset: "",
    credentialEnvVar: "",
    timeoutSecs: 1800,
  },
  baseBranch: "dev",
} as unknown as AppConfig;

const claude = agentPresets[0];
const existingSource = {
  id: "s1",
  name: "Work",
  provider: "gitlab" as const,
  baseUrl: "https://gl",
  projectFilter: null,
};

/** What the backend holds; saveConfig writes it, getConfig reads it. */
let stored: AppConfig;

beforeEach(() => {
  localStorage.clear();
  stored = baseConfig;
  vi.mocked(getConfig).mockImplementation(async () => stored);
  vi.mocked(saveConfig).mockImplementation(async (next) => {
    stored = next;
  });
  vi.mocked(setToken).mockResolvedValue(undefined);
  vi.mocked(removeToken).mockResolvedValue(undefined);
  vi.mocked(testConnection).mockResolvedValue(undefined);
  vi.mocked(detectAgentClis).mockResolvedValue([{ id: "claude", path: "/usr/local/bin/claude" }]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderRoutes(initial = "/setup") {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route path="/setup" element={<Setup />} />
        <Route
          path="/tasks"
          element={
            <FirstRunGate>
              <p>Tasks page</p>
            </FirstRunGate>
          }
        />
        <Route path="/settings" element={<p>Settings page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

function continueButton() {
  return screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement;
}

function typeToken(token: string) {
  fireEvent.change(screen.getByLabelText("Access token"), { target: { value: token } });
}

async function passTest() {
  fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
  await screen.findByText("Connected");
}

/** Fills step 1, passes the test and continues to step 2. */
async function connect() {
  await screen.findByText(/Step 1 of 3/);
  typeToken("glpat-x");
  await passTest();
  fireEvent.click(continueButton());
  await screen.findByText(/Step 2 of 3/);
}

describe("Setup", () => {
  it("continue is disabled until the connection test passes", async () => {
    renderRoutes();
    await screen.findByText(/Step 1 of 3/);
    expect((screen.getByLabelText("Base URL") as HTMLInputElement).value).toBe("https://gitlab.com");
    typeToken("glpat-x");
    expect(continueButton().disabled).toBe(true);

    vi.mocked(testConnection).mockRejectedValueOnce("bad token");
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await screen.findByText("bad token (gitlab.com)");
    expect(continueButton().disabled).toBe(true);

    await passTest();
    expect(testConnection).toHaveBeenLastCalledWith({
      provider: "gitlab",
      baseUrl: "https://gitlab.com",
      token: "glpat-x",
    });
    expect(continueButton().disabled).toBe(false);
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it("changing a field after a passing test disables continue again", async () => {
    renderRoutes();
    await screen.findByText(/Step 1 of 3/);
    typeToken("glpat-x");
    await passTest();

    typeToken("glpat-y");
    expect(screen.queryByText("Connected")).toBeNull();
    expect(continueButton().disabled).toBe(true);

    await passTest();
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "github" } });
    expect((screen.getByLabelText("Base URL") as HTMLInputElement).value).toBe("https://github.com");
    expect(continueButton().disabled).toBe(true);

    await passTest();
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://gh.example.com" } });
    expect(continueButton().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "gitlab" } });
    // An edited URL is kept when the provider changes.
    expect((screen.getByLabelText("Base URL") as HTMLInputElement).value).toBe("https://gh.example.com");
  });

  it("saving the source stores the token first and removes it if the config save fails", async () => {
    vi.mocked(saveConfig).mockRejectedValueOnce("disk full");
    renderRoutes();
    await screen.findByText(/Step 1 of 3/);
    typeToken("glpat-x");
    await passTest();
    fireEvent.click(continueButton());

    await screen.findByText("disk full (no host)");
    expect(screen.getByText(/Step 1 of 3/)).toBeTruthy();
    const id = vi.mocked(setToken).mock.calls[0][0];
    expect(setToken).toHaveBeenCalledExactlyOnceWith(id, "glpat-x");
    expect(saveConfig).toHaveBeenCalledExactlyOnceWith({
      ...baseConfig,
      gitSources: [
        { id, name: "gitlab.com", provider: "gitlab", baseUrl: "https://gitlab.com", projectFilter: null },
      ],
    });
    expect(removeToken).toHaveBeenCalledExactlyOnceWith(id);
    const order = (fn: unknown) => vi.mocked(fn as () => void).mock.invocationCallOrder[0];
    expect(order(setToken)).toBeLessThan(order(saveConfig));
    expect(order(saveConfig)).toBeLessThan(order(removeToken));

    fireEvent.click(continueButton());
    await screen.findByText(/Step 2 of 3/);
    expect(setToken).toHaveBeenCalledTimes(2);
    expect(removeToken).toHaveBeenCalledOnce();
    expect(stored.gitSources).toHaveLength(1);
    expect(stored.gitSources[0].id).toBe(vi.mocked(setToken).mock.calls[1][0]);
    await screen.findByRole("button", { name: /Claude Code/ });
  });

  it("going back and continuing with unchanged values does not save the source twice", async () => {
    renderRoutes();
    await connect();
    await screen.findByRole("button", { name: /Claude Code/ });
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByText(/Step 1 of 3/);
    expect((screen.getByLabelText("Access token") as HTMLInputElement).value).toBe("glpat-x");

    fireEvent.click(continueButton());
    await screen.findByText(/Step 2 of 3/);
    await screen.findByRole("button", { name: /Claude Code/ });
    expect(setToken).toHaveBeenCalledOnce();
    expect(saveConfig).toHaveBeenCalledOnce();
    expect(stored.gitSources).toHaveLength(1);
  });

  it("going back and changing the values replaces the saved source", async () => {
    renderRoutes();
    await connect();
    const oldId = vi.mocked(setToken).mock.calls[0][0];
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByText(/Step 1 of 3/);
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://gl.example.com" } });
    typeToken("glpat-y");
    await passTest();
    fireEvent.click(continueButton());
    await screen.findByText(/Step 2 of 3/);

    const newId = vi.mocked(setToken).mock.calls[1][0];
    expect(newId).not.toBe(oldId);
    expect(setToken).toHaveBeenLastCalledWith(newId, "glpat-y");
    expect(stored.gitSources).toEqual([
      { id: newId, name: "gl.example.com", provider: "gitlab", baseUrl: "https://gl.example.com", projectFilter: null },
    ]);
    expect(removeToken).toHaveBeenCalledExactlyOnceWith(oldId);
    const calls = (fn: unknown) => vi.mocked(fn as () => void).mock.invocationCallOrder;
    expect(calls(setToken)[1]).toBeLessThan(calls(saveConfig)[1]);
    expect(calls(saveConfig)[1]).toBeLessThan(calls(removeToken)[0]);
  });

  it("a failed replace keeps the first source and removes only the new token", async () => {
    renderRoutes();
    await connect();
    const first = stored.gitSources[0];
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByText(/Step 1 of 3/);
    typeToken("glpat-y");
    await passTest();
    vi.mocked(saveConfig).mockRejectedValueOnce("disk full");
    fireEvent.click(continueButton());

    await screen.findByText("disk full (no host)");
    const newId = vi.mocked(setToken).mock.calls[1][0];
    expect(removeToken).toHaveBeenCalledExactlyOnceWith(newId);
    expect(stored.gitSources).toEqual([first]);
  });

  it("a detected agent can be chosen and fills the preset", async () => {
    vi.mocked(detectAgentClis).mockResolvedValue([
      { id: "claude", path: "/usr/local/bin/claude" },
      { id: "other", path: "/bin/other" },
    ]);
    vi.mocked(testAgentCommand).mockResolvedValue({ ok: true, timedOut: false, output: "pong", error: null });
    renderRoutes();
    await connect();

    const card = await screen.findByRole("button", { name: /Claude Code/ });
    await waitFor(() => expect(card.textContent).toContain("Detected"));
    expect(screen.getByRole("button", { name: /Codex/ }).textContent).toContain("Not found");
    expect(screen.queryByText("/bin/other")).toBeNull();
    expect(screen.queryByText("No supported agent CLI was found on your PATH.")).toBeNull();
    expect(
      screen.getByRole("link", { name: "Use custom commands in Settings" }).getAttribute("href"),
    ).toBe("/settings");
    expect(card.getAttribute("aria-pressed")).toBe("false");
    expect(continueButton().disabled).toBe(false);

    const withSource = stored;
    fireEvent.click(card);
    await waitFor(() => expect(card.getAttribute("aria-pressed")).toBe("true"));
    expect(saveConfig).toHaveBeenLastCalledWith({
      ...withSource,
      agent: applyPreset(withSource.agent, "claude"),
    });
    expect(continueButton().disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Test agent" }));
    await screen.findByText("OK");
    expect(testAgentCommand).toHaveBeenCalledExactlyOnceWith(claude.worker);

    fireEvent.click(continueButton());
    await screen.findByText(/Step 3 of 3/);
    expect(screen.getByText(/gitlab\.com/)).toBeTruthy();
    expect(screen.getByText(claude.label)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "I'll set it up myself" })).toBeTruthy();
  });

  it("choosing an agent over hand-edited commands asks before replacing them", async () => {
    stored = {
      ...baseConfig,
      agent: {
        ...baseConfig.agent,
        workerCmd: "my worker",
        reviewerCmd: "my reviewer",
        planCmd: "my plan",
        descriptionCmd: "my desc",
      },
    };
    renderRoutes();
    await connect();
    const withSource = stored;

    fireEvent.click(await screen.findByRole("button", { name: /Claude Code/ }));
    await screen.findByText("Replace your edited commands?");
    expect(saveConfig).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    await waitFor(() => expect(saveConfig).toHaveBeenCalledTimes(2));
    expect(saveConfig).toHaveBeenLastCalledWith({
      ...withSource,
      agent: applyPreset(withSource.agent, "claude"),
    });
  });

  it("with no agent detected the step explains and still allows finishing", async () => {
    vi.mocked(detectAgentClis).mockResolvedValue([]);
    renderRoutes();
    await connect();

    await screen.findByText("No supported agent CLI was found on your PATH.");
    expect(
      screen.getByRole("link", { name: "Use custom commands in Settings" }).getAttribute("href"),
    ).toBe("/settings");
    expect(continueButton().disabled).toBe(false);
    fireEvent.click(continueButton());
    await screen.findByText(/Step 3 of 3/);
    expect(screen.getByText("Not set up")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Go to tasks" }));
    await screen.findByText("Tasks page");
  });

  it("the setup summary names the preset inferred from the commands", async () => {
    stored = {
      ...baseConfig,
      agent: {
        ...baseConfig.agent,
        workerCmd: claude.worker,
        reviewerCmd: claude.readOnly,
        planCmd: claude.readOnly,
        descriptionCmd: claude.readOnly,
        preset: "",
      },
    };
    renderRoutes();
    await connect();
    fireEvent.click(continueButton());
    await screen.findByText(/Step 3 of 3/);
    expect(screen.getByText(claude.label)).toBeTruthy();
    expect(screen.queryByText("Custom commands")).toBeNull();
  });

  it("with existing sources the wizard can continue without adding one", async () => {
    stored = { ...baseConfig, gitSources: [existingSource] };
    renderRoutes();
    await screen.findByText(/Step 1 of 3/);
    expect(screen.getByLabelText("Access token")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep my existing sources" }));
    await screen.findByText(/Step 2 of 3/);
    await screen.findByRole("button", { name: /Claude Code/ });
    expect(setToken).not.toHaveBeenCalled();
    expect(saveConfig).not.toHaveBeenCalled();

    fireEvent.click(continueButton());
    await screen.findByText(/Step 3 of 3/);
    expect(screen.getByText("Work")).toBeTruthy();
  });

  it("without existing sources there is no way past step 1 except a passing test", async () => {
    renderRoutes();
    await screen.findByText(/Step 1 of 3/);
    expect(screen.queryByRole("button", { name: "Keep my existing sources" })).toBeNull();
  });

  it("after the wizard saves a source it no longer offers to keep existing ones", async () => {
    renderRoutes();
    await connect();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByText(/Step 1 of 3/);
    expect(stored.gitSources).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Keep my existing sources" })).toBeNull();
  });

  it("the custom commands link opens Advanced in settings", async () => {
    renderRoutes();
    await connect();
    fireEvent.click(screen.getByRole("link", { name: "Use custom commands in Settings" }));
    await screen.findByText("Settings page");
    expect(localStorage.getItem("settings-advanced-open")).toBe("1");
  });

  it("skipping goes to settings and remembers the skip", async () => {
    renderRoutes();
    await screen.findByText(/Step 1 of 3/);
    fireEvent.click(screen.getByRole("button", { name: "I'll set it up myself" }));
    await screen.findByText("Settings page");
    expect(localStorage.getItem("setup-skipped")).toBe("1");
    expect(saveConfig).not.toHaveBeenCalled();
    cleanup();

    localStorage.clear();
    renderRoutes();
    await connect();
    await screen.findByRole("button", { name: /Claude Code/ });
    fireEvent.click(screen.getByRole("button", { name: "I'll set it up myself" }));
    await screen.findByText("Settings page");
    expect(localStorage.getItem("setup-skipped")).toBe("1");
  });

  it("finishing the wizard and opening tasks does not redirect back to setup", async () => {
    renderRoutes("/tasks");
    await connect();
    const card = await screen.findByRole("button", { name: /Claude Code/ });
    fireEvent.click(card);
    await waitFor(() => expect(card.getAttribute("aria-pressed")).toBe("true"));
    fireEvent.click(continueButton());
    await screen.findByText(/Step 3 of 3/);

    fireEvent.click(screen.getByRole("button", { name: "Go to tasks" }));
    await screen.findByText("Tasks page");
    expect(screen.queryByText(/Step \d of 3/)).toBeNull();
    expect(getConfig).toHaveBeenCalledTimes(3);
  });
});

describe("FirstRunGate", () => {
  function renderGate() {
    return render(
      <MemoryRouter initialEntries={["/tasks"]}>
        <Routes>
          <Route path="/setup" element={<p>Setup page</p>} />
          <Route
            path="/tasks"
            element={
              <FirstRunGate>
                <p>Tasks page</p>
              </FirstRunGate>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
  }

  it("the gate redirects to setup only when there are no sources and no skip", async () => {
    renderGate();
    await screen.findByText("Setup page");
    cleanup();

    localStorage.setItem("setup-skipped", "1");
    renderGate();
    await screen.findByText("Tasks page");
    cleanup();

    localStorage.clear();
    stored = { ...baseConfig, gitSources: [existingSource] };
    renderGate();
    await screen.findByText("Tasks page");
    cleanup();

    vi.mocked(getConfig).mockRejectedValueOnce("broken config");
    renderGate();
    await screen.findByText("Tasks page");
  });

  it("the gate renders nothing while the config loads", async () => {
    let resolve: (config: AppConfig) => void = () => undefined;
    vi.mocked(getConfig).mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const { container } = renderGate();
    expect(container.textContent).toBe("");
    resolve(baseConfig);
    await screen.findByText("Setup page");
  });
});
