import type { InlineExtension } from "../core/extensions/types.ts";
// fork: user-created agents and the /agents screen.
import agentsExtension from "../fork/agents.ts";
// fork: home extensions.
import appendSystemExtension from "../fork/append-system.ts";
import backgroundExtension from "../fork/background.ts";
// the browser tool, through the Prism browser extension.
import browserExtension from "../fork/browser/index.ts";
// fork: enforce per-session execution limits.
import budgetsExtension from "../fork/budgets.ts";
// fork: features follow the model's capabilities.
import capabilityGates from "../fork/capability-gates.ts";
import checkpointsExtension from "../fork/checkpoints.ts";
// Claude models through the user's own Claude Code (`claude -p`), with Prism's tools.
import claudeCodeExtension from "../fork/claude-code/index.ts";
// fork: opt-in configuration writer; the permission guard remains always loaded.
import configTool from "../fork/config-tool.ts";
// the agent's own desktop (headless labwc).
import desktopExtension from "../fork/desktop/index.ts";
// fork: the user's own desktop, a module of its own.
import userDesktopExtension from "../fork/desktop/user-tool.ts";
import docsCommand from "../fork/docs-command.ts";
// fork: local diagnostics and the /doctor report.
import doctorExtension from "../fork/doctor.ts";
// fork: the engine's technical log for the window's and the phone's Logs panel.
import engineLog from "../fork/engine-log.ts";
import fileAttachments from "../fork/file-attachments.ts";
import fileBrowser from "../fork/file-browser.ts";
// generated UI.
import generatedUi from "../fork/generated-ui.ts";
import imageAttachments from "../fork/image-attachments.ts";
import injectionWarning from "../fork/injection-warning.ts";
import lspSetup from "../fork/lsp-setup.ts";
import machineContext from "../fork/machine-context.ts";
import memoryExtension from "../fork/memory.ts";
// fork: /model-settings, server values next to Prism's.
import modelSettings from "../fork/model-settings.ts";
// fork: on-demand, offline module cost probe.
import moduleCostProbe from "../fork/module-cost-probe.ts";
import notifyExtension from "../fork/notify.ts";
// fork: first-start choices, /onboarding.
import onboarding from "../fork/onboarding.ts";
// fork: permission gate.
import permissionsExtension from "../fork/permissions.ts";
import phoneLink from "../fork/phone-link.ts";
// fork.9 (CAP-02): /export-zip, a portable archive of chosen sessions and files.
import { portableExport } from "../fork/portable-export.ts";
// fork: Prism visual pack.
import prismExtension from "../fork/prism/index.ts";
// fork: project continuity.
import projectContinuity from "../fork/project-continuity.ts";
import replyLanguage from "../fork/reply-language.ts";
import requestInspector from "../fork/request-inspector.ts";
// fork.9 (CAP-01): /schedule, scheduled tasks on systemd user timers.
import { scheduleCommand } from "../fork/schedule-command.ts";
import { realSystemd } from "../fork/scheduled-tasks.ts";
import secretsExtension from "../fork/secrets/extension.ts";
// fork: the model list of each server the user added, read again at start.
import serverModelRefresh from "../fork/server-model-refresh.ts";
// fork: home extensions.
import sessionSearchExtension from "../fork/session-search.ts";
// fork: what an interrupted session left, /state.
import sessionStateExtension from "../fork/session-state.ts";
// /skills over pi's own skill mechanism.
import skillsExtension from "../fork/skills.ts";
// fork.9 (SEC-04): the sudo tool, off unless the user turns it on.
import { sudoExtension } from "../fork/sudo.ts";
// fork: opt-in local JSONL operation timeline.
import traceExtension from "../fork/trace.ts";
// /update and the update mode at start.
import updatesExtension from "../fork/updates.ts";
import { vendoredExtension } from "../fork/vendored.ts";
import webExtension from "../fork/web.ts";
import codemodeExtension from "./codemode/index.ts";
import llamaExtension from "./llama/index.ts";
import mcpExtension from "./mcp/index.ts";
import toolSearchExtension from "./tool-search/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, builtin: true },
	// offered in /login; nothing runs until the user chooses it there.
	{ name: "claude-code", factory: claudeCodeExtension, builtin: true },
	// Replaceable: an extension that registers `codemode`, `tool_search`, or `/mcp` (such as a third-party
	// MCP extension) takes over instead of running alongside the built-in one.
	{ name: "codemode", factory: codemodeExtension, replaceable: true, builtin: true },
	{ name: "tool-search", factory: toolSearchExtension, replaceable: true, builtin: true },
	{ name: "mcp", factory: mcpExtension, replaceable: true, builtin: true },
	// fork: runs before the permission gate so each call is recorded first.
	{ name: "trace", factory: traceExtension, builtin: true },
	// fork: user-set limits apply in interactive and automated modes.
	{ name: "budgets", factory: budgetsExtension, builtin: true },
	// fork: before the permission gate, so its `tool_call` handler arms the approval notice before the gate
	// awaits the answer.
	{ name: "notify", factory: notifyExtension, replaceable: true, builtin: true },
	// fork: not `builtin`, so --no-extensions, --safe and the `extensions` setting keep it loaded.
	// Replaceable: a user extension that registers `/perm` or its flags (such as the pi-custom original)
	// takes over instead of failing on the name conflict. A project extension cannot.
	{ name: "permissions", factory: permissionsExtension, replaceable: true, userReplaceableOnly: true },
	// fork: not `builtin` either: the secrets kept out of the model's commands, and their masking.
	{ name: "secrets", factory: secretsExtension },
	{ name: "injection-warning", factory: injectionWarning, builtin: true },
	// fork.10 (LIV-08): a screenshot pasted in the terminal is sent as an image; not `builtin`, so always on.
	{ name: "image-attachments", factory: imageAttachments },
	// files added to a message from outside the project, copied for the agent and kept with the session.
	{ name: "file-attachments", factory: fileAttachments },
	// fork.9 (SEC-04): not `builtin` and not replaceable; registers nothing unless `sandbox.sudo` is on.
	{ name: "sudo", factory: sudoExtension() },
	// fork: `builtin`, so `-builtin:prism`, --no-extensions and --safe give the vanilla interface.
	{ name: "prism", factory: prismExtension, builtin: true },
	// fork: /docs, the shipped documentation in a reader; always on.
	{ name: "docs", factory: docsCommand },
	// fork: /doctor, local read-only diagnostics; always on.
	{ name: "doctor", factory: doctorExtension },
	// /update, and the startup check or install the update mode asks for; always on.
	{ name: "updates", factory: updatesExtension },
	// fork: on-demand view of the last transport payload.
	{ name: "request-inspector", factory: requestInspector },
	// fork: what went well too in the Logs panel (RPC mode only); always on.
	{ name: "engine-log", factory: engineLog },
	// fork: the file browser side panel (alt+e, /files); `builtin`, so /settings turns it off.
	{ name: "files", factory: fileBrowser, builtin: true },
	// fork: /phone, the window's "Link a phone" in the terminal; always on.
	{ name: "phone-link", factory: phoneLink },
	// fork: /model-settings, the current model's limits and sampling next to the server's; always on.
	{ name: "model-settings", factory: modelSettings },
	// fork: at start and on "model not found", a server's model list is read again; always on.
	{ name: "server-model-refresh", factory: serverModelRefresh },
	// fork: the onboarding (/onboarding), opened by itself at the first start without a model; always on.
	{ name: "onboarding", factory: onboarding },
	// fork: language server suggestions for coding projects (/lsp-setup); off with pi-lsp.
	{ name: "lsp-setup", factory: lspSetup, builtin: true },
	// fork: the reply language section of the system prompt.
	{ name: "reply-language", factory: replyLanguage, builtin: true },
	// fork: the user's system, hardware and shell in the system prompt.
	{ name: "machine-context", factory: machineContext, builtin: true },
	// fork: project continuity documents and their rules in the prompt; on by default.
	{ name: "project-continuity", factory: projectContinuity, builtin: true },
	// fork: home extensions. `builtin`, so the `extensions` setting turns each one off; replaceable,
	// so a user copy (such as the pi-custom original) takes over instead of failing on the name conflict.
	{ name: "checkpoints", factory: checkpointsExtension, replaceable: true, builtin: true },
	{ name: "background", factory: backgroundExtension, replaceable: true, builtin: true },
	// Off by default: `+builtin:memory` in the `extensions` setting turns it on.
	{ name: "memory", factory: memoryExtension, replaceable: true, builtin: true, disabledByDefault: true },
	{
		name: "session-search",
		factory: sessionSearchExtension,
		replaceable: true,
		builtin: true,
		// fork: off by default, a model would otherwise read the user's other sessions.
		disabledByDefault: true,
	},
	// fork: interrupted tool calls shown on resume, and /state.
	{ name: "session-state", factory: sessionStateExtension, builtin: true },
	{ name: "web", factory: webExtension, replaceable: true, builtin: true },
	// the user's own browser, through the Prism extension.
	{ name: "browser", factory: browserExtension, builtin: true, disabledByDefault: true },
	// the agent's own desktop, apart from the user's.
	{ name: "desktop", factory: desktopExtension, builtin: true, disabledByDefault: true },
	// fork: the user's own desktop, off by default, its own switch.
	{ name: "user-desktop", factory: userDesktopExtension, builtin: true, disabledByDefault: true },
	{ name: "append-system", factory: appendSystemExtension, builtin: true },
	{ name: "agents", factory: agentsExtension, builtin: true },
	{ name: "skills", factory: skillsExtension, builtin: true },
	{ name: "schedule", factory: scheduleCommand(realSystemd), builtin: true },
	{ name: "portable-export", factory: portableExport, builtin: true },
	// show_ui, tables, charts, choices and forms the model shows; a terminal shows them as text.
	{ name: "generated-ui", factory: generatedUi, builtin: true },
	{ name: "config-tool", factory: configTool, builtin: true, disabledByDefault: true },
	// fork: third-party plugins, vendored unchanged (vendor/README.md).
	{
		name: "pi-lsp",
		// fork: Prism's fork, malformed server edits refused, linear reading (vendor/forks/pi-lsp/FORK.md).
		factory: vendoredExtension("../forks/pi-lsp/dist/index.ts"),
		replaceable: true,
		builtin: true,
	},
	{
		name: "pi-context-inspector",
		factory: vendoredExtension("../forks/pi-context-inspector/index.ts"),
		replaceable: true,
		builtin: true,
	},
	{
		name: "pi-plan-mode",
		// fork: Prism's fork, alt+p toggle and a shorter tool list (vendor/forks/pi-plan-mode/FORK.md).
		factory: vendoredExtension("../forks/pi-plan-mode/dist/index.ts"),
		replaceable: true,
		builtin: true,
	},
	{
		name: "pi-goal",
		// fork: Prism's fork, its menus translated (vendor/forks/pi-goal/FORK.md).
		factory: vendoredExtension("../forks/pi-goal/dist/index.ts"),
		replaceable: true,
		builtin: true,
	},
	{
		name: "rpiv-ask-user-question",
		// fork: Prism's fork, without the import cycle that hung the prebundled plugin.
		factory: vendoredExtension("../forks/rpiv-ask-user-question/index.ts"),
		replaceable: true,
		builtin: true,
	},
	// fork: turns off what the model lacks and names an unknown capability when a request fails.
	// Last, so its before_agent_start runs after the plugins that turn their own tools back on.
	{ name: "capability-gates", factory: capabilityGates, builtin: true },
	// fork: internal provider, inert unless a measurement child requests it.
	{ name: "module-cost-probe", factory: moduleCostProbe, builtin: true },
];
