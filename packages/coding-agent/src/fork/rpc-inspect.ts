/**
 * fork: the data behind the terminal's /tree and /doctor screens, for an RPC client that draws
 * them with its own components instead of the terminal's. Read-only, except
 * the operations the terminal's screens run themselves: a label change and the navigation of /tree
 * (`navigateTree`, with or without a branch summary), the export of /doctor. Nothing here decides anything the
 * terminal does not: the same session calls, the same filters, the same masked report.
 *
 * Commands:
 * - `get_tree` → `{leafId, filterMode, askSummary, nodes: [{id, parentId, depth, branches, onPath, kind, role?,
 *   text, label?, timestamp, hidden?, setting?}]}`: the session tree in the terminal's order (the branch holding the
 *   current point first), depth growing only where the tree branches. `hidden`: an assistant step with only tool
 *   calls (the terminal hides it except at the current point); `setting`: bookkeeping entries (labels, model and
 *   level changes…) that its default filter hides. `askSummary`: whether the terminal asks for a branch summary.
 * - `get_tree_entry {entryId}` → `{text?}`: what the terminal's copy key copies for that entry.
 * - `tree_label {entryId, label?}` → `{}`: the terminal's label key (an empty label clears it).
 * - `tree_navigate {entryId, summarize?, instructions?}` → `{navigated, editorText?, message?, aborted?}`: the terminal's
 *   navigation once the point and the summary are chosen; a reply under way is stopped first, as there.
 * - `tree_abort` → `{}`: stops the branch summary under way (the terminal's Escape while it summarizes).
 * - `get_doctor` → `{createdAt, checks: [{component, status, observed, cause, action, detail}]}`: /doctor's report,
 *   translated and masked as the terminal shows it.
 * - `doctor_export {path}` → `{path}`: /doctor export, relative to the session's folder.
 * - `get_model_settings` → `{model: {provider, id, name}, serverKind?, intro, rows: [{key, label, type, server?, prism,
 *   on?, unset?, corrected}]}`: /model-settings's rows for the current model (model-settings.ts), the server read once when
 *   the screen opens, as there; `type` "bool" | "number" | "text" | "json" says how to edit the Prism value.
 * - `get_context` → `{model?, usage?, breakdown?, compaction: {auto}, systemPrompt, tools: [{name, description?, parameters: [{name, type,
 *   required, description?}]}], messages: [{role, title?, text, tokens}]}`: what /context inspects (the system prompt,
 *   the active tools' definitions, the messages the model gets), with the terminal's estimate of where the tokens go
 *   (context-breakdown.ts), and the context gauge's line on auto-compaction.
 * - `model_setting_set {key, value?}` → `{warning?, rows}`: the value typed as in the terminal (`parseSettingValue`;
 *   no value removes the correction), saved and applied to the session's model as the terminal does.
 * - `get_request_report`, `get_trace_report`, `get_session_report`, `get_lsp_report`: masked inspector snapshots;
 *   the loaded modules own trace and LSP readers, removed at session shutdown. LSP status starts no server.
 * - `request_export {path}` → `{path}`: the terminal's complete redacted /sent export, exclusive creation, 0600. It and
 *   `doctor_export` note the file they wrote, which `files_read` (rpc-builtins.ts) may send to a client on another machine.
 * - `checkpoints_get` → `{turns}`, `checkpoints_preview {turn}` → `{turn, revision, files, skipped}`,
 *   `checkpoints_restore {turn, revision}` → `{restored, removed, failed}`: the loaded module's rewind;
 *   refused during a working turn or when snapshots changed since the review.
 * - `lsp_setup_get {all?}`, `lsp_setup_set {name, enabled, all?}` → the setup module's state;
 *   `lsp_setup_install {name}` → `{line}` to put in the composer, never executed here; sudo is refused.
 * - `agents_get`, `agents_save {agent, existingName?}`, `agents_remove {name}`, `agents_policy {value}`:
 *   the loaded agent module's data and validated mutations. `agents_disable` saves the module switch and
 *   returns `{reload: true}`; refused during a working turn. Creation never overwrites an existing agent.
 *   `agents_stop {run}` stops an agent running in the background. `agents_get` also lists the
 *   session's runs; `agent_transcript {session}` → `{entries}`, a run's full transcript.
 */
