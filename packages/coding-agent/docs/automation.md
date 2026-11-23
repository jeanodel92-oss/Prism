# Automation

Prism can run without the terminal interface for scripts and integrations. Select a
configured model and provider with the usual CLI options; examples below use the
model configured as the default.

## Print mode

`-p` runs one prompt, prints the final answer, and exits:

```bash
prism -p "Summarize the current project"
```

## JSON event stream

`--mode json` prints one JSON event per line, then exits:

```bash
prism --mode json "Summarize the current project" > events.jsonl
```

## RPC

`--mode rpc` reads JSONL commands from stdin and writes responses and events to
stdout. Close stdin to request a clean shutdown:

```bash
printf '%s\n' '{"id":"prompt-1","type":"prompt","message":"Summarize the current project"}' \
  | prism --mode rpc --no-session
```

## TypeScript SDK

Use the SDK when the host application is also written in TypeScript and should run
Prism in the same process:

```typescript
import { createAgentSession } from "@earendil-works/pi-coding-agent";

const { session } = await createAgentSession();
try {
  await session.prompt("Summarize the current project");
  console.log(session.getLastAssistantText());
} finally {
  session.dispose();
}
```

## Permissions without a user interface

The default permission mode is `ask`. In `-p` and JSON modes, an action that would
open a confirmation dialog is blocked immediately: the model receives the reason as
a tool error and Prism writes it to stderr. Prism does not wait for a user who cannot
answer. Safe actions continue to run.

In RPC mode the confirmation goes to the client as an `extension_ui_request`
(`select`) and waits for its `extension_ui_response`; see
[RPC extension UI](rpc-extension-ui.md). A client that never answers keeps the call
waiting.

For unattended scripts, choose the least access needed. `--perm-mode broad` allows
ordinary actions that would otherwise ask, including project writes:

```bash
prism --perm-mode broad -p "Update the project files"
```

Dangerous actions still require confirmation and remain blocked without an
interactive UI. A targeted rule in the agent's `permissions.json` can grant a
specific action, for example `{"allow":["write(src/**)"]}`. In the `safe`, `ask` and
`broad` modes, allowed shell commands still run in the [sandbox](sandbox.md): they write
only to the project, and a host never allowed is refused, since no one can answer.
See [Permissions](permissions.md) for modes, rule matching, and protected paths.
