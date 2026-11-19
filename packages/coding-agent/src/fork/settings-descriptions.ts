// fork: what each setting of /settings concretely does, for someone who has never used
// pi. The upstream descriptions are often technical ("Render Mermaid code blocks as Unicode
// diagrams"); the maintainer could not tell what several settings did.
// Settings missing here keep their upstream description. Key names stay in the text when the
// upstream description builds them from the user's key bindings.

import { MODE_SUMMARIES } from "./perm-view.ts";

export const SETTING_DESCRIPTIONS: Record<string, string> = {
	"web-search-provider":
		"Where web_search sends your searches: Exa works without a key; Brave, Tavily and Firecrawl need a key; SearXNG uses your own instance. Changing this closes Settings and reloads the tools.",
	"web-search-key-exa":
		"Without an API key (an access key from Exa), web_search uses Exa's public service with request limits. A key uses your Exa account's limits. Saved keys are stored in auth.json.",
	"web-search-key":
		"Save or remove this provider's API key. Searches need a key for this provider. Environment keys take precedence; remove them from your environment to stop using them.",
	"web-search-url":
		"The http(s) base URL of your SearXNG instance, for example http://localhost:8080. No key is needed. Enable JSON search results on the instance. Save or remove the URL here.",
	theme: "Colours of the interface. Automatic picks the light or the dark theme to match your terminal's background.",
	"theme-customize":
		"Change the colours of the theme in use, with a preview. A copy is saved in the themes folder and becomes your theme; the original stays as it was.",
	animations:
		"Moving effects: the logo drawing in at startup, the working line, shines, breathing dots and opening menus. Each has its styles, and presets set them all; off keeps it still.",
	"hide-thinking": "Hide thinking blocks in replies. This changes the display, not how much the model thinks.",
	"mermaid-rendering":
		"When the model writes a diagram in Mermaid (a text format for flowcharts and sequence diagrams), draw it with text characters instead of showing its source.",
	"show-images": "Show images (screenshots, pictures the model reads) inside the terminal, when the terminal can.",
	"image-width-cells": "How wide images appear in the conversation, in character columns.",
	"quiet-startup": "What Prism prints at startup.",
	"editor-padding": "Empty columns on each side of the text you type.",
	"output-padding": "Empty columns on each side of the messages in the conversation.",
	"autocomplete-max-visible": "How many suggestions the list shows at once while you type a / command or a file path.",
	"show-hardware-cursor":
		"Show the terminal's own cursor in the input box. Useful with input methods for Chinese, Japanese or Korean.",
	autocompact:
		"Automatically summarize older messages when the conversation nears the model's limit. Recent messages stay in full; older details may be lost in the summary.",
	"compaction-threshold":
		"How full the model's context can get before Auto-compact summarizes old messages. Lower percentages summarize earlier. High values are capped to leave room for the summary request and reply. Default uses the existing token reserve. Applies when Auto-compact is on.",
	"reply-language":
		"The language the model answers in. Prism's own instructions stay in English. Another language can be written in settings.json (replyLanguage). Code, commands and file names are never translated.",
	"steering-mode": "Press Enter while the agent is working to guide its next steps.",
	"double-escape-action": "What pressing Escape twice does when the input box is empty.",
	"tree-filter-mode": "Which messages /tree (the map of the session's branches) shows when it opens.",
	"skill-commands": "Add /skill:name commands to open skills: saved instructions for specific tasks.",
	"tui-mode": "How Prism uses the terminal.",
	"fullscreen-scrollbar": "When the scrollbar on the right of the conversation is visible (fullscreen mode only).",
	"fullscreen-copy-on-select":
		"Copy text to the clipboard as soon as you select it with the mouse. Off: select, then press Ctrl+X to copy.",
	"fullscreen-wheel-scroll-lines": "Lines scrolled per mouse-wheel notch.",
	"fullscreen-exit-output": "What is printed in the terminal on leaving full-screen mode.",
	"clear-on-shrink": "Erase leftover empty lines when the screen content gets shorter. Can make the screen flicker.",
	"terminal-progress": "Show progress in the terminal's tab bar while the model works, in terminals that support it.",
	"block-images": "Do not send images to the model's service or server.",
	"auto-resize-images":
		"Shrink large images to at most 2000×2000 pixels before sending them; models accept them more reliably.",
	"default-project-trust":
		"When no saved choice or extension decides, choose whether to trust the folder. Trust allows its settings to load, missing project packages to be installed, and its extensions to run code.",
	transport: "Choose how to connect when the service offers a choice.",
	"http-idle-timeout":
		"How long an HTTP request can wait without receiving data. This is not a limit on the whole reply. Disable it if your local model pauses longer than the selected limit.",
	"cache-warming-mode":
		"Send extra requests to keep previously sent text cached for reuse. These requests may cost money.",
	warnings: "Choose which warnings Prism shows.",
	"cache-miss-notices":
		"Note in the conversation when the provider's prompt cache was missed (which costs more) and how it recovered.",
	"local-cloud-warning": "Show one quiet line when a request switches from a local model to a cloud model.",
	"trace-enabled":
		"Keep a local timeline of tool calls, permission decisions and results. Parameters are saved with known secrets masked. Off by default; changing this setting takes effect after /reload.",
	"trace-retention-days": "Delete operation trace files older than this many days at startup.",
	"collapse-changelog": "After an update, show a short summary of the changes instead of the full notes.",
	"default-model": "The model new sessions start with. /model changes the model of the current session.",
	"default-thinking":
		"How much the model thinks before answering, for new sessions and this one. Higher levels may take longer and cost more. A model's own level, below, wins.",
	"scoped-models": "Which models Ctrl+P cycles through (also /scoped-models).",
	"anthropic-extra-usage":
		"Warn when using an Anthropic subscription may incur extra charges. This warning does not block extra charges.",
};

