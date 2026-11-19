/**
 * Claude models through the user's own Claude Code (`claude -p`), with
 * Prism's tools.
 *
 * Prism's engine calls `streamSimple` with the whole transcript each time; Claude Code keeps its own history in a
 * long-lived process. A conversation therefore keeps one `claude` process and the number of transcript messages
 * it has seen. A call whose transcript extends that prefix only delivers what is new: tool results answer the
 * calls waiting on the MCP bridge, user messages go to stdin. Any other transcript (compaction, a rewind, a
 * resumed session, a new model) starts a new process that gets the earlier conversation as text.
 */
import {
	type ApiKeyCredential,
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type ImageContent,
	type Message,
	type Model,
	type ModelThinkingLevel,
	type Provider,
	parseStreamingJson,
	type RefreshModelsContext,
	type SimpleStreamOptions,
	type TextContent,
	type ThinkingLevelMap,
	type Tool,
	type TranscriptContext,
	type Usage,
} from "@earendil-works/pi-ai";
import { getModels } from "@earendil-works/pi-ai/compat";
import { t } from "../i18n/index.ts";
import { ClaudeProcess, findClaudeBinary, type StreamJson } from "./claude-process.ts";
import { CLAUDE_CODE_PROVIDER_ID } from "./id.ts";
import {
	BRIDGE_SERVER_NAME,
	BRIDGE_TOOL_PREFIX,
	type BridgeCallResult,
	type McpBridge,
	startMcpBridge,
} from "./mcp-bridge.ts";

export { CLAUDE_CODE_PROVIDER_ID };
export const CLAUDE_CODE_API = "claude-code";
const BASE_URL = "claude-code:local";
const MODELS_FRESH_MS = 60 * 60 * 1000;

export const CLAUDE_CODE_TERMS_URL = "https://code.claude.com/docs/en/legal-and-compliance";
export const CLAUDE_CODE_TERMS_NOTICE =
	"Anthropic allows your Claude subscription in the unmodified Claude Code, but its terms do not say whether an app such as Prism may run it for you. Any risk to your Claude account is yours.";

/** One model as Claude Code's `initialize` control response lists it. */
export interface ClaudeCodeModelInfo {
	value: string;
	resolvedModel?: string;
	displayName?: string;
	supportsEffort?: boolean;
	supportedEffortLevels?: string[];
}

const PI_LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function toPiModel(info: ClaudeCodeModelInfo): Model<typeof CLAUDE_CODE_API> {
	// Claude Code does not say the context size; the built-in Anthropic catalog does, for the model an alias
	// resolves to.
	const known = info.resolvedModel
		? getModels("anthropic").find((model) => model.id === info.resolvedModel)
		: undefined;
	const levels = new Set(info.supportedEffortLevels ?? []);
	const thinkingLevelMap: ThinkingLevelMap = {};
	for (const level of PI_LEVELS) thinkingLevelMap[level] = levels.has(level) ? level : null;
	const resolved = info.resolvedModel && info.resolvedModel !== info.value ? ` (${info.resolvedModel})` : "";
	return {
		id: info.value,
		name: `${info.displayName ?? info.value}${resolved}`,
		api: CLAUDE_CODE_API,
		provider: CLAUDE_CODE_PROVIDER_ID,
		baseUrl: BASE_URL,
		reasoning: info.supportsEffort === true && levels.size > 0,
		...(info.supportsEffort && levels.size > 0 ? { thinkingLevelMap } : {}),
		input: ["text", "image"],
		// Paid by the user's subscription: nothing per token here.
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: known?.contextWindow ?? 200_000,
		maxTokens: known?.maxTokens ?? 32_000,
	};
}

