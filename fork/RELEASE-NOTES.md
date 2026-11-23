# Prism release notes

What changed in each version of Prism, for the people who use it. `prism update`, `/changelog` and the
site show these notes. Earlier versions (before 1.0.0-fork.12) were private previews.

## [Unreleased]

## [1.0.0-fork.12.2] - 2026-11-23

### Added
- `prism auth login <provider>` and `prism auth logout <provider>` sign in to a provider or save an API key,
  and sign out, from the shell without starting a session (for example on a server over SSH).
- Select text in the terminal prompt with shift+arrows, shift+Home/End and ctrl+shift or alt+shift+arrows;
  typing or pasting replaces the selection, and ctrl+x copies it.
- Model settings: "Tool images", for OpenAI-compatible models. When on, an image returned by a tool (a
  screenshot, for example) stays inside the tool result instead of arriving as a separate message the model
  may take for yours. Recommended for Qwen models. Off by default, since the server must accept it
  (llama.cpp does, OpenAI's API does not).

### Changed
- `/browser setup` installs the browser extension from its store first (addons.mozilla.org, Chrome Web
  Store), so it updates itself and survives restarts, Flatpak browsers included. Loading it from a folder is
  still offered for browsers without the store.
- An extension installed from a store and older than the one Prism ships is no longer reported at every
  start, since the store updates it.

### Fixed
- Your default model opens at startup even when it is not in the model cycle list (`enabledModels`); Prism used
  to switch silently to the first model of that list.
- Inline math that wraps onto a second line inside a paragraph renders as a formula, in the terminal and the
  window.
- `ctrl+z` undoes the last change to the message you are typing, in the terminal and in the window (it used
  to send Prism to the background; that action now has no default key, except under WSL). `ctrl+y` and
  `ctrl+shift+z` redo. Pasting back the last deleted text has no default key any more; bind
  `tui.editor.yank` in `keybindings.json` if you use it. The window follows the undo and redo keys set in
  `keybindings.json`.
- A mistyped command (`/hepl`) is no longer sent to the model as a message: Prism says it is unknown and
  suggests the closest command.
- `prism --help` describes Prism, with its own variable names (`PRISM_OFFLINE`, `PRISM_PACKAGE_DIR`,
  `PRISM_SHARE_VIEWER_URL`; the `PI_*` names still work). `/share` links to a viewer on Prism's site, not
  on pi.dev.
- On a system older than glibc 2.39 (Debian 12, Ubuntu 22.04), Prism and the installer now say that the
  window needs glibc 2.39, instead of listing libraries to install that would not help. The terminal works
  from glibc 2.28, and the installer refuses an older system with a clear message.
- Started in your home folder with reading limited to the project, Prism says it in two lines with one
  thing to do, instead of a long paragraph.
- The window no longer lagged on large high-refresh screens: it used about 60 % of a CPU core while the
  home screen animated on a 2880×1800, 120 Hz display, and now uses 2 to 3 %.
- Servers added with `/login` › compatible server: a model whose name contains `/`
  (`unsloth/Qwen3-27B-GGUF`) now enters the list limited by `/scoped-models`, and so does a model a server
  starts serving later.
- llama.cpp-style servers: the fallback value of the model template's reasoning levels counts too (GLM 5.3
  Flash now offers "max"), and thinking can be turned off on Maya servers.
- deb and rpm packages: an applications-menu entry, an icon and a copyright file; the Rust licence notices
  are readable by every user.
- The terminal header shows "Prism 12.1" instead of "prism 1.0.0-fork.12.1", and the prompt reads
  "Ask Prism anything…".
- Without a model, the footer shows a dash instead of "?/0 auto", and the first screen no longer repeats the
  missing-model warning under the setup assistant.
- `/doctor` says "Cause" and "Possible cause" in plain words, and reports a selected model without a key or
  sign-in as a problem, with `/login` as the fix.
- `prism --bogus` suggests `prism --help`. `prism update` prefixes its messages with `prism update:`, and the
  installer ends with one line saying Prism is ready and how to start it.
- The installer says when `secret-tool` is missing (keys are then stored in a file readable only by you)
  and offers the command to install it.
- The AppImage opens the window when it is started from a file manager.
- Window: the cursor is in the prompt when the window opens and after a dialog closes, and Escape closes
  Settings right away.
- Window: zoom with Ctrl+plus, Ctrl+minus and Ctrl+0, or Settings › Window › Text size; the window remembers
  its zoom, size, position and whether it was maximized.
- Window: a mistyped command says it is unknown and suggests the closest one; Tab moves on from the prompt
  when there is nothing to complete; every notice can be closed.
- Window: Settings › Window shows the Prism version; narrow windows list the settings categories on one
  scrolling row.
- Android app: the pairing screen shows what it is for, and connection errors are explained in plain words.
- Security: sign-in no longer opens links that are not web addresses, including addresses supplied by MCP
  servers; a bundled network library was updated for security fixes.
- Very long sessions load again instead of failing, and starting Prism from a deleted folder shows a clear
  message.
- Pasted-text markers no longer get mixed up after deleting one, and tables no longer disappear after an
  unclosed math block.
