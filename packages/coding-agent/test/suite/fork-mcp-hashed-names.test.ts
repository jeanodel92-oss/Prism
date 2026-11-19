/**
 * fork: two tools whose names sanitize alike (`a-b`, `a_b`) get a hash
 * suffix, but the suffixed name was not checked. A third tool literally named `a_b_<hash of a-b>` then lost its name
 * to `a-b`, so the model could no longer call it, and calling its name ran `a-b` instead.
 */
import { createHash } from "node:crypto";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { type JsonRpcRequest, LATEST_PROTOCOL_VERSION } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpExtension } from "../../src/extensions/mcp/index.ts";
import { createMcpToolName } from "../../src/extensions/mcp/tools.ts";
import { createHarness, createTestUiContext, type Harness } from "./harness.ts";

const hash = createHash("sha256").update("docs\0a-b").digest("hex").slice(0, 8);
const occupant = `a_b_${hash}`;

function fakeServer(names: string[], calls: string[]) {
	const pair = createInMemoryTransportPair();
	const respond = (request: JsonRpcRequest): unknown => {
		switch (request.method) {
			case "initialize":
				return {
					protocolVersion: LATEST_PROTOCOL_VERSION,
					capabilities: { tools: {} },
					serverInfo: { name: "docs", version: "1.0.0" },
				};
			case "tools/list":
				return { tools: names.map((name) => ({ name, inputSchema: { type: "object", properties: {} } })) };
			case "tools/call": {
				const { name } = request.params as { name: string };
				calls.push(name);
				return { content: [{ type: "text", text: name }] };
			}
			default:
				return {};
		}
	};
	pair.server.onMessage((message) => {
		if (!("id" in message) || !("method" in message)) return;
		const request = message as JsonRpcRequest;
		queueMicrotask(() => void pair.server.send({ jsonrpc: "2.0", id: request.id, result: respond(request) }));
	});
	void pair.server.start();
	return pair.client;
}

describe("fork: hashed MCP tool names", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function namesFor(order: string[]) {
		const calls: string[] = [];
		const harness = await createHarness({
			initialActiveToolNames: [],
			extensionFactories: [
				createMcpExtension({
					loadConfig: () => ({
						servers: [
							{ name: "docs", config: { url: "http://unused.invalid", exposure: "direct" }, source: "test" },
						],
						errors: [],
					}),
					createTransport: () => fakeServer(order, calls),
				}),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });
		const mcpNames = () => harness.session.getAllTools().filter((tool) => tool.name.startsWith("mcp__docs__"));
		await vi.waitFor(() => expect(mcpNames()).toHaveLength(3));
		return { harness, calls, names: mcpNames().map((tool) => tool.name) };
	}

	it.each([
		[occupant, "a-b", "a_b"],
		["a-b", "a_b", occupant],
		["a_b", occupant, "a-b"],
	])("gives each tool its own name, the same in any order (%s, %s, %s)", async (...order) => {
		const { harness, calls, names } = await namesFor(order);
		expect(new Set(names).size).toBe(3);
		// The tool named like a hashed name keeps it.
		const occupantName = createMcpToolName("docs", occupant);
		expect(names).toContain(occupantName);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(occupantName, {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		expect(calls).toEqual([occupant]);
	});
});
