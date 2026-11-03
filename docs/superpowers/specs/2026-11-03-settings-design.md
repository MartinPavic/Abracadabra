# Settings, first-run setup and agent instructions: design

Date: 2026-11-03. Status: draft for approval. Project 2 of 3 (1: per-file review, merged; 3: visual redesign of the run page and task list, designed separately). Several choices below are mine, not yours; they are listed under "Calls made".

## Intent

A new user should get from install to a first run with two inputs: a token and a choice of agent. Today they face one page of about 15 fields, including shell command templates, prompt files, a usage regex and per-project folder mapping. The goal is a setup that is short for the first run and still gives power users every existing setting. Users also want to give the agents their own instructions (an `agent.md`).

## Goals

- A first-run wizard in three steps: connect a git source, pick an agent, done.
- Settings split into **Basics** and a collapsed **Advanced** section. Every existing setting stays reachable; fields are moved, not removed.
- Agent instructions: markdown text the user writes or imports, globally and per project, added to what the agents are told.
- A "ready to run" check that says exactly what is missing instead of failing during a run.
- Existing config files keep working with no migration step.

## Non-goals

- Visual redesign (project 3). This design fixes structure and behaviour; reuse the current Tailwind patterns.
- Managing agent skills. The agent CLI already loads its own user-level and project-level skills, because the app runs it as the user in the project folder.
- New git providers, importing or exporting settings, a config-file editor.

## Anti-goals

- A wizard that gets in the way of someone who wants to configure everything by hand (it is skippable).
- A setting that existed before and can no longer be reached.
- Tokens stored anywhere but the OS keychain.
- Instructions that silently change a file in the user's repository.

## Facts from the code that shape this

- `AgentCommandsSection.tsx` already has two presets (Claude Code, OpenAI Codex) that fill the worker, reviewer, plan and description commands.
- A run with no configured local folder uses an app-managed clone (`managed_repo_dir`, `pipeline.rs`). So folder mapping is not needed up front; it only matters for people who want runs in their own checkout.
- The prompt-file settings fill a `{system_prompt}` placeholder in the command. The presets do not contain that placeholder, so those settings do nothing for preset users today (a command that uses the placeholder with no file set fails the run).
- A project's own `<repo>/.task-doer/<role>.md` wins over the configured file; this stays.
- Config is camelCase JSON with `#[serde(default)]` fields. Tokens are one keychain entry per source plus the agent credential, read once per launch.

## Approaches considered

Structure:
- **A. Wizard plus Basics / Advanced (chosen).** Short path for newcomers, nothing lost for power users.
- B. One page with a "simple mode" switch. Less work, but two views of the same fields and no guided first run.
- C. Config file only. Fine for power users, not sellable.

Instructions mechanism:
- **1. Add the instructions to the prompt text (chosen).** Works for every CLI and needs no command edits.
- 2. Pass them through the `{system_prompt}` flag. Depends on each CLI's flag and on commands that the presets do not use.
- 3. Write `AGENTS.md` / `CLAUDE.md` into the repository for the run. Touches the user's repository and can leave files behind.

## Design

### First-run wizard

Shown at launch when there are no git sources. Skippable ("I'll set it up myself", which opens Settings); a skip is remembered in `localStorage` so it does not return every launch. "Run setup again" in Settings reopens it.

1. **Connect.** Provider (GitLab or GitHub), base URL (prefilled with `https://gitlab.com` or `https://github.com`), token, a name derived from the host. A short hint states the token scopes needed. Continue stays disabled until `test_connection` succeeds. The source and token are saved the way `handleAdd` does today (token to the keychain first, config second, token removed again if saving fails).
2. **Agent.** New backend command `detect_agent_clis() -> Vec<DetectedAgent { id: "claude" | "codex", path }>` looks for `claude` and `codex` on the app's PATH (the login-shell PATH is already merged at startup). Detected ones appear as selectable cards; choosing one fills the worker, reviewer, plan and description commands from the preset and stores `agent.preset`. If none is found the step says so and offers "Custom command", which opens Advanced, Agent commands. The existing "Test agent" action is available here.
3. **Done.** Summary of what was set up and a button to the task list.

Presets move from `AgentCommandsSection.tsx` to `src/lib/agentPresets.ts` and are used by both the wizard and Settings.

### Settings page

Basics, always visible:
- **Connections:** list, add, remove, test.
- **Agent:** preset choice (cards as in the wizard) and "Test agent". Picking a preset overwrites the four commands; if they currently differ from the stored preset (hand-edited), ask for confirmation first. Prompt files, usage regex and the credential are not touched. The API key and its environment variable name stay in Advanced (most CLI users are already logged in).
- **Instructions:** see below.
- **Branches:** base branch.

