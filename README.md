# Abracadabra

A desktop app that turns assigned GitLab/GitHub issues into reviewed, ready-to-push branches:
fetch your assigned issues, run an automated worker/reviewer coding-agent pipeline against them on
a new branch in your project folder, and approve/discard/redo the result from the UI.

See [project.md](project.md) for the full project idea and [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)
for the phased build plan (this repo is being built phase by phase against that plan).

Stack: [Tauri](https://tauri.app/) (Rust backend) + React/Vite (TypeScript frontend).

## Prerequisites

- [Node.js](https://nodejs.org/) (v20+) and [pnpm](https://pnpm.io/)
- [Rust](https://www.rust-lang.org/tools/install) (stable toolchain, via `rustup`)
- Platform build tools required by Tauri — see the [Tauri prerequisites guide](https://tauri.app/start/prerequisites/)
  (on macOS: Xcode Command Line Tools, `xcode-select --install`)

## Getting started

```bash
pnpm install
pnpm tauri dev
```

This opens the app in a native window with hot-reload for both the frontend (Vite) and backend
(Rust — recompiles and restarts automatically on changes under `src-tauri/`).

## Other commands

| Command | Description |
| --- | --- |
| `pnpm tauri dev` | Run the app in development mode (hot-reload) |
| `pnpm tauri build` | Build a release bundle/installer for the current platform |
| `pnpm build` | Type-check (`tsc`) and build the frontend only (`dist/`), no Tauri bundling |
| `pnpm dev` | Run just the Vite dev server (frontend only, no native window) |
| `pnpm test` | Run the frontend tests (Vitest) |

Rust-only checks (from `src-tauri/`):

```bash
cargo check   # compile-check the backend
cargo test    # run unit tests (keychain round-trip test is #[ignore]d by default,
              # run with `cargo test -- --ignored` to exercise the real OS keychain)
```

The built app is `src-tauri/target/release/bundle/macos/Abracadabra.app` (unsigned; right-click and
choose Open the first time). `.gitlab-ci.yml` runs the checks on every push and builds the bundle
on tags (needs a runner tagged `macos`).

## Project layout

```
src/                      React/Vite frontend
  views/                  Page-level views (Settings, TaskList, TaskRun) routed via react-router-dom
  components/             Reusable UI components (AppShell nav/theme shell, etc.)
  lib/                    api.ts (typed `invoke` wrappers), useConfig.ts, theme.ts

src-tauri/src/            Rust backend
  commands/                Tauri command groups (config.rs, providers.rs, runs.rs)
  config.rs                AppConfig schema + load/save (JSON in the Tauri app-config dir)
  secrets.rs                OS keychain-backed token storage (via the `keyring` crate)
  git/                      git CLI wrapper (clone/fetch/worktree/commit/diff) — stub, Phase 2
```

## Configuration & secrets

App config (git sources, agent command templates, branch/commit templates, timeouts) is persisted
as JSON under the OS-specific Tauri app-config directory (e.g. `~/Library/Application Support/Abracadabra`
on macOS). Git source **tokens are never written to that file** — they're stored per-source in the
OS keychain (Keychain on macOS, Credential Manager on Windows, Secret Service on Linux) via the
`keyring` crate, and the frontend never receives the raw token back from the backend.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