/** What each built-in extension adds, for its on/off switch. */
export const EXTENSION_DESCRIPTIONS: Record<string, string> = {
	trace: "/trace: keeps a local timeline of the tools run, the permissions asked and their results, when you turn it on.",
	budgets: "/budget: limits on time, tool calls, tokens and cost for a session; 80% gives a warning.",
	"injection-warning":
		"Warns when a tool result looks like a prompt injection: stops the agent and asks whether to continue. A safety net, not the main protection.",
	"session-state":
		"On resume, shows what a session was doing when it stopped and what to do about a tool left unfinished; /state shows the same.",
	schedule:
		"/schedule: tasks that run by themselves at set times, created only after you read and confirm what they may do.",
	"portable-export":
		"/export-zip: an archive of the sessions and files you pick, to continue with a model in another tool. Known secrets are masked.",
	browser:
		"/browser: the agent opens and uses web pages in your own browser, in tabs of its own, through the Prism extension.",
	desktop:
		"/desktop: the agent uses graphical programs on a desktop of its own, with its own pointer and keyboard, apart from yours. Needs labwc.",
	"user-desktop":
		"The agent may use your own screen, pointer and keyboard when you ask it to and agree in Prism's dialog, until you take them back (your shortcut, or moving the mouse). Needs Hyprland, GNOME or KDE.",
	"generated-ui":
		"Lets the model show tables, charts, choices and forms from a fixed catalogue, instead of plain text.",
	"config-tool":
		"Lets the model change Prism's settings with the configure_prism tool, each change only after your answer. Security settings stay yours.",
	"capability-gates":
		"Follows what the model can do: without tool calls Prism replies without tools, without images an attachment is not sent, and it tells you why.",
	"llama.cpp": "Manages the models of a llama.cpp server in router mode: list, download from Hugging Face, load.",
	"claude-code":
		"Uses the Claude Code program installed on this computer, with your Claude subscription, as a model provider.",
	codemode:
		"A tool that runs a short script calling other tools; off until activated, MCP uses it for script-only tools.",
	"tool-search": "A tool to search the available tools, for when there are many; off until activated.",
	mcp: "Connects the MCP servers (external tool providers) listed in mcp.json.",
	prism: "Prism's look: header, composer, status bar, conversation and menus. Off shows the plain interface.",
	checkpoints: "Saves file snapshots before the model edits them, so you can roll back.",
	background: "Lets the model run long commands in the background and check on them later.",
	memory: "Keeps notes across sessions that the model can read and update.",
	"session-search":
		"Lets the model search your other sessions. Privacy: a cloud model then reads excerpts of them, perhaps private work held with a local model; Prism asks you first.",
	notify: "Desktop notification when the model finishes, or waits for your approval.",
	web: "Web search and page reading for the model.",
	"lsp-setup":
		"In a project with source code, says once which language servers to install, and /lsp-setup gives the command. Never installs anything by itself.",
	"reply-language": "Tells the model which language to answer in (Settings > Conversation > Reply language).",
	"machine-context":
		"Tells the model your system, desktop, processor, memory, free disk space and shell, so its commands fit your computer.",
	files: "A side panel to browse the project's files and add them to your message (alt+e, /files).",
	"append-system": "Adds your APPEND_SYSTEM.md file to the model's instructions.",
	agents: "Custom agents created with /agents, which the model runs with the agent tool.",
	skills: "/skills: install, turn on or off, update and remove skills. Off, the skills already set up still load.",
	"pi-lsp": "Checks code for errors with language servers (TypeScript, Python, …) when they are installed.",
	"pi-context-inspector": "/context: shows what fills the model's context.",
	"pi-plan-mode": "Plan mode: the model plans first and only reads files until you approve.",
	"pi-goal": "Goal mode: give the model a goal it keeps working towards across turns.",
	"rpiv-ask-user-question": "Lets the model ask you multiple-choice questions in a small form.",
	"project-continuity":
		'In a project with a project/handoff.md file, tells the model what each continuity document (spec, roadmap, journal, handoff, questions) is for and how to keep it current. Elsewhere, adds nothing to the prompt and shows an "init" button that runs /init.',
};

