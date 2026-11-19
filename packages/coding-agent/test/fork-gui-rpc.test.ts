import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import type * as ThemeModule from "../src/modes/interactive/theme/theme.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

// fork: what the GUI needs from RPC mode beyond upstream: a dialog the engine closes on its own
// (timeout, abort) is announced, a dialog about a tool call names that call, and the sessions can be listed.

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../src/modes/interactive/theme/theme.js", async (importOriginal) => ({
	...(await importOriginal<typeof ThemeModule>()),
	theme: {},
}));

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {
			rpcIo.lineHandler = undefined;
		};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

type NodeListener = Parameters<typeof process.on>[1];

function takeListenerSnapshot(): { stdinEnd: NodeListener[]; signals: Map<NodeJS.Signals, NodeListener[]> } {
	const signals: NodeJS.Signals[] = ["SIGTERM", "SIGHUP"];
	return {
		stdinEnd: process.stdin.listeners("end") as NodeListener[],
		signals: new Map(signals.map((signal) => [signal, process.listeners(signal) as NodeListener[]])),
	};
}

function restoreListeners(snapshot: ReturnType<typeof takeListenerSnapshot>): void {
	for (const listener of process.stdin.listeners("end") as NodeListener[]) {
		if (!snapshot.stdinEnd.includes(listener)) process.stdin.off("end", listener);
	}
	for (const [signal, previous] of snapshot.signals) {
		for (const listener of process.listeners(signal) as NodeListener[]) {
			if (!previous.includes(listener)) process.off(signal, listener);
		}
	}
}

function records(): Array<Record<string, unknown>> {
	return rpcIo.outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function runtimeHost(harness: Harness): AgentSessionRuntime {
	return {
		session: harness.session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
		setBeforeSessionInvalidate: vi.fn(),
		setOnSessionLost: vi.fn(),
	} as unknown as AgentSessionRuntime;
}

const send = (record: unknown) => rpcIo.lineHandler?.(JSON.stringify(record));

describe("fork: RPC contract for the GUI", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) cleanup();
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	async function start(harness: Harness): Promise<void> {
		const snapshot = takeListenerSnapshot();
		cleanups.push(() => {
			harness.cleanup();
			restoreListeners(snapshot);
		});
		void runRpcMode(runtimeHost(harness));
		await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
	}

	test("announces a dialog that timed out, so the client closes it", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("ask", {
						description: "ask",
						handler: async (_args, ctx) => {
							const answer = await ctx.ui.select("Pick", ["a", "b"], { timeout: 50, warning: "It costs." });
							ctx.ui.notify(`answer:${answer ?? "none"}`);
						},
					});
				},
			],
		});
		await start(harness);
		send({ id: "p", type: "prompt", message: "/ask" });

		await vi.waitFor(() => expect(records().some((r) => r.message === "answer:none")).toBe(true));
		const request = records().find((r) => r.type === "extension_ui_request" && r.method === "select");
		expect(request).toBeDefined();
		// fork: the client receives the risk it shows in red.
		expect(request!.warning).toBe("It costs.");
		expect(records()).toContainEqual({ type: "extension_ui_dismissed", id: request!.id, reason: "timeout" });
		// A late answer to the closed dialog changes nothing.
		send({ type: "extension_ui_response", id: request!.id, value: "a" });
		expect(records().filter((r) => typeof r.message === "string" && r.message.startsWith("answer:"))).toHaveLength(1);
	});

	test("announces a dialog closed by its abort signal and names the tool call it is about", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", async (event, ctx) => {
						const answer = await ctx.ui.select("Allow?", ["Allow", "Block"], {
							signal: ctx.signal,
							toolCallId: event.toolCallId,
						});
						return answer === "Allow" ? undefined : { block: true, reason: "blocked" };
					});
				},
			],
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "x.txt" }, { id: "call-1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await start(harness);
		send({ id: "p", type: "prompt", message: "read it" });

		await vi.waitFor(() =>
			expect(records().some((r) => r.type === "extension_ui_request" && r.method === "select")).toBe(true),
		);
		const request = records().find((r) => r.type === "extension_ui_request" && r.method === "select")!;
		expect(request.toolCallId).toBe("call-1");

		send({ id: "a", type: "abort" });
		await vi.waitFor(() =>
			expect(records()).toContainEqual({ id: "a", type: "response", command: "abort", success: true }),
		);
		expect(records()).toContainEqual({ type: "extension_ui_dismissed", id: request.id, reason: "aborted" });
	});

	test("lists the sessions of the working directory without their full text", async () => {
		const dir = mkdtempSync(join(tmpdir(), "prism-gui-rpc-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const sessionManager = SessionManager.create(dir, join(dir, "sessions"));
		sessionManager.appendMessage({ role: "user", content: "first question", timestamp: Date.now() });
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "answer" }],
			api: "faux",
			provider: "faux",
			model: "faux",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		const harness = await createHarness({ sessionManager });
		await start(harness);
		send({ id: "l", type: "list_sessions" });

		await vi.waitFor(() => expect(records().some((r) => r.id === "l")).toBe(true));
		const response = records().find((r) => r.id === "l") as {
			success: boolean;
			data: { sessions: Array<Record<string, unknown>> };
		};
		expect(response.success).toBe(true);
		expect(response.data.sessions).toHaveLength(1);
		const [listed] = response.data.sessions;
		expect(listed.id).toBe(harness.session.sessionId);
		expect(listed.path).toBe(harness.session.sessionFile);
		expect(listed.firstMessage).toBe("first question");
		expect(listed).not.toHaveProperty("allMessagesText");
	});
});