/** Asks Claude Code for its models and its login; the process stops right after. */
export async function readClaudeCode(
	binary: string,
	signal?: AbortSignal,
): Promise<{ models: ClaudeCodeModelInfo[]; loggedIn: boolean }> {
	const process = new ClaudeProcess({ binary, cwd: globalThis.process.cwd() });
	const stop = () => process.kill();
	signal?.addEventListener("abort", stop, { once: true });
	try {
		const id = process.control({ subtype: "initialize" });
		for (;;) {
			const line = await process.next();
			if (!line) throw new Error(`Claude Code stopped before answering: ${process.errorOutput || "no output"}`);
			const response = line.response as Record<string, unknown> | undefined;
			if (line.type !== "control_response" || response?.request_id !== id) continue;
			if (response.subtype === "error") throw new Error(`Claude Code: ${String(response.error)}`);
			const body = (response.response ?? {}) as Record<string, unknown>;
			const account = (body.account ?? {}) as Record<string, unknown>;
			const source = (value: unknown) => typeof value === "string" && value !== "" && value !== "none";
			const named = (value: unknown) => typeof value === "string" && value !== "";
			return {
				models: Array.isArray(body.models) ? (body.models as ClaudeCodeModelInfo[]) : [],
				// Claude Code 2.1.319, logged in with a subscription, names the
				// account (email, subscriptionType) and no token source; logged out, it says tokenSource "none".
				loggedIn:
					source(account.tokenSource) ||
					source(account.apiKeySource) ||
					named(account.email) ||
					named(account.subscriptionType),
			};
		}
	} finally {
		signal?.removeEventListener("abort", stop);
		process.kill();
	}
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, entry]) => entry !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function textOf(content: string | (TextContent | ImageContent)[]): string {
	return typeof content === "string"
		? content
		: content.map((block) => (block.type === "text" ? block.text : "[image]")).join("\n");
}

/** Enough of a message to tell whether the transcript still extends what the process has seen. */
function fingerprint(message: Message): string {
	switch (message.role) {
		case "assistant":
			return `a:${message.content
				.map((block) => (block.type === "toolCall" ? block.id : block.type === "text" ? block.text.length : ""))
				.join(",")}`;
		case "user":
			return `u:${textOf(message.content).length}`;
		case "toolResult":
			return `t:${message.toolCallId}`;
		default:
			return `s:${textOf(message.content).length}`;
	}
}

const HISTORY_RESULT_LIMIT = 20_000;

/** The earlier conversation as text, for a new process that has none of it. */
export function historyText(messages: readonly Message[]): string {
	const lines: string[] = [];
	for (const message of messages) {
		if (message.role === "user") lines.push(`User: ${textOf(message.content)}`);
		else if (message.role === "system") {
			const text = textOf(message.content);
			if (text) lines.push(`System notice: ${text}`);
		} else if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "text" && block.text) lines.push(`Assistant: ${block.text}`);
				else if (block.type === "toolCall")
					lines.push(`Assistant called ${block.name} with ${JSON.stringify(block.arguments)}`);
			}
		} else {
			const text = textOf(message.content);
			const cut = text.length > HISTORY_RESULT_LIMIT ? `${text.slice(0, HISTORY_RESULT_LIMIT)}\n[truncated]` : text;
			lines.push(`Result of ${message.toolName}${message.isError ? " (error)" : ""}: ${cut}`);
		}
	}
	return lines.join("\n\n");
}

type InputBlock = { type: "text"; text: string } | { type: "image"; source: Record<string, string> };

function inputBlocks(content: string | (TextContent | ImageContent)[]): InputBlock[] {
	if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
	return content.map((block) =>
		block.type === "text"
			? { type: "text", text: block.text }
			: { type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } },
	);
}

function userMessage(blocks: InputBlock[]): Record<string, unknown> {
	return { type: "user", message: { role: "user", content: blocks } };
}

/** How long a call may arrive ahead of the answer that makes it. */
const EXPECT_TIMEOUT_MS = 30_000;

interface ExpectedCall {
	id: string;
	name: string;
	args: string;
}

