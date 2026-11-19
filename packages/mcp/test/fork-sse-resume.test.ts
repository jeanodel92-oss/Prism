/**
 * fork: the SSE parser and stream resumption.
 * - an event's id became the resumption cursor as soon as its `id:` line was read. A stream cut after
 *   `id: reply` and before its data resumed past a reply never received.
 * - only LF ended a line; a server ending lines with a lone CR, which SSE allows, never had its events read.
 * - a non-Latin-1 event id made Headers throw before the resuming GET, so it never resumed.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { LATEST_PROTOCOL_VERSION, McpClient, StreamableHttpTransport } from "../src/index.ts";
import { consumeSseStream, type SseEvent } from "../src/transports/streamable-http.ts";
import { closeServers, listen, readBody } from "./helpers.ts";

afterEach(closeServers);

async function parse(chunks: string[]): Promise<{ events: SseEvent[]; ids: string[] }> {
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
	const events: SseEvent[] = [];
	const ids: string[] = [];
	await consumeSseStream(stream, { onEvent: (event) => events.push(event), onId: (id) => ids.push(id) });
	return { events, ids };
}

const reply = (id: unknown, text: string) =>
	JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });

/**
 * A server whose tool call answers with `primeWith` and closes, then answers the resuming GET. Records the
 * Last-Event-ID of each resuming GET, decoded from its UTF-8 bytes.
 */
async function resumingServer(primeWith: string): Promise<{ url: string; resumedFrom: string[] }> {
	const resumedFrom: string[] = [];
	const origin = await listen(async (request: IncomingMessage, response: ServerResponse) => {
		if (request.method === "GET") {
			const header = request.headers["last-event-id"];
			if (typeof header !== "string") {
				response.statusCode = 405;
				response.end();
				return;
			}
			resumedFrom.push(Buffer.from(header, "latin1").toString("utf8"));
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(`id: replay\ndata: ${reply(2, "resumed")}\n\n`);
			return;
		}
		if (request.method !== "POST") {
			response.end();
			return;
		}
		const message = JSON.parse(await readBody(request)) as { id?: unknown; method?: string };
		if (!("id" in message)) {
			response.statusCode = 202;
			response.end();
		} else if (message.method === "initialize") {
			response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s" });
			response.end(
				JSON.stringify({
					jsonrpc: "2.0",
					id: message.id,
					result: {
						protocolVersion: LATEST_PROTOCOL_VERSION,
						capabilities: { tools: {} },
						serverInfo: { name: "sse-fixture", version: "1.0.0" },
					},
				}),
			);
		} else if (message.method === "tools/list") {
			response.setHeader("content-type", "application/json");
			response.end(
				JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "echo", inputSchema: {} }] } }),
			);
		} else {
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(primeWith);
		}
	});
	return { url: `${origin}/mcp`, resumedFrom };
}

async function callAfterResume(primeWith: string): Promise<{ result: unknown; resumedFrom: string[] }> {
	const { url, resumedFrom } = await resumingServer(primeWith);
	const client = new McpClient({ name: "sse-test", version: "1.0.0" });
	await client.connect(
		new StreamableHttpTransport({ url, openGetStream: false, reconnect: { initialDelayMs: 1, maxRetries: 2 } }),
	);
	try {
		return { result: await client.callTool("echo", {}, { timeoutMs: 5_000 }), resumedFrom };
	} finally {
		await client.close();
	}
}

describe("fork: SSE parsing and resumption", () => {
	it("publishes an id only once its event is complete", async () => {
		expect(await parse(["id: prime\ndata:\n\nid: reply\n"])).toEqual({
			events: [{ id: "prime", data: "" }],
			ids: ["prime"],
		});
		expect(await parse(['id: prime\ndata:\n\nid: reply\ndata: {"jsonrpc"'])).toEqual({
			events: [{ id: "prime", data: "" }],
			ids: ["prime"],
		});
		// An event with an id and no data still moves the cursor once its blank line arrives.
		expect((await parse(["id: a\n\n"])).ids).toEqual(["a"]);
	});

	it("resumes from the last complete event when the stream is cut after an id", async () => {
		const { result, resumedFrom } = await callAfterResume("id: prime\ndata:\n\nid: reply\n");
		expect(result).toEqual({ content: [{ type: "text", text: "resumed" }] });
		expect(resumedFrom).toEqual(["prime"]);
	});

	it("reads lines ended by CR, LF or CRLF, a CRLF pair split across chunks included", async () => {
		const expected = { events: [{ id: "1", event: "message", data: "a\nb" }], ids: ["1"] };
		expect(await parse(["event: message\rid: 1\rdata: a\rdata: b\r\r"])).toEqual(expected);
		expect(await parse(["event: message\nid: 1\ndata: a\ndata: b\n\n"])).toEqual(expected);
		expect(await parse(["event: message\r\nid: 1\r\ndata: a\r\ndata: b\r\n\r\n"])).toEqual(expected);
		expect(await parse(["event: message\r", "\nid: 1\r", "\ndata: a\r", "\ndata: b\r", "\n\r", "\n"])).toEqual(
			expected,
		);
	});

	it("answers a call whose stream ends lines with a lone CR", async () => {
		const { url } = await resumingServer(`event: message\rdata: ${reply(2, "cr")}\r\r`);
		const client = new McpClient({ name: "sse-test", version: "1.0.0" });
		await client.connect(new StreamableHttpTransport({ url, openGetStream: false }));
		try {
			expect(await client.callTool("echo", {}, { timeoutMs: 5_000 })).toEqual({
				content: [{ type: "text", text: "cr" }],
			});
		} finally {
			await client.close();
		}
	});

	it("resumes with a non-Latin-1 event id, sent as UTF-8", async () => {
		const id = "réponse-雪";
		const { result, resumedFrom } = await callAfterResume(`id: ${id}\ndata:\n\n`);
		expect(result).toEqual({ content: [{ type: "text", text: "resumed" }] });
		expect(resumedFrom).toEqual([id]);
	});
});