/**
 * fork.10.5 (simple settings readable by someone who never used an agent): each built-in
 * module's name in words; the module's own name stays in its description, where search finds it.
 */
export const EXTENSION_LABELS: Record<string, string> = {
	"llama.cpp": "llama.cpp models",
	"claude-code": "Claude Code subscription",
	codemode: "Tool scripts (codemode)",
	"tool-search": "Tool search",
	mcp: "MCP servers",
	trace: "Operation trace",
	budgets: "Session limits (budgets)",
	notify: "Desktop notifications",
	"injection-warning": "Prompt injection warning",
	files: "Files panel",
	"lsp-setup": "Language server suggestions",
	"reply-language": "Reply language",
	"machine-context": "Your computer, for the model",
	"project-continuity": "Project documents (/init)",
	checkpoints: "Undo file changes (checkpoints)",
	background: "Background commands",
	memory: "Memory across sessions",
	"session-search": "Search past sessions",
	"session-state": "Where a session stopped",
	web: "Web search",
	"append-system": "Extra instructions (APPEND_SYSTEM.md)",
	agents: "Custom agents",
	skills: "Skills",
	schedule: "Scheduled tasks",
	"portable-export": "Export as a zip",
	browser: "Your browser (Prism extension)",
	desktop: "The agent's own desktop",
	"user-desktop": "Your desktop",
	"generated-ui": "Tables, charts and forms",
	"config-tool": "Settings changed by the model",
	"pi-lsp": "Code checks (language servers)",
	"pi-context-inspector": "Context inspector",
	"pi-plan-mode": "Plan mode",
	"pi-goal": "Goal mode",
	"rpiv-ask-user-question": "Questions from the model",
	"capability-gates": "Model capability checks",
	prism: "Prism's look",
};

/**
 * fork: action commands /settings lists in its Other domain, when they exist in this session
 * . They act rather than set something, so a row runs the command.
 */
export const SETTINGS_SHORTCUTS: Array<{
	command: string;
	label: string;
	description: string;
	domain?: string;
	/** Acts on the PC's own screen: not offered on the phone (isPhoneClient). */
	pcOnly?: boolean;
	/** The window has its own entry for it: offered in the terminal only (isNativeMenusClient). */
	terminalOnly?: boolean;
}> = [
	{
		command: "login",
		label: "Sign in",
		description: "Sign in to a model service or add a server (also /login).",
		domain: "models",
	},
	{
		command: "onboarding",
		label: "First-run setup",
		description: "Go through the first-run choices again: theme, permissions, models (also /onboarding).",
	},
	{
		command: "trust",
		label: "Trust this folder",
		description: "Choose whether this project's settings, extensions and instructions apply (also /trust).",
	},
	{
		command: "budget",
		label: "Budgets of this session",
		description:
			"Limits on time, tool calls, tokens and cost for the current session only; defaults are in Conversation (also /budget).",
	},
	{
		command: "llama",
		label: "llama.cpp models",
		description: "Load, unload and download the models of a llama.cpp server in router mode (also /llama).",
	},
	// fork: Servers. fork: language servers open their manager, /lsp-setup, rather
	// than /lsp, which listed about forty servers in a warning.
	{
		command: "lsp-setup",
		label: "Language servers",
		description:
			"This project's language servers: install them, turn them on or off (also /lsp-setup; /lsp sums up their state).",
		domain: "servers",
	},
	{
		command: "mcp",
		label: "MCP connections",
		description: "Sign in to an MCP server, sign out, reconnect, and see each server's tools (also /mcp).",
		domain: "servers",
	},
	// fork: the browser's guided setup, in the Computer use domain.
	{
		command: "browser setup",
		label: "Set up a browser",
		description:
			"Step by step: choose the browser, add the Prism extension, then a check from end to end. Linking another browser makes it the one the agent uses (also /browser setup).",
		domain: "computer-use",
		pcOnly: true,
	},
	// updates, channel and rollback, under Other with the update mode.
	{
		command: "update",
		label: "Check for updates",
		description:
			"Asks the Prism site for a newer version and installs it on request; also switches between the stable and canary channels and goes back to the previous version (also /update).",
		pcOnly: true,
	},
	// /phone in the terminal's /settings, under Other. The window
	// links a phone from its own settings (Window > Link a phone).
	{
		command: "phone",
		label: "Link a phone",
		description:
			"The Prism app on Android uses this PC: the phone server, a pairing code as a QR code and as text, the phones linked and their removal (also /phone).",
		pcOnly: true,
		terminalOnly: true,
	},
];

