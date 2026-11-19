// fork: /login entry for a compatible server, against a fake OpenAI-compatible
// server. The key must reach the server, auth.json only, and nothing the model sees.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthPrompt } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { connectCompatibleServer } from "../src/fork/compatible-server.ts";

const KEY = "test-secret-key-r21-7f3a9c";

function sse(chunks: unknown[]): string {
	return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
}

async function readBody(request: IncomingMessage): Promise<string> {
	let body = "";
	for await (const chunk of request) body += chunk;
	return body;
}

describe("fork: /login to a compatible server", () => {
	let tempDir: string;
	let server: Server;
	let url: string;
	const requestBodies: string[] = [];
	const authHeaders: (string | undefined)[] = [];

	beforeEach(async () => {
		tempDir = mkdtempSync(join(tmpdir(), "prism-compatible-server-"));
		requestBodies.length = 0;
		authHeaders.length = 0;
		server = createServer(async (request, response) => {
			const body = await readBody(request);
			authHeaders.push(request.headers.authorization);
			if (request.headers.authorization !== `Bearer ${KEY}`) {
				response.writeHead(401).end();
			} else if (request.method === "GET" && request.url === "/v1/models") {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ object: "list", data: [{ id: "fake-model", object: "model" }] }));
			} else if (request.method === "POST" && request.url === "/v1/chat/completions") {
				requestBodies.push(body);
				const afterTool = (JSON.parse(body).messages as { role: string }[]).some((m) => m.role === "tool");
				const delta = afterTool
					? { role: "assistant", content: "done" }
					: {
							role: "assistant",
							tool_calls: [
								{
									index: 0,
									id: "call_1",
									type: "function",
									function: { name: "bash", arguments: '{"command":"env"}' },
								},
							],
						};
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(
					sse([
						{ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta }] },
						{
							id: "1",
							object: "chat.completion.chunk",
							choices: [{ index: 0, delta: {}, finish_reason: afterTool ? "stop" : "tool_calls" }],
						},
					]),
				);
			} else {
				response.writeHead(404).end();
			}
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	afterEach(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("adds the server without editing a file; the key stays out of models.json and of the model's context", async () => {
		const agentDir = join(tempDir, "agent");
		const modelsPath = join(agentDir, "models.json");
		const authPath = join(agentDir, "auth.json");
		const runtime = await ModelRuntime.create({ authPath, modelsPath, allowModelNetwork: false });

		const answers = (prompt: AuthPrompt): string => {
			if (prompt.type === "select") return "openai-completions";
			if (prompt.type === "secret") return KEY;
			return prompt.message === "Server URL" ? url : "";
		};
		const added = await connectCompatibleServer(runtime, modelsPath, {
			prompt: async (prompt) => answers(prompt),
			notify: () => {},
		});

		const port = new URL(url).port;
		expect(added).toMatchObject({ providerId: `127.0.0.1-${port}`, baseUrl: `${url}/v1`, models: ["fake-model"] });
		// the fake server exposes no native endpoint, so nothing is confirmed.
		expect(added.detected?.kind).toBe("generic");
		const modelsJson = readFileSync(modelsPath, "utf-8");
		expect(modelsJson).not.toContain(KEY);
		expect(JSON.parse(modelsJson).providers[added.providerId]).toEqual({
			baseUrl: `${url}/v1`,
			api: "openai-completions",
			// nothing confirmed, nothing absent: images and thinking stay available.
			models: [{ id: "fake-model", input: ["text", "image"], reasoning: true }],
		});
		expect(readFileSync(authPath, "utf-8")).toContain(KEY);

		const model = runtime.getModel(added.providerId, "fake-model");
		expect(model).toBeDefined();
		const cwd = join(tempDir, "ws");
		mkdirSync(cwd);
		const sessionDir = join(tempDir, "sessions");
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime: runtime,
			model,
			sessionManager: SessionManager.create(cwd, sessionDir),
			settingsManager: SettingsManager.inMemory(),
		});
		await session.prompt("run env");

		// The request went through with the key, and the bash tool ran.
		expect(requestBodies).toHaveLength(2);
		expect(authHeaders.every((header) => header === `Bearer ${KEY}`)).toBe(true);
		const toolResult = session.messages.find((message) => message.role === "toolResult");
		expect(JSON.stringify(toolResult)).toContain("PATH=");
		// Nothing the model sees, and nothing in the session file, contains the key.
		expect(session.systemPrompt).not.toContain(KEY);
		expect(JSON.stringify(toolResult)).not.toContain(KEY);
		for (const body of requestBodies) expect(body).not.toContain(KEY);
		const sessionFiles = readdirSync(sessionDir);
		expect(sessionFiles).toHaveLength(1);
		expect(readFileSync(join(sessionDir, sessionFiles[0]!), "utf-8")).not.toContain(KEY);
		session.dispose();
	});

	it("rejects a name that is already a built-in provider", async () => {
		const modelsPath = join(tempDir, "models.json");
		const runtime = await ModelRuntime.create({ authPath: join(tempDir, "auth.json"), modelsPath });
		await expect(
			connectCompatibleServer(runtime, modelsPath, {
				prompt: async (prompt) =>
					prompt.type === "select"
						? "openai-completions"
						: prompt.type === "secret"
							? KEY
							: prompt.message === "Server URL"
								? `${url}/v1`
								: "openai",
				notify: () => {},
			}),
		).rejects.toThrow('"openai" is already a provider');
	});
});
