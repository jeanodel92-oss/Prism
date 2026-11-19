import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { getAgentDir } from "../config.ts";
import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";
import type { Theme } from "../modes/interactive/theme/theme.ts";
import { parseFrontmatter } from "../utils/frontmatter.ts";
import { AgentActivity, type AgentStep, stepLine } from "./agent-activity.ts";
import { agentSessionDir } from "./agent-transcript.ts";
import { getExtensionArgs, getPiInvocation } from "./child-invocation.ts";
import { appendStderrTail, ChildLines, launch } from "./child-process.ts";
import { readGlobalSetting, saveGlobalSetting } from "./global-settings.ts";
import { fill, t } from "./i18n/index.ts";
import {
	type ChildPermissions,
	childPermissionArgs,
	childPermissions,
	isWiderMode,
	watchChildPermissions,
} from "./permissions.ts";
import { existingSessionTmpDir, SHARED_TMP_ENV } from "./sandbox/runtime.ts";

export const AGENT_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"] as const;
/**
 * besides the built-in tools chosen for it, an agent gets every tool of
 * the session (background, web, LSP, MCP, browser…) except these, which address the user or run the session itself:
 * questions, generated UIs, plan mode, goals, proposals to approve, Prism's configuration, sudo's password, and
 * agents themselves (an agent does not start agents).
 */
export const NOT_FOR_AGENTS: ReadonlySet<string> = new Set([
	"agent",
	"ask_user_question",
	"show_ui",
	"plan_mode_question",
	"plan_mode_complete",
	"goal_wait",
	"goal_complete",
	"goal_blocked",
	"propose_scope",
	"propose_scheduled_task",
	"configure_prism",
	"sudo",
]);
/** The background module's message when a task ends (background.ts). */
const TASK_ENDED = "background-task-ended";
/** what the main session receives when an agent's background task ends after its answer. */
export const AGENT_BACKGROUND_MESSAGE = "agent-background";
/** what the main session receives when an agent run in the background answers or fails. */
export const AGENT_ANSWER_MESSAGE = "agent-answer";
/** The details of an agent's answer message, and of its tool result. */
export interface AgentRunDetails {
	agent?: string;
	/** The run's id ("ag1"), set while it runs in the background. */
	id?: string;
	task?: string;
	steps?: AgentStep[];
	dropped?: number;
	/** The tool started the agent in the background: its answer comes as a message. */
	started?: boolean;
	failed?: boolean;
	/** The user stopped it before it answered. */
	stopped?: boolean;
	model?: string;
	usage?: unknown;
	toolsUsed?: string[];
	/** the id of the agent's own session, which holds its full transcript (agent-transcript.ts). */
	session?: string;
}
const DEFAULT_AGENT_TOOLS = ["read", "grep", "find", "ls"];
const MAX_RESULT_CHARS = 30_000;
// fork: what the model reads stays in English whatever the interface language;
// renderResult shows these texts translated.
const NO_TEXT = "The agent returned no text.";
const TRUNCATED = "Answer truncated.";
const UNKNOWN_AGENT = "Unknown agent: ";
const EXITED = "Agent exited with code ";
const NO_MODEL = "Choose a model before running an agent.";
/** The start of the tool's text when the agent runs in the background (renderResult and the window recognise it). */
const STARTED_PREFIX = "Started agent ";
/** fork: what an agent is, above the list of /agents; one sentence, so the window stays short. */
const AGENTS_HELP = [
	"An agent is your own helper: its instructions, model and tools. When a task fits its purpose, the model runs it, or ask for it by name.",
];

/**
 * when the model may call an agent, in settings.json under `agentInvocation`. Autonomous by default,
 * as before. On request: when the user's latest message asks for an agent in their own words, a rule the model follows,
 * or contains the keyword, which Prism checks: when the keyword is the only way, a call without it is refused.
 */
/** Under the policy choices: what Prism checks and what it cannot. */
const INVOCATION_HELP = [
	"Prism checks the keyword. A request in your own words is a rule the model follows, not a check.",
	"Either way, what an agent does still goes through your permissions.",
];
const STOP_DETAIL = "It stops before it answers. What it already did stays, and the model is told it was stopped.";
const TURN_OFF_DETAIL =
	"The agent tool and /agents stop until you turn them back on in /settings › Modules. Your agents are kept.";

/** The policy in one line, above the list of /agents. */
function policySummary(policy: AgentInvocation): string {
	if (policy.autonomous) return t("Runs agents: on its own, when a task fits.");
	if (policy.explicitRequest && policy.keyword)
		return fill("Runs agents: when you ask for one or write {0}.", policy.keywordText);
	return policy.keyword
		? fill("Runs agents: only when you write {0}.", policy.keywordText)
		: t("Runs agents: when you ask for one.");
}

export interface AgentInvocation {
	autonomous: boolean;
	explicitRequest: boolean;
	keyword: boolean;
	keywordText: string;
}

export const DEFAULT_KEYWORD = "@agent";
const KEYWORD_PATTERN = /^\S{1,32}$/;

export function readAgentInvocation(): AgentInvocation {
	const value = readGlobalSetting("agentInvocation");
	const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
	const explicitRequest = record.explicitRequest !== false;
	const keyword = record.keyword !== false;
	const text = typeof record.keywordText === "string" ? record.keywordText.trim() : "";
	return {
		// With no way left to ask for an agent, the model calls them on its own, as by default.
		autonomous: record.autonomous !== false || (!explicitRequest && !keyword),
		explicitRequest,
		keyword,
		keywordText: KEYWORD_PATTERN.test(text) ? text : DEFAULT_KEYWORD,
	};
}

/** Whether only the keyword lets the model call an agent: the one policy Prism can enforce. */
const keywordOnly = (policy: AgentInvocation) => !policy.autonomous && policy.keyword && !policy.explicitRequest;

/** What the tool description says about the policy; the model reads it in English. */
export function invocationRule(policy: AgentInvocation): string {
	if (policy.autonomous) return "";
	const ways = [
		policy.explicitRequest ? "explicitly asks for an agent" : undefined,
		policy.keyword ? `contains ${policy.keywordText}` : undefined,
	].filter(Boolean);
	return ` Call it only when the user's latest message ${ways.join(" or ")}${keywordOnly(policy) ? "; any other call is refused" : ""}.`;
}

