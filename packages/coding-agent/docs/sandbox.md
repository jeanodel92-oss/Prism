# Sandbox

Prism runs the shell commands of the agent in a sandbox built with [bubblewrap](https://github.com/containers/bubblewrap) (`bwrap`), a seccomp filter and a network proxy of its own. A command in the sandbox can change only the project, cannot read your keys and credentials, and reaches only the network hosts you allow.

The sandbox works together with the [permission gate](permissions.md): the gate decides whether a call runs, the sandbox limits what a command can do once it runs.

## When commands run in the sandbox

By default, commands run in the sandbox in the `safe`, `ask` and `broad` [permission modes](permissions.md#modes), and outside it in `unrestricted`. **/settings › Permissions & sandbox › In modes** changes this for each mode, including turning it on for `unrestricted`.

The sandbox covers:

- the `bash` tool and background commands started by the agent;
- your own `!` commands only when **Your ! commands in the sandbox** is on (off by default: they run as you).

It does not cover:

- the file tools (`read`, `write`, `edit`, `grep`, `find`, `ls`): they run in Prism's own process and the permission gate judges each path (protected paths, writes outside the project);
- commands listed under **Run outside the sandbox** (`sandbox.excludedCommands`, such as `docker`), which still go through the permission gate;
- the `sudo` tool, which runs as root outside the sandbox after your approval (see [Controlled sudo](permissions.md#controlled-sudo));
- extensions, MCP servers, language servers and the browser extension: they run outside it, with your account's permissions;
- anything in `unrestricted` mode, unless you turned the sandbox on for it.

## Requirements

The sandbox needs `bwrap` on the system:

```bash
sudo dnf install bubblewrap      # Fedora
sudo apt install bubblewrap      # Debian, Ubuntu
sudo pacman -S bubblewrap        # Arch
```

The `.deb` and `.rpm` packages install it with Prism. When `bwrap` is missing or fails, Prism says why at startup and the agent's shell commands **stay blocked**: nothing falls back to running outside the sandbox. Install it, or turn the sandbox off for the current mode in **/settings › Permissions & sandbox**, with the risk that implies.

On Ubuntu 24.04 and later, AppArmor blocks the user namespaces bubblewrap needs unless a profile allows them. Prism's error message then gives the command that writes and loads such a profile.

## What a sandboxed command can do

| | Inside the sandbox |
|---|---|
| Write | The project folder, a private `/tmp` for the session, the package managers' caches (`~/.npm`, `~/.cache`, `~/.cargo/registry`, `~/go/pkg`) through a layer of their own, and the paths you add under **Writable paths** (`sandbox.allowWrite`). Prism's project configuration (`.prism/`), Git hooks and Git configuration stay read-only. In `safe` mode, the project is read-only too. |
| Read | With **What the agent reads** set to `project` (default): the project, what its tools need, and the paths you add under **Also readable**. The rest of your home folder, other accounts and mounted disks are not visible. With `all`: everything except the hidden paths. |
| Hidden | Prism's own folder (`~/.prism`, with its credentials and permissions), the phone link's keys, SSH, GnuPG, cloud and Git credentials, package-registry tokens, browser and mail profiles, keyrings and password stores, the system journal, crash dumps and local mail, plus the paths you add under **Hidden paths** (`sandbox.hide`). In `safe` mode, the project's own secret files (`.env`, keys) are hidden too. |
| Processes and sockets | A separate process space: Prism and your other programs are not visible. The session bus, the keyring, the compositor and the system D-Bus are closed; the seccomp filter refuses Unix sockets. |
| Network | No direct network. Connections go through Prism's proxy, which lets through only the hosts you allowed. A host never seen before asks you (**Ask for new hosts**); **Blocked hosts** never pass. A port of this machine (`localhost:5432`) or Git over SSH (`ssh://github.com`) opens only when you allow it. Without an interactive UI, a host that would ask is refused. |
| Environment | Variables that look like keys, tokens or passwords, identity-agent sockets such as `SSH_AUTH_SOCK`, and any variable holding a key Prism stores are removed from the agent's commands, in the sandbox or not. See [Secrets](security.md#secrets). |

Each network question offers to allow a host for the command, for the session or for the project; see [Permissions](permissions.md#what-gets-gated-in-ask-mode) for how those approvals are kept and taken back.

## Opt-in access

These switches in **/settings › Permissions & sandbox › Commands** are off by default:

| Switch | Setting | What it allows |
|---|---|---|
| Git signs with my key | `sandbox.gitSigning` | Git in the sandbox signs commits and tags with your signing key. Prism signs outside the sandbox; the key never enters it. |
| Commands see my containers | `sandbox.containers` | List your Docker or Podman containers and images (`docker ps`, `docker images`), read only. |
| Commands read the state of services | `sandbox.serviceState` | Read service state over D-Bus (`systemctl status`, `is-active`, `list-units`), without changing services or reading their configuration. |
| Commands as root (sudo) | `sandbox.sudo` | The `sudo` tool; see [Controlled sudo](permissions.md#controlled-sudo). |

## See and change the sandbox

`/sandbox` opens **/settings › Permissions & sandbox** on the sandbox's state: whether it works, the writable and hidden paths, and the allowed hosts. Without an interactive UI, it prints the same summary.

The settings live in the `sandbox` object of the global `settings.json` (`~/.prism/agent/settings.json`). A project's settings, the model and `configure_prism` cannot change them. If that file cannot be parsed, no tool runs until you fix it.

```json
{
  "sandbox": {
    "modes": { "safe": true, "ask": true, "broad": true, "unrestricted": false },
    "allowWrite": ["~/.local/share/pnpm"],
    "hide": ["~/Documents/private"],
    "network": { "askNewHosts": true, "allow": ["registry.npmjs.org", "*.github.com"], "deny": [] },
    "excludedCommands": ["docker"],
    "userCommands": false,
    "read": { "limit": "project", "allow": ["~/Documents/specs"] }
  }
}
```

## Limits

- The sandbox confines commands, not Prism itself. Extensions, MCP and language servers, and the file tools run with your account's permissions; the permission gate's path rules are pattern checks, not isolation.
- An allowed host is allowed for what the command sends there. The proxy does not inspect what an allowed program does with its connection.
- The sandbox shares the kernel with your system. For a stronger boundary around the whole Prism process, see [Isolate Prism](containerization.md).
