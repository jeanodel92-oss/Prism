import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSystemMessageText, type SystemMessage } from "@earendil-works/pi-ai";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionCommandContext, ExtensionUIContext } from "../src/core/extensions/types.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import requestInspector from "../src/fork/request-inspector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const CANARY = "API_CANARY_7f16d3c08f2a";
const TOOL_RESULT = "REQUEST_INSPECTOR_TOOL_RESULT";
const COMPACTION_SUMMARY = "REQUEST_INSPECTOR_COMPACTION_SUMMARY";
const IMAGE_DATA = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

async function readBody(request: IncomingMessage): Promise<string> {
	let body = "";
	for await (const chunk of request) body += chunk;
	return body;
}

function sse(delta: Record<string, unknown>, finishReason: string): string {
	return [
		`data: ${JSON.stringify({ id: "request-inspector", object: "chat.completion.chunk", choices: [{ index: 0, delta }] })}\n\n`,
		`data: ${JSON.stringify({ id: "request-inspector", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}\n\n`,
		"data: [DONE]\n\n",
	].join("");
}

function userText(body: Record<string, unknown>): string {
	const messages = body.messages as Array<{ role: string; content?: unknown }>;
	const message = [...messages].reverse().find((candidate) => candidate.role === "user");
	if (typeof message?.content === "string") return message.content;
	return Array.isArray(message?.content)
		? message.content
				.map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : ""))
				.join(" ")
		: "";
}

