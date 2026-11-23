# Settings Reference

This reference lists user-configurable settings, their types, defaults, and purposes. Settings live in `~/.prism/agent/settings.json`; a trusted project's `.prism/settings.json` overrides them, except settings marked global only. Resource lists are combined. See [Configuration](configuration.md) for file locations and trust behavior. `/settings` changes most of them from Prism.

## Model and thinking

<a id="model-cycling"></a>

| Setting | Type | Default | Description |
|---|---|---|---|
| `defaultProvider` | string | Automatic | Startup AI provider. |
| `defaultModel` | string | Automatic | Startup model ID. |
| `defaultThinkingLevel` | `"off" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh" \| "max"` | `"medium"` | Startup thinking level. |
| `modelThinkingLevels` | object | None | Per-model startup thinking levels keyed by exact `provider/modelId`. |
| `thinkingBudgets` | object | Built-in budgets | Token budgets for `minimal`, `low`, `medium`, and `high` thinking levels. |
| `enabledModels` | `string[]` | All available models | Model patterns used for startup selection and model cycling. Uses the same format as `--models`. |
| `hideThinkingBlock` | boolean | `true` | Hide thinking blocks in the transcript. |
| `showCacheMissNotices` | boolean | `false` | Show notices for significant cache misses, successful cache warming, compaction usage, and provider recovery. |
| `showLocalCloudWarning` | boolean | `true` | Show one status line when a request goes to a cloud endpoint right after one went to a local endpoint (localhost or a private address). `/sent` shows the last request. |
| `cacheWarming` | `"off" \| "streaming" \| "idle"` | `"streaming"` | Keep eligible provider prompt caches warm during active runs or, with `"idle"`, between runs. Global setting only. |