/** One Prism conversation and the `claude` process that holds its history. */
class Conversation {
	process: ClaudeProcess | undefined;
	bridge: McpBridge | undefined;
	key = "";
	/** Transcript messages (after the leading system message) the process has seen, its own answers included. */
	seen = 0;
	lastSeen = "";
	/** Tool calls of the last answer: their ids, and those Claude Code has not called through the bridge yet. */
	pendingIds = new Set<string>();
	expected: ExpectedCall[] = [];
	readonly waiting = new Map<string, (result: BridgeCallResult) => void>();
	readonly ready = new Map<string, BridgeCallResult>();
	/** Reading the end of a finished turn, up to its `result` line. */
	draining: Promise<void> | undefined;
	/** Calls on one conversation run one after the other. */
	queue: Promise<void> = Promise.resolve();

	private readonly expectedWaiters = new Set<() => void>();

	/** A tool call of the answer being read: Claude Code may call it before Prism has read the whole answer. */
	expect(call: ExpectedCall): void {
		this.pendingIds.add(call.id);
		this.expected.push(call);
		for (const wake of this.expectedWaiters) wake();
	}

	private match(name: string, wanted: string): ExpectedCall | undefined {
		let index = this.expected.findIndex((call) => call.name === name && call.args === wanted);
		if (index < 0) index = this.expected.findIndex((call) => call.name === name);
		return index < 0 ? undefined : this.expected.splice(index, 1)[0];
	}

	async onCall(name: string, args: Record<string, unknown>): Promise<BridgeCallResult> {
		const wanted = canonical(args);
		let call = this.match(name, wanted);
		const deadline = Date.now() + EXPECT_TIMEOUT_MS;
		while (!call && Date.now() < deadline) {
			await new Promise<void>((resolve) => {
				const wake = () => {
					this.expectedWaiters.delete(wake);
					clearTimeout(timer);
					resolve();
				};
				const timer = setTimeout(wake, Math.max(0, deadline - Date.now()));
				this.expectedWaiters.add(wake);
			});
			call = this.match(name, wanted);
		}
		if (!call) return { content: [{ type: "text", text: `Prism did not expect a call to ${name}.` }], isError: true };
		const ready = this.ready.get(call.id);
		if (ready) {
			this.ready.delete(call.id);
			return ready;
		}
		return new Promise((resolve) => this.waiting.set(call.id, resolve));
	}

	deliver(id: string, result: BridgeCallResult): void {
		const waiting = this.waiting.get(id);
		if (waiting) {
			this.waiting.delete(id);
			waiting(result);
		} else this.ready.set(id, result);
	}

	reset(): void {
		this.process?.kill();
		this.process = undefined;
		this.seen = 0;
		this.lastSeen = "";
		this.pendingIds.clear();
		this.expected = [];
		for (const resolve of this.waiting.values())
			resolve({ content: [{ type: "text", text: "The conversation was restarted." }], isError: true });
		this.waiting.clear();
		this.ready.clear();
		this.draining = undefined;
		for (const wake of this.expectedWaiters) wake();
	}

	async close(): Promise<void> {
		this.reset();
		await this.bridge?.close();
		this.bridge = undefined;
	}
}

const MAX_CONVERSATIONS = 8;
const conversations = new Map<string, Conversation>();

function conversationFor(sessionId: string): Conversation {
	let conversation = conversations.get(sessionId);
	if (conversation) {
		// Most recently used last.
		conversations.delete(sessionId);
		conversations.set(sessionId, conversation);
		return conversation;
	}
	conversation = new Conversation();
	conversations.set(sessionId, conversation);
	while (conversations.size > MAX_CONVERSATIONS) {
		const [oldest, entry] = conversations.entries().next().value as [string, Conversation];
		conversations.delete(oldest);
		void entry.close();
	}
	return conversation;
}

/** Stops every `claude` process this Prism process started. */
export async function closeClaudeCodeConversations(): Promise<void> {
	const all = [...conversations.values()];
	conversations.clear();
	await Promise.all(all.map((conversation) => conversation.close()));
}

function abortedError(): Error {
	return new Error("Request was aborted");
}

