/**
 * fork: the HTTP transport reads a JSON response and an error body up to
 * a limit, never past it, and stops reading when the caller gives up. Each server here answers with a body that never
 * ends; the transport must cancel it after the limit.
 */
import { describe, expect, it } from "vitest";
import { type McpFetch, McpHttpError, StreamableHttpTransport } from "../src/index.ts";

/** A body that never ends, in 64 KiB chunks; `pulled` counts the bytes the reader asked for. */
function endless(state: { pulled: number; cancelled: boolean }, first = ""): ReadableStream<Uint8Array> {
	const chunk = new Uint8Array(64 * 1024).fill(0x20);
	let sentFirst = false;
	return new ReadableStream({
		pull(controller) {
			const data = sentFirst || !first ? chunk : new TextEncoder().encode(first);
			sentFirst = true;
			state.pulled += data.byteLength;
			controller.enqueue(data);
		},
		cancel() {
			state.cancelled = true;
		},
	});
}

function transport(fetch: McpFetch, maxMessageBytes = 1024 * 1024): StreamableHttpTransport {
	return new StreamableHttpTransport({ url: "http://127.0.0.1:9/mcp", fetch, openGetStream: false, maxMessageBytes });
}

const request = { jsonrpc: "2.0" as const, id: 1, method: "tools/list" };

describe("fork: bounded MCP HTTP bodies", () => {
	it("refuses a JSON response larger than the message limit and cancels its body", async () => {
		const state = { pulled: 0, cancelled: false };
		const http = transport(
			async () =>
				new Response(endless(state, '{"jsonrpc":"2.0","id":1,"result":{"tools":['), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		await http.start();
		await expect(http.send(request)).rejects.toThrow(/larger than 1048576 bytes/);
		expect(state.cancelled).toBe(true);
		expect(state.pulled).toBeLessThan(2 * 1024 * 1024);
	});

	it("keeps only an excerpt of an error body and cancels the rest", async () => {
		const state = { pulled: 0, cancelled: false };
		const http = transport(async () => new Response(endless(state, "overloaded"), { status: 503 }));
		await http.start();
		const error = await http.send(request).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(McpHttpError);
		expect((error as McpHttpError).message).toMatch(/status 503: overloaded/);
		expect((error as McpHttpError).body.length).toBeLessThanOrEqual(8 * 1024);
		expect(state.cancelled).toBe(true);
		expect(state.pulled).toBeLessThan(256 * 1024);
	});

	it("stops reading a slow response when the caller gives up", async () => {
		let cancelled = false;
		const http = transport(
			async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0",'));
						},
						cancel() {
							cancelled = true;
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);
		await http.start();
		const controller = new AbortController();
		const sent = http.send(request, { signal: controller.signal });
		setTimeout(() => controller.abort(new Error("timed out")), 50);
		await expect(sent).rejects.toThrow(/timed out/);
		expect(cancelled).toBe(true);
	});
});
