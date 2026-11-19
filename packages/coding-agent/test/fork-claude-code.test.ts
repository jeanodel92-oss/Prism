// Claude models through the user's own Claude Code (`claude -p`), with
// Prism's tools reached through a local MCP server. A fake `claude` stands in for the real binary.
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, type Message, normalizeContext } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CLAUDE_BIN_ENV } from "../src/fork/claude-code/claude-process.ts";
import { CLAUDE_CODE_PROVIDER_ID } from "../src/fork/claude-code/id.ts";
import { startMcpBridge } from "../src/fork/claude-code/mcp-bridge.ts";
import {
	closeClaudeCodeConversations,
	createClaudeCodeProvider,
	readClaudeCode,
	toPiModel,
} from "../src/fork/claude-code/provider.ts";
import { signsInWithAccount } from "../src/fork/login-menu.ts";
import { loginActionLabel } from "../src/fork/login-operations.ts";
import { formatAuthSelectorProviderType } from "../src/modes/interactive/components/oauth-selector.ts";

const tools = [{ name: "bash", description: "Run a command", parameters: Type.Object({ command: Type.String() }) }];
const model = toPiModel({ value: "default", displayName: "Default" });

let dir: string;
let binary: string;
let log: string;
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "prism-fake-claude-"));
	binary = join(dir, "claude");
	copyFileSync(join(import.meta.dirname, "fixtures", "fake-claude.mjs"), binary);
	chmodSync(binary, 0o755);
	log = join(dir, "log.jsonl");
	process.env[CLAUDE_BIN_ENV] = binary;
	process.env.FAKE_CLAUDE_LOG = log;
});
afterEach(async () => {
	await closeClaudeCodeConversations();
	rmSync(log, { force: true });
	delete process.env.FAKE_CLAUDE_CRASH;
});
afterAll(() => {
	delete process.env[CLAUDE_BIN_ENV];
	delete process.env.FAKE_CLAUDE_LOG;
	rmSync(dir, { recursive: true, force: true });
});