/** The keyword as a word of its own, whatever its case: "@agent" matches "ask @Agent to", not "@agents". */
export function mentionsKeyword(text: string, keyword: string): boolean {
	const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(^|[^\\w@])${escaped}(?![\\w-])`, "i").test(text);
}

/** Turns the module off in the user `extensions` setting, as /settings › Modules does (setBuiltinExtensionEnabled). */
function turnAgentsOff(): void {
	const current = readGlobalSetting("extensions");
	const entries = Array.isArray(current) ? current.filter((entry): entry is string => typeof entry === "string") : [];
	const kept = entries.filter((entry) => entry.replace(/^[+!-]/, "") !== "builtin:agents");
	saveGlobalSetting(["extensions"], [...kept, "-builtin:agents"]);
}

export interface CustomAgent {
	name: string;
	description: string;
	model?: string;
	tools: string[];
	instructions: string;
}

interface AgentsPanel {
	snapshot(): {
		agents: CustomAgent[];
		tools: readonly string[];
		defaultTools: readonly string[];
		models: string[];
		invocation: AgentInvocation;
		help: string[];
		policyHelp: string[];
		offDetail: string;
		/** the agents running in the background, with their current step. */
		running: Array<{ id: string; agent: string; step: string }>;
		/** this session's agent runs, oldest first, for the window's side menu. */
		runs: AgentRun[];
	};
	/** Resolves once the agent has ended. */
	stop(id: string): Promise<void>;
	save(value: unknown, existingName?: unknown): void;
	remove(name: string): void;
	policy(value: unknown): void;
	disable(): void;
}

/** an agent run of the session, running or ended; `session` names its transcript (agent-transcript.ts). */
export interface AgentRun {
	id: string;
	agent: string;
	task: string;
	state: "running" | "answered" | "failed" | "stopped";
	step?: string;
	session?: string;
}

const panels = new WeakMap<ExtensionContext["sessionManager"], AgentsPanel>();

export function agentsPanel(ctx: ExtensionContext): AgentsPanel | undefined {
	return panels.get(ctx.sessionManager);
}

export function isValidAgentName(name: string): boolean {
	return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}

/**
 * the name typed for a new agent, as a valid one: "Relecteur de Code" is
 * "relecteur-de-code". Capitals and spaces were refused with no word on the format.
 */
export function agentName(typed: string): string {
	return typed
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

export function agentsDir(agentDir = getAgentDir()): string {
	return join(agentDir, "agents");
}

export function agentFilePath(name: string, agentDir = getAgentDir()): string {
	if (!isValidAgentName(name)) throw new Error("Use lowercase letters, numbers, and dashes.");
	return join(agentsDir(agentDir), `${name}.md`);
}

export function writeAgent(agent: CustomAgent, agentDir = getAgentDir(), exclusive = false): string {
	if (!isValidAgentName(agent.name)) throw new Error("Use lowercase letters, numbers, and dashes.");
	if (!agent.description.trim()) throw new Error("Purpose cannot be empty.");
	if (!agent.tools.length || agent.tools.some((name) => !(AGENT_TOOLS as readonly string[]).includes(name))) {
		throw new Error("Choose at least one available tool.");
	}
	const path = agentFilePath(agent.name, agentDir);
	mkdirSync(agentsDir(agentDir), { recursive: true });
	const model = agent.model ? `model: ${JSON.stringify(agent.model)}\n` : "";
	writeFileSync(
		path,
		`---\nname: ${agent.name}\ndescription: ${JSON.stringify(agent.description.trim())}\ntools: ${agent.tools.join(", ")}\n${model}---\n\n${agent.instructions.trim()}\n`,
		{ encoding: "utf8", flag: exclusive ? "wx" : "w" },
	);
	return path;
}

export function readAgents(agentDir = getAgentDir()): CustomAgent[] {
	const dir = agentsDir(agentDir);
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
		.flatMap((entry) => {
			try {
				const { frontmatter, body } = parseFrontmatter(readFileSync(join(dir, entry.name), "utf8"));
				if (
					typeof frontmatter.name !== "string" ||
					!isValidAgentName(frontmatter.name) ||
					typeof frontmatter.description !== "string" ||
					typeof frontmatter.tools !== "string"
				)
					return [];
				return [
					{
						name: frontmatter.name,
						description: frontmatter.description,
						model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
						tools: frontmatter.tools
							.split(",")
							.map((tool) => tool.trim())
							.filter(Boolean),
						instructions: body.trim(),
					},
				];
			} catch {
				return [];
			}
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

export function buildAgentInvocation(
	agent: CustomAgent,
	currentModel: string,
	extensions = getExtensionArgs(),
	permissions: string[] = [],
	sessionTools: readonly string[] = [],
	/** the agent's own session, kept for its transcript; without one, it keeps none. */
	session?: { dir: string; id: string },
): string[] {
	const builtIn: readonly string[] = AGENT_TOOLS;
	const others = sessionTools.filter((name) => !builtIn.includes(name) && !NOT_FOR_AGENTS.has(name));
	return [
		"--mode",
		"rpc",
		...(session ? ["--session-dir", session.dir, "--session-id", session.id] : ["--no-session"]),
		"--model",
		agent.model ?? currentModel,
		"--tools",
		[...agent.tools, ...others].join(","),
		"--exclude-tools",
		AGENT_TOOLS.filter((name) => !agent.tools.includes(name)).join(","),
		"--append-system-prompt",
		agent.instructions,
		...permissions,
		...extensions,
	];
}

function rpcResponse(id: string, value: string | boolean | undefined): string {
	const response =
		value === undefined
			? { type: "extension_ui_response", id, cancelled: true }
			: typeof value === "boolean"
				? { type: "extension_ui_response", id, confirmed: value }
				: { type: "extension_ui_response", id, value };
	return `${JSON.stringify(response)}\n`;
}

function stringField(value: unknown, field: string): string | undefined {
	if (!value || typeof value !== "object" || !(field in value)) return undefined;
	const fieldValue = (value as Record<string, unknown>)[field];
	return typeof fieldValue === "string" ? fieldValue : undefined;
}

/** The id of the agent's first prompt, whose response says whether its turn started. */
const START_PROMPT_ID = "agent-task";
/** fork: the ids of the parent's later restrictions, and how long the agent has to apply one. */
const RESTRICTION_ID = "agent-restriction-";
const RESTRICTION_ACK_MS = 10_000;

async function runAgent(
	agent: CustomAgent,
	task: string,
	cwd: string,
	ui: ExtensionContext["ui"],
	hasUI: boolean,
	currentModel: string,
	permissions: string[],
	signal: AbortSignal | undefined,
	onUpdate: ((text: string, activity: { steps: AgentStep[]; dropped: number }) => void) | undefined,
	sessionTools: readonly string[] = [],
	later?: (report: string) => void,
	/** The session's private /tmp, which the agent shares. */
	tmp?: string,
	session?: { dir: string; id: string },
	/** fork: the parent's live permissions, for the restrictions it adds later. */
	restrictions?: { now: () => ChildPermissions | undefined; watch: (listener: () => void) => () => void },
): Promise<{
	agent: string;
	text: string;
	model?: string;
	usage?: unknown;
	toolsUsed: string[];
	activity: { steps: AgentStep[]; dropped: number };
	/** Its background tasks still running when it answered. */
	running: Array<{ id: string; command: string }>;
	/**
	 * fork: the agent's process ends, after its answer when background
	 * tasks still run. Until then it stays stoppable and is stopped with the session.
	 */
	exited: Promise<void>;
}> {
	const argv = buildAgentInvocation(agent, currentModel, getExtensionArgs(), permissions, sessionTools, session);
	const invocation = getPiInvocation(argv);
	// fork: in its own process group, stopped with it (SIGTERM, then SIGKILL).
	const launched = launch(invocation.command, invocation.args, {
		cwd,
		stdio: ["pipe", "pipe", "pipe"],
		...(tmp ? { env: { ...process.env, [SHARED_TMP_ENV]: tmp } } : {}),
	});
	const child = launched.child;
	const stdout = new ChildLines();
	let stderr: Buffer = Buffer.alloc(0);
	let finalText = "";
	let model: string | undefined;
	let usage: unknown;
	const toolsUsed = new Set<string>();
	// each step of the agent, sent with every update and kept in the result (agent-activity.ts).
	const activity = new AgentActivity();
	let status = "";
	/**
	 * an agent's background tasks live as long as its process, whose
	 * sandbox, output and Git copies they use. When it answers while some still run, the tool returns, and its
	 * process stays until they have ended: it receives each end as the main session would, answers it, and that
	 * report reaches the main session as a message (`later`).
	 */
	const running = new Map<string, string>();
	const backgroundCalls = new Map<string, Record<string, unknown>>();
	let reports: string[] = [];
	let answered = false;
	const runningList = () => [...running].map(([id, command]) => ({ id, command }));
	const update = (text = status) => {
		status = text;
		if (!answered) onUpdate?.(text, activity.snapshot());
	};
	let settled = false;
	let terminating = false;
	let terminationError: string | undefined;
	const dialogs = new AbortController();
	let markExited = () => {};
	const exited = new Promise<void>((resolve) => {
		markExited = resolve;
	});
	return await new Promise((resolve, reject) => {
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			// An answer given while its background tasks run leaves the process stoppable until it closes.
			if (running.size === 0) signal?.removeEventListener("abort", abort);
			if (error) reject(error);
			else
				resolve({
					agent: agent.name,
					text: finalText.trim() || stderr.toString("utf8").trim() || NO_TEXT,
					model,
					usage,
					toolsUsed: [...toolsUsed],
					activity: activity.snapshot(),
					running: runningList(),
					exited,
				});
		};
		const abort = () => {
			if (terminating) return;
			terminating = true;
			terminationError = "Agent stopped.";
			void launched.stop();
		};
		const answerDialog = async (request: Record<string, unknown>) => {
			const id = stringField(request, "id");
			const method = stringField(request, "method");
			if (!id || !method) return;
			if (!hasUI) {
				child.stdin.write(rpcResponse(id, undefined));
				return;
			}
			const title = fill("{0}: {1}", agent.name, stringField(request, "title") ?? t("Agent permission"));
			let answer: string | boolean | undefined;
			// an agent that ends (stopped by the user) closes the question it left open.
			// fork: the agent's question keeps its red warning.
			const warning = stringField(request, "warning");
			const opts = { signal: dialogs.signal, ...(warning ? { warning } : {}) };
			if (method === "select") {
				const options = request.options;
				if (Array.isArray(options) && options.every((item) => typeof item === "string"))
					answer = await ui.select(title, options, opts);
			} else if (method === "confirm") {
				const message = stringField(request, "message") ?? "";
				answer = await ui.confirm(title, message, opts);
			} else if (method === "input") {
				answer = await ui.input(title, stringField(request, "placeholder"), opts);
			} else if (method === "editor") {
				answer = await ui.editor(title, stringField(request, "prefill"), opts);
			}
			if (!dialogs.signal.aborted) child.stdin.write(rpcResponse(id, answer));
		};
		const onData = (chunk: string) => {
			if (terminating) return;
			const parsed = stdout.push(chunk);
			if (parsed.overflow) {
				terminating = true;
				terminationError = "Agent output line exceeded the 32 MiB limit.";
				void launched.stop();
				return;
			}
			for (const line of parsed.lines) {
				if (!line.trim()) continue;
				let record: Record<string, unknown>;
				try {
					const parsed: unknown = JSON.parse(line);
					if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
					record = parsed as Record<string, unknown>;
				} catch {
					continue;
				}
				if (record.type === "response" && acknowledged(record)) continue;
				if (record.type === "extension_ui_request") void answerDialog(record);
				// fork: the first prompt refused before its turn ends the run with the
				// agent's error; handled without a turn, the agent has nothing more to do.
				if (record.type === "response" && record.id === START_PROMPT_ID) {
					if (record.success === false) {
						terminating = true;
						terminationError = stringField(record, "error") ?? "The agent refused its task.";
						void launched.stop();
						return;
					}
					if ((record.data as { disposition?: unknown } | undefined)?.disposition === "handled") child.stdin.end();
				}
				const stepped = activity.record(record);
				if (record.type === "tool_execution_start" && typeof record.toolName === "string") {
					toolsUsed.add(record.toolName);
					if (record.toolName === "background" && typeof record.toolCallId === "string")
						backgroundCalls.set(record.toolCallId, (record.args ?? {}) as Record<string, unknown>);
					update(fill("{0} is using {1}", agent.name, record.toolName));
				} else if (stepped) update();
				if (record.type === "tool_execution_end" && record.toolName === "background" && record.isError !== true) {
					const args = backgroundCalls.get(String(record.toolCallId)) ?? {};
					const id = (record.result as { details?: { id?: unknown } } | undefined)?.details?.id;
					if (typeof id === "string" && args.action === "run") running.set(id, String(args.command ?? ""));
					if (typeof id === "string" && args.action === "kill") running.delete(id);
				}
				if (record.type === "message_end" && record.message && typeof record.message === "object") {
					const message = record.message as {
						role?: unknown;
						content?: unknown;
						model?: unknown;
						usage?: unknown;
					};
					if (message.role === "custom" && (message as { customType?: unknown }).customType === TASK_ENDED) {
						const id = (message as { details?: { id?: unknown } }).details?.id;
						if (typeof id === "string") running.delete(id);
						const content = message.content;
						reports.push(
							typeof content === "string"
								? content
								: (Array.isArray(content) ? content : [])
										.flatMap((part) => (typeof part?.text === "string" ? [part.text] : []))
										.join("\n"),
						);
					}
					if (message.role === "assistant") {
						const content = Array.isArray(message.content) ? message.content : [];
						finalText = content
							.flatMap((part) =>
								part &&
								typeof part === "object" &&
								(part as { type?: unknown }).type === "text" &&
								typeof (part as { text?: unknown }).text === "string"
									? [(part as { text: string }).text]
									: [],
							)
							.join("\n");
						if (typeof message.model === "string") model = message.model;
						usage = message.usage;
					}
				}
				if (record.type === "agent_settled") {
					update(fill("{0} finished", agent.name));
					if (answered) {
						later?.(laterReport(agent.name, reports, finalText.trim(), runningList()));
						reports = [];
					} else if (running.size > 0) {
						finish();
						answered = true;
					}
					if (running.size === 0) child.stdin.end();
				}
			}
		};
		/**
		 * fork: a mode the parent narrows, or a session deny rule it adds, reaches the
		 * running agent through its own permission commands; a wider mode does not. An agent that refuses or does not
		 * acknowledge a restriction in time is stopped: it never keeps rights its parent took back.
		 */
		let applied = restrictions?.now();
		let restrictionCount = 0;
		const unacknowledged = new Map<string, NodeJS.Timeout>();
		// fork: one mode at a time. A second mode sent while the
		// agent was still applying the first (starting its sandbox) superseded it there: the first was answered as
		// refused and the agent stopped, though it ended in the right mode. The next one goes once the first is answered.
		let modeInFlight: string | undefined;
		const stopUnrestricted = () => {
			if (terminating) return;
			terminating = true;
			terminationError = "Agent stopped: it did not apply the session's new permissions.";
			void launched.stop();
		};
		const restrict = () => {
			const now = restrictions?.now();
			if (!now || !applied || terminating || child.stdin.writableEnded) return;
			const commands: Array<Record<string, unknown>> = [];
			const narrower = !modeInFlight && now.mode !== applied.mode && !isWiderMode(now.mode, applied.mode);
			if (narrower) commands.push({ type: "perm_mode", mode: now.mode });
			for (const rule of now.deny)
				if (!applied.deny.includes(rule))
					commands.push({ type: "perm_rule", action: "add", effect: "deny", rule, where: "session" });
			applied = { mode: narrower ? now.mode : applied.mode, deny: [...new Set([...applied.deny, ...now.deny])] };
			for (const command of commands) {
				const id = `${RESTRICTION_ID}${++restrictionCount}`;
				const timer = setTimeout(stopUnrestricted, RESTRICTION_ACK_MS);
				timer.unref?.();
				unacknowledged.set(id, timer);
				if (command.type === "perm_mode") modeInFlight = id;
				child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
			}
		};
		const unwatch = restrictions?.watch(restrict);
		const acknowledged = (record: Record<string, unknown>) => {
			const timer = typeof record.id === "string" ? unacknowledged.get(record.id) : undefined;
			if (!timer) return false;
			clearTimeout(timer);
			unacknowledged.delete(record.id as string);
			const refused = (record.data as { error?: unknown } | undefined)?.error;
			if (record.success === false || refused) stopUnrestricted();
			else if (record.id === modeInFlight) {
				modeInFlight = undefined;
				restrict();
			}
			return true;
		};
		child.stdout.setEncoding("utf8").on("data", onData);
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = appendStderrTail(stderr, chunk);
		});
		child.once("error", (error) => {
			signal?.removeEventListener("abort", abort);
			unwatch?.();
			for (const timer of unacknowledged.values()) clearTimeout(timer);
			unacknowledged.clear();
			markExited();
			finish(error);
		});
		child.once("close", (code) => {
			signal?.removeEventListener("abort", abort);
			unwatch?.();
			for (const timer of unacknowledged.values()) clearTimeout(timer);
			unacknowledged.clear();
			markExited();
			dialogs.abort();
			if (answered && running.size > 0)
				later?.(
					`Agent ${agent.name} stopped before its background tasks ended: ${runningList()
						.map((task) => `${task.id} (${task.command})`)
						.join(", ")}. Their output may be incomplete.`,
				);
			if (terminationError) finish(new Error(terminationError));
			else if (code === 0) finish();
			else finish(new Error(stderr.toString("utf8").trim() || `${EXITED}${code}`));
		});
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
		// the task is the model's text, never one of the agent's commands (`/perm always …` would save
		// a rule, and a command ends without the agent_settled this waits for). A prompt runs a command only when it
		// starts with "/".
		const message = task.startsWith("/") ? `Task: ${task}` : task;
		if (!terminating) child.stdin.write(`${JSON.stringify({ id: START_PROMPT_ID, type: "prompt", message })}\n`);
		update(fill("{0} is working", agent.name));
	});
}

/** What the main session reads when an agent's background tasks end after its answer (English: for the model). */
export function laterReport(
	name: string,
	reports: string[],
	answer: string,
	running: Array<{ id: string; command: string }>,
): string {
	return [
		`**Agent ${name}: background task ended**`,
		...reports,
		...(answer ? [`Agent ${name} then answered:\n${answer}`] : []),
		...(running.length
			? [`Still running in its background: ${running.map((task) => `${task.id} (${task.command})`).join(", ")}.`]
			: []),
	].join("\n\n");
}

/** Writes a new agent, or an edited one under its new name (the old file is removed once the new one is written). */
function saveAgent(agent: CustomAgent, existingName?: string): void {
	const renamed = existingName !== undefined && agent.name !== existingName;
	writeAgent(agent, getAgentDir(), existingName === undefined || renamed);
	if (renamed) rmSync(agentFilePath(existingName));
}

async function chooseTools(ctx: ExtensionContext, initial: string[]): Promise<string[] | undefined> {
	const selected = new Set(initial);
	while (true) {
		const choices = [...AGENT_TOOLS.map((name) => `${name}${selected.has(name) ? " ✓" : ""}`), t("Done")];
		const choice = await ctx.ui.select(t("Choose tools"), choices);
		if (!choice) return undefined;
		if (choice === t("Done")) return selected.size > 0 ? [...selected] : undefined;
		const name = choice.split(" ")[0] ?? "";
		if (selected.has(name)) selected.delete(name);
		else selected.add(name);
	}
}

async function editAgent(ctx: ExtensionContext, current?: CustomAgent): Promise<CustomAgent | undefined> {
	let name: string | undefined;
	while (!name) {
		// an agent can be renamed; input() has no prefill, so an empty answer
		// keeps the current name.
		const typed = await ctx.ui.input(t("Name"), current?.name ?? t("e.g. file-reader"));
		if (typed === undefined) return undefined;
		if (current && !typed.trim()) {
			name = current.name;
			break;
		}
		const value = agentName(typed);
		if (current && value === current.name) {
			name = value;
			break;
		}
		if (!isValidAgentName(value)) {
			ctx.ui.notify(t("Use lowercase letters, numbers, and dashes."), "warning");
			continue;
		}
		if (existsSync(agentFilePath(value))) {
			ctx.ui.notify(t("An agent with this name already exists."), "warning");
			continue;
		}
		name = value;
	}
	// input() has no prefill: when editing, an empty answer keeps the current purpose.
	const answer = await ctx.ui.input(t("What is this agent for?"), current?.description ?? t("One short sentence"));
	if (answer === undefined) return undefined;
	const description = answer.trim() || current?.description;
	if (!description) return undefined;
	const models = ctx.modelRegistry.getAvailable();
	const modelChoices = [t("Same as the current session"), ...models.map((model) => `${model.provider}/${model.id}`)];
	const modelChoice = await ctx.ui.select(t("Model"), modelChoices);
	if (!modelChoice) return undefined;
	const tools = await chooseTools(ctx, current?.tools ?? DEFAULT_AGENT_TOOLS);
	if (!tools) return undefined;
	const instructions = await ctx.ui.editor(t("Instructions"), current?.instructions ?? "");
	if (instructions === undefined) return undefined;
	return {
		name,
		description,
		model: modelChoice === t("Same as the current session") ? undefined : modelChoice,
		tools,
		instructions,
	};
}

/** An agent's answer as the main model reads it, cut at MAX_RESULT_CHARS, with its background tasks still running. */
function answerText(result: Awaited<ReturnType<typeof runAgent>>): string {
	const answer =
		result.text.length > MAX_RESULT_CHARS ? `${result.text.slice(0, MAX_RESULT_CHARS)}\n\n${TRUNCATED}` : result.text;
	const name = result.agent;
	const still = result.running.length
		? `\n\nStill running in ${name}'s background: ${result.running.map((task) => `${task.id} (${task.command})`).join(", ")}. When each ends, ${name} reads its result and you get a message with its report.`
		: "";
	return `${answer}${still}`;
}

