# Updates and Channels

## Update Prism

```bash
prism update              # install the latest release
prism update --check      # only say whether a newer release exists
prism update --rollback   # go back to the previous release (again: undo)
```

Each update downloads the release from `https://prism.odelserver.space`, checks the minisign signature of its `SHA256SUMS` list, then the archive, switches to the new release in one step and keeps the previous one. It then shows the release notes.

Inside Prism, `/update` does the same from the terminal or the window: it checks, then offers to install the newer release, switch channel or go back to the previous version. The running version keeps going; the new one opens at the next start.

`prism update --models` only refreshes the cloud model catalog, `prism update --extensions` only the installed packages, `prism update --all` Prism and the installed packages. See [Command Line](cli.md#update-prism-or-packages).

### Installed by a package manager

`prism update` updates only an installation made by the site's installer (`install.sh`). A Prism installed by your system's package manager (`.deb`, `.rpm`) is updated by it, with everything else; `prism update` says so and leaves it to it. An AppImage is updated by downloading the new file from the [download page](https://prism.odelserver.space/downloads/), or by an AppImage manager.

## When Prism checks on its own

By default, Prism never checks for updates on its own. The `updateMode` setting (**/settings › Other › Updates**) changes that:

| Value | At startup |
|---|---|
| `manual` (default) | Nothing; run `/update` or `prism update` |
| `notify` | Says when a newer release exists |
| `auto` | Installs it; the new version opens at the next start |

`notify` and `auto` check at most once an hour, only for an installation made by the site's installer, and never with `--offline` or `PI_OFFLINE`.

## Stable and canary channels

- **Stable** (default): validated releases.
- **Canary**: one release per commit that passes the build's checks. It can break. Canary releases are signed with a key of their own, which cannot sign a stable release; their version names the channel (`…-fork.<n>.canary.<m>`), and each start shows a warning while you are on it.

```bash
prism update --channel canary   # switch to canary and update
prism update --channel stable   # back to stable, keeping your configuration
```

To install on the canary channel from the start:

```bash
curl -fsSL https://prism.odelserver.space/install.sh | sh -s -- --channel canary
```

On canary, Prism installs the newer of the latest canary and the latest stable release.

## Uninstall

```bash
curl -fsSL https://prism.odelserver.space/install.sh | sh -s -- --uninstall
```

This removes the installed releases (`~/.local/share/prism`) and the `prism` command. Your configuration, sessions and saved credentials, in `~/.prism`, are kept.
