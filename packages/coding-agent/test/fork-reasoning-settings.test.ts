// fork: per-model reasoning settings. A model keeps its earlier reasoning between turns, a
// per-model thinking budget reaches the request, and "Other parameters" add to the chat template's
// arguments instead of replacing them.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
	formatRows,
	parseSettingValue,
	readModelCorrection,
	settingRows,
	writeModelCorrection,
	writeThinkingBudget,
} from "../src/fork/model-settings.ts";

type Body = Record<string, unknown> & { messages: Record<string, unknown>[] };

describe("fork: per-model reasoning settings", () => {
	let server: Server | undefined;
	let tempDir = "";
	const bodies: Body[] = [];

	afterEach(async () => {
		bodies.length = 0;
		await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
		server = undefined;
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
		tempDir = "";
	});

	/** An OpenAI-compatible server that records each request and answers with some reasoning, then text. */
	async function serve(): Promise<string> {
		server = createServer(async (request, response) => {
			let body = "";
			for await (const chunk of request) body += chunk;
			if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
				response.writeHead(404).end();
				return;
			}
			bodies.push(JSON.parse(body) as Body);
			const turn = bodies.length;
			const chunks = [
				{ id: "1", choices: [{ index: 0, delta: { reasoning_content: `thought ${turn}` } }] },
				{ id: "1", choices: [{ index: 0, delta: { content: `answer ${turn}` } }] },
				{ id: "1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
			];
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`);
		});
		await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
		return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`;
	}

	/** A reasoning model whose thinking is switched through the chat template, as llama.cpp serves Qwen. */
	async function setup(
		chatTemplateKwargs: Record<string, unknown> = { enable_thinking: { $var: "thinking.enabled" } },
	) {
		tempDir = mkdtempSync(join(tmpdir(), "prism-reasoning-settings-"));
		const modelsPath = join(tempDir, "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					box: {
						baseUrl: await serve(),
						api: "openai-completions",
						apiKey: "none",
						models: [
							{
								id: "qwen",
								reasoning: true,
								contextWindow: 65536,
								maxTokens: 32000,
								compat: { thinkingFormat: "chat-template", chatTemplateKwargs },
							},
						],
					},
				},
			}),
		);
		return modelsPath;
	}

	async function prompts(...texts: string[]) {
		const runtime = await ModelRuntime.create({
			authPath: join(tempDir, "auth.json"),
			modelsPath: join(tempDir, "models.json"),
			allowModelNetwork: false,
		});
		const model = runtime.getModel("box", "qwen")!;
		const cwd = join(tempDir, "ws");
		mkdirSync(cwd, { recursive: true });
		const { session } = await createAgentSession({
			cwd,
			agentDir: tempDir,
			modelRuntime: runtime,
			model,
			thinkingLevel: "medium",
			sessionManager: SessionManager.create(cwd, join(tempDir, "sessions")),
			settingsManager: SettingsManager.inMemory(),
		});
		for (const text of texts) await session.prompt(text);
		return model;
	}

	it("sends the earlier reasoning back and asks the chat template to keep it", async () => {
		await setup();
		await prompts("one", "two");
		expect(bodies).toHaveLength(2);
		for (const body of bodies) {
			expect(body.chat_template_kwargs).toEqual({ enable_thinking: true, preserve_thinking: true });
		}
		const assistant = bodies[1]!.messages.find((message) => message.role === "assistant");
		expect(assistant).toMatchObject({ content: "answer 1", reasoning_content: "thought 1" });
	});

	it("keeps a preserve_thinking value the user wrote in models.json", async () => {
		await setup({ enable_thinking: { $var: "thinking.enabled" }, preserve_thinking: false });
		await prompts("one");
		expect(bodies[0]!.chat_template_kwargs).toEqual({ enable_thinking: true, preserve_thinking: false });
	});

	it("adds chat_template_kwargs typed in Other parameters to the ones Prism builds", async () => {
		const modelsPath = await setup();
		const extra = parseSettingValue("extra", '{"chat_template_kwargs": {"custom": 1}, "seed": 3}');
		if (extra instanceof Error) throw extra;
		await writeModelCorrection(modelsPath, "box", "qwen", "extra", extra);
		await prompts("one");
		expect(bodies[0]).toMatchObject({
			seed: 3,
			chat_template_kwargs: { enable_thinking: true, preserve_thinking: true, custom: 1 },
		});
	});

	it("sends the model's thinking budget in the field the server reads", async () => {
		const modelsPath = await setup();
		expect(parseSettingValue("thinkingBudget", "4000")).toBe(4000);
		expect(parseSettingValue("thinkingBudget", "0")).toBeInstanceOf(Error);
		await writeThinkingBudget(modelsPath, "box", "qwen", 4000, "thinking_budget_tokens");
		expect(readModelCorrection(modelsPath, "box", "qwen")).toEqual({
			thinkingBudgets: { minimal: 4000, low: 4000, medium: 4000, high: 4000 },
			compat: { thinkingTokenBudgetField: "thinking_budget_tokens" },
		});
		const model = await prompts("one");
		expect(bodies[0]).toMatchObject({ thinking_budget_tokens: 4000 });
		const lines = formatRows(settingRows(model, readModelCorrection(modelsPath, "box", "qwen"), undefined));
		expect(lines.find((line) => line.startsWith("Thinking budget"))).toMatch(/Prism 4000 \(your correction\)$/);

		// Removing it removes the field it set, so no budget is sent any more.
		await writeThinkingBudget(modelsPath, "box", "qwen", undefined, undefined);
		expect(readModelCorrection(modelsPath, "box", "qwen")).toEqual({});
		bodies.length = 0;
		await prompts("two");
		expect(bodies[0]).not.toHaveProperty("thinking_budget_tokens");
	});
});