/** Reads one answer of the model (one API message) and streams it as Prism's assistant message. */
async function readAnswer(
	process: ClaudeProcess,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	signal: AbortSignal | undefined,
	onToolCall?: (call: ExpectedCall) => void,
): Promise<{ stop: "tool_use" | "end" | "length" }> {
	let started = false;
	let stopReason: string | undefined;
	const blocks = new Map<number, { index: number; json: string }>();
	const start = () => {
		if (started) return;
		started = true;
		stream.push({ type: "start", partial: output });
	};
	let abort: (() => void) | undefined;
	const aborted = new Promise<undefined>((resolve) => {
		abort = () => resolve(undefined);
		if (signal?.aborted) resolve(undefined);
		else signal?.addEventListener("abort", abort, { once: true });
	});
	try {
		for (;;) {
			const line: StreamJson | undefined = await Promise.race([process.next(), aborted]);
			if (signal?.aborted) throw abortedError();
			if (!line) {
				throw new Error(
					`Claude Code stopped${process.exitCode !== null ? ` (exit ${process.exitCode})` : ""}: ${process.errorOutput || "no output"}`,
				);
			}
			if (line.type === "result") {
				// A turn that ended without a streamed answer: an error Claude Code reports itself.
				const result = typeof line.result === "string" ? line.result : "";
				const errors = Array.isArray(line.errors) ? line.errors.map(String).join("; ") : "";
				throw new Error(result || errors || `Claude Code ended the turn (${String(line.subtype)}).`);
			}
			if (line.type === "assistant" && line.error) {
				const message = line.message as { content?: { type?: string; text?: string }[] } | undefined;
				const text = message?.content?.map((block) => block.text ?? "").join("") ?? "";
				throw new Error(text || `Claude Code: ${String(line.error)}`);
			}
			if (line.type !== "stream_event") continue;
			const event = line.event as Record<string, unknown>;
			switch (event.type) {
				case "message_start": {
					const message = event.message as { model?: string; id?: string; usage?: Record<string, number> };
					if (message.model) output.responseModel = message.model;
					if (message.id) output.responseId = message.id;
					const usage = message.usage ?? {};
					output.usage.input = usage.input_tokens ?? 0;
					output.usage.cacheRead = usage.cache_read_input_tokens ?? 0;
					output.usage.cacheWrite = usage.cache_creation_input_tokens ?? 0;
					output.usage.output = usage.output_tokens ?? 0;
					start();
					break;
				}
				case "content_block_start": {
					start();
					const block = event.content_block as Record<string, unknown>;
					const index = output.content.length;
					if (block.type === "text") {
						output.content.push({ type: "text", text: "" });
						stream.push({ type: "text_start", contentIndex: index, partial: output });
					} else if (block.type === "thinking" || block.type === "redacted_thinking") {
						output.content.push({
							type: "thinking",
							thinking: "",
							...(block.type === "redacted_thinking" ? { redacted: true } : {}),
						});
						stream.push({ type: "thinking_start", contentIndex: index, partial: output });
					} else if (block.type === "tool_use") {
						const name = String(block.name ?? "");
						output.content.push({
							type: "toolCall",
							id: String(block.id ?? ""),
							name: name.startsWith(BRIDGE_TOOL_PREFIX) ? name.slice(BRIDGE_TOOL_PREFIX.length) : name,
							arguments: {},
						});
						stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
					} else break;
					blocks.set(Number(event.index), { index, json: "" });
					break;
				}
				case "content_block_delta": {
					const entry = blocks.get(Number(event.index));
					if (!entry) break;
					const delta = event.delta as Record<string, unknown>;
					const block = output.content[entry.index];
					if (delta.type === "text_delta" && block.type === "text") {
						const text = String(delta.text ?? "");
						block.text += text;
						stream.push({ type: "text_delta", contentIndex: entry.index, delta: text, partial: output });
					} else if (delta.type === "thinking_delta" && block.type === "thinking") {
						const text = String(delta.thinking ?? "");
						block.thinking += text;
						stream.push({ type: "thinking_delta", contentIndex: entry.index, delta: text, partial: output });
					} else if (delta.type === "input_json_delta" && block.type === "toolCall") {
						const text = String(delta.partial_json ?? "");
						entry.json += text;
						block.arguments = parseStreamingJson(entry.json);
						stream.push({ type: "toolcall_delta", contentIndex: entry.index, delta: text, partial: output });
					}
					break;
				}
				case "content_block_stop": {
					const entry = blocks.get(Number(event.index));
					if (!entry) break;
					const block = output.content[entry.index];
					if (block.type === "text")
						stream.push({ type: "text_end", contentIndex: entry.index, content: block.text, partial: output });
					else if (block.type === "thinking")
						stream.push({
							type: "thinking_end",
							contentIndex: entry.index,
							content: block.thinking,
							partial: output,
						});
					else if (block.type === "toolCall") {
						if (entry.json) block.arguments = parseStreamingJson(entry.json);
						onToolCall?.({ id: block.id, name: block.name, args: canonical(block.arguments) });
						stream.push({ type: "toolcall_end", contentIndex: entry.index, toolCall: block, partial: output });
					}
					break;
				}
				case "message_delta": {
					const delta = event.delta as { stop_reason?: string } | undefined;
					if (delta?.stop_reason) stopReason = delta.stop_reason;
					const usage = event.usage as Record<string, number> | undefined;
					if (usage?.output_tokens !== undefined) output.usage.output = usage.output_tokens;
					break;
				}
				case "message_stop": {
					start();
					output.rawStopReason = stopReason;
					if (stopReason === "tool_use" && output.content.some((block) => block.type === "toolCall"))
						return { stop: "tool_use" };
					return { stop: stopReason === "max_tokens" ? "length" : "end" };
				}
			}
		}
	} finally {
		if (abort) signal?.removeEventListener("abort", abort);
		output.usage.totalTokens =
			output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
	}
}