Advanced, collapsed by default (remembers its open state):
- Agent commands (worker, reviewer, plan, description), prompt files, usage regex, timeout.
- Test command, auto-fix attempts, reviewer gate, parallel runs.
- Branch, commit and merge request templates.
- Per-source and per-project overrides.
- IDE command, history retention.
- **Project checkouts:** per project "use my own checkout" with a folder picker (the existing local-repos mapping, moved here). Without an entry the app-managed clone is used.

New config field: `agent.preset: String` (`"claude"`, `"codex"` or empty for a custom setup), `#[serde(default)]`. It tells the ready check which binary to look for. It is written when a preset is picked and cleared (set to empty) when any of the four commands is edited so that it no longer matches the preset. For an existing config with empty `preset`, the UI infers the preset from the command text (as `AgentCommandsSection` does today) and stores it the next time settings are saved; until then the ready check skips the CLI lookup, as it does for custom setups.

### Agent instructions

- Two scopes: **global**, and **per project**. A project scope is identified by source id plus project path (the same path on two sources is two scopes). Both scopes apply to the worker, reviewer and plan roles. They do not apply to the description or diagram agents.
- Stored as files in the app config dir: `instructions/global.md` and `instructions/projects/<slug>-<hash>.md`, where the hash is computed from the source id and the project path with the same hashing `managed_repo_dir` uses, so two different paths that slugify alike never share a file. The scope arrives as `{ sourceId, projectPath }` and is only ever turned into a file name through that function, never joined into a path.
- Commands: `get_instructions(scope)`, `set_instructions(scope, text)` (maximum 50,000 characters, otherwise an error) and `read_text_file(path)` which returns the content of a chosen `.md` or `.txt` file (UTF-8, at most 256 KB) so the UI can show it in the editor; nothing is saved until the user presses Save.
- UI: a markdown textarea for the global instructions with "Import file...", and a list of known projects (from the task list's projects) with the same editor per project.
- Composition: for the worker and plan prompts, add a section `## Instructions from the user` after the repository section; for the reviewer prompt, add it before the part that states the required `VERDICT:` line, so the user's text cannot override that contract. The section holds the global text, then `### For this project` and the project text. Both are included; a project text does not replace the global one. Empty text adds nothing. Redo runs (with feedback, including auto-fix and reviewer-gate redos) use the same prompts and so get the same instructions.
- `AGENTS.md`, `CLAUDE.md` and skills in the repository or the user's home are read by the CLIs themselves and are not touched. `<repo>/.task-doer/<role>.md` keeps working as before.

### Ready-to-run check

New command `check_ready(source_id) -> ReadyReport { items: Vec<{ id, ok, message }> }` with these items: token present for the source; worker command set; the CLI for `agent.preset` found on PATH (skipped when `preset` is empty). A configuration with a custom worker command and no preset counts as ready. Plan runs additionally need a plan command: the item for it only disables the plan button, not Run. The task list shows a banner listing what is missing with a button to the right place (wizard step, Settings), and disables Run with the reason as its tooltip until the items pass. No folder item: a missing local folder is not an error.

### Errors

- Failed connection test in the wizard: show the existing distinct errors (auth, timeout with the VPN hint) and keep the form values.
- `detect_agent_clis` failure: treat as "none detected".
- Instruction save errors are shown next to the editor and the text is kept.

### Tests

- Rust: scope to path mapping rejects traversal and odd names; size limits; the prompt builders include the instructions section in the right order and omit it when empty; `detect_agent_clis` with a temporary PATH containing fake executables; `check_ready` items.
- Frontend: wizard step flow and the continue gate on a passing test; skipping; Settings shows the old sections under Advanced; instructions import fills the editor without saving; the ready banner and disabled Run.

## Calls made without the user

- Existing configs are never migrated or rewritten; the wizard appears only when no source exists.
- Folder mapping is moved to Advanced and defaults to the managed clone.
- One instructions text per scope applies to worker, reviewer and plan (no per-role instructions).
- Instructions live as files in the app config dir, not in the user's repo and not in `config.json`.
- A small `agent.preset` field is added rather than guessing the CLI from command text; it is cleared when the commands are edited away from the preset, and backfilled from the command text for existing configs.
- The API key and its environment variable name stay in Advanced, not Basics.
- Per-project instructions are keyed by source id plus project path, stored under a hashed file name.
- The reviewer gets the instructions before its `VERDICT:` contract. Redo runs get them too.
- The wizard asks for no instructions; they are in Settings.

## Left to the builder

- Exact wording of hints and messages, layout details, and how the Advanced section remembers its state.
- Whether the ready check runs on a timer or on page focus.
- How the project list for per-project instructions is gathered (from cached tasks or from run history).
