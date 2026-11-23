# Run Prism safely

Treat model-generated commands and code as untrusted. Prism reads, changes and runs files for the account that started it. Two protections limit what a generated action can do:

- The [permission gate](permissions.md) decides whether each tool call runs. In the default `broad` [mode](permissions.md#modes), the agent works in the project without asking, and asks before reaching outside it, before `sudo`, and before calls it detects as dangerous.
- The [sandbox](sandbox.md) confines the agent's shell commands in the `safe`, `ask` and `broad` modes: they can change only the project, cannot see Prism's credentials or your keys, and reach only the network hosts you allow.

Files, comments, instructions, command output, web pages and model responses can steer the model through prompt injection. Prism's [injection warning](permissions.md#prompt-injection-warning) pauses the agent on suspicious tool results; it reduces the risk without removing it. Project trust controls which project resources load at startup, but it does not make that content or the resulting actions safe.

## What the protections do not cover

- **Prism's own process.** Extensions, MCP servers, language servers and the file tools run with your account's permissions, outside the sandbox. The permission gate's path rules are pattern checks, not isolation.
- **`unrestricted` mode.** It asks nothing, and its commands run outside the sandbox unless you turn the sandbox on for it.
- **What you allow.** A command you exclude from the sandbox, the `sudo` tool, a host you allow, or an action you approve does what it does.

## Choose how to run Prism

| How Prism runs | What remains protected |
|---|---|
| Directly, with the sandbox on (default in `safe`, `ask` and `broad`) | The agent's shell commands cannot change files outside the project and its caches, cannot read the hidden paths, and reach only allowed hosts. Prism itself, its extensions and the file tools still run with your account's permissions. |
| Directly, without the sandbox | Only what your operating-system user cannot access. A dedicated user account can narrow those permissions. |
| Entirely inside a container or virtual machine | Host files and processes that you do not expose to the environment. Credentials and network services remain accessible if you make them available inside it. This also confines Prism's own process and its extensions. |

The working folder controls resource discovery and the default location for tools. Without the sandbox, it does not prevent commands from reaching other paths available to the Prism process.

Whichever option you choose, only provide the files and services required for the task, prefer narrowly scoped, short-lived credentials, and allow only the network hosts a task needs. For containers and virtual machines, see [Isolate Prism](containerization.md).

<a id="secrets"></a>

## Secrets

- **Where credentials are kept.** A credential you add with `/login` goes to your system keyring (Secret Service, through libsecret's `secret-tool`) when one works; `auth.json` then keeps only a marker. Without a keyring, it goes to `~/.prism/agent/auth.json` (mode `0600`), with a warning, and `/doctor` reports it. A locked keyring is not treated as missing: nothing is written, and Prism asks you to unlock it. `PRISM_SECRET_SERVICE=off` turns the keyring off. Keys already in clear in `auth.json` stay there until you move them with **Move credentials to the keyring** in `/settings`.
- **What the agent's commands see.** Environment variables that look like keys, tokens or passwords, identity-agent sockets such as `SSH_AUTH_SOCK`, and any variable holding a key Prism stores are removed from the agent's commands, in the sandbox or not; their values are never shown. Your own `!` commands keep your environment. To pass a variable to one command, add a rule in **Variables hidden from commands** in `/settings` (`"secrets": { "passEnv": { "GITHUB_TOKEN": ["bash(gh *)"] } }` in the global `settings.json`). The `secrets.envAllowlist` setting goes further: commands then get only known, harmless variables and the ones you list in `secrets.allowEnv`.
- **What leaves Prism.** Keys Prism stores are masked as `[secret hidden: …]` in what it sends to the model, in sessions, exports, shares, traces and `/doctor export`.
- **What the sandbox hides.** Commands in the sandbox cannot read `~/.prism` (credentials, permissions, trust) nor the usual credential locations; see [Sandbox](sandbox.md#what-a-sandboxed-command-can-do).

The model can never change the permission mode, permission rules, trust decisions, the `sandbox` and `secrets` settings, or stored credentials, in any mode.

<a id="privacy"></a>

## Privacy

Prism sends no telemetry: no install, update or usage report, and no analytics. It connects on its own only to:

- the model providers and servers you configure, for each request;
- `https://pi.dev`, to refresh the cloud model catalog of the providers you signed in to, at most every 4 hours (turn it off with **Update the model catalog** in `/settings`, or `"modelCatalogRefresh": false`);
- `https://prism.odelserver.space`, only when you run `/update` or `prism update`, or when the `updateMode` setting asks it to check at startup (off by default);
- GitHub, to download `fd` or `rg` the first time a tool needs one that is not installed.

Other connections follow an action of yours: `/login`, web tools, MCP servers, package installs, `/share`, the phone link. `--offline` (or `PI_OFFLINE=1`) turns off the automatic ones.

**Sign in with ChatGPT** sends OpenAI a random identifier of this installation (`deviceId`, a UUID kept in the global `settings.json` and created at the first such sign-in), as the `ext_agent_host_id` parameter of the authorization address. It links the ChatGPT sign-ins made from the same installation. It is not sent with model requests or token refreshes. Deleting `deviceId` from `settings.json` makes the next sign-in create a new one.

<a id="project-trust"></a>

## Understand project trust

Project trust controls whether Prism loads most settings and resources supplied by a working folder. It prevents a folder from silently loading executable extensions before you approve it.

Project trust is not a complete startup boundary. Prism reads the project `sessionDir` setting while selecting or creating a session, before it resolves project trust. Declining trust prevents the remaining project settings and protected resources from loading, but it cannot undo that initial session-directory lookup.

Project trust does not limit what tool calls can access or affect. After Prism starts, enabled tools still use the operating-system permissions of the Prism process. Instructions and other content in the folder can also influence the model.

### Resources protected by project trust

Prism requires a project-trust decision when it finds any of these resources from the current working directory:

- `.prism/settings.json`
- `.prism/mcp.json`
- `.prism/extensions`, `.prism/skills`, `.prism/prompts`, or `.prism/themes`
- `.prism/SYSTEM.md` or `.prism/APPEND_SYSTEM.md`
- project `.agents/skills` in the current directory or an ancestor directory

A bare `.prism` directory does not require project trust.

Granting project trust allows Prism to load:

- project settings
- project MCP servers from `.prism/mcp.json`
- extensions, skills, prompt templates, themes, and system-prompt files under `.prism`
- missing packages configured through project settings
- project-local and project-package extensions

Declining project trust skips those protected resources, except for the initial `sessionDir` lookup described above.

Context files such as `AGENTS.override.md`, `AGENTS.md`, and `CLAUDE.md` load regardless of project trust unless you disable context loading. Treat instructions in a folder as untrusted input even when you decline project trust.

### How Prism chooses a trust decision

A command-line `--approve` or `--no-approve` override applies first. When protected resources exist and there is no command-line override:

1. User-level and command-line extensions can handle the `project_trust` event. The first extension that returns yes or no owns the decision.
2. If no extension decides, Prism looks for a saved decision for the current directory or one of its parents. The closest decision applies.
3. If no saved decision applies, Prism follows the global `defaultProjectTrust` setting, whose default is `"ask"`.

Saved decisions use canonical directory paths and live in:

```text
~/.prism/agent/trust.json
```

Use `/trust` to save a decision for future Prism processes.

### Project trust without an interactive prompt

Print, JSON, and RPC modes cannot show the built-in trust prompt. If no command-line override, extension, or saved decision applies:

- `defaultProjectTrust: "always"` loads protected project resources.
- `defaultProjectTrust: "ask"` or `"never"` skips them.

Use `--approve` or `--no-approve` when an automated run needs an explicit one-time decision.

## Reduce impact and improve recovery

These practices do not replace isolation, but they reduce exposure or make recovery easier:

- Give Prism access only to files and services required for the task.
- Use snapshots, backups, or version control before substantial changes.
- Review extensions and packages before loading them. Extensions execute inside the Prism process.
- Prefer narrowly scoped, short-lived credentials.
- Review diffs and generated output before applying results to another system.
- Review sessions before exporting or sharing them. They can contain prompts, tool arguments, command output, file contents, and credentials exposed during the conversation.

## Report a security issue

Report a vulnerability privately, through the **Report a vulnerability** button in the Security tab of Prism's repository, as its [security policy](../../../SECURITY.md) (`SECURITY.md` at the root of the repository) says. The [Source code](https://prism.odelserver.space/source/) page of Prism's site links to the repository. Do not open a public issue for a security-sensitive report.

The policy lists what Prism guarantees (sandbox, permissions, secrets, network rules, rendering, folder trust, phone link, browser extension and desktop, signed updates) and what is out of scope: `unrestricted` mode and actions you approved, prompt injection that stays within what the current mode allows, extensions and packages you install, and the behavior of model providers.

For other defects, see [Report a problem](doctor.md#report-a-problem).
