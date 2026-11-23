# Prism's Window

Prism opens in the terminal or in a window of its own. Both run the same engine: sessions, settings, commands, permissions and the sandbox are shared, and a session started in one can be resumed in the other.

## Open the window

```bash
prism --gui     # open the window for this launch
prism --tui     # open the terminal interface for this launch
prism           # follow the "Open Prism in" setting
```

The first launch where the window can open asks once: **In its window** or **In the terminal**. Choosing the window adds Prism to your applications menu. **/settings › Interface › Open Prism in** changes the choice later (the `openIn` setting, `"terminal"` or `"window"`, global only).

The window opens on the folder Prism was started from. Started from the applications menu, it gets your login shell's `PATH`, so the agent finds the same programs as in a terminal.

## Requirements

- Linux x64 with a graphical session (Wayland or X11) and glibc 2.39 or newer (Debian 13, Ubuntu 24.04, Fedora 40 and later).
- WebKitGTK 4.1 with GTK 3: `libwebkit2gtk-4.1-0` on Debian and Ubuntu, `webkit2gtk4.1` on Fedora, `webkit2gtk-4.1` on Arch. The `.deb` and `.rpm` packages install it.

Without a display, without WebKitGTK, or when the window cannot start, Prism says why and opens in the terminal. When WebKitGTK is missing, it prints the command that installs it on your distribution.

## What the window adds

The window offers the terminal's features with its own layout:

- a side menu with your conversations, a search over past sessions, scheduled tasks, sub-agents, memory, logs and the operation trace;
- dialogs for permissions, settings and logins in place of the terminal's menus;
- a file browser, readers for documents and `/docs`, and files attached with a button or dropped on the window;
- **Link a phone**, to pair the [Android app](phone.md).
- zoom with `ctrl+plus`, `ctrl+minus` and `ctrl+0`, or **Settings › Window › Text size**; the window remembers the zoom, its size, its position (outside Wayland) and whether it was maximized.

Slash commands work as in the terminal.

## Troubleshooting

- The window does not open: its messages are in `~/.prism/agent/gui.log`. `prism --tui` opens the terminal, which needs neither a display nor WebKitGTK.
- `PRISM_GUI_BINARY` points Prism at another window program, for development builds.
- See [Diagnostics](doctor.md) for `/doctor` and how to report a problem.