describe("request inspector over a real local HTTP request", () => {
	let tempDir: string;
	let agentDir: string;
	let server: Server;
	let endpoint: string;
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	let requestBodies: Array<Record<string, unknown>>;
	let requestHeaders: Array<Record<string, string | string[] | undefined>>;
	let neverRequest: Promise<void>;
	let resolveNeverRequest: () => void;
	let renderedView: string[];

	beforeEach(async () => {
		initTheme();
		tempDir = mkdtempSync(join(tmpdir(), "prism-request-inspector-"));
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		requestBodies = [];
		requestHeaders = [];
		renderedView = [];
		neverRequest = new Promise<void>((resolve) => {
			resolveNeverRequest = resolve;
		});
		server = createServer(async (request, response) => {
			const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
			requestHeaders.push(request.headers);
			if (request.url !== "/v1/chat/completions") {
				response.writeHead(404).end();
				return;
			}
			requestBodies.push(body);
			const text = userText(body);
			if (text.includes("never-response")) {
				resolveNeverRequest();
				return;
			}

			const messages = body.messages as Array<{ role: string }>;
			if (text.includes("inspection-after-compaction") && !messages.some((message) => message.role === "tool")) {
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(
					sse(
						{
							role: "assistant",
							tool_calls: [
								{
									index: 0,
									id: "call_after_compaction",
									type: "function",
									function: { name: "fixture_tool", arguments: "{}" },
								},
							],
						},
						"tool_calls",
					),
				);
				return;
			}
			const hasToolResult = messages.some((message) => message.role === "tool");
			if (!hasToolResult && (requestBodies.length === 1 || text.includes("inspection-after-compaction"))) {
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(
					sse(
						{
							role: "assistant",
							tool_calls: [
								{
									index: 0,
									id: "call_initial",
									type: "function",
									function: { name: "fixture_tool", arguments: "{}" },
								},
							],
						},
						"tool_calls",
					),
				);
				return;
			}
			const content = text.includes("inspection-after-compaction") ? "done" : COMPACTION_SUMMARY;
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(sse({ role: "assistant", content }, "stop"));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
	});

	afterEach(async () => {
		session?.dispose();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	async function createSession() {
		const modelsPath = join(agentDir, "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"inspector-local": {
						baseUrl: endpoint,
						api: "openai-completions",
						models: [
							{
								id: "inspector-model",
								name: "Inspector Model",
								reasoning: false,
								input: ["text", "image"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 32768,
								maxTokens: 512,
								headers: { "x-inspector-canary": CANARY },
							},
						],
					},
				},
			}),
		);
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify("inspector-local", async () => ({ type: "api_key", key: CANARY }));
		const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath });
		const model = modelRuntime.getModel("inspector-local", "inspector-model");
		expect(model).toBeDefined();
		const cwd = join(tempDir, "workspace");
		mkdirSync(cwd);
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			extensionFactories: [
				requestInspector,
				(pi) => {
					pi.registerTool({
						name: "fixture_tool",
						label: "Fixture tool",
						description: "Returns a fixed test result.",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: TOOL_RESULT }], details: {} }),
					});
				},
			],
		});
		await resourceLoader.reload();
		const result = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime,
			settingsManager,
			sessionManager: SessionManager.create(cwd, join(agentDir, "sessions"), { id: "request-inspector" }),
			resourceLoader,
		});
		session = result.session;
		settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
		const uiContext = {
			notify: () => {},
			setStatus: () => {},
			custom: async (
				factory: (
					tui: unknown,
					theme: unknown,
					keybindings: unknown,
					done: () => void,
				) => { render: (width: number) => string[] },
			) => {
				const component = factory({ terminal: { rows: 1000 }, requestRender: () => {} }, {}, {}, () => {});
				renderedView = component.render(180);
				// No line wider than a narrow terminal, whatever the payload holds (base64 images, long JSON).
				for (const line of component.render(40)) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
			},
		} as unknown as ExtensionUIContext;
		await session.bindExtensions({ uiContext, mode: "tui" });
		return { cwd, model };
	}

	it("matches sent view to the server body across tools, images, compaction, and a pending request", async () => {
		const { cwd, model } = await createSession();
		const runner = (
			session as unknown as {
				_extensionRunner: {
					getCommand(
						name: string,
					): { handler(args: string, context: ExtensionCommandContext): Promise<void> } | undefined;
					createCommandContext(): ExtensionCommandContext;
				};
			}
		)._extensionRunner;
		const sentCommand = runner.getCommand("sent");
		expect(sentCommand).toBeDefined();
		await session!.prompt("first request with an image", {
			images: [{ type: "image", data: IMAGE_DATA, mimeType: "image/png" }],
		});
		await session!.prompt("ordinary second history item");
		expect(session!.messages.length).toBeGreaterThan(3);
		await session!.compact();
		await session!.prompt("inspection-after-compaction", {
			images: [{ type: "image", data: IMAGE_DATA, mimeType: "image/png" }],
		});
		const finalBody = requestBodies.at(-1)!;
		const beforeSent = requestBodies.length;
		await sentCommand!.handler("", runner.createCommandContext());
		expect(requestBodies).toHaveLength(beforeSent);
		expect(renderedView.join("\n")).toContain("Last model request");

		const exportPath = join(cwd, "sent.json");
		await sentCommand!.handler(`export ${exportPath}`, runner.createCommandContext());
		const exportedText = readFileSync(exportPath, "utf8");
		// Code review 2026-10-20 (L10): `~` is expanded like the tools expand it.
		const savedHome = process.env.HOME;
		process.env.HOME = cwd;
		try {
			await sentCommand!.handler("export ~/sent-home.json", runner.createCommandContext());
		} finally {
			process.env.HOME = savedHome;
		}
		expect(readFileSync(join(cwd, "sent-home.json"), "utf8")).toContain('"provider"');
		const exported = JSON.parse(exportedText) as {
			provider: string;
			endpoint: string;
			model: string;
			preparedPrompt: { messages: Array<Record<string, unknown>> };
			providerPayload: Record<string, unknown>;
			response: string;
		};
		const payload = exported.providerPayload;
		const receivedMessages = finalBody.messages as Array<{ role: string; content?: unknown }>;
		const prepared = exported.preparedPrompt;

		expect(exported.provider).toBe("inspector-local");
		expect(exported.endpoint).toBe(endpoint);
		expect(exported.model).toBe(model!.id);
		expect(payload.model).toBe(finalBody.model);
		expect(payload).toEqual(finalBody);
		expect(receivedMessages.find((message) => message.role === "system")?.content).toBe(
			getSystemMessageText(
				prepared.messages.find((message) => message.role === "system") as unknown as SystemMessage,
			),
		);
		expect(receivedMessages.some((message) => message.role === "tool" && message.content === TOOL_RESULT)).toBe(true);
		expect(JSON.stringify(receivedMessages)).toContain(COMPACTION_SUMMARY);
		expect(JSON.stringify(receivedMessages)).toContain("inspection-after-compaction");
		expect(JSON.stringify(prepared.messages)).toContain(TOOL_RESULT);
		expect(JSON.stringify(prepared.messages)).toContain(COMPACTION_SUMMARY);
		expect(JSON.stringify(prepared.messages)).toContain(IMAGE_DATA);
		expect(
			receivedMessages.some(
				(message) =>
					Array.isArray(message.content) &&
					JSON.stringify(message.content).includes(`data:image/png;base64,${IMAGE_DATA}`),
			),
		).toBe(true);
		expect(finalBody.tools).toEqual(payload.tools);
		expect(JSON.stringify(finalBody.tools)).toContain("fixture_tool");
		expect(prepared.messages.length).toBeGreaterThan(0);
		expect(requestHeaders.some((headers) => headers.authorization === `Bearer ${CANARY}`)).toBe(true);
		expect(requestHeaders.some((headers) => headers["x-inspector-canary"] === CANARY)).toBe(true);
		expect(exportedText).not.toContain(CANARY);
		expect(renderedView.join("\n")).not.toContain(CANARY);

		const sentCount = requestBodies.length;
		const pendingPrompt = session!.prompt("never-response");
		await neverRequest;
		session!.abort();
		await pendingPrompt;
		const pendingExportPath = join(cwd, "pending.json");
		await sentCommand!.handler(`export ${pendingExportPath}`, runner.createCommandContext());
		const pendingText = readFileSync(pendingExportPath, "utf8");
		const pending = JSON.parse(pendingText) as { response: string; providerPayload: unknown };
		expect(requestBodies).toHaveLength(sentCount + 1);
		expect(pending.response).toBe("not received yet");
		expect(pending.providerPayload).toBeDefined();
		expect(pendingText).not.toContain(CANARY);
		const beforePendingSent = requestBodies.length;
		await sentCommand!.handler("", runner.createCommandContext());
		expect(requestBodies).toHaveLength(beforePendingSent);
		expect(renderedView.join("\n")).toContain("not received yet");
		expect(renderedView.join("\n")).not.toContain(CANARY);
	});
});
