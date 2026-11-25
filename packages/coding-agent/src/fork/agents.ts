import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { getAgentDir } from "../config.ts";
import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";
import type { Theme } from "../modes/interactive/theme/theme.ts";
import { parseFrontmatter } from "../utils/frontmatter.ts";
import { AgentActivity, type AgentStep, stepLine } from "./agent-activity.ts";
import { type AgentTranscriptEntry, agentSessionDir, agentTranscript } from "./agent-transcript.ts";
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
	"agent_wait",
]);

/**
 * the advanced agent mode, off by default.
 * On, a general agent is always there, a call may choose another model of the user's selected list, `agent_wait`
 * waits for answers, and at most `agentsMaxParallel` agents run at once.
 */
export const AGENTS_ADVANCED_SETTING = "agentsAdvanced";
export const AGENTS_MAX_PARALLEL_SETTING = "agentsMaxParallel";
export const DEFAULT_MAX_PARALLEL = 4;
const MAX_PARALLEL_LIMIT = 32;

export function agentsAdvanced(agentDir = getAgentDir()): boolean {
	return readGlobalSetting(AGENTS_ADVANCED_SETTING, agentDir) === true;
}

export function maxParallelAgents(agentDir = getAgentDir()): number {
	const value = readGlobalSetting(AGENTS_MAX_PARALLEL_SETTING, agentDir);
	return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_PARALLEL_LIMIT
		? value
		: DEFAULT_MAX_PARALLEL;
}

/** The agent the advanced mode always offers; a user's own agent of the same name replaces it. */
export const GENERAL_AGENT: CustomAgent = {
	name: "general",
	description: "A general-purpose agent for any task: research, reading code, edits and commands.",
	tools: [...AGENT_TOOLS],
	instructions:
		"The main session started you for one task. Do it, then answer with what the main session needs: what you found, what you changed and what is left. Be concise.",
};

/**
 * the agent `/agents fork` starts on a copy of this conversation, on the session's model
 * only (owner: no other model for an agent that inherits the conversation).
 */
export const FORK_AGENT: CustomAgent = {
	name: "fork",
	description: "A copy of this session, with its conversation so far, for one task.",
	tools: [...AGENT_TOOLS],
	instructions:
		"You are a copy of the main session, started with its conversation so far for one task, which follows. Do it, then answer with what the main session needs: what you found, what you changed and what is left. Be concise.",
};

/** The most files a call may name for an agent to read first. */
const MAX_BRIEF_FILES = 20;

/**
 * the task an agent receives, with what the call gives it besides: a summary of the
 * conversation written by the model, and files the agent reads first. The files are checked here (inside the project,
 * existing) but read by the agent, through its own permissions: Prism never sends a file the agent could not read.
 */
export function agentBrief(cwd: string, task: string, context?: string, files?: readonly string[]): string {
	const parts = [task];
	if (context?.trim()) parts.push(`## Context from the main session\n${context.trim()}`);
	const named = [...new Set((files ?? []).map((file) => file.trim()).filter(Boolean))];
	if (named.length > MAX_BRIEF_FILES) throw new Error(`Name at most ${MAX_BRIEF_FILES} files for an agent.`);
	const listed = named.map((file) => {
		const path = resolve(cwd, file);
		const inside = relative(cwd, path);
		if (!inside || inside.startsWith("..") || isAbsolute(inside))
			throw new Error(`${file} is outside the project: name files inside it.`);
		let isFile = false;
		try {
			isFile = statSync(path).isFile();
		} catch {
			// Missing: said below.
		}
		if (!isFile) throw new Error(`${file} is not a file of the project.`);
		return `- ${inside}`;
	});
	if (listed.length) parts.push(`## Files to read first\n${listed.join("\n")}`);
	return parts.join("\n\n");
}

/**
 * agents the advanced mode offers to turn on in /agents. No model is named: they run on
 * the session's model unless a call chooses another. The three that only read run in the read-only mode.
 */
export const PRESET_AGENTS: readonly CustomAgent[] = [
	{
		name: "explorer",
		description:
			"Explores the project to answer a question: finds files, reads code, explains how it works. Read only.",
		tools: ["read", "grep", "find", "ls"],
		readOnly: true,
		instructions:
			"Explore the project to answer the task. Read and search only; change nothing. Answer with what you found, citing file paths and line numbers, and say what you could not check.",
	},
	{
		name: "planner",
		description: "Designs a plan for a change: the steps, the files to touch, the risks. Read only.",
		tools: ["read", "grep", "find", "ls"],
		readOnly: true,
		instructions:
			"Study the code the task concerns and write a concrete plan: the steps in order, the files and functions to change, the risks, and how to check the result. Change nothing.",
	},
	{
		name: "reviewer",
		description: "Reviews a change (a diff, files or a commit) and reports its defects and risks. Read only.",
		tools: ["read", "grep", "find", "ls", "bash"],
		readOnly: true,
		instructions:
			"Review what the task names. Report real defects first, each with its file and line and a concrete case where it goes wrong; then risks; skip matters of style. Change nothing.",
	},
	{
		name: "worker",
		description:
			"Carries out a well-defined change: edits files and runs commands, within the session's permissions.",
		tools: [...AGENT_TOOLS],
		instructions:
			"Make the change the task describes, then check it with the project's tests or commands. Answer with what you changed, how you checked it and what is left.",
	},
];
export const AGENTS_PRESETS_SETTING = "agentsPresets";
/**
 * the model and effort the user chose for the general agent and the
 * preconfigured ones, by name: `{ "explorer": { "model": "provider/id", "thinking": "low" } }`.
 */
export const AGENTS_BUILTIN_SETTING = "agentsBuiltin";
/** The thinking levels an agent may be given, as `--thinking` takes them. */
export const AGENT_THINKING_LEVELS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

function isAgentThinking(value: string): value is ThinkingLevel {
	return (AGENT_THINKING_LEVELS as readonly string[]).includes(value);
}

/** What the user set for each built-in agent: its model and effort, when not the session's. */
export function builtinChoices(agentDir = getAgentDir()): Record<string, { model?: string; thinking?: ThinkingLevel }> {
	const value = readGlobalSetting(AGENTS_BUILTIN_SETTING, agentDir);
	const names = new Set([GENERAL_AGENT.name, ...PRESET_AGENTS.map((agent) => agent.name)]);
	const choices: Record<string, { model?: string; thinking?: ThinkingLevel }> = {};
	if (!value || typeof value !== "object" || Array.isArray(value)) return choices;
	for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
		if (!names.has(name) || !entry || typeof entry !== "object") continue;
		const { model, thinking } = entry as { model?: unknown; thinking?: unknown };
		choices[name] = {
			...(typeof model === "string" && model ? { model } : {}),
			...(typeof thinking === "string" && isAgentThinking(thinking) ? { thinking } : {}),
		};
	}
	return choices;
}

