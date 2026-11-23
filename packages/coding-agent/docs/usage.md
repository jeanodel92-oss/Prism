# Use Prism in the terminal

Run `prism` from the folder you want to work in. Prism uses that folder to discover files, instructions, and configuration, and to group saved sessions. If you have not installed Prism or chosen a model yet, follow the [Quickstart](quickstart.md).

Prism may ask whether you trust the working folder before loading its project resources. See [Project trust](security.md#understand-project-trust).

<p align="center"><img src="images/interactive-mode.png" alt="Prism interactive mode showing a conversation, editor, and status information" width="750"></p>

The transcript shows your prompts, Prism's responses, tool calls, results, and errors. You write prompts and commands in the editor. The footer shows the current folder, session, model, context usage, and accumulated usage and cost.

## Enter a prompt

Type a request and press `Enter` to send it. Use `Shift+Enter` to add a line, or press `Ctrl+G` to work on a longer prompt in your configured external editor.

To include files or images:

- Type `@` to search for a file and add it to your prompt.
- Run `/files` or press `Alt+E` to browse project files. Press `Tab` to mark files and `Enter` to add them to your prompt.
- Press `Tab` to complete a path.
- Paste an image or drag it into a compatible terminal. A copied image, such as a screenshot, shows as `[Image #1]` in the editor and goes to the model as an image with the message; delete the placeholder to leave it out. Files copied in the file manager paste as paths; a file from outside the project is first copied into the session's private `/tmp`, where the agent reads it without a permission question, and the path is that copy's.

## Follow Prism's work

Prism shows each tool call and result while it works. Press `Ctrl+O` to force every expandable block open or closed, including thinking blocks. This resets individual choices made by clicking blocks. Press `Ctrl+T` to show or hide thinking blocks until the next `Ctrl+O`.

The startup header lists the instructions and resources Prism loaded. The editor border indicates the current thinking level. The footer updates as the model uses context and reports usage.

Whether Prism asks before a tool call depends on the permission mode. In the default `broad` mode, Prism works in the project without asking and asks before reaching outside it, before `sudo`, and before calls it detects as dangerous. `ask` also confirms file changes and commands not known to be safe, `safe` lets the agent only read and run safe commands, and `unrestricted` skips ordinary questions once you have accepted it. Press `Alt+M` to cycle modes, or use `/perm mode <mode>` for the session and `/perm default <mode>` for new sessions. See [Permissions](permissions.md#modes).

In the `safe`, `ask` and `broad` modes, the agent's shell commands also run in the [sandbox](sandbox.md), which limits what they can write, read and reach. File tools, extensions and the `unrestricted` mode are not covered by it. Review commands and changed files, and use a container for untrusted or unattended work. See [Security](security.md).

## Change direction

You can send more input while Prism is working:

| What you want | Action |
|---|---|
| Adjust the current task | Type a message and press `Enter` |
| Add work after the current task | Type a message and press `Alt+Enter` |
| Return queued messages to the editor | Press `Alt+Up` |
| Stop the current task | Press `Escape` |

A message sent with `Enter` waits until the current response and its tool calls finish, then guides the next response. A follow-up sent with `Alt+Enter` waits until Prism finishes the current task. Aborting returns queued messages to the editor.

Windows Terminal reserves some Alt shortcuts. See [Terminal Setup](terminal-setup.md) for the Windows alternatives.

## Change the model or settings

Type `/` to search the available commands. The commands you will use most often are:

- `/model` selects a model. Press `Ctrl+L` to open the same selector.
- `/thinking` selects how much reasoning the current model uses. Press `Shift+Tab` to cycle through supported levels.
- `/login` and `/logout` manage provider access.
- `/settings` changes common preferences.

Prompt templates, skills, and extensions can add more commands to the same menu. See [Choose a Model](models.md), [Configuration](configuration.md), or the complete [Slash Commands reference](slash-commands.md).

## Continue or start over

Prism saves sessions automatically unless session persistence is disabled.

- `/new` starts a new session.
- `/resume` opens another saved session.
- `/name` gives the current session a recognizable name.
- `/session` shows its file, ID, message count, token usage, and cost.

Use `/tree`, `/fork`, or `/clone` when you want to explore another approach without losing existing work. Use `/compact` to reduce the conversation history sent to the model. See [Sessions and Context](sessions.md) for these workflows.

After leaving Prism, run `prism --continue` from the same folder to resume its most recent session.

## Run a terminal command

Prefix a command with `!` to run it and include its output in the conversation:

```text
!git status
```

Use `!!` when you want to run a command without sending its output to the model.

## Copy, export, or share results

Press `Ctrl+X` or run `/copy` to copy the last assistant response. Use `/export` to save the session as HTML or JSONL.

Use `/share` to upload the session and get a viewer link. With Radius authentication, the artifact is visible to your Radius organization. Otherwise, Prism creates a private GitHub gist through the GitHub CLI. Review the session first because it can contain prompts, tool output, file contents, and credentials exposed during the conversation.

## Adjust the terminal

Fullscreen mode, the default, keeps the editor and status area fixed while the transcript scrolls within the terminal window. Regular mode uses the terminal's normal scrollback. Choose a mode through `/settings` or `--tui-mode`.

Terminal support for mouse input, keyboard shortcuts, and inline images varies. See [Terminal Setup](terminal-setup.md) for platform-specific configuration and [Keybindings](keybindings.md) for every configurable shortcut. Run `/help` to inspect the shortcuts active in your current session.

## Collect diagnostic information

When troubleshooting terminal rendering or conversation state, run `/debug`. Prism writes the rendered terminal lines and current session messages to `prism-debug.log` in your [agent directory](configuration.md#agent-directory).

Review this file before sharing it. It can contain prompts, model responses, tool output, file contents, and terminal data.
