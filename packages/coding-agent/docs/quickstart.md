# Quickstart

Prism runs in your terminal and works with files on your machine. To use it, you need access to a model through a supported provider. This can be a subscription, an API key, or a local model.

For native Windows setup, read [Windows Setup](windows.md). For Android, read [Termux Setup](termux.md).

## 1. Install Prism

Install Prism on Linux x64:

```bash
curl -fsSL https://prism.odelserver.space/install.sh | sh
```

Verify the installation:

```bash
prism --version
```

## 2. Start Prism

Change to the folder you want Prism to work with, then start it:

```bash
cd /path/to/folder
prism
```

The working folder helps Prism discover relevant files, instructions, and configuration. Prism also uses it to group saved sessions.

<p align="center"><img src="images/interactive-mode.png" alt="Prism running in a terminal with a conversation, input editor, and status footer" width="750"></p>

The interface shows your conversation, an editor for prompts and commands, and a footer with the current folder, model, and session status. See [Use Prism in the terminal](usage.md) to learn how to add files, run commands, direct ongoing work, and manage results.

## 3. Choose a model

A **model** generates Prism's responses. A **provider** is the service or account Prism uses to access that model.

In Prism, run:

```text
/login
```

Choose a provider, then follow the prompts to use a subscription or store an API key. Run `/model` afterward if you want to select a different available model.

See [Choose a model and provider](models.md) for supported providers, environment-variable authentication, local models, and custom endpoints.

## 4. Give Prism a task

Prism shows each file read, search, command, and edit it performs. In the default `broad` permission mode, it works in the project without asking and asks before reaching outside it, before `sudo`, and before calls it detects as dangerous. Press `Alt+M` or run `/perm` to choose a stricter mode. See [Permissions](permissions.md#modes).

Enter a task that matches your work, for example:

```text
Summarize @meeting-notes.md and save the action items to action-items.md.
```

```text
Explain how this repository is structured and how to run its checks.
```

```text
Compare @previous.csv with @current.csv and summarize the important changes.
```

Type `@` in the editor to search for a file instead of entering its full path. When Prism finishes, review its response and any changed files. Use version control or backups for important work. For untrusted or unattended work, use a container or another sandbox. See [Security](security.md).

## Continue later

Prism saves sessions automatically. Exit Prism, then resume the most recent session for the same working folder with:

```bash
prism --continue
```

Use `/resume` to choose another saved session. See [Continue or branch a session](sessions.md) for session naming, branching, compaction, export, and sharing.

## Next steps

- [Use Prism interactively](usage.md) to learn input, commands, shortcuts, and queued messages.
- [Add instructions](configuration.md#context-files) that Prism should follow whenever it works in a folder.
- [Choose a model and provider](models.md).

### Choose how to customize Prism

Start with the least powerful mechanism that meets your need:

| Need | Start with |
|---|---|
| Give Prism persistent instructions for a folder | [`AGENTS.md`](configuration.md#context-files) |
| Reuse a prompt from the `/` menu | [Prompt template](prompt-templates.md) |
| Add task-specific instructions and supporting files | [Skill](skills.md) |
| Add executable tools, commands, or event handlers | [Extension](extensions.md) |
| Build a custom terminal component | [Terminal UI](tui.md) |
| Connect an unsupported model service | [Custom provider](custom-provider.md) |
| Install or distribute several resources | [Prism package](packages.md) |

## Uninstall Prism

Run the installer with `--uninstall`:

```bash
curl -fsSL https://prism.odelserver.space/install.sh | sh -s -- --uninstall
```

Uninstalling Prism does not remove configuration, credentials, sessions, or installed Prism packages from `~/.prism/agent/`.
