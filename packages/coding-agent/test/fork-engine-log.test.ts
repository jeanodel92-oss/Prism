// fork: the engine's log says what went well too, in RPC mode only, and never a tool's
// arguments or a message's text.
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import engineLog, { duration, logLine, replyLine } from "../src/fork/engine-log.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

function fakePi() {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		getThinkingLevel: () => "medium",
	} as unknown as ExtensionAPI;
	const emit = (name: string, event: Record<string, unknown>, ctx: Partial<ExtensionContext>) => {
		for (const handler of handlers.get(name) ?? []) handler({ type: name, ...event }, ctx as ExtensionContext);
	};
	return { pi, emit };
}

function reply(extra: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "the secret answer" }],
		api: "openai-completions",
		provider: "local",
		model: "coder",
		usage: {
			input: 1200,
			output: 80,
			cacheRead: 1000,
			cacheWrite: 0,
			totalTokens: 1280,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
		...extra,
	} as AssistantMessage;
}

describe("engine log", () => {
	it("logs a turn's request, response, reply and tools in RPC mode, without arguments or text", () => {
		const lines: string[] = [];
		const { pi, emit } = fakePi();
		engineLog(pi, (text) => lines.push(text));
		const ctx = { mode: "rpc", model: { provider: "local", id: "coder" } } as unknown as ExtensionContext;
		emit("session_start", { reason: "startup" }, ctx);
		emit("agent_start", {}, ctx);
		emit("before_provider_request", { payload: { messages: ["the secret prompt"] } }, ctx);
		emit("after_provider_response", { status: 200, headers: {} }, ctx);
		emit("message_end", { message: reply({ stopReason: "toolUse" }) }, ctx);
		emit("tool_execution_start", { toolCallId: "1", toolName: "bash", args: { command: "echo secret-arg" } }, ctx);
		emit("tool_execution_end", { toolCallId: "1", toolName: "bash", result: {}, isError: false }, ctx);
		emit("tool_execution_start", { toolCallId: "2", toolName: "read", args: { path: "x" } }, ctx);
		emit("tool_execution_end", { toolCallId: "2", toolName: "read", result: {}, isError: true }, ctx);
		emit("before_provider_request", { payload: {} }, ctx);
		emit("after_provider_response", { status: 429, headers: {} }, ctx);
		emit("message_end", { message: reply({ stopReason: "error", errorMessage: "rate limited" }) }, ctx);
		emit("message_end", { message: { role: "user", content: "the secret prompt" } }, ctx);
		emit("agent_end", { messages: [] }, ctx);
		emit("session_compact_failed", { reason: "manual", aborted: false, errorMessage: "too short" }, ctx);

		const text = lines.map((line) => line.replace(/^\d\d:\d\d:\d\d /, "")).join("");
		expect(lines.every((line) => /^\d\d:\d\d:\d\d .+\n$/.test(line))).toBe(true);
		expect(text).toMatch(
			/^session startup: local\/coder, thinking medium\nworking\nrequest sent to local\/coder\nresponse HTTP 200 from local\/coder after \d+ ms\nreply from local\/coder: toolUse in \d+ ms, 1200 tokens in, 1000 read from cache, 80 out\ntool bash started\ntool bash done in \d+ ms\ntool read started\ntool read failed in \d+ ms\nrequest sent to local\/coder\nerror response HTTP 429 from local\/coder after \d+ ms\nreply from local\/coder failed in \d+ ms: rate limited\nidle\ncompaction failed: too short\n$/,
		);
		expect(text).not.toContain("secret");
	});

	it("writes nothing outside RPC mode, where stderr is the screen or the user's output", () => {
		const lines: string[] = [];
		const { pi, emit } = fakePi();
		engineLog(pi, (text) => lines.push(text));
		for (const mode of ["tui", "print", "json"]) {
			const ctx = { mode, model: undefined } as unknown as ExtensionContext;
			emit("session_start", { reason: "startup" }, ctx);
			emit("agent_start", {}, ctx);
		}
		expect(lines).toEqual([]);
	});

	it("formats times, durations and the served model", () => {
		expect(logLine("x", new Date(2026, 10, 13, 9, 5, 7))).toBe("09:05:07 x\n");
		expect(duration(812.4)).toBe("812 ms");
		expect(duration(4321)).toBe("4.3 s");
		expect(
			replyLine(
				reply({ responseModel: "coder-q8", usage: { ...reply().usage, cacheRead: 0, reasoning: 30 } }),
				undefined,
			),
		).toBe("reply from local/coder (coder-q8): stop, 1200 tokens in, 80 out, 30 of them thinking");
		expect(replyLine(reply({ stopReason: "aborted" }), 1500)).toBe(
			"reply from local/coder stopped in 1.5 s, 1200 tokens in, 1000 read from cache, 80 out",
		);
	});
});