- OpenAI-compatible servers such as vLLM no longer reject requests after all tools are turned off;
  conversation summaries are no longer cut short; brief network drops are retried and connection errors show
  their real cause.
- llama.cpp: the default address is now llama-server's current default port, 9931. Servers you already added
  keep their address.
- File search finds `./src/*.ts`, and `src/*.ts` only looks in `src` at the top of the search folder.
- `ctrl+backspace` and `ctrl+delete` delete a word in the terminal's editor.
- Full-screen terminal on Linux: a middle click pastes the primary selection, as in any terminal, and text you
  select in Prism becomes the primary selection.
- Android app: a pairing code typed on the phone's keyboard pairs even when the keyboard added spaces or
  capitals. New app icon, with a themed icon on Android 13 and newer.
- Browser extension 0.1.3: the agent's tab group is grey and its pointer is light, instead of purple.
- When the default model in your settings no longer exists or has no key, Prism says so at startup and names
  the model it uses instead.
- Servers added with `/login` › compatible server: their model list is read again at startup and after a
  "model not found" error, and added or removed models are announced once. What the server says about the
  models it still serves (thinking levels, context, images) is read again too, so a server updated to accept
  new reasoning levels offers them without being added again.
- `/login` › compatible server with a server you already added proposes its existing name, so Enter updates it
  instead of adding it a second time.
- `/browser setup` without an interface (`-p`) gives Firefox the right folder.

### Removed
- pi's hidden easter-egg commands and its unused `enableAnalytics` setting (Prism never sent analytics).

## [1.0.0-fork.12.1] - 2026-11-21

### Added
- deb and rpm packages for every stable release, installed in `/opt/prism` with the `prism` command.
  A packaged Prism leaves its updates to apt or dnf.
- AppImage for every stable release (no `libfuse2` needed). AppImage managers such as Gear Lever update it.
- The installer also checks for bubblewrap, which the command sandbox needs, and offers the command to
  install it.

### Fixed
- The sandbox's temporary cache layer was left on disk after a command that deleted a folder in a package
  cache.
- `@` completion proposed `@./--file.txt` for a file whose name starts with `-` (fd 10.5).

## [1.0.0-fork.12] - 2026-11-19

The first public release of Prism.

### Added
- The installer is signed (`install.sh.minisig`); the repository README gives the key and the command to
  check it before running it.
- Math in answers is rendered in the window and the Android app (KaTeX), with the same delimiters as the
  terminal. Prices and variables such as `$HOME` stay text.
- The Android app is available from an F-Droid repository on Prism's site (F-Droid, Droid-ify, Neo Store or
  Obtainium).
- `/update` checks for a newer Prism, installs it when you ask, switches between the stable and canary
  channels, and goes back to the previous version. An "Updates" setting chooses manual (the default: Prism
  asks its site nothing), notify, or automatic.
- The Android app can check for updates too, on request or at startup.
- The browser extension is published on addons.mozilla.org and the Chrome Web Store, and Prism tells you
  when the installed extension comes from another version.
- A canary channel: test versions at major development steps, signed with their own key, which can never
  pass for a stable release.

### Changed
- Without a chosen permission mode, Prism starts in broad mode: it works in the project without asking,
  and asks before leaving it, before `sudo` and before a dangerous call.
- The model no longer presents itself as a coding-only assistant, and knows your computer (system, desktop,
  CPU, memory, free disk space, shell). This module can be turned off.
- Licence: Prism's own code, and Prism as distributed, are GPL-3.0-or-later; the pi code it is built on
  stays MIT. Every release ships `LICENSE`, `LICENSES/` and the notices of its Rust, Java and Kotlin
  libraries.
- The Android app scans QR codes with ZXing instead of Google's ML Kit: it works without Google services and
  contains no non-free component.
- A model retired by its provider leaves `/model` as soon as the provider's catalog stops listing it.

### Fixed
- Security: a review of the permission checks closed many ways for a command to run code or write without a
  question (`awk`, bash arithmetic, a changed `PATH`, `man`, Git configuration that runs a program, Plan mode
  test runners). Other fixes:
  - **Sandbox.** It no longer lets a command:
    - rewrite shared package caches;
    - read the system journal;
    - open `vsock` sockets;
    - hide its changes from `git status`;
    - plant a Git repository whose configuration runs a program;
    - change the browser extension's files.
  - **Network.** Allowed names that lead to private addresses ask again and show the address. Blocking an
    address also blocks every name that leads to it.
  - **What permission questions show.** Terminal escape sequences and invisible characters in a command or
    path are shown as `<U+XXXX>`, so they can no longer hide part of the question.
  - **Hidden keys and project secrets.** They stay hidden from reads, edits and sandboxed commands, and
    some thirty common credential files are protected like `.env`.
  - **Robustness.** Huge images, very long stream lines and a phone that stops reading can no longer exhaust
    memory or freeze Prism.
- Window: very long conversations open fast and stay light (about 320 MiB and 2.4 s at 20,000 messages).
- Published binaries no longer contain the build machine's paths.
- Claude models through a Claude Code subscription show their reasoning summaries again.