/** A built-in agent with the model and effort the user chose for it. */
function withChoices(agent: CustomAgent, choices: ReturnType<typeof builtinChoices>): CustomAgent {
	const chosen = choices[agent.name];
	return chosen ? { ...agent, ...chosen } : agent;
}

/** The preconfigured agents the user turned on. */
export function enabledPresets(agentDir = getAgentDir()): string[] {
	const value = readGlobalSetting(AGENTS_PRESETS_SETTING, agentDir);
	const names = new Set(PRESET_AGENTS.map((agent) => agent.name));
	return Array.isArray(value)
		? value.filter((name): name is string => typeof name === "string" && names.has(name))
		: [];
}

/**
 * The agents a call may name: the user's own, and in the advanced mode the general one and the preconfigured ones
 * turned on. A user's own agent replaces a built-in one of the same name.
 */
export function availableAgents(advanced: boolean, agentDir = getAgentDir()): CustomAgent[] {
	const own = readAgents(agentDir);
	if (!advanced) return own;
	const on = new Set(enabledPresets(agentDir));
	const choices = builtinChoices(agentDir);
	const builtIn = [GENERAL_AGENT, ...PRESET_AGENTS.filter((agent) => on.has(agent.name))].map((agent) =>
		withChoices(agent, choices),
	);
	return [...builtIn.filter((agent) => !own.some((entry) => entry.name === agent.name)), ...own];
}

/** The flags that start a child Prism process with `permissions` (as childPermissionArgs writes them). */
function permissionFlags(permissions: ChildPermissions): string[] {
	return [
		"--perm-mode",
		permissions.mode,
		...(permissions.deny.length > 0 ? ["--perm-deny", JSON.stringify(permissions.deny)] : []),
	];
}

/** The permissions an agent starts with: the session's, or the read-only mode for an agent that only reads. */
export function agentPermissions(
	agent: CustomAgent,
	session: ChildPermissions | undefined,
): ChildPermissions | undefined {
	if (!agent.readOnly) return session;
	return { mode: "safe", deny: session?.deny ?? [] };
}

/**
 * The models an agent may run on in the advanced mode: the session's, then those of the user's selected list (Ctrl+P),
 * without the session's own model again. No list: the session's model only.
 */
export function agentModels(
	current: string | undefined,
	scoped: readonly { model: { provider: string; id: string } }[],
): string[] {
	const listed = scoped.map(({ model }) => `${model.provider}/${model.id}`);
	return [...new Set([...(current ? [current] : []), ...listed])];
}

/**
 * a model as the agent tool names it to the model: its id, then the name its
 * provider gives it when that says more. An alias such as `claude-code/haiku` carries no version: asked for "Haiku
 * 5.5", the model picked a dated id of an older one.
 */
export function modelLabel(model: { provider: string; id: string; name?: string }): string {
	const id = `${model.provider}/${model.id}`;
	const name = model.name?.replace(/\s+/g, " ").trim();
	const same = (other: string) => other.toLowerCase() === name?.toLowerCase();
	return name && !same(model.id) && !same(id) ? `${id} (${name})` : id;
}

/** The models agents may use, as `agentModels` lists them, each with its name (`modelLabel`). */
export function agentModelLabels(
	current: { provider: string; id: string; name?: string } | undefined,
	scoped: readonly { model: { provider: string; id: string; name?: string } }[],
): string[] {
	const labels = new Map<string, string>();
	for (const model of [...(current ? [current] : []), ...scoped.map((entry) => entry.model)]) {
		const id = `${model.provider}/${model.id}`;
		if (!labels.has(id)) labels.set(id, modelLabel(model));
	}
	return [...labels.values()];
}

/** What the advanced mode adds, in the question that turns it on. */
const ADVANCED_DETAIL =
	"Adds a general agent you do not need to create, a model chosen for each call from your selected list, agent_wait, and a limit on agents at once. Your own agents stay as they are.";
/** What the user reads before turning the advanced mode on (shown in red). */
export const ADVANCED_WARNING =
	"The model can start agents without you creating them, on another model of your selected list (Ctrl+P), and give them a summary of this conversation or files you name. What an agent receives goes to the provider of its model: with a cloud model, parts of this conversation leave your machine even when this session uses a local model. Several agents can run at once, each a full Prism process.";
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
	/** the answer agent_wait returned, which the message shows to the user but not to the model again. */
	answer?: string;
	/** the model the agent ran on ("provider/model"), which a continued run keeps. */
	launchModel?: string;
	/** the id of the run this one continues, with its context. */
	continues?: string;
	/** the user started this run from /agents or the window. */
	byUser?: boolean;
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
const MODEL_NOT_LISTED = "Model not in the user's selected list: ";
/** what the answer message says to the model when agent_wait already returned the answer. */
const RETURNED_BY_WAIT = "Its answer was returned by agent_wait.";
const DEFAULT_WAIT_SECONDS = 600;
const MAX_WAIT_SECONDS = 3600;
/** The start of the tool's text when the agent runs in the background (renderResult and the window recognise it). */
const STARTED_PREFIX = "Started agent ";
/** fork: what an agent is, above the list of /agents; one sentence, so the window stays short. */
const AGENTS_HELP = [
	"An agent is your own helper: its instructions, model and tools. When a task fits its purpose, the model runs it, or ask for it by name.",
];
/**
 * the advanced mode adds to the normal one and takes nothing away; the rule on when
 * the model may run an agent covers the agents it adds.
 */
const ADVANCED_ON_HELP =
	"Advanced mode on: the general agent and the preconfigured agents you turned on are added to yours. When the model may run an agent applies to them too.";

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

/** A template filled in English, for the model: `fill` translates it. */
function english(template: string, ...values: string[]): string {
	return template.replace(/\{(\d)\}/g, (slot, n: string) => values[Number(n)] ?? slot);
}

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
	/** its effort (`--thinking`); the model's default when unset. */
	thinking?: ThinkingLevel;
	tools: string[];
	instructions: string;
	/** a preconfigured agent that only reads: it runs in the read-only mode (safe), whatever the session's. */
	readOnly?: boolean;
}

