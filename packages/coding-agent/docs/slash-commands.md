# Slash commands

Type `/` in Prism's editor to search the commands available in the current session; `/help` lists the active commands and shortcuts, most used first. This page lists the commands of the current Prism release.

Some commands belong to a built-in module: they exist only while that module is on (**/settings › Modules**). Modules that are off by default are marked *(off by default)*. Extensions, prompt templates and skills can add commands, so the command menu is the exact reference for your session.

## Models and settings

| Command | Description |
|---|---|
| `/settings` | Open settings |
| `/model [provider/model]` | Select a model |
| `/thinking [level]` | Set the thinking level |
| `/scoped-models` | Choose the models `Ctrl+P` cycles through |
| `/model-settings` | Show and correct the current model's name, context, output limit, sampling and other request parameters, next to the server's values |
| `/login [provider]` | Add provider authentication |
| `/logout` | Remove provider authentication |
| `/llama` | Manage models on the configured llama.cpp router |
| `/web-key [exa\|brave\|tavily\|firecrawl\|searxng] [remove]` | Save or remove a web search API key or SearXNG URL; defaults to the selected provider. Choose the provider in `/settings` > Web search; see [Web search settings](settings.md#web-search) |
| `/budget` | Show this session's execution limits and usage; `/budget time 30`, `/budget tools 50`, `/budget tokens 200000`, `/budget cost 2`, `/budget off [time\|tools\|tokens\|cost]` set or clear them |
| `/onboarding` | Go through the first-start choices again: language, theme, permissions, modules, privacy, model |
| `/tutorial` | Learn Prism in nine short modules, each with an exercise Prism checks without calling the model; progress is kept |

## Permissions and safety

| Command | Description |
|---|---|
| `/perm` | Permissions: mode, default mode, rules and approvals in effect; see [Permissions](permissions.md#commands). `Alt+M` cycles the mode |
| `/sandbox` | The [sandbox](sandbox.md): its state, writable and hidden paths, allowed hosts |
| `/trust` | Save a project trust decision for future Prism processes |
| `/doctor [details\|export <file>]` | Check the local configuration and paths; see [Diagnostics](doctor.md) |
| `/sent [export <path>]` | Inspect the last request sent to the model: destination, instructions, tools and messages |
| `/trace` | The current session's operation trace, when traces are on (`traceEnabled`) |

## Sessions and context

| Command | Description |
|---|---|
| `/new` | Start a new session |
| `/resume` | Switch to another saved session |
| `/name [name]` | Set the session display name, or show the current name when omitted |
| `/session` | Show current session information and statistics |
| `/state` | What the session was doing when it stopped, and what to do about a tool left unfinished |
| `/tree` | Navigate the session tree |
| `/fork` | Create a new session from an earlier user message |
| `/clone` | Duplicate the current session at its current position |
| `/compact [instructions]` | Compact the current context, optionally with custom instructions |
| `/context` | Show what fills the model's context: system prompt, tools, messages |
| `/import <path>` | Import and resume a JSONL session |
| `/expand` | Expand thinking and tool output together; again: collapse both |
| `/sessions [all] <keywords>` | Search your past sessions *(`session-search` module, off by default)* |
| `/memory [instruction]`, `/memory-project [instruction]`, `/memory-edit` | Show or update the memory kept across sessions, for every project or this one *(`memory` module, off by default)* |

## Undo and background work

| Command | Description |
|---|---|
| `/undo` | Revert the file changes of the last model turn. Changes made by a shell command are not tracked |
| `/checkpoints` | List file checkpoints and go back to one |
| `/bg` | Show and manage background tasks (`Alt+J`) |
| `/bg-clear` | Forget finished background tasks |
| `/agents` | Create and manage custom agents, which the model runs with the `agent` tool; see this session's agent runs, stop one, send a finished one a message (it keeps its context), run one yourself; turn the advanced agent mode on. `/agents fork <task>` (advanced mode) runs an agent on a copy of this conversation |
| `/plan` | Enter or manage Plan mode: the model plans and only reads files until you approve (`Alt+P`) |
| `/goal [--tokens 100k] <goal>` | Give the model a goal it keeps working towards across turns |
| `/schedule` | Create, pause or remove [scheduled tasks](scheduled-tasks.md) |

## Export and share

| Command | Description |
|---|---|
| `/copy` | Copy the last assistant message |
| `/export [path]` | Export the session as HTML or JSONL |
| `/export-zip` | Export chosen sessions and files as a portable ZIP archive, with known secrets masked |
| `/share` | Upload the session as a secret GitHub gist and print a link to Prism's session viewer |

Review a session before exporting or sharing it. Sessions can contain prompts, tool arguments, command output, file contents, and credentials exposed during the conversation.

## Project and files

| Command | Description |
|---|---|
| `/files` | Browse project files and add them to your prompt (`Alt+E`) |
| `/init [plan or path]` | Set up the project's continuity documents (`AGENTS.md`, `project/`) from a plan or from the existing repository, after showing what will be created and asking |
| `/handoff [note]` | Have the model update `project/handoff.md`, with the branch, commit, uncommitted files and running background tasks measured by Prism. Prism then stamps the file with the commit; at startup, a handoff that no longer matches the repository is reported |
| `/lsp-setup [all]` | Show language servers for the project's languages, or all supported servers, turn them on or off, and offer installation commands |
| `/lsp` | Show the language server configuration |
| `/mcp` | Manage MCP servers: sign in, reconnect, enable or disable, and change exposure; see [MCP](mcp.md) |
| `/skills` | Install, turn on or off, update and remove skills |

## Prism, the window and devices

| Command | Description |
|---|---|
| `/docs [topic]` | Read this documentation in Prism |
| `/help` | Shortcuts and common actions, most frequent first |
| `/changelog` | Show Prism's release notes |
| `/update` | Check for a Prism update, switch channel or go back to the previous version; see [Updates](updates.md) |
| `/phone` | Link the [Android app](phone.md) to this computer, list and revoke linked phones |
| `/browser [setup\|resume\|firefox]` | Link Prism to your [browser](browser.md) *(`browser` module, off by default)* |
| `/desktop [stop]` | The agent's own desktop: live view or status *(`desktop` module, off by default)* |
| `/reload` | Reload keybindings, extensions, skills, templates, themes, and context files |
| `/debug` | Write the screen and the session's messages to `~/.prism/agent/prism-debug.log`, for a display problem |
| `/quit` | Quit Prism |

## Commands added by resources

- Extensions can register commands with their own arguments and completion behavior.
- Each prompt template is available under its template name.
- Skills are available as `/skill:name` when skill commands are enabled.

Use `/reload` after adding or changing a discovered command resource. See [Extensions](extensions.md), [Prompt Templates](prompt-templates.md), and [Skills](skills.md) for their loading and naming rules.