/** Reads what follows a finished turn, up to its `result` line. */
async function drain(process: ClaudeProcess): Promise<void> {
	for (;;) {
		const line = await process.next();
		if (!line || line.type === "result") return;
	}
}

interface Prepared {
	systemPrompt: string;
	tools: Tool[];
	/** The transcript after its leading system message. */
	convo: Message[];
}

function prepare(context: TranscriptContext): Prepared {
	const [first, ...rest] = context.messages;
	const leading = first?.role === "system" ? first : undefined;
	const tools = new Map<string, Tool>();
	for (const message of context.messages) {
		if (message.role !== "system") continue;
		for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
		for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
	}
	return {
		systemPrompt: leading ? textOf(leading.content) : "",
		tools: [...tools.values()],
		convo: leading ? rest : context.messages,
	};
}

/** The first message of a new process: the earlier conversation as text, then what is new. */
function openingBlocks(convo: readonly Message[]): InputBlock[] {
	let tail = convo.length;
	while (tail > 0 && (convo[tail - 1].role === "user" || convo[tail - 1].role === "system")) tail--;
	const history = convo.slice(0, tail);
	const blocks: InputBlock[] = [];
	if (history.length > 0) {
		blocks.push({
			type: "text",
			text: `This conversation continues an earlier one. The earlier conversation, for context:\n<earlier-conversation>\n${historyText(history)}\n</earlier-conversation>`,
		});
	}
	for (const message of convo.slice(tail)) {
		if (message.role === "user") blocks.push(...inputBlocks(message.content));
		else if (message.role === "system") {
			const text = textOf(message.content);
			if (text) blocks.push({ type: "text", text: `System notice: ${text}` });
		}
	}
	if (tail === convo.length) blocks.push({ type: "text", text: "Continue from the tool results above." });
	return blocks;
}

function effortFor(model: Model<string>, options: SimpleStreamOptions | undefined): string | undefined {
	if (!options?.reasoning) return undefined;
	const mapped = model.thinkingLevelMap?.[options.reasoning];
	return typeof mapped === "string" ? mapped : undefined;
}