Cache warming runs only when the model declares a cache lifetime and Prism estimates at least $0.05 in avoided cache-miss cost. Refresh usage counts toward session totals but does not enter model context. `/session` shows the next decision; extensions can override it with `cache_warming_decision`. See [Prompt Cache Lifetimes](models.md#prompt-cache-lifetimes).

See [Choose a Model](models.md) for model selection and thinking controls.

## Interaction

| Setting | Type | Default | Description |
|---|---|---|---|
| `steeringMode` | `"all" \| "one-at-a-time"` | `"all"` | How queued steering messages are delivered. |
| `followUpMode` | `"all" \| "one-at-a-time"` | `"one-at-a-time"` | How queued follow-up messages are delivered. |
| `replyLanguage` | string | `"auto"` | Reply in the language of the user's latest message, or use any language name (for example `"French"`). Project settings can override it. `/settings` > Conversation > Reply language. |
| `language` | `"auto" \| "en" \| "fr"` | `"auto"` | Language of Prism's menus and messages. `"auto"` follows `LC_ALL`, `LC_MESSAGES`, then `LANG`: French for `fr*`, English otherwise. The model's replies follow `replyLanguage`. `/settings` > Language. |
| `externalEditor` | string | `$VISUAL`, `$EDITOR`, then platform default | Command opened by the external-editor keybinding. |
| `doubleEscapeAction` | `"tree" \| "fork" \| "none"` | `"tree"` | Action for double Escape with an empty editor. |
| `treeFilterMode` | `"default" \| "no-tools" \| "user-only" \| "labeled-only" \| "all"` | `"default"` | Initial filter used by `/tree`. |
| `defaultProjectTrust` | `"ask" \| "always" \| "never"` | `"ask"` | Fallback project-trust behavior. **Can only be set in agent-directory settings.** |
| `interfaceMode` | `"simple" \| "advanced"` | `"simple"` | `simple` hides technical settings and details; `advanced` shows every setting and each action's command and output. `/settings` > Interface. |
| `openIn` | `"terminal" \| "window"` | None (asks once) | Where a plain `prism` opens: the terminal or [Prism's window](window.md). Unset, the first launch where the window can open asks. `--gui` and `--tui` override it for one launch. Global setting only. `/settings` > Interface > Open Prism in. |
| `agentInvocation` | object | All on | When the model runs custom agents. `autonomous` (default `true`): on its own, when a task fits. Off, only when your latest message asks for an agent (`explicitRequest`) or contains `keywordText` (`keyword`, default `"@agent"`); with the keyword alone, Prism refuses any other call. Global setting only. `/agents`. |
| `handoffReminder` | object | `{ "enabled": false, "interval": 100 }` | With the `project-continuity` module, remind the model to update `project/handoff.md` every `interval` tool calls. Global setting only. |

## Tools

| Setting | Type | Default | Description |
|---|---|---|---|
| `defaultTools` | `string[]` | `read`, `bash`, `edit`, `write` | Tools enabled at startup. Plain names replace the defaults; `+name` adds a tool and `-name` removes one. An empty array disables all built-in tools but not extension or SDK tools. |
| `codemode.mode` | `"on"` \| `"only"` | `"on"` | How the `codemode` tool presents tools while it is active. `on`: declared tools get a note on calling them from scripts appended to their description, and `codemode` lists only tools that are not declared. `only`: `codemode` lists every tool scripts can call, and active built-in and extension tools are hidden from the model, so it reaches them through `codemode`. |
| `codemode.inlineBudget` | number | `3000` | Estimated tokens (characters / 4) the `codemode` tool's description may spend on tool declarations. Tools that do not fit are left out and found with `searchTools()`. `0` lists only namespaces. |

Available built-in tools are `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, and `ls`. `defaultTools` can also name `codemode` and `tool_search`, which built-in extensions register inactive, and other extension tools registered inactive.

A list of only `+name` and `-name` entries changes the inherited selection instead of replacing it. For example, this enables `codemode` next to the default tools:

```json
{
  "defaultTools": ["+codemode"]
}
```

This replaces `bash` with `powershell` and enables `grep`: `["-bash", "+powershell", "+grep"]`. Project settings apply on top of user settings: a project list with only `+name` and `-name` entries changes the user's selection, and a project list with a plain name replaces it. In one list, plain names form the selection, and `+name` and `-name` then apply in order.

`/reload` enables tools newly added to `defaultTools`. It does not disable tools removed from it or re-enable unchanged tools you turned off. `--tools`, `--no-tools`, and `--no-builtin-tools` override `defaultTools`, also on reload.

CLI tool options override this setting for one invocation; `--tools` does not accept `+name` or `-name`. See [Command Line](cli.md#tools).

### Web search

| Setting | Type | Default | Description |
|---|---|---|---|
| `webSearchProvider` | `"exa" \| "brave" \| "tavily" \| "firecrawl" \| "searxng"` | `"exa"` | Provider used by `web_search`. Global setting only. `/settings` > Web search > Provider. |
| `webSearchUrl` | string | None | SearXNG instance base URL (`http` or `https`, without credentials, a query, or a fragment). Global setting only. |

Exa works without a key through its public, rate-limited endpoint; an Exa key uses its API instead. Brave, Tavily and Firecrawl require their own API keys. SearXNG requires an instance base URL. Configure the selected provider's key or URL in `/settings` > Web search, or with `/web-key [exa|brave|tavily|firecrawl|searxng] [remove]`. Omitting the provider uses the selected one; naming a provider configures its key or URL without changing the selection.

`EXA_API_KEY`, `BRAVE_API_KEY`, `TAVILY_API_KEY`, and `FIRECRAWL_API_KEY` take precedence over keys saved by `/web-key` in the agent directory's `auth.json`. `remove` deletes the saved key or SearXNG URL, but does not unset environment variables. A missing Brave, Tavily or Firecrawl key, or a missing SearXNG URL, produces a setup error instead of falling back to Exa. Firecrawl searches return web snippets without scraping pages and accept queries of at most 500 characters. `web_fetch` works independently of the search provider: it uses Exa when an Exa key is available, then falls back to fetching URLs directly.

## Sessions and context

| Setting | Type | Default | Description |
|---|---|---|---|
| `sessionDir` | string | Agent session directory | Session storage directory. Relative paths resolve from the working directory. `PRISM_CODING_AGENT_SESSION_DIR` and `--session-dir` override this setting. |

### Compaction

| Setting | Type | Default | Description |
|---|---|---|---|
| `compaction.enabled` | boolean | `true` | Enable automatic compaction. |
| `compaction.thresholdPercent` | number | None (Default) | Trigger percentage above 0 and at most 100, capped to leave room for summarization. Global setting only. `/settings` > Conversation > Auto-compact threshold; Default uses `contextWindow - reserveTokens`. |
| `compaction.reserveTokens` | number | `16384` | Tokens reserved for the model response. |
| `compaction.keepRecentTokens` | number | `20000` | Recent tokens retained without summarization. |
| `compaction.modelOverrides` | object | None | Per-model token settings keyed by exact `provider/modelId`. |

<a id="per-model-compaction-overrides"></a>

Compaction token values must be non-negative safe integers. Each value resolves independently from the matching model override, then the ordinary compaction setting, then the built-in default. Project and user objects merge before model lookup.

See [Compaction Reference](compaction.md) for trigger, summarization, and validation behavior.

### Branch summaries

| Setting | Type | Default | Description |
|---|---|---|---|
| `branchSummary.reserveTokens` | number | `16384` | Tokens reserved when summarizing branch history. |
| `branchSummary.skipPrompt` | boolean | `false` | Skip the branch-summary prompt and default to no summary. |

## Terminal and display

| Setting | Type | Default | Description |
|---|---|---|---|
| `theme` | string | `"prism-light/prism"` | Built-in or custom theme name, or a light/dark pair. The default pair follows the terminal's appearance. `system` derives colors from the terminal theme. |
| `quietStartup` | boolean \| `"header"` | `false` | `true` hides the startup header and loaded-resource listing. `"header"` keeps the header (version and key hints) but hides the model scope line and loaded-resource listing. |
| `animations` | boolean | `true` | Prism's animations: the logo drawing in at startup, the working line, shines, breathing dots, opening menus and the spinner in the terminal title. `false`, or a terminal that is not interactive, keeps them all still. `/settings` > Appearance > Animations. |
| `animationStyles` | object | Original styles | One style per animation: `intro` (`default`, `off`, `wipe`, `dissolve`), `working` (`default`, `off`, `dots`, `meter`), `thinking` (`default`, `off`, `dots`, `pulse`), `tools` (`default`, `off`, `spinner`, `meter`), `menus` (`default`, `off`, `wipe`, `slide`), `title` (`default`, `off`, `dots`). `/settings` > Appearance > Animations sets them one by one or with a preset. |
| `animationsOff` | string[] | `[]` | Animations turned off one by one, under `animations`: `intro` (startup logo), `working`, `thinking`, `tools`, `menus`, `title`. `/settings` > Appearance > Animations lists them with a preview. |
| `footerActions` | string[] | `[]` | Commands pinned to the footer, in order, before the settings gear and "more…": `help`, `docs`, `tutorial`, `settings`, `perm`, `model`, `session`, `new`, `resume`, `tree`, `export`, `compact`. Those that do not fit stay in "more…". "more…" > Footer buttons… pins, moves and removes them. |
| `tuiMode` | `"regular" \| "fullscreen"` | `"fullscreen"` | Interactive terminal UI mode. |
| `fullscreenExitOutput` | `"transcript" \| "resume-hint"` | `"transcript"` | Output printed when fullscreen mode exits. |
| `fullscreenScrollbar` | `"auto" \| "always" \| "hidden"` | `"auto"` | Fullscreen transcript scrollbar behavior. |
| `fullscreenCopyOnSelect` | boolean | `true` | Copy selected text automatically in fullscreen mode. On Linux, the selection also becomes the primary selection, and a middle click pastes the primary selection into the editor, as in a terminal. |
| `fullscreenWheelScrollLines` | `"auto"` \| number | `"auto"` | Lines per mouse-wheel event in fullscreen mode, from 1 to 100. `"auto"` moves one line per event in local macOS terminals, which already accelerate wheel and trackpad input; elsewhere, and over SSH, it speeds up fast wheel spins to at most 6 lines per event. Alt+wheel moves five times as far. |
| `editorPaddingX` | number | `0` | Horizontal editor padding from 0 to 3 cells. |
| `outputPad` | `0 \| 1` | `1` | Horizontal transcript padding. |
| `autocompleteMaxVisible` | number | `5` | Visible autocomplete entries, from 3 to 20. |
| `showHardwareCursor` | boolean | `false` | Show the terminal cursor while Prism positions it for input methods. |
| `terminal.showImages` | boolean | `true` | Display inline images when supported. |
| `terminal.imageWidthCells` | number | `60` | Preferred inline image width in terminal cells. |
| `terminal.clearOnShrink` | boolean | `false` | Clear empty rows when rendered content shrinks. |
| `terminal.showTerminalProgress` | boolean | `false` | Show OSC 9;4 progress in the terminal tab. |
| `terminal.hyperlinks` | `boolean \| "auto"` | `"auto"` | Override OSC 8 hyperlink detection. |
| `terminal.images` | `"kitty" \| "iterm2" \| "auto" \| false` | `"auto"` | Override inline-image protocol detection. |
| `terminal.trueColor` | `boolean \| "auto"` | `"auto"` | Override true-color detection. |
| `images.autoResize` | boolean | `true` | Resize images to at most 2000 by 2000 pixels before sending them to a model. |
| `images.blockImages` | boolean | `false` | Prevent images from being sent to models. |
| `markdown.codeBlockIndent` | string | `"  "` | Prefix used to indent rendered code blocks. |
| `markdown.mermaid` | `"off" \| "final" \| "streaming"` | `"streaming"` | Mermaid rendering mode. |

See [Themes](themes.md) and [Terminal Setup](terminal-setup.md) for format and platform details.

## Network and retries

| Setting | Type | Default | Description |
|---|---|---|---|
| `transport` | `"auto" \| "sse" \| "websocket" \| "websocket-cached"` | `"auto"` | Preferred transport for AI providers that support multiple transports. |
| `httpProxy` | string | None | Proxy URL applied as `HTTP_PROXY` and `HTTPS_PROXY` for Prism-managed HTTP clients. **Can only be set in agent-directory settings.** |
| `httpIdleTimeoutMs` | number | `300000` | HTTP header and body idle timeout in milliseconds. Set to `0` to disable. |
| `websocketConnectTimeoutMs` | number | `15000` | WebSocket connection timeout in milliseconds. Set to `0` to disable. |
| `retry.enabled` | boolean | `true` | Enable automatic agent-level retry for transient failures. |
| `retry.maxRetries` | number | `3` | Maximum agent-level retry attempts. |
| `retry.baseDelayMs` | number | `2000` | Initial exponential-backoff delay in milliseconds. |
| `retry.maxAgentDelayMs` | number | `60000` | Maximum agent-level retry delay in milliseconds. |
| `retry.provider.timeoutMs` | number | `httpIdleTimeoutMs` | Provider request timeout in milliseconds. |
| `retry.provider.maxRetries` | number | `0` | Provider-level retry attempts. |
| `retry.provider.maxRetryDelayMs` | number | `60000` | Maximum server-requested delay in milliseconds. Set to `0` to disable the limit. |

Keep `retry.provider.maxRetries` at `0` unless provider-level retries are required. Provider retries can delay Prism from handling quota and usage-limit errors itself.

## Shell

| Setting | Type | Default | Description |
|---|---|---|---|
| `shellPath` | string | Platform default | Custom shell executable path. Supports a leading `~`. |
| `shellCommandPrefix` | string | None | Prefix prepended to every shell command. |
| `npmCommand` | `string[]` | `npm` | Command and arguments used for npm package lookup and installation. |

See [Shell aliases](shell-aliases.md) for shell setup and [Prism Packages](packages.md) for package-manager behavior.

## Resources

Resource paths in user settings resolve from the agent directory. Paths in project settings resolve from the project `.prism` directory. Absolute paths and `~` are supported.

| Setting | Type | Default | Description |
|---|---|---|---|
| `packages` | array | `[]` | npm, git, or local Prism package sources. See [Prism Packages](packages.md). |
| `extensions` | `string[]` | `[]` | Extension files or directories. |
| `skills` | `string[]` | `[]` | Skill files or directories. |
| `prompts` | `string[]` | `[]` | Prompt-template files or directories. |
| `themes` | `string[]` | `[]` | Theme files or directories. |
| `enableSkillCommands` | boolean | `true` | Register skills as `/skill:name` commands. |

Resource arrays support glob exclusions with `!pattern`, exact inclusion with `+path`, and exact exclusion with `-path`. Prism loads resources listed in both user-level and project settings.

The built-in extensions are named `builtin:mcp`, `builtin:llama.cpp`, `builtin:codemode`, `builtin:tool-search`, `builtin:prism` (the Prism look), `builtin:files` (the project file browser, `/files`, `Alt+E`), `builtin:lsp-setup` (`/lsp-setup [all]`, language server suggestions), `builtin:reply-language` (reply language instructions), `builtin:machine-context` (your system, hardware and shell, for the model), `builtin:checkpoints` (`/undo`, `/checkpoints`), `builtin:background` (the `background` tool, `/bg`), `builtin:memory` (`/memory`), `builtin:session-search` (the `session_search` tool, which searches your other sessions and asks before sending their excerpts to a cloud model, and `/sessions`), `builtin:notify` (desktop notifications, `/settings` > Notifications), `builtin:web` (the `web_fetch` and `web_search` tools; search uses the configured [web search provider](#web-search)), `builtin:browser` (the `browser` tool and `/browser`: the agent uses your own browser, in tabs of its own, through the Prism extension), `builtin:desktop` (the `desktop` tool and `/desktop`: the agent uses graphical programs on a desktop of its own, a headless labwc, apart from yours), `builtin:user-desktop` (the `user_desktop` tool: the agent uses your own screen, pointer and keyboard when you ask and agree, until you take them back), `builtin:append-system` (generic instructions added after `APPEND_SYSTEM.md`), `builtin:agents` (custom agents, `/agents`, the `agent` tool), `builtin:skills` (`/skills`, the skill manager; skills load without it), `builtin:project-continuity` (in a project with `project/handoff.md`, the role of each continuity document in the system prompt; elsewhere, an `init` button in the footer that runs `/init`), and the vendored third-party plugins listed in `vendor/README.md` (`builtin:pi-lsp`, ...). They load by default, except `builtin:memory`, `builtin:session-search`, `builtin:browser`, `builtin:desktop` and `builtin:user-desktop`, which `+builtin:memory`, `+builtin:session-search`, `+builtin:browser`, `+builtin:desktop` and `+builtin:user-desktop` turn on; `-builtin:mcp` disables one. A `+builtin:<name>` or `-builtin:<name>` entry in project settings overrides the user setting. `prism config` lists them under Built-in. `--no-extensions` disables them too, and `-e builtin:<name>` loads one explicitly. In a session, `/settings` > Extensions turns them on or off; the change applies when Settings closes (after the current response, with `/reload`, if one is running). The next request declares the added or removed tools and prompt sections in one short message at the end of the conversation, so the prompt cache of everything before stays valid.

## Updates and warnings

| Setting | Type | Default | Description |
|---|---|---|---|
| `updateMode` | `"manual" \| "notify" \| "auto"` | `"manual"` | `"manual"`: Prism asks `https://prism.odelserver.space` nothing until you run `/update` or `prism update`. `"notify"`: at start, it says when a newer Prism exists. `"auto"`: at start, it installs it; the new version opens at the next start. At most one check an hour; only for an installation made by the site installer, and never with `PI_OFFLINE`. In `/settings` › Other › Updates. See [Updates](updates.md). |
| `modelCatalogRefresh` | boolean | `true` | Refresh the cloud model catalog of the providers you signed in to from `https://pi.dev`, at startup, in `/model` and after `/login`, at most every 4 hours. `false`: only `prism update --models` downloads it. Global setting only. `/settings` > Update the model catalog. |
| `collapseChangelog` | boolean | `false` | Show a condensed changelog after an update. |
| `warnings.anthropicExtraUsage` | boolean | `true` | Warn when Anthropic subscription authentication may use paid extra usage. |
| `desktopNotifications` | object | `{ "enabled": true, "approvals": true }` | With the `notify` module: a desktop notification when the model finishes (`enabled`) and when it waits for your approval (`approvals`). Global setting only. `/settings` > Notifications. |

Prism sends no telemetry. See [Privacy](security.md#privacy) for the connections it makes on its own.

## Privacy and operation traces

| Setting | Type | Default | Description |
|---|---|---|---|
| `traceEnabled` | boolean | `false` | Keep a local JSONL timeline of tool calls, parameters, permission decisions and results. Known stored credentials and common secret patterns are masked. Prompts and model text are not recorded. |
| `traceRetentionDays` | number | `7` | At startup, delete trace files older than this many days. |
| `deviceId` | string | None | Random identifier of this installation, created at the first "Sign in with ChatGPT" and sent to OpenAI during that sign-in; see [Privacy](security.md#privacy). Global setting only; deleting it makes the next sign-in create a new one. |

`/trace` shows the current session's timeline and file path. Enable it in `/settings` under Privacy, then run `/reload`; setting changes take effect after reloading. File contents are clipped at 16,000 characters per parameter with the original length recorded.

## Permissions, sandbox and secrets

These settings are global only: a project's settings, the model and `configure_prism` cannot change them. `/settings` > Permissions & sandbox shows them.

| Setting | Type | Default | Description |
|---|---|---|---|
| `sandbox.modes` | object | `safe`, `ask`, `broad` on; `unrestricted` off | Permission modes whose shell commands run in the [sandbox](sandbox.md). |
| `sandbox.read.limit` | `"project" \| "all"` | `"project"` | What sandboxed commands read: the project, its tools' resources and `sandbox.read.allow`; or everything except hidden paths. |
| `sandbox.read.allow` | string[] | `[]` | Extra readable paths (`~` is your home folder). |
| `sandbox.allowWrite` | string[] | `[]` | Extra writable paths. |
| `sandbox.hide` | string[] | `[]` | Extra hidden paths. |
| `sandbox.network.askNewHosts` | boolean | `true` | Ask before a sandboxed command reaches a host not listed. |
| `sandbox.network.allow` | string[] | `[]` | Hosts sandboxed commands reach without asking (`registry.npmjs.org`, `*.github.com`, `localhost:5432`, `ssh://github.com`). |
| `sandbox.network.deny` | string[] | `[]` | Hosts sandboxed commands never reach. |
| `sandbox.userCommands` | boolean | `false` | Run your own `!` commands in the sandbox too. |
| `sandbox.excludedCommands` | string[] | `[]` | Commands that run outside the sandbox, such as `docker`; they still get the permission check. |
| `sandbox.gitSigning` | boolean | `false` | Git in the sandbox signs with your key, through Prism. |
| `sandbox.containers` | boolean | `false` | Sandboxed commands list your containers and images, read only. |
| `sandbox.serviceState` | boolean | `false` | Sandboxed commands read the state of system services. |
| `sandbox.sudo` | boolean | `false` | The `sudo` tool; see [Controlled sudo](permissions.md#controlled-sudo). |
| `sandbox.sudoRememberPassword` | boolean | `false` | Remember the sudo password in memory for 5 minutes. |
| `secrets.passEnv` | object | `{}` | Variables passed to given commands despite looking secret, as `{ "GITHUB_TOKEN": ["bash(gh *)"] }`. See [Secrets](security.md#secrets). |
| `secrets.envAllowlist` | boolean | `false` | Give the agent's commands only known variables, those of `secrets.allowEnv` and those `passEnv` passes. |
| `secrets.allowEnv` | string[] | `[]` | With `envAllowlist`: extra variable names; `*` matches any characters. |
| `injectionWarning` | boolean | `true` | The [prompt injection warning](permissions.md#prompt-injection-warning). |
| `scopeMaxMinutes` | number | `480` | Longest [task scope](permissions.md#task-scope), in minutes (5 or more). |
| `desktopTakeBackKey` | string | `"ctrl+shift+q"` | With the `user-desktop` module: the shortcut that takes your desktop back from the agent. |

The permission rules themselves live in `permissions.json`; see [Permissions](permissions.md#config).
