/**
 * fork: an SSE response stream lives as long as its request. A request
 * cancelled, or already answered, no longer reads its stream nor resumes it with GET.
 */
import { describe, expect, it } from "vitest";
import { type JsonRpcMessage, type McpFetch, StreamableHttpTransport } from "../src/index.ts";

const request = { jsonrpc: "2.0" as const, id: 1, method: "tools/call" };

/** An SSE body that sends `events`, then stays open, or ends when `end` is set. */
function sse(events: string, state: { cancelled: boolean }, end = false): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(events));
				if (end) controller.close();
			},
			cancel() {
				state.cancelled = true;
			},
		}),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

function transport(fetch: McpFetch, initialDelayMs = 1): StreamableHttpTransport {
	return new StreamableHttpTransport({
		url: "http://127.0.0.1:9/mcp",
		fetch,
		openGetStream: false,
		reconnect: { initialDelayMs, maxDelayMs: initialDelayMs },
	});
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("fork: an MCP request's SSE stream ends with the request", () => {
	it("stops reading the stream of a cancelled request, and resumes nothing", async () => {
		const state = { cancelled: false };
		const methods: string[] = [];
		const http = transport(async (_url, init) => {
			methods.push(init?.method ?? "GET");
			return sse("id: e1\ndata:\n\n", state);
		});
		await http.start();
		const controller = new AbortController();
		await http.send(request, { signal: controller.signal });
		await wait(5);
		controller.abort();
		await wait(20);
		expect(state.cancelled).toBe(true);
		expect(methods).toEqual(["POST"]);
		await http.close();
	});

	it("opens no GET to resume a stream whose request was cancelled while waiting to reconnect", async () => {
		const state = { cancelled: false };
		const methods: string[] = [];
		const http = transport(async (_url, init) => {
			methods.push(init?.method ?? "GET");
			// The server closes the stream after its resumption id, before answering.
			return sse("id: e1\ndata:\n\n", state, true);
		}, 30);
		await http.start();
		const controller = new AbortController();
		await http.send(request, { signal: controller.signal });
		await wait(5);
		controller.abort();
		await wait(60);
		expect(methods).toEqual(["POST"]);
		await http.close();
	});

	it("lets go of a stream the server keeps open after its response", async () => {
		const state = { cancelled: false };
		const http = transport(async () =>
			sse(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } })}\n\n`, state),
		);
		const messages: JsonRpcMessage[] = [];
		http.onMessage((message) => messages.push(message));
		await http.start();
		await http.send(request);
		await wait(20);
		expect(messages).toEqual([{ jsonrpc: "2.0", id: 1, result: { content: [] } }]);
		expect(state.cancelled).toBe(true);
		await http.close();
	});
});
