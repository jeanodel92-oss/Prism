/**
 * the MCP server through which `claude -p` calls Prism's tools.
 * Claude Code runs without its own tools and reaches this one server over HTTP on 127.0.0.1, with a bearer
 * token only this process knows. A `tools/call` waits until Prism's engine has run the call, so the sandbox,
 * the permission gate and the display stay Prism's. Streamable HTTP, answered with plain JSON: no server stream.
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ImageContent, TextContent, Tool } from "@earendil-works/pi-ai";

/** The MCP server name Claude Code sees; its tools reach the model as `mcp__prism__<tool>`. */
export const BRIDGE_SERVER_NAME = "prism";
export const BRIDGE_TOOL_PREFIX = `mcp__${BRIDGE_SERVER_NAME}__`;

export interface BridgeCallResult {
	content: (TextContent | ImageContent)[];
	isError: boolean;
}

/** Runs one call the model made; resolves with what the model gets back. */
export type BridgeCallHandler = (name: string, args: Record<string, unknown>) => Promise<BridgeCallResult>;

export interface McpBridge {
	readonly url: string;
	readonly token: string;
	setTools(tools: readonly Tool[]): void;
	close(): Promise<void>;
}

interface JsonRpcRequest {
	jsonrpc?: string;
	id?: string | number | null;
	method?: string;
	params?: Record<string, unknown>;
}

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function readBody(request: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		request.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(new Error("MCP request too large"));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
		request.on("error", reject);
	});
}

function toMcpContent(content: (TextContent | ImageContent)[]): Record<string, unknown>[] {
	const blocks = content.map((block) =>
		block.type === "text"
			? { type: "text", text: block.text }
			: { type: "image", data: block.data, mimeType: block.mimeType },
	);
	return blocks.length > 0 ? blocks : [{ type: "text", text: "" }];
}

export async function startMcpBridge(onCall: BridgeCallHandler): Promise<McpBridge> {
	const token = randomBytes(32).toString("hex");
	let tools: readonly Tool[] = [];

	const answer = async (message: JsonRpcRequest): Promise<Record<string, unknown> | undefined> => {
		const id = message.id;
		if (id === undefined || id === null) return undefined;
		const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
		switch (message.method) {
			case "initialize":
				return reply({
					protocolVersion:
						typeof message.params?.protocolVersion === "string" ? message.params.protocolVersion : "2025-06-18",
					capabilities: { tools: { listChanged: false } },
					serverInfo: { name: BRIDGE_SERVER_NAME, version: "1" },
				});
			case "ping":
				return reply({});
			case "tools/list":
				return reply({
					tools: tools.map((tool) => ({
						name: tool.name,
						description: tool.description,
						// TypeBox schemas are JSON Schema; its symbol keys do not survive JSON.
						inputSchema: JSON.parse(JSON.stringify(tool.parameters)),
					})),
				});
			case "tools/call": {
				const name = typeof message.params?.name === "string" ? message.params.name : "";
				const args =
					message.params?.arguments && typeof message.params.arguments === "object"
						? (message.params.arguments as Record<string, unknown>)
						: {};
				try {
					const result = await onCall(name, args);
					return reply({ content: toMcpContent(result.content), isError: result.isError });
				} catch (error) {
					return reply({
						content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
						isError: true,
					});
				}
			}
			default:
				return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${message.method}` } };
		}
	};

	const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		if (request.headers.authorization !== `Bearer ${token}`) {
			response.writeHead(401).end();
			return;
		}
		if (request.method === "DELETE") {
			response.writeHead(200).end();
			return;
		}
		if (request.method !== "POST") {
			// No server-initiated stream: every answer comes back on its POST.
			response.writeHead(405, { allow: "POST, DELETE" }).end();
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(await readBody(request));
		} catch {
			response.writeHead(400).end();
			return;
		}
		const batch = Array.isArray(parsed);
		const messages = (batch ? parsed : [parsed]) as JsonRpcRequest[];
		const answers = (await Promise.all(messages.map(answer))).filter(
			(entry): entry is Record<string, unknown> => entry !== undefined,
		);
		if (answers.length === 0) {
			response.writeHead(202).end();
			return;
		}
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify(batch ? answers : answers[0]));
	};

	const server: Server = createServer((request, response) => {
		handle(request, response).catch(() => {
			if (!response.headersSent) response.writeHead(500);
			response.end();
		});
	});
	// A tool call can wait for the user's approval as long as they take.
	server.requestTimeout = 0;
	server.headersTimeout = 60_000;
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	return {
		url: `http://127.0.0.1:${port}/mcp`,
		token,
		setTools: (next) => {
			tools = next;
		},
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}
