# Slash commands

Type `/` in Prism's terminal editor to search the commands available in the current session. This page lists the built-in commands in the current Prism release.

Extensions, prompt templates, and skills can add commands. The command menu in Prism is therefore the exact reference for the resources loaded in your session.

## Models and settings

| Command | Description |
|---|---|
| `/settings` | Open settings |
| `/model [provider/model]` | Select a model |
| `/budget` | Show this session's execution limits and usage; `/budget time 30`, `/budget tools 50`, `/budget tokens 200000`, `/budget cost 2`, `/budget off [time|tools|tokens|cost]` set or clear them |
| `/init [plan or path]` | With the `project-continuity` extension on: set up the project's continuity documents (`AGENTS.md`, `project/`) from a plan or from the existing repository, after showing what will be created and asking |
| `/handoff [note]` | With the `project-continuity` extension on: have the model update `project/handoff.md`, with the branch, commit, uncommitted files and running background tasks measured by Prism. Prism then stamps the file with the commit; at startup, a handoff that no longer matches the repository is reported |
| `/thinking [level]` | Set the thinking level |
| `/scoped-models` | Configure the models used by interactive cycling |
| `/login [provider]` | Add provider authentication |
| `/logout` | Remove provider authentication |
| `/llama` | Manage models on the configured llama.cpp router |
| `/web-key [exa\|brave\|tavily\|firecrawl\|searxng] [remove]` | Save or remove a web search API key or SearXNG URL; defaults to the selected provider. Choose the provider in `/settings` > Web search; see [Web search settings](settings.md#web-search) |

## Sessions and context

| Command | Description |
|---|---|
| `/new` | Start a new session |
| `/resume` | Switch to another saved session |
| `/name [name]` | Set the session display name, or show the current name when omitted |
| `/session` | Show current session information and statistics |
| `/tree` | Navigate the session tree |
| `/fork` | Create a new session from an earlier user message |
| `/clone` | Duplicate the current session at its current position |
| `/compact [instructions]` | Compact the current context, optionally with custom instructions |
| `/import <path>` | Import and resume a JSONL session |

## Export and share

| Command | Description |
|---|---|
| `/copy` | Copy the last assistant message |
| `/export [path]` | Export the session as HTML or JSONL |
| `/share` | Upload the session and return a viewer link |
| `/bug [description]` | Prepare a private bug report for the Prism developers |

Review a session before exporting or sharing it. Sessions can contain prompts, tool arguments, command output, file contents, and credentials exposed during the conversation.

## Runtime and project

| Command | Description |
|---|---|
| `/trust` | Save a project trust decision for future Prism processes |
| `/files` | Browse project files and add them to your prompt (`Alt+E`) |
| `/lsp-setup [all]` | Show language servers for the project's languages, or all supported servers, and offer installation commands |
| `/reload` | Reload keybindings, extensions, skills, templates, themes, and context files |
| `/changelog` | Show Prism's release notes |
| `/tutorial` | Learn Prism in nine short modules, each with an exercise Prism checks without calling the model; progress is kept. Also offered at the end of onboarding and in the « more… » menu |
| `/quit` | Quit Prism |

## Commands added by resources

- Extensions can register commands with their own arguments and completion behavior.
- Each prompt template is available under its template name.
- Skills are available as `/skill:name` when skill commands are enabled.

Use `/reload` after adding or changing a discovered command resource. See [Extensions](extensions.md), [Prompt Templates](prompt-templates.md), and [Skills](skills.md) for their loading and naming rules.