async function runTurn(
	model: Model<string>,
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	stream: AssistantMessageEventStream,
): Promise<void> {
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
	const binary = findClaudeBinary();
	const fail = (error: unknown, conversation?: Conversation) => {
		conversation?.reset();
		const aborted = options?.signal?.aborted === true;
		output.stopReason = aborted ? "aborted" : "error";
		output.errorMessage = aborted ? "Request was aborted" : error instanceof Error ? error.message : String(error);
		stream.push({ type: "error", reason: output.stopReason, error: output });
		stream.end(output);
	};
	if (!binary) {
		fail(new Error(t("Claude Code (`claude`) is not on PATH. Install Claude Code, then try again.")));
		return;
	}
	const prepared = prepare(context);
	const effort = effortFor(model, options);

	// A request without tools (a compaction summary, a title) gets a process of its own, stopped after it.
	if (prepared.tools.length === 0) {
		const process = new ClaudeProcess({
			binary,
			cwd: globalThis.process.cwd(),
			model: model.id,
			effort,
			systemPrompt: prepared.systemPrompt,
		});
		try {
			process.send(userMessage(openingBlocks(prepared.convo)));
			const answer = await readAnswer(process, output, stream, options?.signal);
			output.stopReason = answer.stop === "length" ? "length" : "stop";
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end(output);
		} catch (error) {
			fail(error);
		} finally {
			process.kill();
		}
		return;
	}

	const conversation = conversationFor(options?.sessionId ?? "default");
	const previous = conversation.queue;
	let release: () => void = () => {};
	conversation.queue = new Promise((resolve) => {
		release = resolve;
	});
	await previous;
	try {
		await conversation.draining;
		conversation.draining = undefined;
		const key = canonical({
			model: model.id,
			effort,
			system: prepared.systemPrompt,
			tools: prepared.tools.map((tool) => [tool.name, tool.description, JSON.stringify(tool.parameters)]),
		});
		const { convo } = prepared;
		const tail = convo.slice(conversation.seen);
		const continues =
			conversation.process?.alive === true &&
			conversation.key === key &&
			conversation.seen > 0 &&
			convo.length > conversation.seen &&
			fingerprint(convo[conversation.seen - 1]) === conversation.lastSeen &&
			tail.every((message) => message.role !== "assistant") &&
			[...conversation.pendingIds].every((id) =>
				tail.some((message) => message.role === "toolResult" && message.toolCallId === id),
			);

		if (continues) {
			const blocks: InputBlock[] = [];
			for (const message of tail) {
				if (message.role === "toolResult") {
					conversation.deliver(message.toolCallId, { content: message.content, isError: message.isError });
				} else if (message.role === "user") blocks.push(...inputBlocks(message.content));
				else if (message.role === "system") {
					const text = textOf(message.content);
					if (text) blocks.push({ type: "text", text: `System notice: ${text}` });
				}
			}
			conversation.pendingIds.clear();
			if (blocks.length > 0) conversation.process!.send(userMessage(blocks));
		} else {
			conversation.reset();
			if (!conversation.bridge) {
				conversation.bridge = await startMcpBridge((name, args) => conversation.onCall(name, args));
			}
			conversation.bridge.setTools(prepared.tools);
			conversation.key = key;
			conversation.process = new ClaudeProcess({
				binary,
				cwd: globalThis.process.cwd(),
				model: model.id,
				effort,
				systemPrompt: prepared.systemPrompt,
				mcp: { url: conversation.bridge.url, token: conversation.bridge.token, serverName: BRIDGE_SERVER_NAME },
			});
			conversation.process.send(userMessage(openingBlocks(convo)));
		}

		const process = conversation.process!;
		const answer = await readAnswer(process, output, stream, options?.signal, (call) => conversation.expect(call));
		conversation.seen = convo.length + 1;
		conversation.lastSeen = fingerprint(output);
		if (answer.stop === "tool_use") {
			output.stopReason = "toolUse";
		} else {
			conversation.draining = drain(process);
			output.stopReason = answer.stop === "length" ? "length" : "stop";
		}
		stream.push({ type: "done", reason: output.stopReason, message: output });
		stream.end(output);
	} catch (error) {
		fail(error, conversation);
	} finally {
		release();
	}
}

