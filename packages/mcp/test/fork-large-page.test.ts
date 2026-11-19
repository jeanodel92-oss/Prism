/**
 * fork: a valid page of 200 000 entries is listed; its entries are not
 * spread into the arguments of one push (V8 throws past about 150 000).
 */
import { describe, expect, it } from "vitest";
import { type JsonRpcRequest, LATEST_PROTOCOL_VERSION, McpClient } from "../src/index.ts";
import { createInMemoryTransportPair } from "../src/testing/index.ts";

describe("fork: a large MCP list page", () => {
	it("lists a page of 200 000 resources", async () => {
		const pair = createInMemoryTransportPair();
		const resources = Array.from({ length: 200_000 }, (_, i) => ({ uri: `file:///r${i}`, name: `r${i}` }));
		const results: Record<string, unknown> = {
			initialize: {
				protocolVersion: LATEST_PROTOCOL_VERSION,
				capabilities: { resources: {} },
				serverInfo: { name: "big", version: "1.0.0" },
			},
			"resources/list": { resources },
		};
		pair.server.onMessage((message) => {
			if (!("id" in message) || !("method" in message)) return;
			const request = message as JsonRpcRequest;
			queueMicrotask(
				() => void pair.server.send({ jsonrpc: "2.0", id: request.id, result: results[request.method] }),
			);
		});
		await pair.server.start();
		const client = new McpClient({ name: "test-client", version: "1.0.0" });
		await client.connect(pair.client);
		try {
			expect(await client.listResources()).toHaveLength(200_000);
		} finally {
			await client.close();
		}
	});
});