function received(): { pid: number; args: string[]; text: string }[] {
	try {
		return readFileSync(log, "utf-8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line))
			.filter((entry) => entry.text !== undefined);
	} catch {
		return [];
	}
}

async function call(
	messages: Message[],
	options: { tools?: typeof tools; sessionId?: string; signal?: AbortSignal } = {},
): Promise<AssistantMessage> {
	const { provider } = createClaudeCodeProvider();
	const stream = provider.streamSimple(
		model,
		normalizeContext({ systemPrompt: "Prism prompt", tools: options.tools ?? tools, messages }),
		{ sessionId: options.sessionId ?? "s", signal: options.signal },
	);
	for await (const _ of stream) {
	}
	return stream.result();
}

const user = (text: string): Message => ({ role: "user", content: text, timestamp: Date.now() });

describe("fork: Claude Code provider (claude -p)", () => {
	it("reads Claude Code's models and login, and maps effort levels to thinking levels", async () => {
		const { models, loggedIn } = await readClaudeCode(binary);
		expect(loggedIn).toBe(true);
		expect(models.map((entry) => entry.value)).toEqual(["default", "plain"]);
		const [reasoning, plain] = models.map(toPiModel);
		expect(reasoning.reasoning).toBe(true);
		expect(reasoning.thinkingLevelMap).toMatchObject({ low: "low", high: "high", medium: null, off: null });
		expect(reasoning.cost.input).toBe(0);
		expect(plain.reasoning).toBe(false);
		expect(plain.thinkingLevelMap).toBeUndefined();
	});

	// Claude Code 2.1.319 names a subscription account without a token source.
	it("reads a login from the account alone, and a logged-out Claude Code as such", async () => {
		try {
			process.env.FAKE_CLAUDE_ACCOUNT_ONLY = "1";
			expect((await readClaudeCode(binary)).loggedIn).toBe(true);
			delete process.env.FAKE_CLAUDE_ACCOUNT_ONLY;
			process.env.FAKE_CLAUDE_LOGGED_OUT = "1";
			expect((await readClaudeCode(binary)).loggedIn).toBe(false);
		} finally {
			delete process.env.FAKE_CLAUDE_ACCOUNT_ONLY;
			delete process.env.FAKE_CLAUDE_LOGGED_OUT;
		}
	});

	it("runs a tool call through Prism and keeps one process for the conversation", async () => {
		const messages: Message[] = [user("please TOOL")];
		const first = await call(messages);
		expect(first.stopReason).toBe("toolUse");
		const toolCall = first.content.find((block) => block.type === "toolCall");
		expect(toolCall).toMatchObject({ type: "toolCall", name: "bash", arguments: { command: "echo hi" } });
		messages.push(first, {
			role: "toolResult",
			toolCallId: toolCall!.type === "toolCall" ? toolCall!.id : "",
			toolName: "bash",
			content: [{ type: "text", text: "PRISM RAN" }],
			isError: false,
			timestamp: Date.now(),
		});
		const second = await call(messages);
		expect(second.stopReason).toBe("stop");
		expect(second.content).toEqual([{ type: "text", text: "tool said: PRISM RAN" }]);
		messages.push(second, user("next"));
		const third = await call(messages);
		expect(third.content).toEqual([{ type: "text", text: "echo: next" }]);
		const seen = received();
		expect(seen.map((entry) => entry.text)).toEqual(["please TOOL", "next"]);
		expect(new Set(seen.map((entry) => entry.pid)).size).toBe(1);
		// Claude Code's own tools are off; Prism's MCP server is the only one, and it is allowed.
		const args = seen[0].args;
		expect(args[args.indexOf("--tools") + 1]).toBe("");
		expect(args).toContain("--strict-mcp-config");
		expect(args[args.indexOf("--allowedTools") + 1]).toBe("mcp__prism");
		expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
		// Without it, print mode sends empty thinking blocks instead of the summaries.
		expect(args[args.indexOf("--thinking-display") + 1]).toBe("summarized");
		expect(args).not.toContain("--dangerously-skip-permissions");
	});

	it("starts again with the earlier conversation as text when the transcript no longer follows", async () => {
		const answered = await call([user("one")]);
		expect(answered.content).toEqual([{ type: "text", text: "echo: one" }]);
		// A rewind: the same conversation, but the answer replaced by another.
		const other: AssistantMessage = { ...answered, content: [{ type: "text", text: "a different answer" }] };
		await call([user("one"), other, user("two")]);
		const seen = received();
		expect(seen).toHaveLength(2);
		expect(seen[1].pid).not.toBe(seen[0].pid);
		expect(seen[1].text).toContain("<earlier-conversation>");
		expect(seen[1].text).toContain("Assistant: a different answer");
		expect(seen[1].text.endsWith("two")).toBe(true);
	});

	it("answers a request without tools in a process of its own", async () => {
		await call([user("in the conversation")]);
		const summary = await call([user("summarize")], { tools: [] });
		expect(summary.content).toEqual([{ type: "text", text: "echo: summarize" }]);
		const seen = received();
		expect(seen[1].pid).not.toBe(seen[0].pid);
		expect(seen[1].args).not.toContain("--mcp-config");
	});

	it("reports Claude Code's failure with what it printed", async () => {
		process.env.FAKE_CLAUDE_CRASH = "1";
		const failed = await call([user("hello")]);
		expect(failed.stopReason).toBe("error");
		expect(failed.errorMessage).toContain("not logged in");
	});

	it("says so when Claude Code is not installed", async () => {
		process.env[CLAUDE_BIN_ENV] = join(dir, "missing");
		try {
			const failed = await call([user("hello")]);
			expect(failed.stopReason).toBe("error");
		} finally {
			process.env[CLAUDE_BIN_ENV] = binary;
		}
	});

	it("stops on an aborted request", async () => {
		const controller = new AbortController();
		controller.abort();
		const aborted = await call([user("hello")], { signal: controller.signal });
		expect(aborted.stopReason).toBe("aborted");
	});

	it("only lets the token holder use the MCP server", async () => {
		const bridge = await startMcpBridge(async () => ({ content: [], isError: false }));
		try {
			const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
			const refused = await fetch(bridge.url, { method: "POST", body });
			expect(refused.status).toBe(401);
			const allowed = await fetch(bridge.url, {
				method: "POST",
				body,
				headers: { authorization: `Bearer ${bridge.token}` },
			});
			expect(allowed.status).toBe(200);
		} finally {
			await bridge.close();
		}
	});

	it("is offered at /login with the account sign-ins, as a subscription that stores no key", () => {
		expect(signsInWithAccount(CLAUDE_CODE_PROVIDER_ID)).toBe(true);
		expect(signsInWithAccount("anthropic")).toBe(false);
		expect(formatAuthSelectorProviderType("api_key", false, CLAUDE_CODE_PROVIDER_ID)).toBe("subscription");
		expect(formatAuthSelectorProviderType("api_key", true, "anthropic")).toBe("API key");
		expect(loginActionLabel("api_key", "Claude Code", CLAUDE_CODE_PROVIDER_ID)).toBe("Connected to Claude Code");
		expect(loginActionLabel("api_key", "OpenAI", "openai")).toBe("Saved API key for OpenAI");
	});

	it("shows Anthropic's terms before connecting, then stores a choice without any key", async () => {
		const { provider } = createClaudeCodeProvider();
		const shown: string[] = [];
		const credential = await provider.auth.apiKey!.login!({
			signal: new AbortController().signal,
			notify: (event) => {
				if (event.type === "info") shown.push(`info:${event.message}`);
			},
			prompt: async (prompt) => {
				shown.push(`prompt:${prompt.message}`);
				return "connect";
			},
		});
		expect(shown).toHaveLength(2);
		expect(shown[1]).toContain("its terms do not say whether an app such as Prism may run it");
		expect(credential).toEqual({ type: "api_key" });
	});
});
