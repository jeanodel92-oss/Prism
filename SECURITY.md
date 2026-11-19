# Security policy

## Reporting a vulnerability

Report it privately through GitHub's private vulnerability reporting: the **Report a vulnerability** button in this
repository's **Security** tab. Do not open a public issue.

Include what is affected (version from `prism --version`, interface, configuration), the steps or proof of concept,
and the impact you observed.

## What Prism guarantees

Prism runs an AI agent with the user's account. Some of its protections are meant to hold even when the model is under
the control of a prompt injection; those are in scope:

- **Sandbox**: a command run in the sandbox reads, writes or reaches the network beyond what its limits allow.
- **Permissions**: an action runs without the approval its permission mode asks for, or the model changes the
  permission mode, rules or approvals without the user's consent.
- **Secrets**: an API key or password stored by Prism reaches the model's context, or a tool the model runs can read
  it.
- **Network rules**: a connection reaches a destination the rules refuse, by DNS rebinding or otherwise.
- **Rendering**: model or tool output that loads a remote resource, injects terminal escape sequences, or runs script
  in an HTML export.
- **Folder trust**: settings, extensions or instructions from a folder apply before the user trusted it.
- **Phone link**: a device that was not paired controls Prism, or reads a session.
- **Browser extension and desktop**: another extension or program uses Prism's native host, or the agent uses the
  browser or desktop without the permission it needs.
- **Updates and releases**: an install or update accepts a release that its signature does not cover.

## Out of scope

- The `unrestricted` permission mode, and actions the user approved.
- Prompt injection that stays within what the current permission mode allows. Prism's injection warnings reduce the
  risk; they are not a guarantee.
- Attacks that need prior write access to the user's files, configuration (`~/.prism`) or environment, unless they
  show how Prism grants that access.
- Extensions, skills, packages or tools the user installs, and repositories the user trusts.
- The behaviour of model providers, and malicious model output that no protection above lets through.
- Problems in code that comes unchanged from [pi](https://github.com/earendil-works/pi): report those to pi, as its
  security policy says.
