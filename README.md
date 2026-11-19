# Prism

Prism is an AI agent harness for Linux: a coding agent in the terminal, the same agent in a desktop window, and a phone
app that drives it from your phone. It works with the model providers you choose, local servers included, and keeps
what the agent does inside permissions and a sandbox you control.

Prism is a fork of [pi](https://github.com/earendil-works/pi) 1.0.0 by Earendil Works. The pi packages it is built on
are in this repository, with Prism's changes.

Website: <https://prism.odelserver.space>

## What it does

- **Terminal and window.** The terminal interface and the desktop window (Tauri) run the same engine and share
  sessions, settings and commands.
- **Phone app.** The Android app is a window on the Prism of your computer, over your local network or Tailscale, with
  no server in between.
- **Permissions and sandbox.** Each tool call is judged by a permission mode; commands run in a bubblewrap sandbox
  that limits what they can read, write and reach on the network.
- **Any model.** No provider or model is built in as a requirement: use any provider pi supports, or a local
  OpenAI-compatible server.
- **Your browser and desktop, when you allow it.** A browser extension (Firefox, Chrome) and a desktop of its own let
  the agent use a browser or graphical programs, within the same permissions.
- **Updates.** Stable releases, and canary builds for those who want each change early.

## Install

Linux x64:

```bash
curl -fsSL https://prism.odelserver.space/install.sh | sh
```

The installer checks each release's signature before installing it. The Android app is offered on the website and in
an F-Droid repository.

## Build from source

Requirements: Linux, Node.js 22.19 or newer, npm, git, and `fd` and `ripgrep` on the system for the tests.

```bash
npm ci --ignore-scripts
./pi-test.sh                       # run Prism from the sources
npm run check                      # lint, format and type checks
./test.sh                          # tests, isolated from your own configuration
fork/scripts/install-local.sh      # build and install for the current user
```

## Repository layout

| Path | What it holds |
|---|---|
| `packages/` | The pi packages (AI providers, agent core, terminal UI, coding agent) with Prism's changes; Prism's own modules are in `packages/coding-agent/src/fork/` |
| `fork/gui/` | The desktop window |
| `fork/android/` | The Android app and the phone link |
| `fork/host/` | The host shared by the window and the phone server: engines, sessions, file transfers |
| `fork/desktop-helper/` | Helpers in C for the agent's desktop and the desktop portal |
| `fork/scripts/` | Installer, local install, release and canary builds |
| `fork/tools/` | Development tools: fake provider, terminal driver, release tests |

## Licence

Prism's code is under the GNU General Public License, version 3 or later. The code that comes from pi keeps its MIT
licence. `REUSE.toml` says which applies to each file; the licence texts are in `LICENSES/`.