import { dirname } from "node:path";
import type { ToolCall } from "@earendil-works/pi-ai";
import { getModelsPath } from "../config.ts";
import type { AgentSession } from "../core/agent-session.ts";
import { estimateTokens } from "../core/compaction/compaction.ts";
import { buildSessionContext, type SessionEntry, type SessionTreeNode } from "../core/session-manager.ts";
import { resolveToCwd } from "../core/tools/path-utils.ts";
import { agentTranscript } from "./agent-transcript.ts";
import { agentsPanel } from "./agents.ts";
import { capabilitiesPath, readCapabilities } from "./capability-store.ts";
import { checkpointPanel } from "./checkpoints.ts";
import { buildTokenBreakdown } from "./context-breakdown.ts";
import { buildDoctorReport, exportDoctorReport } from "./doctor.ts";
import { noteExported } from "./file-browser.ts";
import { t } from "./i18n/index.ts";
import { lspSnapshot } from "./lsp-inspector.ts";
import { lspSetupPanel } from "./lsp-setup.ts";
import {
	parseSettingValue,
	type RowKey,
	readModelCorrection,
	readServer,
	type ServerValues,
	saveSetting,
	settingRows,
} from "./model-settings.ts";
import { homeRelative } from "./path-within.ts";
import { autoCompactEnabled, compactionState } from "./prism/footer.ts";
import { autoCompactionLine, type ContextInfo } from "./prism/footer-actions.ts";
import { exportRequest, redact, requestReport } from "./request-inspector.ts";
import { sessionStateSnapshot } from "./session-state.ts";
import { pairToolCalls } from "./tool-call-occurrences.ts";
import { traceSnapshot } from "./trace.ts";

type Command = { type: string; [key: string]: unknown };

export const INSPECT_COMMANDS = new Set([
	"get_tree",
	"get_tree_entry",
	"tree_label",
	"tree_navigate",
	"tree_abort",
	"get_doctor",
	"doctor_export",
	"get_model_settings",
	"get_context",
	"model_setting_set",
	"get_request_report",
	"request_export",
	"get_session_report",
	"get_trace_report",
	"get_lsp_report",
	"checkpoints_get",
	"checkpoints_preview",
	"checkpoints_restore",
	"lsp_setup_get",
	"lsp_setup_set",
	"lsp_setup_install",
	"agents_get",
	"agents_save",
	"agents_remove",
	"agents_policy",
	"agents_disable",
	"agents_stop",
	"agent_transcript",
]);

