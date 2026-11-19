// fork: fuzz target for the content blocks an MCP server returns. pi-mcp checks that a result has a
// `content` array, not what the blocks in it look like; a block of the wrong shape must become a placeholder,
// never a tool result that breaks the transcript or later requests. Replay with PI_FUZZ_SEED.
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { type CallToolResult, type JsonRpcRequest, LATEST_PROTOCOL_VERSION } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getTextOutput } from "../src/core/tools/render-utils.ts";
import { createMcpExtension } from "../src/extensions/mcp/index.ts";
import { convertMcpResult } from "../src/extensions/mcp/tools.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

function makeRandom(seed: number): () => number {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
		return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
	};
}

const seed = Number(process.env.PI_FUZZ_SEED ?? 7_717);
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const PLACEHOLDER = /^\[Invalid MCP /;

/** What every block of a tool result must look like for the renderer and the providers. */
function expectWellFormed(content: unknown[], label: string) {
	for (const block of content) {
		const { type, text, data, mimeType } = block as Record<string, unknown>;
		if (type === "text") expect(typeof text, label).toBe("string");
		else {
			expect(type, label).toBe("image");
			expect([typeof data, typeof mimeType], label).toEqual(["string", "string"]);
		}
	}
}

const saveOutput = async () => "/saved/output";

describe("fork: MCP result content blocks", () => {
	it("turns arbitrary blocks into well-formed content, and keeps blocks that follow the spec", async () => {
		const random = makeRandom(seed);
		const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
		const junk: unknown[] = [undefined, null, true, 0, 5, Number.NaN, "", [], {}, ["x"], { toString: 1 }];
		const text = ["", "hello", "a\nb", "\u{1F600}", "x".repeat(300)];
		const mime = ["image/png", "text/plain", "application/json", "application/octet-stream", "audio/wav"];
		// Each field: valid samples and whether the spec lets it be absent.
		type Field = [name: string, samples: readonly unknown[], optional: boolean];
		const blocks: Record<string, Field[]> = {
			text: [["text", text, false]],
			image: [
				["data", [PNG, ""], false],
				["mimeType", mime, false],
			],
			audio: [
				["data", ["AAAA"], false],
				["mimeType", mime, false],
			],
			resource_link: [
				["uri", ["file:///a.txt", "docs://x", "not a uri"], false],
				["name", text, false],
				["title", text, true],
				["description", text, true],
				["mimeType", mime, true],
				["size", [0, 1, 1e9], true],
			],
		};
		const resourceFields: Field[] = [
			["uri", ["file:///a.png", "docs://x", ""], false],
			["mimeType", mime, true],
		];
		for (let index = 0; index < 1500; index++) {
			const content: unknown[] = [];
			const valid: boolean[] = [];
			for (let count = Math.floor(random() * 4); count > 0; count--) {
				const kind = pick([...Object.keys(blocks), "resource", "unknown", "junk"]);
				if (kind === "junk") {
					content.push(pick(junk));
					valid.push(false);
					continue;
				}
				const block: Record<string, unknown> = { type: kind };
				let ok = true;
				const fill = (target: Record<string, unknown>, fields: Field[]) => {
					for (const [name, samples, optional] of fields) {
						const value = random() < 0.8 ? pick(samples) : pick(junk);
						if (value !== undefined) target[name] = value;
						if (!(samples.includes(value) || (optional && value === undefined))) ok = false;
					}
				};
				if (kind === "resource") {
					const resource: Record<string, unknown> = {};
					fill(resource, resourceFields);
					fill(resource, [random() < 0.5 ? ["text", text, false] : ["blob", [PNG, "aGk=", ""], false]]);
					block.resource = random() < 0.9 ? resource : pick(junk);
					if (block.resource !== resource) ok = false;
				} else if (kind !== "unknown") fill(block, blocks[kind]!);
				content.push(block);
				valid.push(ok);
			}
			const label = `seed=${seed} case=${index} ${JSON.stringify(content)}`;
			const result = await convertMcpResult("docs", "tool", { content } as CallToolResult, { saveOutput });
			expectWellFormed(result.content, label);
			expect(() => getTextOutput(result, false), label).not.toThrow();
			// Every block converts on its own, so a block that follows the spec is never replaced.
			const placeholders = result.content.filter((block) => block.type === "text" && PLACEHOLDER.test(block.text));
			expect(placeholders.length, label).toBeLessThanOrEqual(valid.filter((ok) => !ok).length);
			if (valid.every(Boolean)) expect(placeholders, label).toEqual([]);
		}
	}, 60_000);

	describe("through a session", () => {
		let harness: Harness | undefined;
		afterEach(() => harness?.cleanup());

		it("keeps the session usable after a server returns blocks of the wrong shape", async () => {
			let content: unknown = [];
			const pair = createInMemoryTransportPair();
			pair.server.onMessage((message) => {
				if (!("id" in message) || !("method" in message)) return;
				const request = message as JsonRpcRequest;
				const result =
					request.method === "initialize"
						? {
								protocolVersion: LATEST_PROTOCOL_VERSION,
								capabilities: { tools: {} },
								serverInfo: { name: "docs", version: "1" },
							}
						: request.method === "tools/list"
							? { tools: [{ name: "odd", inputSchema: { type: "object", properties: {} } }] }
							: { content };
				queueMicrotask(() => void pair.server.send({ jsonrpc: "2.0", id: request.id, result }));
			});
			void pair.server.start();
			harness = await createHarness({
				extensionFactories: [
					createMcpExtension({
						loadConfig: () => ({
							servers: [
								{ name: "docs", config: { url: "http://unused.invalid", exposure: "direct" }, source: "test" },
							],
							errors: [],
						}),
						createTransport: () => pair.client,
					}),
				],
			});
			await harness.session.bindExtensions({ uiContext: createTestUiContext() });
			await vi.waitFor(() =>
				expect(harness!.session.getAllTools().some((tool) => tool.name === "mcp__docs__odd")).toBe(true),
			);
			for (const blocks of [
				[
					{ type: "text", text: "kept" },
					{ type: "text", text: { nested: 1 } },
				],
				[null, { type: "image", data: PNG, mimeType: "image/png" }],
				[{ type: "resource", resource: { uri: "a", blob: 5 } }],
				[{ type: "text", text: "kept" }, { type: "resource" }],
			]) {
				content = blocks;
				harness.setResponses([
					fauxAssistantMessage([fauxToolCall("mcp__docs__odd", {})], { stopReason: "toolUse" }),
					fauxAssistantMessage("done"),
				]);
				await harness.session.prompt("go");
				const label = JSON.stringify(blocks);
				const result = harness.session.messages.findLast((message) => message.role === "toolResult")!;
				expect(result.isError, label).toBe(false);
				expect(result.content, label).toHaveLength(blocks.length);
				expectWellFormed(result.content, label);
				expect(() => getTextOutput(result, false), label).not.toThrow();
				const texts = result.content.flatMap((block) => (block.type === "text" ? [block.text] : []));
				expect(
					texts.filter((text) => PLACEHOLDER.test(text)),
					label,
				).toHaveLength(1);
				if (texts.length > 1) expect(texts[0], label).toBe("kept");
			}
		});
	});
});