export function streamClaudeCode(
	model: Model<string>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	void runTurn(model, context, options, stream);
	return stream;
}

export interface ClaudeCodeProviderController {
	provider: Provider<typeof CLAUDE_CODE_API>;
}

export function createClaudeCodeProvider(): ClaudeCodeProviderController {
	let models: readonly Model<typeof CLAUDE_CODE_API>[] = [];
	const provider: Provider<typeof CLAUDE_CODE_API> = {
		id: CLAUDE_CODE_PROVIDER_ID,
		name: "Claude Code (claude -p)",
		baseUrl: BASE_URL,
		auth: {
			apiKey: {
				name: "Claude Code (your Claude subscription, through claude -p)",
				login: async (interaction): Promise<ApiKeyCredential> => {
					// a light warning, the terms not settling this case (claude-code.md).
					interaction.notify({
						type: "info",
						message: t(CLAUDE_CODE_TERMS_NOTICE),
						links: [{ url: CLAUDE_CODE_TERMS_URL, label: t("Anthropic's terms") }],
					});
					// The sign-in itself is instant: one choice keeps the sentence on screen until it is read.
					await interaction.prompt({
						type: "select",
						message: t(CLAUDE_CODE_TERMS_NOTICE),
						options: [{ id: "connect", label: t("Connect") }],
						signal: interaction.signal,
					});
					const binary = findClaudeBinary();
					if (!binary) {
						throw new Error(t("Claude Code (`claude`) is not on PATH. Install Claude Code, then try again."));
					}
					const { loggedIn } = await readClaudeCode(binary, interaction.signal);
					if (!loggedIn)
						throw new Error(t("Claude Code is not logged in. Run `claude` and log in there, then try again."));
					return { type: "api_key" };
				},
				// Only once the user chose it in /login: having `claude` installed is not consent.
				check: async ({ credential }) =>
					credential && findClaudeBinary() ? { type: "api_key", source: "Claude Code" } : undefined,
				resolve: async ({ credential }) =>
					credential && findClaudeBinary()
						? { auth: { apiKey: CLAUDE_CODE_PROVIDER_ID }, source: "Claude Code" }
						: undefined,
			},
		},
		getModels: () => models,
		refreshModels: async (context: RefreshModelsContext): Promise<void> => {
			const stored = context.stored?.models.filter(
				(model): model is Model<typeof CLAUDE_CODE_API> =>
					model.provider === CLAUDE_CODE_PROVIDER_ID && "api" in model && model.api === CLAUDE_CODE_API,
			);
			if (
				stored &&
				!(await context.publish({
					update: () => {
						models = stored;
					},
				}))
			)
				return;
			if (context.signal.aborted || !context.credential) return;
			// The list comes from the local binary, not from Prism's network: read it once even offline, then again
			// when it is an hour old, or when asked to.
			const checkedAt = context.stored?.checkedAt ?? 0;
			if (stored?.length && !context.force && (!context.allowNetwork || Date.now() - checkedAt < MODELS_FRESH_MS))
				return;
			const binary = findClaudeBinary();
			if (!binary) return;
			const { models: infos } = await readClaudeCode(binary, context.signal);
			if (context.signal.aborted || infos.length === 0) return;
			const refreshed = infos.map(toPiModel);
			await context.publish({
				persist: { models: refreshed, checkedAt: Date.now() },
				update: () => {
					models = refreshed;
				},
			});
		},
		stream: (model, context, options) => streamClaudeCode(model, context, options as SimpleStreamOptions),
		streamSimple: (model, context, options) => streamClaudeCode(model, context, options),
	};
	return { provider };
}
