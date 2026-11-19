// fork: local-server context must drive compaction before a request overflows.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthPrompt } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { connectCompatibleServer } from "../src/fork/compatible-server.ts";

const CONTEXT_WINDOW = 8192;

function sse(content: string): string {
	return `data: ${JSON.stringify({
		id: "completion",
		object: "chat.completion.chunk",
		choices: [{ index: 0, delta: { role: "assistant", content } }],
	})}\n\ndata: ${JSON.stringify({
		id: "completion",
		object: "chat.completion.chunk",
		choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
	})}\n\ndata: [DONE]\n\n`;
}

async function readBody(request: IncomingMessage): Promise<string> {
	let body = "";
	for await (const chunk of request) body += chunk;
	return body;
}

describe("fork: real local-server context", () => {
	let server: Server | undefined;
	let tempDir = "";
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;

	afterEach(async () => {
		session?.dispose();
		session = undefined;
		await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
		server = undefined;
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
		tempDir = "";
	});

	it("uses the smallest slot and compacts before a usage-free request exceeds it", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "prism-real-context-"));
		const requests: { estimatedTokens: number; maxTokens: number }[] = [];
		server = createServer(async (request, response) => {
			const body = await readBody(request);
			if (request.method === "GET" && request.url === "/v1/models") {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ data: [{ id: "local-model" }] }));
				return;
			}
			if (request.method === "GET" && request.url === "/props") {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ default_generation_settings: { n_ctx: 16384 }, total_slots: 2 }));
				return;
			}
			if (request.method === "GET" && request.url === "/slots") {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(
					JSON.stringify([
						{ id: 0, n_ctx: 12288 },
						{ id: 1, n_ctx: CONTEXT_WINDOW },
					]),
				);
				return;
			}
			if (request.method === "POST" && request.url === "/v1/chat/completions") {
				const payload = JSON.parse(body) as { messages: unknown[]; max_tokens?: number };
				requests.push({
					estimatedTokens: Math.ceil(JSON.stringify(payload.messages).length / 4),
					maxTokens: payload.max_tokens ?? 0,
				});
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(sse("ok"));
				return;
			}
			response.writeHead(404).end();
		});
		await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		const agentDir = join(tempDir, "agent");
		const modelsPath = join(agentDir, "models.json");
		const runtime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath,
			allowModelNetwork: false,
		});
		const answers = (prompt: AuthPrompt): string =>
			prompt.type === "select" ? "openai-completions" : prompt.message === "Server URL" ? url : "";
		const connected = await connectCompatibleServer(runtime, modelsPath, {
			prompt: async (prompt) => answers(prompt),
			notify: () => {},
		});

		const model = runtime.getModel(connected.providerId, "local-model");
		expect(model?.contextWindow).toBe(CONTEXT_WINDOW);
		expect(
			JSON.parse(readFileSync(modelsPath, "utf-8")).providers[connected.providerId].models[0].contextWindow,
		).toBe(CONTEXT_WINDOW);
		const cwd = join(tempDir, "workspace");
		const { session: activeSession } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime: runtime,
			model,
			sessionManager: SessionManager.create(cwd, join(tempDir, "sessions")),
			settingsManager: SettingsManager.inMemory({
				compaction: { thresholdPercent: 70, reserveTokens: 1024, keepRecentTokens: 256 },
			}),
		});
		session = activeSession;
		const events: string[] = [];
		session.subscribe((event) => {
			if (event.type === "compaction_start") events.push(event.reason);
		});

		for (let turn = 0; turn < 12 && events.length === 0; turn++) {
			await session.prompt(`turn ${turn} ${"x".repeat(2400)}`);
		}

		expect(events).toContain("threshold");
		expect(requests.length).toBeGreaterThan(1);
		expect(requests.every((request) => request.estimatedTokens + request.maxTokens <= CONTEXT_WINDOW)).toBe(true);
	});
});
