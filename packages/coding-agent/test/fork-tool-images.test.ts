// fork: "Images from tools" in a model's settings keeps the images a tool returns
// inside its tool message, instead of the separate user message Qwen's chat template reads as one from the user.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
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
} from "../src/fork/model-settings.ts";

type Body = { messages: Array<{ role: string; content: unknown }> };

describe("fork: images from tools", () => {
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

	/** Answers the first request with a call to `snap`, the next one with text. */
	async function serve(): Promise<string> {
		server = createServer(async (request, response) => {
			let body = "";
			for await (const chunk of request) body += chunk;
			bodies.push(JSON.parse(body) as Body);
			const call = { index: 0, id: "call_1", type: "function", function: { name: "snap", arguments: "{}" } };
			const chunks =
				bodies.length === 1
					? [
							{ id: "1", choices: [{ index: 0, delta: { tool_calls: [call] } }] },
							{ id: "1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
						]
					: [
							{ id: "2", choices: [{ index: 0, delta: { content: "green" } }] },
							{ id: "2", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
						];
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`);
		});
		await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
		return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`;
	}

	async function setup(): Promise<string> {
		tempDir = mkdtempSync(join(tmpdir(), "prism-tool-images-"));
		const modelsPath = join(tempDir, "models.json");
		const model = { id: "qwen-vl", input: ["text", "image"], contextWindow: 65536, maxTokens: 4000 };
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: { box: { baseUrl: await serve(), api: "openai-completions", apiKey: "none", models: [model] } },
			}),
		);
		return modelsPath;
	}

	/** One prompt whose tool call returns a screenshot; returns the request that carries the tool result. */
	async function screenshotTurn(): Promise<Body> {
		const runtime = await ModelRuntime.create({
			authPath: join(tempDir, "auth.json"),
			modelsPath: join(tempDir, "models.json"),
			allowModelNetwork: false,
		});
		const cwd = join(tempDir, "ws");
		mkdirSync(cwd, { recursive: true });
		const { session } = await createAgentSession({
			cwd,
			agentDir: tempDir,
			modelRuntime: runtime,
			model: runtime.getModel("box", "qwen-vl")!,
			sessionManager: SessionManager.create(cwd, join(tempDir, "sessions")),
			settingsManager: SettingsManager.inMemory(),
			customTools: [
				{
					name: "snap",
					label: "Snap",
					description: "Take a screenshot",
					parameters: Type.Object({}),
					execute: async () => ({
						content: [{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" }],
						details: {},
					}),
				},
			],
		});
		await session.prompt("Take a screenshot");
		session.dispose();
		expect(bodies).toHaveLength(2);
		return bodies[1]!;
	}

	it("sends a separate user message by default, and the image inside the tool message once turned on", async () => {
		const modelsPath = await setup();
		const before = await screenshotTurn();
		expect(before.messages.map((message) => message.role).slice(-2)).toEqual(["tool", "user"]);

		const on = parseSettingValue("toolImages", "yes");
		expect(on).toBe(true);
		await writeModelCorrection(modelsPath, "box", "qwen-vl", "toolImages", on as boolean);
		expect(readModelCorrection(modelsPath, "box", "qwen-vl")).toEqual({
			compat: { supportsImagesInToolResults: true },
		});
		bodies.length = 0;
		const after = await screenshotTurn();
		expect(after.messages.at(-1)).toEqual({
			role: "tool",
			tool_call_id: "call_1",
			content: [
				{ type: "text", text: "(see attached image)" },
				{ type: "image_url", image_url: { url: "data:image/png;base64,ZmFrZQ==" } },
			],
		});

		const runtime = await ModelRuntime.create({
			authPath: join(tempDir, "auth.json"),
			modelsPath,
			allowModelNetwork: false,
		});
		const model = runtime.getModel("box", "qwen-vl")!;
		const lines = formatRows(settingRows(model, readModelCorrection(modelsPath, "box", "qwen-vl"), undefined));
		expect(lines.find((line) => line.startsWith("Images from tools"))).toMatch(/Prism yes \(your correction\)$/);

		// Removing the correction removes the compat entry it made.
		await writeModelCorrection(modelsPath, "box", "qwen-vl", "toolImages", undefined);
		expect(readModelCorrection(modelsPath, "box", "qwen-vl")).toEqual({});
	});

	it("shows the row only for the OpenAI-compatible chat API", () => {
		const anthropic = getModel("anthropic", "claude-sonnet-4-5")!;
		expect(settingRows(anthropic, {}, undefined).some((row) => row.key === "toolImages")).toBe(false);
	});
});
