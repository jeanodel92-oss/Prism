# Permissions

Prism puts a confirmation gate in front of tool calls. It is always loaded:
`--no-extensions`, `--safe` and the `extensions` setting do not turn it off. Only you
change it, with `/perm` or `--perm-mode`. An extension you install that registers
`/perm`, `--perm-mode` or `--perm-yolo` replaces it. `alt+m` cycles the mode.

**This is not a sandbox.** The rules match patterns in commands and paths; they are
not a security boundary. A shell command you allow can do anything your user account
can do, including reading `auth.json` and your other files: secrets are not isolated
from the agent. For real isolation, see [Isolate Prism](containerization.md).

## What gets gated in `ask` mode

The default mode, `broad`, runs writes and commands in the project without asking;
dangerous calls still ask. See [Modes](#modes).

| Action | Behavior |
|---|---|
| `read`, `grep`, `find`, `ls` | allowed, unless the path is protected |
| safe bash: `ls`, `cat`, `grep`, `rg`, `git status/log/diff/show`, ... | allowed |
| `write` / `edit` inside the project | asks |
| other bash (`npm install`, `git push`, `rm file`, `node ...`) | asks |
| bash redirects to files | asks (outside the project: dangerous) |
| `sudo`, `rm -rf`, `curl \| sh`, `git push --force`, `npm publish`, `chmod 777`, ... | dangerous |
| writes outside the project | dangerous |
| protected paths: `.env*`, `*.pem`, `*.key`, `id_rsa*`, `.netrc`, `authorized_keys`, `.git/hooks/**`, `trust.json`, `permissions.json` | dangerous |
| writes to Prism configuration, including settings, extensions and custom agents | refused; use `configure_prism` for supported changes |
| writes to permissions, trust, credentials and other security configuration | refused; only the user can change these |
| any other tool (extensions) | asks |

A dialog says in words what each choice allows: **Allow once**, **Allow "run npm
install" for 15 minutes**, **in this session**, **in this project**, **Block this
action once**, or **Block "run npm install" in this project**. "In this project", to
allow or to block, comes back in every session on the same folder (the
real path of its Git root, each worktree on its own); it is kept in
`project-permissions.json` in the config directory, never in the project, and listed in
`/settings` › Permissions › Allowed or blocked in this project, where each one can be
taken back.
A host allowed in this project is kept for the command that asked for it ("Allow
registry.npmjs.org for "run npm install" in this project"): another program of the
project is asked about again. If it cannot be saved, the dialog says so and asks again.
A host allowed **in this session** from a command's network question is likewise tied
to that command's rule (for example, `npm install`), in the foreground or background.
Another command asks again; if no rule safely covers the command, only its exact text
is covered. Native network tools such as `web_fetch` keep their session-wide host approvals.
Allowing a command **in this project** also saves the likely hosts shown in its question
with that same rule. The next matching run needs no network question for those hosts;
removing the rule removes its hosts too. Other hosts still ask, and blocked hosts stay blocked.
Prism watches both `project-permissions.json` and global `settings.json`: removing an
allowed host closes connections that no longer have approval in every running session,
and later connections need approval again. Atomic file replacement is detected;
incomplete or invalid settings keep the last valid rules. If file watching is unavailable,
changes are detected by periodic reads (once per second).
A dangerous call offers to allow it once, to allow this exact call in this session
(never saved: a resumed session asks again; not offered for protected paths and
credentials), or to block it, and asks even in `broad` mode. `/perm window` lists what is
allowed in this session and takes it back. An unanswered dialog is denied after 3 minutes.

Without an interactive UI (`-p`, `--mode json`), anything that would ask is blocked,
unless an allow rule matches or the mode is `broad` or `unrestricted`.

## Prompt injection warning

The built-in `injection-warning` module is on by default. It checks text returned by
every tool, including files, shell commands, web and MCP tools, and nested calls,
before the next model request. Likely instruction overrides, hidden Unicode text
or chat role switches pause the agent with a warning in the terminal or Prism window.
The dialog shows the source and short excerpts with invisible characters made visible.
**Stop the agent** is the first, default choice; **Continue** sends the original result;
the third choice continues and skips further questions for that source in this session.
Stopping keeps the original result in the session too. Dismissing the dialog stops.

Without dialogs (print/JSON, or RPC without an interactive client), a warning goes
to stderr or RPC notifications and the run continues. Content is never filtered or
rewritten. `/settings` > Permissions & sandbox > **Prompt injection warning** turns
the check off immediately (`"injectionWarning": false` in global `settings.json`).
The module can also be disabled like other built-ins.

This is a **risk reduction, not a guarantee or a security boundary**. A score of 3
triggers a warning: one strong signal or three different weak signals. Neutral
discussion and ordinary instructions should not warn. Detection examines at most
the first and last 65,536 UTF-16 code units per result, and can miss disguised attacks or
attacks in the unscanned middle. Sandbox isolation and approvals remain necessary.
An exception lasts only in the running session, not after restart or reload.

## Controlled sudo

Enable **Commands as root (sudo)** in `/settings` › Permissions & sandbox, then
`/reload`. The dedicated `sudo` tool runs installed system programs as root outside
the sandbox, without a shell. It is refused in `safe` mode and without an interactive
UI. Its approval question shows the exact command in every mode, including
`unrestricted`; **Allow sudo for this session** covers subsequent sudo commands and
can be revoked in `/perm window`. This approval is memory-only and ends on session
replacement, shutdown or `/reload` (including when a window's engine sleeps).

Stopping the whole process group requires GNU coreutils `timeout`. Prism prefers
`gnutimeout` when installed (including Ubuntu 26.04) and verifies the implementation
before using sudo. A non-GNU limiter is refused; install `gnu-coreutils` or select GNU `timeout`.

Next to sudo, **Remember sudo password for 5 minutes** sets
`sandbox.sudoRememberPassword` (boolean, default `false`, global only). Like all
`sandbox` settings, a project and `configure_prism` cannot change it. When enabled,
Prism remembers an accepted password until five minutes after it was typed; using it
does not extend the window. Subsequent calls skip the masked password field but
still need approval unless sudo was approved for the session. With both, the command
runs without a question and the tool result says it used a remembered password and
session approval. A refused password, disabling the setting or sudo, expiry,
session replacement, shutdown or `/reload` drops the reference.

Each call still feeds the password through a fresh, single-use `SUDO_ASKPASS` FIFO;
`sudo -k -A` and the final `sudo -k` keep sudo's credential cache disabled. The
password never goes to the model, session, logs, traces, environment variables or
stored files; output masks it as `***`. A JavaScript string cannot be wiped, only
dereferenced. This opt-in window and session approval are the owner's D11 decision
(2026-11-05): same-user access to Prism's memory is no easier than before, but a
compromised Prism process now holds the remembered password for up to five minutes.
An in-flight command also retains its local reference until it returns.

## Task scope

Before a long task, the agent can propose what it needs (`propose_scope`): operations in
plain words ("Install the dependencies: runs npm install, connects to
registry.npmjs.org"), and a duration. You leave out lines, say whether you **stay** or go
**away**, and approve; nothing is allowed until you do. You can also set one yourself with
`/perm scope` (change the project's files, run commands in the sandbox).

While the task runs, what the scope covers passes without a question. Anything else is
asked about if you stay (with "for this task" to widen the scope), or refused at once if
you are away; you get the list of what was refused when the task ends. One refusal holds
for the whole task: the same action is refused again without a question. A scope never
covers a dangerous call, a command excluded from the sandbox or what the mode blocks. It
ends with the task (one run of the agent), at the end of its duration, or from
`/perm scope`; a background command started under it keeps its hosts until the duration
ends.

A scope limits the commands run, the files changed and the hosts sandboxed commands
connect to. It does not limit reading files outside the project (except hidden
folders), commands that run outside the sandbox, or what an allowed program does with its
connections.

## Modes

    /perm mode ask           # safe operations pass, the rest asks
    /perm mode safe          # read-only agent: anything not allowed outright is blocked
    /perm mode broad         # default: works in the project and /tmp without asking; asks for
                             # dangerous calls, reads outside the project and the first
                             # browser or desktop use; deny rules still apply
    /perm mode unrestricted  # no dialogs at all; only your deny rules apply

`broad` was called `yolo`; `yolo` is still accepted. `unrestricted` asks for nothing,
dangerous calls and writes outside the project included. You enable it once, in a
warning dialog (the choice is saved in the global `permissions.json` as
`"unrestrictedAccepted": true`), or explicitly on the command line
(`--perm-mode unrestricted`). A project's `permissions.json` cannot select it. It is still not a
sandbox: the agent can do anything your user account can.

Or for one run: `--perm-mode safe`, `--perm-mode broad` (`--perm-yolo`). The mode
chosen with `/perm mode` or `alt+m` is saved in the session and comes back when you
resume it; `/perm default <mode>` sets the mode new sessions start in.

## Commands

    /perm                      open /settings > Permissions & sandbox (without a UI: status)
    /perm window               modes and the permissions in effect
    /perm status               status
    /perm scope                task scope: set one for the next task, or end the one in effect
    /perm mode <ask|safe|broad|unrestricted>
    /perm default <ask|safe|broad|unrestricted>
    /perm allow <rule>         allow for this session
    /perm deny <rule>          deny for this session
    /perm always <rule> [-g]   save an allow rule to the project config (-g: global)
    /perm never <rule> [-g]    save a deny rule to the project config (-g: global)
    /perm rules                list session and config rules
    /perm clear                clear session rules
    /perm help

## Config

`permissions.json` in the config directory (global), and `<project>/.prism/permissions.json`
(only for trusted projects, merged over the global file):

    {
      "mode": "ask",
      "allow": ["bash(npm run test*)", "write(src/**)"],
      "ask":   ["bash(git push*)"],
      "deny":  ["bash(sudo*)", "write(.env*)"],
      "protectedPaths": ["secrets/**"],
      "tools": { "deploy": "ask" }
    }

Rule syntax: `tool` or `tool(pattern)`. Patterns are globs matched against:

- `bash`: the full command (`*` and `?` match any character);
- `read`, `write`, `edit`: the resolved path, absolute and project-relative (`*` does
  not cross `/`, `**` does);
- other tools: `JSON.stringify(input)`.

Configuration restrictions apply before mode and allow rules. For other calls,
precedence is: deny rules, then `unrestricted`, then the dangerous tier, then allow
rules, then `broad`, then ask rules and the ask tier, then the tool default. An allow
rule does not override the dangerous detection: a dangerous call asks even when an
allow rule matches it.

## Model configuration tool

Enable **config-tool** in `/settings` > Modules, then `/reload`. It is off by default.
`configure_prism` is the model's only supported way to change configuration. It changes
global settings, turns optional built-in modules on/off, and creates or replaces custom
agents. It does not install packages, edit extension/hook code or delete agents. The
`extensions` setting accepts only built-in modules (`builtin:<name>`, `+builtin:<name>`,
`-builtin:<name>`): packages and files are added by the user.

Every call shows the saved value and proposed value (`old -> new`), and asks **Allow this
change once** or **Refuse this change**. Changes that can run code show a warning about
extensions, hooks, shell commands and agent tools. No rule, task scope or `unrestricted`
mode skips this question. No answer after **120 seconds** means refusal; a late answer
does nothing. `safe` and read-only Plan mode refuse changes. This version requires the
interactive terminal: print/JSON and RPC are refused, even if RPC provides dialog transport.
Settings and modules apply after `/reload` or restart; agents apply on their next use.

For the model, use one action per call:

```json
{"action":"setting","key":"theme","value":"light"}
{"action":"module","name":"memory","enabled":true}
{"action":"agent","name":"reader","description":"Read files","tools":["read"],"instructions":"Explain the files you read."}
```

Supported setting keys: `theme`, `animations`, `replyLanguage`, `language` (`auto/en/fr`),
`interfaceMode` (`simple/advanced`), `hideThinkingBlock`, `showHardwareCursor`,
`editorPaddingX` (0–10), `autocompleteMaxVisible` (1–50), `defaultProvider`, `defaultModel`,
`defaultThinkingLevel`, `defaultTools`, `enabledModels`, `extensions`, `skills`, `prompts`,
`themes`, `shellPath`, `shellCommandPrefix`, `externalEditor`, `npmCommand`. Lists contain
strings. Custom agents take a name, description, instructions, tools and optional model.
Only optional built-in module names are accepted; the permission gate cannot be disabled.
Other settings are refused rather than guessed.

Security configuration is **user-only in every mode**, including `unrestricted`:
`permissions.json` (mode, allow/ask/deny rules, protected paths, tool rules, unrestricted
acceptance), `trust.json`, `project-permissions.json` (including its network grants),
`auth.json` and `models.json`; and the `sandbox`, `secrets`, `defaultProjectTrust` settings.
The tool also rejects security field names (`permissions`, `permissionMode`, `mode`,
`allow`, `ask`, `deny`, `protectedPaths`, `tools`, `unrestrictedAccepted`, `trustedFolders`,
`auth`). Unknown keys and nested paths are refused. The authoritative list is in
`src/fork/config-policy.ts`. Use `/perm`, `/settings`, `/trust` or edit these yourself.

`write` and `edit`, and tools declaring a file write (such as LSP), refuse the listed
security files, `settings.json`, `keybindings.json`, `mcp.json`, `lsp.json`,
`consult-models.json`, `consult-budgets.json`, `plan-mode.json`, `pi-plan-mode.json`, and agents/extensions/hooks/
skills/prompts/themes directories in the global agent directory and the project's config
directory, including symlink targets. Shell detection also refuses literal paths in
redirections, `sed -i`, `tee`, `cp`, `mv`, `dd`, output options and interpreter code strings,
including simple `cd` prefixes. It can conservatively refuse reads in complex commands.
It cannot reliably detect computed paths, variable expansion other than HOME, encoded code,
scripts or arbitrary programs that write files without naming them, hard-link aliases or
filesystem races. The sandbox remains necessary; pattern detection is not isolation.
Never retry a refused configuration change with another tool.
