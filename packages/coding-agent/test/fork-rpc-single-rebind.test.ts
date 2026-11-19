// fork: an RPC new_session, switch_session, fork or clone bound the new session's
// extensions twice: once through the runtime's rebind callback, then again in the command handler. Each extension saw
// two session_start events, with no session_shutdown between them.
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import type * as ThemeModule from "../src/modes/interactive/theme/theme.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";

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

function records(): Array<Record<string, unknown>> {
	return rpcIo.outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("fork: one session_start per RPC session change", () => {
	const cleanups: Array<() => Promise<void> | void> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	async function start(events: string[]) {
		const tempDir = join(tmpdir(), `prism-rpc-rebind-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		const model = faux.getModel();
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(tempDir, "models.json"),
		});
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: model.api,
			models: [
				{
					id: model.id,
					name: model.name,
					api: model.api,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					baseUrl: model.baseUrl,
				},
			],
		});
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				agentDir: tempDir,
				modelRuntime,
				cwd,
				resourceLoaderOptions: {
					extensionFactories: [
						(pi) => {
							pi.on("session_start", (event) => {
								events.push(`start:${event.reason}`);
							});
							pi.on("session_shutdown", () => {
								events.push("shutdown");
							});
						},
					],
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
			return {
				...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model })),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtimeHost = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir),
		});
		const stdinEnd = process.stdin.listeners("end") as NodeListener[];
		const signals = new Map(
			(["SIGTERM", "SIGHUP"] as NodeJS.Signals[]).map((signal) => [
				signal,
				process.listeners(signal) as NodeListener[],
			]),
		);
		cleanups.push(async () => {
			for (const listener of process.stdin.listeners("end") as NodeListener[]) {
				if (!stdinEnd.includes(listener)) process.stdin.off("end", listener);
			}
			for (const [signal, previous] of signals) {
				for (const listener of process.listeners(signal) as NodeListener[]) {
					if (!previous.includes(listener)) process.off(signal, listener);
				}
			}
			await runtimeHost.dispose();
			faux.unregister();
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		});
		void runRpcMode(runtimeHost);
		await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
		return runtimeHost;
	}

	async function command(record: Record<string, unknown>): Promise<Record<string, unknown>> {
		rpcIo.lineHandler?.(JSON.stringify(record));
		let response: Record<string, unknown> | undefined;
		// A session change writes its files: past waitFor's 1 s default on the CI runner's busy disk
		// . A response that never comes still fails.
		await vi.waitFor(
			() => {
				response = records().find((r) => r.type === "response" && r.id === record.id);
				expect(response).toBeDefined();
			},
			{ timeout: 10_000 },
		);
		return response!;
	}

	it("starts the new session's extensions once for new_session, switch_session, fork and clone", async () => {
		const events: string[] = [];
		const runtimeHost = await start(events);
		expect(events).toEqual(["start:startup"]);
		await runtimeHost.session.prompt("hello");
		const first = runtimeHost.session.sessionFile!;
		const entryId = runtimeHost.session.getUserMessagesForForking()[0]!.entryId;

		events.length = 0;
		expect(await command({ id: "n", type: "new_session" })).toMatchObject({ success: true });
		expect(events).toEqual(["shutdown", "start:new"]);

		events.length = 0;
		expect(await command({ id: "s", type: "switch_session", sessionPath: first })).toMatchObject({ success: true });
		expect(events).toEqual(["shutdown", "start:resume"]);

		events.length = 0;
		expect(await command({ id: "f", type: "fork", entryId })).toMatchObject({ success: true });
		expect(events).toEqual(["shutdown", "start:fork"]);

		events.length = 0;
		await runtimeHost.session.prompt("again");
		expect(await command({ id: "c", type: "clone" })).toMatchObject({ success: true });
		expect(events).toEqual(["shutdown", "start:fork"]);
	});
});