const STATUS_CHARS = 60;
const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** An agent's answer with its step count collapsed; expanded, its task and every step before the answer. */
function agentBody(
	theme: Theme,
	answer: string,
	details: AgentRunDetails,
	expanded: boolean,
	partial: boolean,
): string {
	const steps = details.steps ?? [];
	const count = steps.filter((step) => step.tool).length;
	const counted =
		count > 0 ? theme.fg("muted", ` · ${fill(count === 1 ? "{0} step" : "{0} steps", String(count))}`) : "";
	if (!expanded) {
		const last = steps.at(-1);
		const head = theme.fg("toolOutput", answer.split("\n")[0] ?? "") + counted;
		return partial && last ? `${head}\n${theme.fg("muted", stepLine(last))}` : head;
	}
	const lines = [
		...(details.task ? [theme.fg("muted", `${t("Task")}: ${details.task}`)] : []),
		...(details.dropped ? [theme.fg("dim", fill("… {0} earlier steps", String(details.dropped)))] : []),
		...steps.map((step) =>
			theme.fg(step.status === "error" ? "error" : step.text !== undefined ? "dim" : "muted", stepLine(step)),
		),
	];
	return [...lines, ...(lines.length ? [""] : []), theme.fg("toolOutput", answer)].join("\n");
}