export async function handleInspectCommand(command: Command, session: AgentSession): Promise<object> {
	const id = typeof command.entryId === "string" ? command.entryId : "";
	switch (command.type) {
		case "agents_get":
		case "agents_save":
		case "agents_remove":
		case "agents_policy":
		case "agents_disable":
		case "agents_stop": {
			const panel = agentsPanel(session.extensionRunner.createContext());
			if (!panel) throw new Error(t("module off"));
			if (command.type === "agents_save") panel.save(command.agent, command.existingName);
			if (command.type === "agents_policy") panel.policy(command.value);
			if (command.type === "agents_remove") {
				if (typeof command.name !== "string") throw new Error("name is required");
				panel.remove(command.name);
			}
			if (command.type === "agents_stop") {
				if (typeof command.run !== "string") throw new Error("run is required");
				await panel.stop(command.run);
			}
			if (command.type === "agents_disable") {
				panel.disable();
				return { reload: true };
			}
			return panel.snapshot();
		}
		case "agent_transcript": {
			if (!agentsPanel(session.extensionRunner.createContext())) throw new Error(t("module off"));
			if (typeof command.session !== "string") throw new Error("session is required");
			return agentTranscript(session.sessionManager, command.session);
		}
		case "lsp_setup_get":
		case "lsp_setup_set":
		case "lsp_setup_install": {
			const panel = lspSetupPanel(session.extensionRunner.createContext());
			if (!panel) throw new Error(t("module off"));
			if (command.type === "lsp_setup_get") return panel.snapshot(command.all === true);
			if (typeof command.name !== "string") throw new Error("name is required");
			if (command.type === "lsp_setup_install") return { line: panel.installCommand(command.name) };
			if (typeof command.enabled !== "boolean") throw new Error("enabled must be a boolean");
			panel.setEnabled(command.name, command.enabled);
			return panel.snapshot(command.all === true);
		}
		case "checkpoints_get":
		case "checkpoints_preview":
		case "checkpoints_restore": {
			const panel = checkpointPanel(session.extensionRunner.createContext());
			if (!panel) throw new Error(t("module off"));
			if (command.type === "checkpoints_get") return panel.snapshot();
			if (typeof command.turn !== "number") throw new Error("turn is required");
			if (command.type === "checkpoints_preview") return panel.preview(command.turn);
			if (typeof command.revision !== "string") throw new Error("revision is required");
			return panel.restore(command.turn, command.revision);
		}
		case "get_request_report":
			return requestReport(session.extensionRunner.createContext());
		case "request_export": {
			if (typeof command.path !== "string") throw new Error("path is required");
			const context = session.extensionRunner.createContext();
			const path = exportRequest(context, command.path);
			noteExported(context, path);
			return { path };
		}
		case "get_session_report":
			return redact(sessionStateSnapshot(session.extensionRunner.createContext())) as object;
		case "get_trace_report": {
			const data = traceSnapshot(session.extensionRunner.createContext());
			if (!data) throw new Error(t("module off"));
			return data;
		}
		case "get_lsp_report": {
			const data = lspSnapshot(session.extensionRunner.createContext());
			if (!data) throw new Error(t("module off"));
			return redact(data) as object;
		}
		case "get_tree":
			return treeData(session);
		case "get_tree_entry": {
			const entry = session.sessionManager.getEntry(id);
			const text = entry ? copyText(entry) : undefined;
			return text ? { text } : {};
		}
		case "tree_label": {
			if (!session.sessionManager.getEntry(id)) throw new Error(t("No entries in session"));
			const label = typeof command.label === "string" && command.label.trim() ? command.label.trim() : undefined;
			session.sessionManager.appendLabelChange(id, label);
			return {};
		}
		case "tree_navigate":
			return navigate(session, id, command.summarize === true, command.instructions);
		case "tree_abort":
			session.abortBranchSummary();
			return {};
		case "get_doctor":
			return buildDoctorReport(session.extensionRunner.createContext());
		case "doctor_export": {
			if (typeof command.path !== "string" || !command.path.trim()) throw new Error("path is required");
			const target = resolveToCwd(command.path.trim(), session.sessionManager.getCwd());
			exportDoctorReport(target, await buildDoctorReport(session.extensionRunner.createContext()));
			noteExported(session.extensionRunner.createContext(), target);
			return { path: target };
		}
		case "get_context":
			return contextData(session);
		case "get_model_settings":
			return modelSettings(session, true);
		case "model_setting_set":
			return await setModelSetting(session, command.key, command.value);
		default:
			throw new Error(`unknown command ${command.type}`);
	}
}

type TreeNode = {
	id: string;
	parentId: string | null;
	depth: number;
	branches: number;
	onPath: boolean;
	kind: string;
	role?: string;
	text: string;
	label?: string;
	timestamp: string;
	hidden?: true;
	setting?: true;
};

const SETTING_TYPES = new Set([
	"label",
	"context_edit",
	"custom",
	"model_change",
	"thinking_level_change",
	"session_info",
]);

function treeData(session: AgentSession): object {
	const manager = session.sessionManager;
	const roots = manager.getTree();
	const leafId = manager.getLeafId();
	// Which subtrees hold the current point: that branch is listed first, and its nodes are "on the path". They are
	// the current point and its ancestors, walked up by a loop (a recursive walk down overflowed the stack on a long session; the session manager refuses parent cycles)
	// .
	const onPath = new Set<string>();
	for (let entry = leafId ? manager.getEntry(leafId) : undefined; entry && !onPath.has(entry.id); ) {
		onPath.add(entry.id);
		entry = entry.parentId ? manager.getEntry(entry.parentId) : undefined;
	}
	const holds = (node: SessionTreeNode) => onPath.has(node.entry.id);
	const first = (nodes: SessionTreeNode[]) => [...nodes].sort((a, b) => Number(holds(b)) - Number(holds(a)));

	// A tool result is labelled by the call it answers: the call of that id in the nearest assistant message above it
	// (two turns or two branches may reuse an id, and the last call seen won).
	const { ownerOfResult } = pairToolCalls(manager.getEntries());
	const callOf = (resultId: string, callId: string): ToolCall | undefined => {
		const owner = manager.getEntry(ownerOfResult.get(resultId) ?? "");
		if (owner?.type !== "message" || owner.message.role !== "assistant") return undefined;
		for (const block of owner.message.content) if (block.type === "toolCall" && block.id === callId) return block;
		return undefined;
	};
	const nodes: TreeNode[] = [];
	const stack: Array<[SessionTreeNode, number]> = first(roots)
		.reverse()
		.map((node) => [node, roots.length > 1 ? 1 : 0]);
	while (stack.length > 0) {
		const [node, depth] = stack.pop()!;
		const entry = node.entry;
		if (entry.type !== "usage") nodes.push(describe(node, depth, holds(node), leafId, callOf));
		const childDepth = node.children.length > 1 ? depth + 1 : depth;
		for (const child of first(node.children).reverse()) stack.push([child, childDepth]);
	}
	return {
		leafId,
		filterMode: session.settingsManager.getTreeFilterMode(),
		askSummary: !session.settingsManager.getBranchSummarySkipPrompt(),
		nodes,
	};
}

