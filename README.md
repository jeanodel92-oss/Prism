# Prism

Prism is a free and open source coding agent for Linux, for local or remote models. It runs in your terminal, in a
window of its own, and from the Prism app on your Android phone, and keeps what the agent does inside permissions and
a sandbox you control.

**Platforms.** Linux x64 only: there is no version for macOS, Windows or ARM computers. The phone app exists on
Android only (arm64, Android 7 or newer); there is no iOS app.

Prism is a fork of [pi](https://github.com/earendil-works/pi) 1.0.0 by Earendil Works. The pi packages it is built on
are in this repository, with Prism's changes. Prism is not affiliated with Earendil or pi's maintainers.

Website: <https://prism.odelserver.space> · Documentation: [`packages/coding-agent/docs/`](packages/coding-agent/docs/index.md),
also `/docs` inside Prism · Issues: this repository's issues · Security: [SECURITY.md](SECURITY.md)

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
prism            # then /login inside Prism to connect a model provider
```

The installer checks each release's signature before installing it. `prism update` installs the latest release and
`prism update --rollback` goes back to the previous one; replace `sh` with `sh -s -- --uninstall` to uninstall.

To check the installer itself before running it, with [minisign](https://jedisct1.github.io/minisign/) and the
release key given here (the same as in `fork/scripts/install.sh`), not by the website:

```bash
curl -fsSLO https://prism.odelserver.space/install.sh
curl -fsSLO https://prism.odelserver.space/install.sh.minisig
minisign -Vm install.sh -P RWQHj1LfelCE8N3pmVRt9kJcLo18AA41Gm8c7heF0irUFX2+UNOKpPHf
sh install.sh
```

### Other channels

The [download page](https://prism.odelserver.space/downloads/) gives each command.

| Channel | How |
|---|---|
| Canary (one build per passing commit, can break) | `curl -fsSL https://prism.odelserver.space/install.sh \| sh -s -- --channel canary`; back with `prism update --channel stable` |
| Debian, Ubuntu | Signed apt repository `https://prism.odelserver.space/apt`, then `sudo apt install prism` |
| Fedora | Signed dnf repository `https://prism.odelserver.space/rpm/prism.repo`, or COPR `jeanodel92/prism`, then `sudo dnf install prism` |
| openSUSE | openSUSE Build Service repository `home:Jeanodel92` (Tumbleweed, Leap 16.0), then `sudo zypper install prism` |
| Arch Linux | Signed pacman repository `https://prism.odelserver.space/arch/$arch`, then `sudo pacman -Syu prism` |
| AppImage | One file, nothing to install; needs FUSE 3 |
| Browser extension | [Firefox (addons.mozilla.org)](https://addons.mozilla.org/addon/prism-browser/), [Chrome Web Store](https://chromewebstore.google.com/detail/prism/oinfdnajckegicaemkaobancehobeghe) |
| Android app | F-Droid repository `https://prism.odelserver.space/fdroid/repo` (fingerprint `243AE77A78F2809378D26DA9A5BE865F155D49035A141CEFFE0BC0E0FCCC795C`), Obtainium, or the APK on the download page |

Packages from a system repository are updated by the system's package manager; `prism update` leaves them to it.
There is no Flatpak: its sandbox keeps Prism from building its own and from running your tools.

### Requirements

- glibc 2.28 or newer for the terminal; 2.39 for the window and the phone link (Debian 13, Ubuntu 24.04, Fedora 40
  and later). musl systems such as Alpine are not supported.
- bubblewrap, for the sandbox. Without it, the agent's commands stay blocked unless you turn the sandbox off.
- WebKitGTK 4.1 with GTK 3, for the window. Without it, Prism opens in the terminal.
- labwc for the agent's own desktop, and libei and PipeWire to let the agent use your desktop under GNOME or KDE: both
  off by default.

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