/** The harness's own lines of a result in the interface language; the agent's text and stderr are shown as they are. */
function localizeAnswer(answer: string, isError: boolean): string {
	if (isError) {
		if (answer.startsWith(UNKNOWN_AGENT)) return fill("Unknown agent: {0}", answer.slice(UNKNOWN_AGENT.length));
		if (/^Agent exited with code (-?\d+|null)$/.test(answer))
			return fill("Agent exited with code {0}", answer.slice(EXITED.length));
		return answer === "Agent stopped." || answer === NO_MODEL ? t(answer) : answer;
	}
	if (answer === NO_TEXT) return t(NO_TEXT);
	return answer.endsWith(`\n\n${TRUNCATED}`) ? `${answer.slice(0, -TRUNCATED.length)}${t(TRUNCATED)}` : answer;
}

/**
 * the agent runs of this session, oldest first: those that ended, from their answer messages (which outlive a
 * restart), then those still running. The ids restart at ag1 with each process; the transcript's session id does not.
 */
function sessionRuns(
	ctx: ExtensionContext,
	running: ReadonlyMap<string, { agent: string; task: string; session?: string; step: string }>,
): AgentRun[] {
	const ended: AgentRun[] = [];
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "custom_message" || entry.customType !== AGENT_ANSWER_MESSAGE) continue;
		const details = (entry.details ?? {}) as AgentRunDetails;
		ended.push({
			id: details.id ?? "",
			agent: details.agent ?? "",
			task: details.task ?? "",
			state: details.stopped ? "stopped" : details.failed ? "failed" : "answered",
			...(details.session ? { session: details.session } : {}),
		});
	}
	return [
		...ended,
		...[...running].map(([id, run]) => ({
			id,
			agent: run.agent,
			task: run.task,
			state: "running" as const,
			step: run.step,
			...(run.session ? { session: run.session } : {}),
		})),
	];
}