function describe(
	node: SessionTreeNode,
	depth: number,
	onPath: boolean,
	leafId: string | null,
	callOf: (resultId: string, callId: string) => ToolCall | undefined,
): TreeNode {
	const entry = node.entry;
	const base = {
		id: entry.id,
		parentId: entry.parentId,
		depth,
		branches: node.children.length,
		onPath,
		timestamp: entry.timestamp,
		...(node.label ? { label: node.label } : {}),
		...(SETTING_TYPES.has(entry.type) ? { setting: true as const } : {}),
	};
	const line = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 300);
	switch (entry.type) {
		case "message": {
			const message = entry.message;
			if (message.role === "user")
				return { ...base, kind: "message", role: "user", text: line(contentText(message.content)) };
			if (message.role === "assistant") {
				const text = line(contentText(message.content));
				const failed = message.stopReason !== "stop" && message.stopReason !== "toolUse";
				return {
					...base,
					kind: "message",
					role: "assistant",
					text:
						text ||
						(message.stopReason === "aborted"
							? t("(aborted)")
							: line(message.errorMessage ?? "") || t("(no content)")),
					...(!text && !failed && entry.id !== leafId ? { hidden: true as const } : {}),
				};
			}
			if (message.role === "toolResult") {
				const call = callOf(entry.id, message.toolCallId);
				return {
					...base,
					kind: "tool",
					role: "toolResult",
					text: line(call ? toolLine(call.name, call.arguments) : message.toolName),
				};
			}
			if (message.role === "bashExecution")
				return { ...base, kind: "bash", role: "bashExecution", text: line(message.command) };
			return {
				...base,
				kind: "message",
				role: message.role,
				text: line(contentText("content" in message ? message.content : "")),
			};
		}
		case "custom_message":
			return { ...base, kind: "custom", text: line(`${entry.customType}: ${contentText(entry.content)}`) };
		case "compaction":
			return { ...base, kind: "compaction", text: line(entry.summary) };
		case "branch_summary":
			return { ...base, kind: "branch_summary", text: line(entry.summary) };
		case "model_change":
			return { ...base, kind: "model_change", text: entry.modelId };
		case "thinking_level_change":
			return { ...base, kind: "thinking_level_change", text: entry.thinkingLevel };
		case "label":
			return { ...base, kind: "label", text: entry.label ?? "" };
		case "session_info":
			return { ...base, kind: "session_info", text: entry.name ?? "" };
		case "custom":
			return { ...base, kind: "custom", text: entry.customType };
		case "context_edit":
			return { ...base, kind: "context_edit", text: entry.targetId };
		default:
			return { ...base, kind: entry.type, text: "" };
	}
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string",
		)
		.map((block) => block.text)
		.join("");
}

/** A tool call in one line, as the terminal's tree shows it (its target, home as ~). */
function toolLine(name: string, args: Record<string, unknown>): string {
	const short = (value: unknown) => homeRelative(String(value ?? ""));
	const target = args.command ?? args.path ?? args.file_path ?? args.pattern ?? args.query;
	return target === undefined ? name : `${name} ${short(target)}`;
}