/**
 * fork: what each choice of a setting does, shown under the setting and in its list of
 * choices. Keyed by setting id, then by the value as the setting lists it. On/off settings and plain numbers
 * need none: the setting's own description covers them.
 */
export const OPTION_DESCRIPTIONS: Record<string, Record<string, string>> = {
	// fork: the permission modes in /settings > Permissions & sandbox, as /perm describes them.
	"perm-mode": MODE_SUMMARIES,
	"perm-default-mode": MODE_SUMMARIES,
	// fork.12.
	"update-mode": {
		manual: "Only when you ask, with /update",
		"notify me": "Checks at start and tells you",
		automatic: "Checks at start and installs; the new version opens at the next start",
	},
	"mermaid-rendering": {
		streaming: "Drawn as soon as they arrive",
		final: "Drawn once the reply is finished",
		off: "Left as source text",
	},
	"quiet-startup": {
		false: "Header, loaded add-ons and tips",
		header: "Header only",
		true: "Nothing",
	},
	"steering-mode": {
		"one-at-a-time": "Each message waits for the previous one to be handled",
		all: "Waiting messages are sent together",
	},
	"follow-up-mode": {
		"one-at-a-time": "Each message waits for the previous one to be handled",
		all: "Waiting messages are sent together",
	},
	"double-escape-action": {
		tree: "Open /tree, the map of the session's branches",
		fork: "Pick an earlier message to start a new session from",
		none: "Nothing",
	},
	"tree-filter-mode": {
		default: "Messages and tool calls",
		"no-tools": "Messages, without tool results",
		"user-only": "Only your messages",
		"labeled-only": "Only entries you labelled",
		all: "Everything, settings changes included",
	},
	"tui-mode": {
		fullscreen: "Its own screen: mouse, scrollbar, menus on top",
		regular: "Text in the terminal's own history",
	},
	"fullscreen-scrollbar": {
		auto: "Shown while scrolling",
		always: "Always shown",
		hidden: "Never shown",
	},
	"fullscreen-exit-output": {
		transcript: "Prints the conversation in the terminal",
		"resume-hint": "Prints only how to reopen the session",
	},
	"fullscreen-wheel-scroll-lines": {
		auto: "Further when you spin the wheel quickly",
	},
	"default-project-trust": {
		Ask: "Ask the first time a folder is opened",
		"Always trust": "Load its settings and add-ons without asking",
		"Never trust": "Ignore its settings and add-ons",
	},
	transport: {
		auto: "The best the service offers",
		sse: "Updates over plain HTTP",
		websocket: "A two-way connection",
		"websocket-cached": "A two-way connection that reuses sent context",
	},
	"http-idle-timeout": {
		disabled: "Never cut a silent reply",
	},
	"cache-warming-mode": {
		off: "No extra requests",
		streaming: "While the model works",
		idle: "Also between tasks, while it saves more than it costs",
	},
	"reply-language": {
		auto: "The language of your latest message",
		English: "Always English",
		French: "Always French",
	},
	language: {
		auto: "The system language",
	},
	"interface-mode": {
		simple: "One line per action, essential settings",
		advanced: "Commands, output and every setting",
	},
};