export default function agentsExtension(pi: ExtensionAPI): void {
	const agentToolName = "agent";
	// the agents running in the background, by id, with their last step for the footer's status.
	const runs = new Map<
		string,
		{
			agent: string;
			task: string;
			session?: string;
			controller: AbortController;
			step: string;
			stoppedByUser?: boolean;
			ended: Promise<void>;
		}
	>();
	/** the user stops a running agent from /agents. */
	const stopRun = (id: string) => {
		const run = runs.get(id);
		if (!run) throw new Error(t("This agent has already ended."));
		run.stoppedByUser = true;
		run.controller.abort();
		return run.ended;
	};
	let agentCounter = 0;
	// Once the session closes, an agent's end calls no model.
	let closed = false;
	const showRuns = (ctx: ExtensionContext) =>
		ctx.ui.setStatus(
			"agents",
			runs.size
				? [...runs.values()].map((run) => truncate(`${run.agent}: ${run.step}`, STATUS_CHARS)).join(" · ")
				: undefined,
		);
	let invocation = readAgentInvocation();
	// The user's latest message, for the keyword.
	let latestPrompt = "";
	const registerAgentTool = () => {
		const agents = readAgents();
		// P2: no agent, no tool in the prompt. Once registered, the tool stays until restart.
		if (agents.length === 0) return;
		const descriptions = agents.map((agent) => `${agent.name}: ${agent.description}`).join("; ");
		pi.registerTool({
			name: agentToolName,
			label: t("Agent"),
			// fork: starts a Prism process, whose own tool calls go through its gate.
			permissions: ["process"],
			description: `Run a custom agent on a task. ${descriptions}${invocationRule(invocation)}`,
			promptSnippet: "Run a custom agent on a task",
			parameters: Type.Object({
				agent: Type.String({ description: "Agent name" }),
				task: Type.String({ description: "Task for the agent" }),
			}),
			async execute(_id, params, signal, onUpdate, ctx) {
				const agent = readAgents().find((item) => item.name === params.agent);
				if (!agent) throw new Error(`${UNKNOWN_AGENT}${params.agent}`);
				if (!ctx.model) throw new Error(NO_MODEL);
				const currentModel = `${ctx.model.provider}/${ctx.model.id}`;
				// the agent's own session, beside this one, for its full transcript in the window's side menu.
				const sessionDir = agentSessionDir(ctx.sessionManager);
				const session = sessionDir ? { dir: sessionDir, id: randomUUID() } : undefined;
				// fork: a report arriving after the session ended reaches no one; the stale `pi` would throw
				// from the child's output handler.
				const later = (report: string) => {
					if (closed) return;
					pi.sendMessage(
						{
							customType: AGENT_BACKGROUND_MESSAGE,
							content: report,
							display: true,
							details: { agent: agent.name },
						},
						{ triggerTurn: true, deliverAs: "followUp" },
					);
				};
				const start = (
					runSignal: AbortSignal | undefined,
					progress: (text: string, activity: { steps: AgentStep[]; dropped: number }) => void,
				) =>
					runAgent(
						agent,
						params.task,
						ctx.cwd,
						ctx.ui,
						ctx.hasUI,
						currentModel,
						// the agent runs in this session's mode, with its deny rules, never in a wider one.
						childPermissionArgs(ctx),
						runSignal,
						progress,
						pi.getAllTools().map((tool) => tool.name),
						later,
						existingSessionTmpDir(ctx.sessionManager.getSessionId()),
						session,
						{ now: () => childPermissions(ctx), watch: (listener) => watchChildPermissions(ctx, listener) },
					);
				/**
				 * with an interface, an agent works as a background task: the
				 * tool returns at once, the main model goes on, and the answer comes as a message that starts a turn
				 * (after the current one). Its progress shows in the footer's status, never in the transcript the model
				 * is writing. Without an interface (print mode), nothing would receive that message: the tool waits.
				 */
				if (ctx.hasUI) {
					const id = `ag${++agentCounter}`;
					const controller = new AbortController();
					const entry = {
						agent: agent.name,
						task: params.task,
						session: session?.id,
						controller,
						step: t("working"),
						ended: Promise.resolve(),
					};
					runs.set(id, entry);
					showRuns(ctx);
					entry.ended = start(controller.signal, (_text, activity) => {
						const run = runs.get(id);
						const last = activity.steps.at(-1);
						if (run && last) run.step = stepLine(last).trim();
						showRuns(ctx);
					}).then(
						(result) => {
							if (closed) return;
							// fork: with background tasks still running, the agent stays listed (and stoppable)
							// until its process ends.
							if (result.running.length > 0) {
								entry.step = t("waiting for its background tasks");
								entry.ended = result.exited;
								void result.exited.then(() => {
									runs.delete(id);
									if (!closed) showRuns(ctx);
								});
							} else runs.delete(id);
							showRuns(ctx);
							pi.sendMessage(
								{
									customType: AGENT_ANSWER_MESSAGE,
									content: `**Agent ${agent.name} answered (${id})**\n\n${answerText(result)}`,
									display: true,
									details: {
										agent: agent.name,
										id,
										task: params.task,
										session: session?.id,
										...result.activity,
										model: result.model,
										usage: result.usage,
										toolsUsed: result.toolsUsed,
									} satisfies AgentRunDetails,
								},
								{ triggerTurn: true, deliverAs: "followUp" },
							);
						},
						(error: unknown) => {
							const stopped = runs.get(id)?.stoppedByUser === true;
							runs.delete(id);
							// The session's ctx is stale once it ended.
							if (closed) return;
							showRuns(ctx);
							// stopped by the user, it starts no turn; the model
							// reads it with the next message.
							if (stopped) {
								pi.sendMessage({
									customType: AGENT_ANSWER_MESSAGE,
									content: `**Agent ${agent.name} stopped (${id})**\n\nThe user stopped this agent before it answered.`,
									display: true,
									details: {
										agent: agent.name,
										id,
										task: params.task,
										session: session?.id,
										stopped: true,
									} satisfies AgentRunDetails,
								});
								return;
							}
							const reason = error instanceof Error ? error.message : String(error);
							pi.sendMessage(
								{
									customType: AGENT_ANSWER_MESSAGE,
									content: `**Agent ${agent.name} failed (${id})**\n\n${reason}`,
									display: true,
									details: {
										agent: agent.name,
										id,
										task: params.task,
										session: session?.id,
										failed: true,
									} satisfies AgentRunDetails,
								},
								{ triggerTurn: true, deliverAs: "followUp" },
							);
						},
					);
					return {
						content: [
							{
								type: "text",
								text: `${STARTED_PREFIX}${agent.name} (${id}). It works in the background: its answer arrives as a message when it ends. Meanwhile, go on with other work, or end your turn if nothing else is left; do not wait, poll or look for its results before that message.`,
							},
						],
						details: {
							agent: agent.name,
							id,
							task: params.task,
							session: session?.id,
							started: true,
						} satisfies AgentRunDetails,
					};
				}
				const result = await start(signal, (text, activity) =>
					onUpdate?.({ content: [{ type: "text", text }], details: { task: params.task, ...activity } }),
				);
				return {
					content: [{ type: "text", text: answerText(result) }],
					details: {
						model: result.model,
						usage: result.usage,
						toolsUsed: result.toolsUsed,
						task: params.task,
						session: session?.id,
						...result.activity,
					} satisfies AgentRunDetails,
				};
			},
			renderCall(args, theme, context) {
				const model =
					readAgents().find((agent) => agent.name === args.agent)?.model ?? t("Same as the current session");
				// the one line the simple interface shows says what the agent does now (its last step, kept by
				// renderResult), and no longer "working" once it has finished.
				const running = context?.isPartial || !context?.executionStarted;
				const kept = (context?.state ?? {}) as { agentStep?: AgentStep; agentSteps?: number };
				const last = running ? kept.agentStep : undefined;
				const steps = kept.agentSteps
					? fill(kept.agentSteps === 1 ? "{0} step" : "{0} steps", String(kept.agentSteps))
					: "";
				const started = (context?.state as { agentStarted?: boolean } | undefined)?.agentStarted;
				const now = running
					? ` · ${last ? stepLine(last).trim() : t("working")}`
					: started
						? ` · ${t("in the background")}`
						: steps
							? ` · ${steps}`
							: "";
				return new Text(`${theme.fg("accent", args.agent)} ${theme.fg("muted", `(${model})${now}`)}`, 0, 0);
			},
			renderResult(result, options, theme, context) {
				const text = result.content
					.filter((item) => item.type === "text")
					.map((item) => item.text)
					.join("\n");
				const details = (result.details ?? {}) as AgentRunDetails;
				if (details.started) {
					// The call's line says so; it was drawn before this result, so it is drawn again once.
					const state = context.state as { agentStarted?: boolean } | undefined;
					if (state && !state.agentStarted) {
						state.agentStarted = true;
						context.invalidate();
					}
					return new Text(
						theme.fg("muted", fill("Started in the background ({0}): its answer will follow.", details.id ?? "")),
						0,
						0,
					);
				}
				// While it runs the text is its state ("luna is using bash"); at the end, its answer.
				const answer = options.isPartial ? text : localizeAnswer(text, context.isError);
				// what the agent does, live: its last step collapsed, every step
				// with the task expanded (app.tools.expand).
				const steps = details.steps ?? [];
				if (context.state)
					Object.assign(context.state as object, {
						agentStep: steps.at(-1),
						agentSteps: steps.filter((step) => step.tool).length,
					});
				return new Text(agentBody(theme, answer, details, options.expanded, options.isPartial), 0, 0);
			},
		});
	};
	registerAgentTool();
	// an agent's background task ended after its answer; the report itself when expanded.
	pi.registerMessageRenderer<{ agent?: string }>(
		AGENT_BACKGROUND_MESSAGE,
		(message, { expanded, outputPad }, theme) => {
			const box = new Container();
			box.addChild(
				new Text(
					theme.fg("accent", theme.bold(fill("{0}: background task ended", message.details?.agent ?? ""))),
					outputPad,
					0,
				),
			);
			if (expanded && typeof message.content === "string")
				box.addChild(new Text(theme.fg("dim", message.content.replace(/^\*\*.*\*\*\n\n/, "")), outputPad, 0));
			return box;
		},
	);
	// an agent run in the background answered: its answer, its steps and task when expanded.
	pi.registerMessageRenderer<AgentRunDetails>(AGENT_ANSWER_MESSAGE, (message, { expanded, outputPad }, theme) => {
		const details = message.details ?? {};
		const box = new Container();
		const title = details.stopped ? "{0} stopped ({1})" : details.failed ? "{0} failed ({1})" : "{0} answered ({1})";
		box.addChild(
			new Text(
				theme.fg(
					details.stopped ? "warning" : details.failed ? "error" : "accent",
					theme.bold(fill(title, details.agent ?? "", details.id ?? "")),
				),
				outputPad,
				0,
			),
		);
		const content = typeof message.content === "string" ? message.content.replace(/^\*\*.*\*\*\n\n/, "") : "";
		const answer = details.stopped
			? t("The user stopped this agent before it answered.")
			: details.failed
				? content
				: localizeAnswer(content, false);
		box.addChild(new Text(agentBody(theme, answer, details, expanded, false), outputPad, 0));
		return box;
	});
	pi.on("session_shutdown", () => {
		closed = true;
		for (const run of runs.values()) run.controller.abort();
		runs.clear();
	});
	// fork: the keyword is checked on what the user typed, before a skill or a
	// template is expanded, and on the latest message the model received: a steer or a follow-up delivered during the
	// run replaces the prompt that started it. The user's inputs, as typed, wait here until the model gets them.
	const typed: Array<{ text: string; queued: "steer" | "followUp" | undefined }> = [];
	// The run's own prompt is its first user message; the ones after it were queued.
	let promptMessagePending = false;
	pi.on("input", (event) => {
		typed.push({ text: event.text, queued: event.streamingBehavior });
	});
	pi.on("before_agent_start", (event) => {
		const idle = typed.filter((input) => input.queued === undefined);
		for (const input of idle) typed.splice(typed.indexOf(input), 1);
		latestPrompt = idle.at(-1)?.text ?? event.prompt;
		promptMessagePending = true;
	});
	pi.on("message_start", (event) => {
		if (event.message.role !== "user") return;
		if (promptMessagePending) {
			promptMessagePending = false;
			return;
		}
		const content = event.message.content;
		const text =
			typeof content === "string"
				? content
				: content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
		// The same text when nothing was expanded; otherwise the oldest queued input, steers before follow-ups as the
		// agent delivers them.
		const exact = typed.findIndex((input) => input.text === text);
		const steer = typed.findIndex((input) => input.queued === "steer");
		const index = exact >= 0 ? exact : steer >= 0 ? steer : typed.findIndex((input) => input.queued === "followUp");
		latestPrompt = index >= 0 ? typed.splice(index, 1)[0]!.text : text;
	});
	pi.on("agent_settled", () => {
		typed.length = 0;
		promptMessagePending = false;
	});
	pi.on("tool_call", (event) => {
		if (event.toolName !== agentToolName || !keywordOnly(invocation)) return;
		if (mentionsKeyword(latestPrompt, invocation.keywordText)) return;
		return {
			block: true,
			reason: `Refused: the user lets you run an agent only when their latest message contains ${invocation.keywordText}.`,
		};
	});

	const applyInvocation = (next: AgentInvocation) => {
		if (!next.autonomous && !next.explicitRequest && !next.keyword) next = { ...next, autonomous: true };
		saveGlobalSetting(["agentInvocation"], next);
		invocation = next;
		registerAgentTool();
	};
	pi.on("session_start", (_event, ctx) => {
		panels.set(ctx.sessionManager, {
			snapshot: () => ({
				agents: readAgents(),
				tools: AGENT_TOOLS,
				defaultTools: DEFAULT_AGENT_TOOLS,
				models: ctx.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`),
				invocation: { ...invocation },
				help: AGENTS_HELP.map(t),
				policyHelp: INVOCATION_HELP.map(t),
				offDetail: t(TURN_OFF_DETAIL),
				running: [...runs].map(([id, run]) => ({ id, agent: run.agent, step: run.step })),
				runs: sessionRuns(ctx, runs),
			}),
			stop: (id) => stopRun(id),
			save: (value, existingName) => {
				if (!value || typeof value !== "object") throw new Error("Invalid agent.");
				const fields = value as Record<string, unknown>;
				if (
					typeof fields.name !== "string" ||
					typeof fields.description !== "string" ||
					typeof fields.instructions !== "string" ||
					!Array.isArray(fields.tools) ||
					!fields.tools.every((tool): tool is string => typeof tool === "string") ||
					(fields.model !== undefined && typeof fields.model !== "string")
				)
					throw new Error("Invalid agent fields.");
				if (existingName !== undefined && typeof existingName !== "string") throw new Error("Invalid agent name.");
				const current =
					existingName === undefined ? undefined : readAgents().find((entry) => entry.name === existingName);
				if (existingName !== undefined && !current) throw new Error("Unknown agent.");
				// the name is written as a valid one, also when renaming.
				const name = agentName(fields.name);
				if (!isValidAgentName(name)) throw new Error(t("Use lowercase letters, numbers, and dashes."));
				if (name !== existingName && readAgents().some((entry) => entry.name === name))
					throw new Error(t("An agent with this name already exists."));
				const model = typeof fields.model === "string" && fields.model ? fields.model : undefined;
				if (
					model &&
					model !== current?.model &&
					!ctx.modelRegistry.getAvailable().some((entry) => `${entry.provider}/${entry.id}` === model)
				)
					throw new Error("Unknown model.");
				saveAgent(
					{ name, description: fields.description, instructions: fields.instructions, tools: fields.tools, model },
					existingName,
				);
				registerAgentTool();
			},
			remove: (name) => {
				if (!readAgents().some((entry) => entry.name === name)) throw new Error("Unknown agent.");
				rmSync(agentFilePath(name));
				registerAgentTool();
			},
			policy: (value) => {
				if (!value || typeof value !== "object") throw new Error("Invalid agent policy.");
				const fields = value as Record<string, unknown>;
				// with the keyword off, an empty field keeps the current keyword.
				const typed = typeof fields.keywordText === "string" ? fields.keywordText.trim() : undefined;
				const keywordText = typed === "" && fields.keyword === false ? invocation.keywordText : typed;
				if (
					typeof fields.autonomous !== "boolean" ||
					typeof fields.explicitRequest !== "boolean" ||
					typeof fields.keyword !== "boolean" ||
					keywordText === undefined ||
					!KEYWORD_PATTERN.test(keywordText)
				)
					throw new Error(t("A keyword is one word of up to 32 characters, without spaces."));
				applyInvocation({
					autonomous: fields.autonomous,
					explicitRequest: fields.explicitRequest,
					keyword: fields.keyword,
					keywordText,
				});
			},
			disable: () => {
				if (!ctx.isIdle()) throw new Error("Stop the current turn before turning agents off.");
				turnAgentsOff();
			},
		});
	});
	pi.on("session_shutdown", (_event, ctx) => {
		panels.delete(ctx.sessionManager);
	});

	const choosePolicy = async (ctx: ExtensionContext) => {
		while (true) {
			const mark = (on: boolean, label: string) => (on ? `${label} ✓` : label);
			const own = t("On its own, when a task fits (default)");
			const asked = t("When you ask for an agent in your message");
			const keyword = fill("When your message contains {0}", invocation.keywordText);
			const change = fill("Change the keyword ({0})", invocation.keywordText);
			const choice = await ctx.ui.select(
				[t("When the model may run an agent"), ...INVOCATION_HELP.map(t)].join("\n"),
				[
					mark(invocation.autonomous, own),
					mark(!invocation.autonomous && invocation.explicitRequest, asked),
					mark(!invocation.autonomous && invocation.keyword, keyword),
					change,
					t("Back"),
				],
			);
			if (!choice || choice === t("Back")) return;
			let next: AgentInvocation | undefined;
			// From autonomous, a way to ask is the only one on; then each way turns on or off by itself.
			const onRequest = invocation.autonomous
				? { ...invocation, explicitRequest: false, keyword: false }
				: invocation;
			if (choice.startsWith(own)) next = { ...invocation, autonomous: true };
			else if (choice.startsWith(asked))
				next = { ...onRequest, autonomous: false, explicitRequest: !onRequest.explicitRequest };
			else if (choice.startsWith(keyword)) next = { ...onRequest, autonomous: false, keyword: !onRequest.keyword };
			else if (choice === change) {
				const text = (await ctx.ui.input(t("Keyword"), invocation.keywordText))?.trim();
				if (!text) continue;
				if (!KEYWORD_PATTERN.test(text)) {
					ctx.ui.notify(t("A keyword is one word of up to 32 characters, without spaces."), "warning");
					continue;
				}
				next = { ...invocation, keywordText: text };
			}
			if (!next) continue;
			try {
				applyInvocation(next);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		}
	};

	pi.registerCommand("agents", {
		description: t("Create and manage custom agents"),
		handler: async (_args, ctx) => {
			while (true) {
				const agents = readAgents();
				const labels = agents.map(
					(agent) =>
						`${agent.name} — ${agent.model ?? t("Same as the current session")} — ${agent.tools.join(", ")} — ${agent.description}`,
				);
				const create = t("New agent");
				const policy = t("When the model may run an agent…");
				const off = t("Turn agents off");
				const title = [t("Agents"), ...AGENTS_HELP.map((line) => t(line)), policySummary(invocation)].join("\n");
				// a running agent can be stopped here, first in the list.
				const stops = [...runs].map(([id, run]) => ({
					id,
					agent: run.agent,
					label: fill("■ Stop {0} ({1}) · {2}", run.agent, id, run.step),
				}));
				const choice = await ctx.ui.select(title, [
					...stops.map((stop) => stop.label),
					...labels,
					create,
					policy,
					off,
					t("Close"),
				]);
				if (!choice || choice === t("Close")) return;
				const stop = stops.find((entry) => entry.label === choice);
				if (stop) {
					if (await ctx.ui.confirm(fill("Stop {0}?", stop.agent), t(STOP_DETAIL))) {
						try {
							// Once it has ended, the list no longer shows it.
							await stopRun(stop.id);
						} catch (error) {
							ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
						}
					}
					continue;
				}
				if (choice === policy) {
					await choosePolicy(ctx);
					continue;
				}
				if (choice === off) {
					if (!(await ctx.ui.confirm(t("Turn agents off?"), t(TURN_OFF_DETAIL)))) continue;
					try {
						turnAgentsOff();
					} catch (error) {
						ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
						continue;
					}
					// The same switch as /settings › Modules; it applies by reloading, as when Settings closes.
					await ctx.reload();
					return;
				}
				if (choice === create) {
					const agent = await editAgent(ctx);
					if (agent) {
						writeAgent(agent, getAgentDir(), true);
						registerAgentTool();
						ctx.ui.notify(
							fill("Agent created: {0}. Ask the model to use it, e.g. « use the {0} agent to … ».", agent.name),
						);
					}
					continue;
				}
				const selected = agents.find((agent) => choice.startsWith(`${agent.name} — `));
				if (!selected) continue;
				const action = await ctx.ui.select(selected.name, [t("Edit"), t("Delete"), t("Back")]);
				if (action === t("Edit")) {
					const updated = await editAgent(ctx, selected);
					if (updated) saveAgent(updated, selected.name);
				} else if (
					action === t("Delete") &&
					(await ctx.ui.confirm(t("Delete agent?"), fill("This removes {0}.", selected.name)))
				) {
					rmSync(agentFilePath(selected.name));
				}
				registerAgentTool();
			}
		},
	});
}