/** What the terminal's tree copies for an entry (tree-selector.ts, getEntryCopyText). */
function copyText(entry: SessionEntry): string | undefined {
	let text: string | undefined;
	if (entry.type === "message") {
		const message = entry.message;
		if (message.role === "bashExecution") text = message.command;
		else if ("content" in message) {
			text = contentText(message.content);
			if (!text && message.role === "assistant") text = message.errorMessage;
		}
	} else if (entry.type === "custom_message") text = contentText(entry.content);
	else if (entry.type === "compaction" || entry.type === "branch_summary") text = entry.summary;
	return text?.trim() ? text : undefined;
}

async function navigate(session: AgentSession, id: string, summarize: boolean, instructions: unknown): Promise<object> {
	const manager = session.sessionManager;
	if (!manager.getEntry(id)) throw new Error(t("No entries in session"));
	if (id === manager.getLeafId()) return { navigated: false, message: t("Already at this point") };
	// The user committed to navigating: stop the active response first, as the terminal does.
	if (session.isStreaming) await session.abort();
	const customInstructions =
		summarize && typeof instructions === "string" && instructions.trim() ? instructions : undefined;
	const result = await session.navigateTree(id, { summarize, customInstructions });
	if (result.aborted) return { navigated: false, aborted: true, message: t("Branch summarization cancelled") };
	if (result.cancelled) return { navigated: false, message: t("Navigation cancelled") };
	return {
		navigated: true,
		...(result.editorText ? { editorText: result.editorText } : {}),
		message: t("Navigated to selected point"),
	};
}

// ------------------------------------------------------------------------------------------ /model-settings

const BOOL_ROWS = new Set<RowKey>(["vision", "toolImages", "reasoning", "tools"]);
const rowType = (key: RowKey) =>
	BOOL_ROWS.has(key) ? "bool" : key === "name" ? "text" : key === "extra" ? "json" : "number";

/** The server's values read when the screen opened, per session: the terminal reads them once per screen too. */
const servers = new WeakMap<AgentSession, { key: string; values: ServerValues | undefined }>();

async function modelSettings(session: AgentSession, readAgain: boolean): Promise<object> {
	const model = session.model;
	if (!model) throw new Error(t("No model selected. Choose one with /model."));
	const ctx = session.extensionRunner.createContext();
	const modelsPath = getModelsPath();
	const key = `${model.provider}/${model.id}`;
	let cached = servers.get(session);
	if (readAgain || cached?.key !== key) {
		cached = { key, values: await readServer(ctx.modelRegistry, modelsPath, model) };
		servers.set(session, cached);
	}
	const server = cached.values;
	const rows = settingRows(
		model,
		readModelCorrection(modelsPath, model.provider, model.id),
		server?.model,
		readCapabilities(capabilitiesPath(dirname(modelsPath)), model.provider, model.id),
	);
	return {
		model: { provider: model.provider, id: model.id, name: model.name },
		...(server ? { serverKind: server.kind } : {}),
		intro: server
			? t(
					`server: what ${server.kind} reports. Prism: what Prism sends or assumes; changing it does not change the server.`,
				)
			: t("This provider does not report its settings: only Prism's values are shown."),
		rows: rows.map((row) => ({
			...row,
			type: rowType(row.key),
			...(BOOL_ROWS.has(row.key) ? { on: row.prism === t("yes") } : {}),
			// No value of Prism's: the field is empty, the text says why.
			...(row.prism === t("not sent") || row.prism === t("not set") ? { unset: true } : {}),
		})),
	};
}

async function setModelSetting(session: AgentSession, key: unknown, typed: unknown): Promise<object> {
	const model = session.model;
	if (!model) throw new Error(t("No model selected. Choose one with /model."));
	const row = settingRows(model, {}, undefined).find((candidate) => candidate.key === key);
	if (!row) throw new Error(`unknown setting ${String(key)}`);
	const value = typeof typed === "string" && typed.trim() !== "" ? parseSettingValue(row.key, typed) : undefined;
	if (value instanceof Error) throw value;
	const modelsPath = getModelsPath();
	const capabilitiesFile = capabilitiesPath(dirname(modelsPath));
	const warning = await saveSetting(
		{ modelsPath, capabilitiesFile },
		model,
		row.key,
		value,
		servers.get(session)?.values?.kind,
	);
	// As the terminal's /model-settings: the registry reads models.json again, and the session takes the new model.
	const registry = session.extensionRunner.createContext().modelRegistry;
	await registry.refresh({ providers: [model.provider], allowNetwork: false });
	const updated = registry.find(model.provider, model.id);
	// fork: the setting is saved for its model; a model chosen meanwhile stays selected.
	const stillSelected = () => {
		const current = session.model;
		return current !== undefined && current.provider === model.provider && current.id === model.id;
	};
	if (updated && stillSelected()) await session.setModel(updated, { onlyIf: stillSelected });
	return { ...(warning ? { warning } : {}), ...(await modelSettings(session, false)) };
}