interface AgentsPanel {
	snapshot(): {
		agents: CustomAgent[];
		tools: readonly string[];
		defaultTools: readonly string[];
		models: string[];
		/** the efforts an agent may be given. */
		thinkingLevels: readonly string[];
		invocation: AgentInvocation;
		help: string[];
		policyHelp: string[];
		offDetail: string;
		/** the agents running in the background, with their current step. */
		running: Array<{ id: string; agent: string; step: string }>;
		/** this session's agent runs, oldest first, for the window's side menu. */
		runs: AgentRun[];
		/** the agents the user may start. */
		available: Array<{ name: string; description: string }>;
		/** the advanced mode, its warning, its limit and the preconfigured agents. */
		advanced: {
			on: boolean;
			warning: string;
			detail: string;
			maxParallel: number;
			maxLimit: number;
			presets: Array<{ name: string; description: string; on: boolean }>;
			/** The general agent then the preconfigured ones, with the model and effort chosen for each. */
			builtin: Array<{ name: string; description: string; model?: string; thinking?: string }>;
		};
	};
	/** starts an agent for the user, in the background; returns its run id. */
	run(agent: unknown, task: unknown): string;
	/** continues the finished run whose own session is `session` with a message; returns the new run id. */
	resume(session: unknown, message: unknown): string;
	/** starts an agent on a copy of this conversation (advanced mode, session's model); returns its run id. */
	fork(task: unknown): string;
	/** turns the advanced mode on or off; it applies by reloading. */
	setAdvanced(on: unknown): void;
	setPresets(names: unknown): void;
	setMaxParallel(count: unknown): void;
	/** the model and effort of the general agent or a preconfigured one; empty means the session's. */
	setBuiltin(name: unknown, choice: unknown): void;
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
	/** the run continues this one, with its context. */
	continues?: string;
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
	const thinking = agent.thinking ? `thinking: ${agent.thinking}\n` : "";
	writeFileSync(
		path,
		`---\nname: ${agent.name}\ndescription: ${JSON.stringify(agent.description.trim())}\ntools: ${agent.tools.join(", ")}\n${model}${thinking}---\n\n${agent.instructions.trim()}\n`,
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
						...(typeof frontmatter.thinking === "string" && isAgentThinking(frontmatter.thinking)
							? { thinking: frontmatter.thinking }
							: {}),
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
	/**
	 * the agent's own session, kept for its transcript; without one, it keeps none. `forkFrom`, a
	 * session file the agent's session starts as a copy of (`/agents fork`).
	 */
	session?: { dir: string; id: string; forkFrom?: string },
): string[] {
	const builtIn: readonly string[] = AGENT_TOOLS;
	const others = sessionTools.filter((name) => !builtIn.includes(name) && !NOT_FOR_AGENTS.has(name));
	return [
		"--mode",
		"rpc",
		...(session
			? [
					...(session.forkFrom ? ["--fork", session.forkFrom] : []),
					"--session-dir",
					session.dir,
					"--session-id",
					session.id,
				]
			: ["--no-session"]),
		"--model",
		agent.model ?? currentModel,
		...(agent.thinking ? ["--thinking", agent.thinking] : []),
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
	session?: { dir: string; id: string; forkFrom?: string },
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
	const engine = await chooseModelAndEffort(ctx);
	if (!engine) return undefined;
	const tools = await chooseTools(ctx, current?.tools ?? DEFAULT_AGENT_TOOLS);
	if (!tools) return undefined;
	const instructions = await ctx.ui.editor(t("Instructions"), current?.instructions ?? "");
	if (instructions === undefined) return undefined;
	return {
		name,
		description,
		...engine,
		tools,
		instructions,
	};
}

/**
 * an agent's model, then its effort. "Same as the current session" and
 * "The model's default" leave them unset; a model the main model names for one call still wins over this choice.
 */
async function chooseModelAndEffort(
	ctx: ExtensionContext,
): Promise<{ model?: string; thinking?: ThinkingLevel } | undefined> {
	const same = t("Same as the current session");
	const models = ctx.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`);
	const model = await ctx.ui.select(t("Model"), [same, ...models]);
	if (!model) return undefined;
	const byDefault = t("The model's default");
	const effort = await ctx.ui.select(t("Effort"), [byDefault, ...AGENT_THINKING_LEVELS]);
	if (!effort) return undefined;
	return {
		...(model === same ? {} : { model }),
		...(effort !== byDefault && isAgentThinking(effort) ? { thinking: effort } : {}),
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

/**
 * the line that tells the main model a run was the user's, not its own; without it
 * the model read « explorer answered (ag1) » as an agent it had started, and a follow-up as a new agent. One line, so
 * the displays can drop it (USER_RUN_LINE).
 */
const USER_RUN_PREFIX = "[Started by the user, not by you: ";
export const USER_RUN_LINE = /^\[Started by the user, not by you: [^\n]*\n\n/;
function userRunLine(name: string, id: string, task: string, continues?: string): string {
	const quoted = JSON.stringify(truncate(task, 500));
	return continues
		? `${USER_RUN_PREFIX}they sent ${name} (${continues}) a follow-up message, run as ${id} with ${continues}'s context. Their message: ${quoted}]\n\n`
		: `${USER_RUN_PREFIX}they ran ${name} (${id}) with the task ${quoted}]\n\n`;
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
			...(details.continues ? { continues: details.continues } : {}),
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
	/** run ids (ag1, ag2…) go on from the session's earlier runs, so `resume` names one run only. */
	let agentCounter = 0;
	/** agents running without an interface (print mode), inside their tool call; not in `runs`. */
	let waitingRuns = 0;
	/**
	 * what each ended run of this process left for the model (its answer, or why it has none), and the runs
	 * agent_wait is waiting for. `ended` records one and says whether agent_wait takes the answer.
	 */
	const endedRuns = new Map<string, string>();

	/** How many agent_wait calls wait for each run: overlapping waits on one run each count. */
	const awaitedRuns = new Map<string, number>();
	const waiters = new Set<() => void>();
	const ended = (id: string, text: string): boolean => {
		endedRuns.set(id, text);
		for (const wake of waiters) wake();
		return (awaitedRuns.get(id) ?? 0) > 0;
	};
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
	// the models of the user's selected list, for the tool's description (set at session start).
	let listedModels: string[] = [];
	/** the agent's own session, beside this one, for its full transcript in the window's side menu. */
	const newAgentSession = (ctx: ExtensionContext) => {
		const sessionDir = agentSessionDir(ctx.sessionManager);
		return sessionDir ? { dir: sessionDir, id: randomUUID() } : undefined;
	};
	/** The agent's process, in the session's permissions; an agent that only reads, in the read-only mode. */
	const startRun = (
		ctx: ExtensionContext,
		agent: CustomAgent,
		task: string,
		currentModel: string,
		session: { dir: string; id: string; forkFrom?: string } | undefined,
		runSignal: AbortSignal | undefined,
		progress: (text: string, activity: { steps: AgentStep[]; dropped: number }) => void,
	) => {
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
		return runAgent(
			agent,
			task,
			ctx.cwd,
			ctx.ui,
			ctx.hasUI,
			currentModel,
			// the agent runs in this session's mode, with its deny rules, never in a wider one.
			// an agent that only reads runs in the read-only mode.
			agent.readOnly ? permissionFlags(agentPermissions(agent, childPermissions(ctx))!) : childPermissionArgs(ctx),
			runSignal,
			progress,
			pi.getAllTools().map((tool) => tool.name),
			later,
			existingSessionTmpDir(ctx.sessionManager.getSessionId()),
			session,
			{
				now: () => agentPermissions(agent, childPermissions(ctx)),
				watch: (listener) => watchChildPermissions(ctx, listener),
			},
		);
	};
	/**
	 * an agent run in the background; its answer comes as a message, which starts a turn unless agent_wait
	 * takes it. Returns the run's id.
	 */
	const runInBackground = (
		ctx: ExtensionContext,
		launch: {
			agent: CustomAgent;
			task: string;
			currentModel: string;
			session?: { dir: string; id: string; forkFrom?: string };
			continues?: string;
			byUser?: boolean;
			/** what the agent receives, when more than the task (context, files); the task stays the label. */
			brief?: string;
		},
	): string => {
		const { agent, task, session } = launch;
		// the advanced mode's limit on agents at once (each one is a Prism process).
		const limit = maxParallelAgents();
		if (agentsAdvanced() && runs.size + waitingRuns >= limit)
			throw new Error(
				launch.byUser
					? fill("{0} agents are already running, the most you allow at once.", String(limit))
					: `${limit} agents are already running, the most the user allows at once. Wait for one with agent_wait, or go on and start this one later.`,
			);
		const id = `ag${++agentCounter}`;
		const controller = new AbortController();
		const entry = {
			agent: agent.name,
			task,
			session: session?.id,
			controller,
			step: t("working"),
			ended: Promise.resolve(),
		};
		runs.set(id, entry);
		showRuns(ctx);
		const base = {
			agent: agent.name,
			id,
			task,
			session: session?.id,
			launchModel: agent.model ?? launch.currentModel,
			...(launch.continues ? { continues: launch.continues } : {}),
			...(launch.byUser ? { byUser: true } : {}),
		} satisfies AgentRunDetails;
		const origin = launch.byUser ? userRunLine(agent.name, id, task, launch.continues) : "";
		// An answer that starts no turn waits for the end of the current one, rather than steering it. fork.12.5
		// a run the user started also starts a turn, so the model reacts to its answer.
		const turn = (awaited: boolean) =>
			awaited ? { triggerTurn: false } : { triggerTurn: true, deliverAs: "followUp" as const };
		entry.ended = startRun(
			ctx,
			agent,
			launch.brief ?? task,
			launch.currentModel,
			session,
			controller.signal,
			(_text, activity) => {
				const run = runs.get(id);
				const last = activity.steps.at(-1);
				if (run && last) run.step = stepLine(last).trim();
				showRuns(ctx);
			},
		).then(
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
				const answer = answerText(result);
				// an answer agent_wait is waiting for goes back through it; the message keeps the run in the
				// session's list without giving the model the same answer twice, and starts no turn.
				const awaited = ended(id, answer);
				pi.sendMessage(
					{
						customType: AGENT_ANSWER_MESSAGE,
						content: `**Agent ${agent.name} answered (${id})**\n\n${origin}${awaited ? RETURNED_BY_WAIT : answer}`,
						display: true,
						details: {
							...base,
							...result.activity,
							model: result.model,
							usage: result.usage,
							toolsUsed: result.toolsUsed,
							...(awaited ? { answer } : {}),
						} satisfies AgentRunDetails,
					},
					turn(awaited),
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
					ended(id, "The user stopped this agent before it answered.");
					pi.sendMessage({
						customType: AGENT_ANSWER_MESSAGE,
						content: `**Agent ${agent.name} stopped (${id})**\n\n${origin}The user stopped this agent before it answered.`,
						display: true,
						details: { ...base, stopped: true } satisfies AgentRunDetails,
					});
					return;
				}
				const reason = error instanceof Error ? error.message : String(error);
				const awaited = ended(id, `It failed: ${reason}`);
				pi.sendMessage(
					{
						customType: AGENT_ANSWER_MESSAGE,
						content: `**Agent ${agent.name} failed (${id})**\n\n${origin}${reason}`,
						display: true,
						details: { ...base, failed: true } satisfies AgentRunDetails,
					},
					turn(awaited),
				);
			},
		);
		return id;
	};
	/** What the tool returns for an agent started in the background. */
	const startedResult = (name: string, id: string, task: string, session?: string, continues?: string) => {
		const what = `${STARTED_PREFIX}${name} (${id}${continues ? `, continuing ${continues} with its context` : ""}).`;
		return {
			content: [
				{
					type: "text" as const,
					text: agentsAdvanced()
						? `${what} It works in the background: its answer arrives as a message when it ends, or through agent_wait when you need it before going on. Do not poll or look for its results otherwise.`
						: `${what} It works in the background: its answer arrives as a message when it ends. Meanwhile, go on with other work, or end your turn if nothing else is left; do not wait, poll or look for its results before that message.`,
				},
			],
			details: {
				agent: name,
				id,
				task,
				session,
				started: true,
				...(continues ? { continues } : {}),
			} satisfies AgentRunDetails,
		};
	};
	/**
	 * the latest finished run of this session that `match` picks, to continue it: its
	 * agent (still offered), the model it ran on and its own session. Never a run still going.
	 */
	const continuable = (
		ctx: ExtensionContext,
		match: (details: AgentRunDetails) => boolean,
		what: string,
		say: (template: string, ...values: string[]) => string = english,
	) => {
		let found: AgentRunDetails | undefined;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom_message" || entry.customType !== AGENT_ANSWER_MESSAGE) continue;
			const details = (entry.details ?? {}) as AgentRunDetails;
			if (match(details)) found = details;
		}
		if (!found) throw new Error(say("No finished agent run {0} in this session.", what));
		const run = found;
		const sessionDir = agentSessionDir(ctx.sessionManager);
		const name = run.agent ?? "";
		if (!run.session || !sessionDir)
			throw new Error(say("{0} ({1}) kept no context to continue.", name, run.id ?? ""));
		if ([...runs.values()].some((entry) => entry.session === run.session))
			throw new Error(say("{0} ({1}) is already running again: wait for its answer.", name, run.id ?? ""));
		const named = [...availableAgents(agentsAdvanced()), ...(agentsAdvanced() ? [FORK_AGENT] : [])].find(
			(item) => item.name === run.agent,
		);
		if (!named) throw new Error(say("{0} is no longer offered: it was removed or turned off.", name));
		return {
			run,
			agent: run.launchModel ? { ...named, model: run.launchModel } : named,
			session: { dir: sessionDir, id: run.session },
		};
	};
	const registerAgentTool = () => {
		const advanced = agentsAdvanced();
		const agents = availableAgents(advanced);
		// P2: no agent, no tool in the prompt. Once registered, the tool stays until restart.
		if (agents.length === 0) return;
		const descriptions = agents.map((agent) => `${agent.name}: ${agent.description}`).join("; ");
		// the advanced mode's call may choose a model, and says how many agents run at once.
		const advancedRule = advanced
			? ` Pass model to run the agent on another model than the session's${listedModels.length ? `: one of ${listedModels.join(", ")} (pass the id, without the name in parentheses)` : " (none is listed: the session's model only)"}. Pass resume with the id of a finished run (ag1) to send that agent a follow-up as task: it keeps its context and model. An agent does not see this conversation: pass context with what it needs from it, and files it should read first. At most ${maxParallelAgents()} agents run at once; agent_wait waits for their answers.`
			: "";
		const baseParameters = {
			agent: Type.String({ description: "Agent name" }),
			task: Type.String({ description: "Task for the agent" }),
		};
		pi.registerTool({
			name: agentToolName,
			label: t("Agent"),
			// fork: starts a Prism process, whose own tool calls go through its gate.
			permissions: ["process"],
			description: `Run ${advanced ? "an" : "a custom"} agent on a task. ${descriptions}${advancedRule}${invocationRule(invocation)}`,
			promptSnippet: advanced ? "Run an agent on a task" : "Run a custom agent on a task",
			parameters: advanced
				? Type.Object({
						...baseParameters,
						model: Type.Optional(
							Type.String({ description: "provider/model to run the agent on; the session's model by default" }),
						),
						context: Type.Optional(
							Type.String({
								description:
									"What the agent needs from this conversation (decisions, constraints, findings), summarized by you",
							}),
						),
						files: Type.Optional(
							Type.Array(Type.String(), {
								description: "Project files the agent reads first, relative to the project",
							}),
						),
						resume: Type.Optional(
							Type.String({
								description:
									"Id of a finished run (ag1) to continue: task is your follow-up, and the agent keeps its context",
							}),
						),
					})
				: Type.Object(baseParameters),
			async execute(
				_id,
				params: {
					agent: string;
					task: string;
					model?: string;
					resume?: string;
					context?: string;
					files?: string[];
				},
				signal,
				onUpdate,
				ctx,
			) {
				if (!ctx.model) throw new Error(NO_MODEL);
				const currentModel = `${ctx.model.provider}/${ctx.model.id}`;
				const advanced = agentsAdvanced();
				// a model chosen by the call, from the session's model and the user's selected list only.
				const requested = advanced ? params.model?.trim() : undefined;
				// a finished run continued with a follow-up keeps its agent, model and context.
				const resume = advanced ? params.resume?.trim() : undefined;
				// the conversation's summary and the files to read first, joined to the task.
				const brief = advanced ? agentBrief(ctx.cwd, params.task, params.context, params.files) : params.task;
				if (resume) {
					if (!ctx.hasUI) throw new Error("Continuing an agent needs Prism's interface.");
					if (runs.has(resume))
						throw new Error(`${resume} is still running: wait for its answer with agent_wait.`);
					const found = continuable(ctx, (details) => details.id === resume, `with the id ${resume}`);
					if (found.run.agent !== params.agent)
						throw new Error(`${resume} is a run of ${found.run.agent}, not of ${params.agent}.`);
					if (requested && requested !== (found.agent.model ?? currentModel))
						throw new Error(`A continued agent keeps the model it ran on: ${found.agent.model ?? currentModel}.`);
					const id = runInBackground(ctx, {
						agent: found.agent,
						task: params.task,
						brief,
						currentModel,
						session: found.session,
						continues: resume,
					});
					return startedResult(found.agent.name, id, params.task, found.session.id, resume);
				}
				const named = availableAgents(advanced).find((item) => item.name === params.agent);
				if (!named) throw new Error(`${UNKNOWN_AGENT}${params.agent}`);
				if (requested) {
					const allowed = agentModels(currentModel, ctx.scopedModels);
					if (!allowed.includes(requested))
						throw new Error(
							`${MODEL_NOT_LISTED}${requested}. The models agents may use: ${agentModelLabels(ctx.model, ctx.scopedModels).join(", ")}. Pass the id, without the name in parentheses. The user adds models to this list with /scoped-models.`,
						);
				}
				const agent = requested ? { ...named, model: requested } : named;
				const session = newAgentSession(ctx);
				/**
				 * with an interface, an agent works as a background task: the
				 * tool returns at once, the main model goes on, and the answer comes as a message that starts a turn
				 * (after the current one). Its progress shows in the footer's status, never in the transcript the model
				 * is writing. Without an interface (print mode), nothing would receive that message: the tool waits.
				 */
				if (ctx.hasUI) {
					const id = runInBackground(ctx, { agent, task: params.task, brief, currentModel, session });
					return startedResult(agent.name, id, params.task, session?.id);
				}
				// the advanced mode's limit holds here too: parallel calls would each start a Prism process.
				const limit = maxParallelAgents();
				if (agentsAdvanced() && runs.size + waitingRuns >= limit)
					throw new Error(
						`${limit} agents are already running, the most the user allows at once. Start this one once one of them has answered.`,
					);
				waitingRuns++;
				const result = await startRun(ctx, agent, brief, currentModel, session, signal, (text, activity) =>
					onUpdate?.({ content: [{ type: "text", text }], details: { task: params.task, ...activity } }),
				).finally(() => {
					waitingRuns--;
				});
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
					(args as { model?: string }).model ??
					availableAgents(agentsAdvanced()).find((agent) => agent.name === args.agent)?.model ??
					t("Same as the current session");
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
	/**
	 * in the advanced mode, the model waits for the agents it names (or all those
	 * running) and gets their answers as this tool's result, instead of a message after its turn.
	 */
	if (agentsAdvanced())
		pi.registerTool({
			name: "agent_wait",
			label: t("Wait for agents"),
			description:
				"Wait for agents started with the agent tool to answer, and get their answers. Call it when you need their answers before going on; otherwise each answer arrives as a message when it ends.",
			promptSnippet: "Wait for running agents to answer",
			parameters: Type.Object({
				ids: Type.Optional(
					Type.Array(Type.String(), { description: "Run ids such as ag1; all running agents by default" }),
				),
				timeout_seconds: Type.Optional(
					Type.Number({ description: `How long to wait at most, ${DEFAULT_WAIT_SECONDS} by default` }),
				),
			}),
			async execute(_id, params: { ids?: string[]; timeout_seconds?: number }, signal) {
				const ids = params.ids?.length
					? [...new Set(params.ids)]
					: [...runs.keys()].filter((id) => !endedRuns.has(id));
				if (ids.length === 0)
					return { content: [{ type: "text", text: "No agent is running." }], details: { ids: [] as string[] } };
				const known = (id: string) => runs.has(id) || endedRuns.has(id);
				const pending = () => ids.filter((id) => known(id) && !endedRuns.has(id));
				const counted = pending();
				for (const id of counted) awaitedRuns.set(id, (awaitedRuns.get(id) ?? 0) + 1);
				const seconds = Math.min(
					MAX_WAIT_SECONDS,
					Math.max(1, Math.round(params.timeout_seconds ?? DEFAULT_WAIT_SECONDS)),
				);
				let timedOut = false;
				await new Promise<void>((resolve) => {
					let timer: ReturnType<typeof setTimeout> | undefined;
					const done = () => {
						waiters.delete(check);
						if (timer) clearTimeout(timer);
						signal?.removeEventListener("abort", done);
						resolve();
					};
					const check = () => {
						if (pending().length === 0) done();
					};
					waiters.add(check);
					timer = setTimeout(() => {
						timedOut = true;
						done();
					}, seconds * 1000);
					timer.unref?.();
					signal?.addEventListener("abort", done, { once: true });
					check();
				});
				// Answers that come after this point arrive as messages again.
				for (const id of counted) {
					const left = (awaitedRuns.get(id) ?? 1) - 1;
					if (left > 0) awaitedRuns.set(id, left);
					else awaitedRuns.delete(id);
				}
				const parts = ids.map((id) => {
					const answer = endedRuns.get(id);
					if (answer !== undefined) return `## ${id}\n${answer}`;
					if (!known(id)) return `## ${id}\nNo agent run has this id in this session.`;
					return `## ${id}\nStill running${timedOut ? ` after ${seconds} s` : ""}: its answer arrives as a message when it ends.`;
				});
				return { content: [{ type: "text", text: parts.join("\n\n") }], details: { ids } };
			},
		});
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
		const content =
			typeof message.content === "string"
				? message.content.replace(/^\*\*.*\*\*\n\n/, "").replace(USER_RUN_LINE, "")
				: "";
		const answer = details.stopped
			? t("The user stopped this agent before it answered.")
			: details.failed
				? content
				: localizeAnswer(details.answer ?? content, false);
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
		// a resumed session's runs keep their ids; new ones come after them.
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom_message" || entry.customType !== AGENT_ANSWER_MESSAGE) continue;
			const number = Number(/^ag(\d+)$/.exec((entry.details as AgentRunDetails | undefined)?.id ?? "")?.[1]);
			if (number > agentCounter) agentCounter = number;
		}
		// the tool's description names the models of the user's selected list.
		if (agentsAdvanced()) {
			listedModels = agentModelLabels(undefined, ctx.scopedModels);
			registerAgentTool();
		}
		panels.set(ctx.sessionManager, {
			snapshot: () => ({
				agents: readAgents(),
				tools: AGENT_TOOLS,
				defaultTools: DEFAULT_AGENT_TOOLS,
				models: ctx.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`),
				thinkingLevels: AGENT_THINKING_LEVELS,
				invocation: { ...invocation },
				help: AGENTS_HELP.map(t),
				policyHelp: INVOCATION_HELP.map(t),
				offDetail: t(TURN_OFF_DETAIL),
				running: [...runs].map(([id, run]) => ({ id, agent: run.agent, step: run.step })),
				runs: sessionRuns(ctx, runs),
				available: availableAgents(agentsAdvanced()).map((agent) => ({
					name: agent.name,
					description: t(agent.description),
				})),
				advanced: {
					on: agentsAdvanced(),
					warning: t(ADVANCED_WARNING),
					detail: t(ADVANCED_DETAIL),
					maxParallel: maxParallelAgents(),
					maxLimit: MAX_PARALLEL_LIMIT,
					presets: PRESET_AGENTS.map((agent) => ({
						name: agent.name,
						description: t(agent.description),
						on: enabledPresets().includes(agent.name),
					})),
					builtin: [GENERAL_AGENT, ...PRESET_AGENTS].map((agent) => {
						const chosen = builtinChoices()[agent.name];
						return { name: agent.name, description: t(agent.description), ...chosen };
					}),
				},
			}),
			stop: (id) => stopRun(id),
			run: (name, task) => {
				if (typeof name !== "string" || typeof task !== "string" || !task.trim())
					throw new Error(t("Write the agent's task."));
				const agent = availableAgents(agentsAdvanced()).find((item) => item.name === name);
				if (!agent) throw new Error(fill("{0} is no longer offered: it was removed or turned off.", name));
				if (!ctx.model) throw new Error(t(NO_MODEL));
				return runInBackground(ctx, {
					agent,
					task: task.trim(),
					currentModel: `${ctx.model.provider}/${ctx.model.id}`,
					session: newAgentSession(ctx),
					byUser: true,
				});
			},
			resume: (session, message) => {
				if (typeof session !== "string" || typeof message !== "string" || !message.trim())
					throw new Error(t("Write your message to the agent."));
				if (!ctx.model) throw new Error(t(NO_MODEL));
				const found = continuable(ctx, (details) => details.session === session, t("with this transcript"), fill);
				return runInBackground(ctx, {
					agent: found.agent,
					task: message.trim(),
					currentModel: `${ctx.model.provider}/${ctx.model.id}`,
					session: found.session,
					...(found.run.id ? { continues: found.run.id } : {}),
					byUser: true,
				});
			},
			fork: (task) => {
				if (!agentsAdvanced()) throw new Error(t("Turn the advanced agent mode on first (/agents)."));
				if (typeof task !== "string" || !task.trim()) throw new Error(t("Write the agent's task."));
				if (!ctx.model) throw new Error(t(NO_MODEL));
				if (!ctx.isIdle())
					throw new Error(
						t("Wait for the end of the current turn: the agent starts from the conversation as it is."),
					);
				const file = ctx.sessionManager.getSessionFile();
				const session = newAgentSession(ctx);
				if (!file || !existsSync(file) || !session)
					throw new Error(t("This conversation is not saved yet: send a first message, or open a saved session."));
				const currentModel = `${ctx.model.provider}/${ctx.model.id}`;
				return runInBackground(ctx, {
					agent: { ...FORK_AGENT, model: currentModel },
					task: task.trim(),
					currentModel,
					session: { ...session, forkFrom: file },
					byUser: true,
				});
			},
			setAdvanced: (on) => {
				if (typeof on !== "boolean") throw new Error("on must be a boolean");
				saveGlobalSetting([AGENTS_ADVANCED_SETTING], on ? true : undefined);
			},
			setPresets: (names) => {
				if (!Array.isArray(names) || !names.every((name) => typeof name === "string"))
					throw new Error("names must be a list of agent names");
				const kept = PRESET_AGENTS.map((agent) => agent.name).filter((name) => names.includes(name));
				saveGlobalSetting([AGENTS_PRESETS_SETTING], kept.length ? kept : undefined);
				registerAgentTool();
			},
			setMaxParallel: (count) => {
				if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > MAX_PARALLEL_LIMIT)
					throw new Error(fill("Type a whole number from 1 to {0}.", String(MAX_PARALLEL_LIMIT)));
				saveGlobalSetting([AGENTS_MAX_PARALLEL_SETTING], count === DEFAULT_MAX_PARALLEL ? undefined : count);
				registerAgentTool();
			},
			setBuiltin: (name, choice) => {
				if (typeof name !== "string" || ![GENERAL_AGENT, ...PRESET_AGENTS].some((agent) => agent.name === name))
					throw new Error("Unknown agent.");
				const fields = (choice && typeof choice === "object" ? choice : {}) as Record<string, unknown>;
				const model = typeof fields.model === "string" && fields.model ? fields.model : undefined;
				const thinking = typeof fields.thinking === "string" && fields.thinking ? fields.thinking : undefined;
				if (model && !ctx.modelRegistry.getAvailable().some((entry) => `${entry.provider}/${entry.id}` === model))
					throw new Error("Unknown model.");
				if (thinking && !isAgentThinking(thinking)) throw new Error("Unknown effort.");
				saveGlobalSetting([AGENTS_BUILTIN_SETTING, name], model || thinking ? { model, thinking } : undefined);
			},
			save: (value, existingName) => {
				if (!value || typeof value !== "object") throw new Error("Invalid agent.");
				const fields = value as Record<string, unknown>;
				if (
					typeof fields.name !== "string" ||
					typeof fields.description !== "string" ||
					typeof fields.instructions !== "string" ||
					!Array.isArray(fields.tools) ||
					!fields.tools.every((tool): tool is string => typeof tool === "string") ||
					(fields.model !== undefined && typeof fields.model !== "string") ||
					(fields.thinking !== undefined &&
						fields.thinking !== "" &&
						(typeof fields.thinking !== "string" || !isAgentThinking(fields.thinking)))
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
				const thinking =
					typeof fields.thinking === "string" && isAgentThinking(fields.thinking) ? fields.thinking : undefined;
				saveAgent(
					{
						name,
						description: fields.description,
						instructions: fields.instructions,
						tools: fields.tools,
						model,
						...(thinking ? { thinking } : {}),
					},
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

	/** the preconfigured agents, each turned on or off by Enter. */
	const choosePresets = async (ctx: ExtensionContext) => {
		while (true) {
			const on = new Set(enabledPresets());
			const rows = PRESET_AGENTS.map((agent) => ({
				name: agent.name,
				label: `${on.has(agent.name) ? "✓" : "·"} ${agent.name} — ${t(agent.description)}`,
			}));
			const choice = await ctx.ui.select(
				[
					t("Preconfigured agents"),
					t("Enter turns each one on or off. They run on the session's model unless a call chooses another."),
				].join("\n"),
				[...rows.map((row) => row.label), t("Back")],
			);
			const row = rows.find((entry) => entry.label === choice);
			if (!row) return;
			if (on.has(row.name)) on.delete(row.name);
			else on.add(row.name);
			const names = PRESET_AGENTS.map((agent) => agent.name).filter((name) => on.has(name));
			saveGlobalSetting([AGENTS_PRESETS_SETTING], names.length ? names : undefined);
			registerAgentTool();
		}
	};

	/** one line of a run's transcript in the terminal. */
	const transcriptLine = (entry: AgentTranscriptEntry): string => {
		const text = (entry.kind === "tool" ? `${entry.name ?? ""} ${entry.args ?? ""}` : (entry.text ?? ""))
			.replace(/\s+/g, " ")
			.trim();
		const who =
			entry.kind === "user"
				? t("Task")
				: entry.kind === "assistant"
					? t("Agent")
					: entry.kind === "thinking"
						? t("Thinking")
						: entry.kind === "tool"
							? t("Tool")
							: t("Note");
		return truncate(`${who}: ${text}`, 110);
	};
	/** How many of a run's last transcript lines the terminal shows. */
	const TRANSCRIPT_LINES = 12;

	/**
	 * the terminal's equivalent of the window's « Sous-agents » panel: this session's
	 * runs, each with the end of its transcript; a running one can be stopped, a finished one continued with a message.
	 */
	const chooseRun = async (ctx: ExtensionContext) => {
		while (true) {
			const all = sessionRuns(ctx, runs).reverse();
			all.sort((a, b) => Number(b.state === "running") - Number(a.state === "running"));
			if (all.length === 0) return;
			const state = (run: AgentRun) => (run.state === "running" ? (run.step ?? t("working")) : t(run.state));
			const rows = all.map((run, index) => ({
				run,
				label: `${index + 1}. ${run.agent} (${run.id}) · ${state(run)} — ${truncate(run.task.replace(/\s+/g, " "), 60)}`,
			}));
			const choice = await ctx.ui.select(t("Agent runs of this session"), [
				...rows.map((row) => row.label),
				t("Back"),
			]);
			const row = rows.find((entry) => entry.label === choice);
			if (!row) return;
			const { run } = row;
			let lines: string[] = [];
			try {
				lines = run.session ? agentTranscript(ctx.sessionManager, run.session).entries.map(transcriptLine) : [];
			} catch {
				// An unreadable transcript shows none.
			}
			const shown = lines.slice(-TRANSCRIPT_LINES);
			const title = [
				`${run.agent} (${run.id}) · ${state(run)}`,
				...(lines.length > shown.length ? [fill("… {0} earlier lines", String(lines.length - shown.length))] : []),
				...(shown.length ? shown : [run.session ? t("Nothing written yet.") : t("This run kept no transcript.")]),
			].join("\n");
			const stop = t("Stop it");
			const message = t("Send it a message…");
			const actions = [
				...(run.state === "running" && runs.has(run.id) ? [stop] : []),
				...(run.state !== "running" && run.session ? [message] : []),
				t("Back"),
			];
			const action = await ctx.ui.select(title, actions);
			if (action === stop) {
				if (await ctx.ui.confirm(fill("Stop {0}?", run.agent), t(STOP_DETAIL))) {
					try {
						await stopRun(run.id);
					} catch (error) {
						ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
					}
				}
			} else if (action === message && run.session) {
				const text = (await ctx.ui.input(fill("Message to {0}", run.agent)))?.trim();
				if (!text) continue;
				try {
					const id = agentsPanel(ctx)?.resume(run.session, text);
					if (id) ctx.ui.notify(fill("{0} continues ({1}): its answer will follow.", run.agent, id));
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
				}
			}
		}
	};

	/** the user starts an agent on a task, from /agents. */
	const launchAgent = async (ctx: ExtensionContext) => {
		const agents = availableAgents(agentsAdvanced());
		const rows = agents.map((agent) => ({ name: agent.name, label: `${agent.name} — ${t(agent.description)}` }));
		const choice = await ctx.ui.select(t("Run which agent?"), [...rows.map((row) => row.label), t("Back")]);
		const row = rows.find((entry) => entry.label === choice);
		if (!row) return;
		const task = (await ctx.ui.input(fill("Task for {0}", row.name)))?.trim();
		if (!task) return;
		try {
			const id = agentsPanel(ctx)?.run(row.name, task);
			if (id) ctx.ui.notify(fill("{0} started ({1}): its answer will follow.", row.name, id));
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
		}
	};

	/** `/agents fork <task>`, and the menu's row: an agent on a copy of the conversation. */
	const forkConversation = async (ctx: ExtensionContext, typed?: string) => {
		const task = typed?.trim() || (await ctx.ui.input(t("Task for the agent that takes this conversation")))?.trim();
		if (!task) return;
		try {
			const id = agentsPanel(ctx)?.fork(task);
			if (id) ctx.ui.notify(fill("{0} started ({1}): its answer will follow.", FORK_AGENT.name, id));
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
		}
	};

	pi.registerCommand("agents", {
		description: t("Create and manage custom agents"),
		getArgumentCompletions: (prefix) =>
			agentsAdvanced() && "fork".startsWith(prefix.trim())
				? [{ value: "fork ", label: "fork", description: t("Run an agent on a copy of this conversation") }]
				: null,
		handler: async (args, ctx) => {
			const forkArgs = /^fork(?:\s+([\s\S]*))?$/.exec(args.trim());
			if (forkArgs) {
				await forkConversation(ctx, forkArgs[1]);
				return;
			}
			while (true) {
				const agents = readAgents();
				const engineLabel = (agent: { model?: string; thinking?: string }) =>
					`${agent.model ?? t("Same as the current session")}${agent.thinking ? ` · ${agent.thinking}` : ""}`;
				const labels = agents.map(
					(agent) => `${agent.name} — ${engineLabel(agent)} — ${agent.tools.join(", ")} — ${agent.description}`,
				);
				const create = t("New agent");
				const policy = t("When the model may run an agent…");
				const off = t("Turn agents off");
				// the advanced agent mode and its limit on agents at once.
				const advancedNow = agentsAdvanced();
				const advancedLabel = advancedNow
					? t("Advanced mode: on (turn it off)")
					: t("Advanced mode: off (turn it on)…");
				const parallelLabel = fill("Agents at once: {0}", String(maxParallelAgents()));
				const presetsLabel = fill("Preconfigured agents ({0} on)…", String(enabledPresets().length));
				// the runs of this session, and starting an agent, in either mode.
				const runCount = sessionRuns(ctx, runs).length;
				const runsLabel = fill("Agent runs of this session ({0})…", String(runCount));
				const launchLabel = t("Run an agent…");
				const forkLabel = t("Run an agent on a copy of this conversation…");
				const launchable = availableAgents(advancedNow).length > 0;
				// with the advanced mode on, the agents it adds are listed with
				// the user's own, each with the model and effort it runs on.
				const builtIn = advancedNow
					? availableAgents(true).filter((agent) => !agents.some((own) => own.name === agent.name))
					: [];
				const builtInRows = builtIn.map((agent) => ({
					name: agent.name,
					label: `${agent.name} — ${t("built-in")} — ${engineLabel(agent)} — ${t(agent.description)}`,
				}));
				const title = [
					t("Agents"),
					...AGENTS_HELP.map((line) => t(line)),
					...(advancedNow ? [t(ADVANCED_ON_HELP)] : []),
					policySummary(invocation),
				].join("\n");
				// a running agent can be stopped here, first in the list.
				const stops = [...runs].map(([id, run]) => ({
					id,
					agent: run.agent,
					label: fill("■ Stop {0} ({1}) · {2}", run.agent, id, run.step),
				}));
				const choice = await ctx.ui.select(title, [
					...stops.map((stop) => stop.label),
					...(runCount ? [runsLabel] : []),
					...(launchable ? [launchLabel] : []),
					...(advancedNow ? [forkLabel] : []),
					...builtInRows.map((row) => row.label),
					...labels,
					create,
					policy,
					advancedLabel,
					...(advancedNow ? [presetsLabel, parallelLabel] : []),
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
				if (choice === runsLabel) {
					await chooseRun(ctx);
					continue;
				}
				if (choice === launchLabel) {
					await launchAgent(ctx);
					continue;
				}
				if (choice === forkLabel) {
					await forkConversation(ctx);
					return;
				}
				if (choice === advancedLabel) {
					if (
						!advancedNow &&
						!(await ctx.ui.confirm(t("Turn the advanced agent mode on?"), t(ADVANCED_DETAIL), {
							warning: t(ADVANCED_WARNING),
						}))
					)
						continue;
					// turning it on goes on to the preconfigured agents to turn on.
					if (!advancedNow) await choosePresets(ctx);
					saveGlobalSetting([AGENTS_ADVANCED_SETTING], advancedNow ? undefined : true);
					// Its tools change: it applies by reloading, as turning agents off does.
					await ctx.reload();
					return;
				}
				if (choice === presetsLabel) {
					await choosePresets(ctx);
					continue;
				}
				if (choice === parallelLabel) {
					const typed = await ctx.ui.input(
						fill("Agents at once (1 to {0})", String(MAX_PARALLEL_LIMIT)),
						String(maxParallelAgents()),
					);
					if (typed === undefined || !typed.trim()) continue;
					const count = Number(typed.trim());
					if (!Number.isInteger(count) || count < 1 || count > MAX_PARALLEL_LIMIT) {
						ctx.ui.notify(fill("Type a whole number from 1 to {0}.", String(MAX_PARALLEL_LIMIT)), "warning");
						continue;
					}
					saveGlobalSetting([AGENTS_MAX_PARALLEL_SETTING], count === DEFAULT_MAX_PARALLEL ? undefined : count);
					registerAgentTool();
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
				const builtInRow = builtInRows.find((row) => row.label === choice);
				if (builtInRow) {
					const engine = await chooseModelAndEffort(ctx);
					if (engine) {
						saveGlobalSetting(
							[AGENTS_BUILTIN_SETTING, builtInRow.name],
							engine.model || engine.thinking ? engine : undefined,
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