// --------------------------------------------------------------------------------------------------- /context

type Schema = { type?: string; description?: string; properties?: Record<string, Schema>; required?: string[] };

/** What the context gauge says: the measured share of the window and how auto-compaction runs here. */
export function contextInfo(session: AgentSession): ContextInfo {
	const ctx = session.extensionRunner.createContext();
	const usage = ctx.getContextUsage();
	const window = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	// fork: on/off and the threshold from the settings the engine compacts with.
	const compaction = compactionState(session.settingsManager, ctx.model, window);
	return {
		percent: usage?.percent ?? null,
		window,
		noModel: !ctx.model || (ctx.model.provider === "unknown" && ctx.model.id === "unknown"),
		auto: compaction?.auto ?? autoCompactEnabled(ctx.cwd, ctx.isProjectTrusted()),
		mark: compaction?.mark,
		threshold: compaction?.threshold,
	};
}

function contextData(session: AgentSession): object {
	const manager = session.sessionManager;
	const systemPrompt = session.systemPrompt ?? "";
	const usage = session.getContextUsage();
	const active = new Set(session.getActiveToolNames());
	const tools = session.getAllTools().filter((tool) => active.has(tool.name));
	const context = buildSessionContext(manager.getEntries(), manager.getLeafId());
	const model = session.model;
	const info = contextInfo(session);
	// fork: the parts of the context listed below, and the engine's threshold.
	const threshold = info.auto ? info.threshold : null;
	const breakdown = buildTokenBreakdown(systemPrompt, tools, context.messages, usage, threshold);
	return {
		...(model ? { model: { provider: model.provider, id: model.id, contextWindow: model.contextWindow } } : {}),
		...(usage ? { usage } : {}),
		...(breakdown ? { breakdown } : {}),
		// /context in the window also says how compaction runs, and offers to compact.
		compaction: { auto: autoCompactionLine(info) },
		systemPrompt,
		tools: tools.map((tool) => {
			const schema = (tool.parameters ?? {}) as Schema;
			return {
				name: tool.name,
				...(tool.description ? { description: tool.description } : {}),
				parameters: Object.entries(schema.properties ?? {}).map(([name, property]) => ({
					name,
					type: property.type ?? "",
					required: schema.required?.includes(name) ?? false,
					...(property.description ? { description: property.description } : {}),
				})),
			};
		}),
		messages: context.messages.map((message) => ({
			role: message.role,
			...messageTitle(message),
			text: messageText(message),
			tokens: estimateTokens(message),
		})),
	};
}

type ContextMessage = ReturnType<typeof buildSessionContext>["messages"][number];

/** What the terminal's Messages tab writes under the role: the model, the tool, the command… */
function messageTitle(message: ContextMessage): { title?: string } {
	switch (message.role) {
		case "assistant":
			return { title: [message.provider, message.model].filter(Boolean).join("/") };
		case "toolResult":
			return { title: message.isError ? `${message.toolName} · error` : message.toolName };
		case "bashExecution":
			return { title: message.command };
		case "custom":
			return { title: message.customType };
		default:
			return {};
	}
}

function messageText(message: ContextMessage): string {
	switch (message.role) {
		case "bashExecution":
			return message.output ?? "";
		case "branchSummary":
		case "compactionSummary":
			return message.summary;
		case "assistant":
			return message.content
				.map((block) =>
					block.type === "text"
						? block.text
						: block.type === "thinking"
							? block.thinking
							: block.type === "toolCall"
								? `${block.name} ${JSON.stringify(block.arguments)}`
								: "",
				)
				.filter(Boolean)
				.join("\n\n");
		default:
			if (!("content" in message)) return "";
			if (typeof message.content === "string") return message.content;
			return message.content
				.map((block) => (block.type === "text" ? block.text : block.type === "image" ? "[image]" : ""))
				.join("");
	}
}
