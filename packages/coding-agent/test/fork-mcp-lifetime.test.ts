/**
 * fork: an MCP server's connections end with it, and its lists follow the newest
 * answer.
 * - close() closes a server still answering initialize, and a client detached after its session expired.
 * - an older tools/list or resources/list answer never replaces a newer one, and a change announced during
 *   setup is read again once the server is connected.
 * - a server switched on then off before the MCP runtime loaded is never started.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type JsonRpcMessage, LATEST_PROTOCOL_VERSION, McpSessionExpiredError } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair, type InMemoryTransport } from "@earendil-works/pi-mcp/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { InMemoryAuthStorageBackend } from "../src/core/auth-storage.ts";
import type { McpServerEntry } from "../src/extensions/mcp/config.ts";
import { createMcpExtension } from "../src/extensions/mcp/index.ts";
// Loaded here so the extension's lazy load of the runtime resolves within a few ticks.
import { McpOAuthCredentialStore, McpServerConnection } from "../src/extensions/mcp/runtime.ts";
import { type SectionContext, setSettingsHost, settingsSections } from "../src/fork/settings-sections.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

type Answer = (method: string) => Promise<Record<string, unknown>> | undefined;

const ENTRY: McpServerEntry = { name: "fake", config: { command: "unused" }, source: "test" };

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const toolList = (...names: string[]) => ({ tools: names.map((name) => ({ name, inputSchema: { type: "object" } })) });

/** An in-memory server: `answer` gives each request's result (initialize has a default), or undefined for none. */
function fakeServer(answer: Answer, capabilities: Record<string, unknown> = { tools: {} }) {
	const pair = createInMemoryTransportPair();
	let closed = false;
	pair.server.onClose(() => {
		closed = true;
	});
	pair.server.onMessage((message) => {
		if (!("id" in message) || !("method" in message)) return;
		const id = message.id;
		const result =
			answer(message.method) ??
			(message.method === "initialize"
				? Promise.resolve({
						protocolVersion: LATEST_PROTOCOL_VERSION,
						capabilities,
						serverInfo: { name: "fake", version: "1.0.0" },
					})
				: undefined);
		void result?.then((value) => pair.server.send({ jsonrpc: "2.0", id, result: value } as JsonRpcMessage));
	});
	void pair.server.start();
	const notify = (method: string) => pair.server.send({ jsonrpc: "2.0", method } as JsonRpcMessage);
	return { client: pair.client, server: pair.server as InMemoryTransport, closed: () => closed, notify };
}

function connection(transports: (() => InMemoryTransport)[], onTools: () => void = () => {}) {
	let opened = 0;
	return new McpServerConnection({
		entry: ENTRY,
		cwd: process.cwd(),
		createTransport: () => transports[opened++](),
		credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
		onTools,
	});
}

describe("fork: MCP connections end with their server", () => {
	it("closes a server that has not answered initialize, and ends its setup", async () => {
		const initialize = deferred<Record<string, unknown>>();
		let asked = false;
		const server = fakeServer((method) => {
			if (method !== "initialize") return Promise.resolve(toolList());
			asked = true;
			// Never answered.
			return initialize.promise;
		});
		const mcp = connection([() => server.client]);
		const opening = mcp.getClient();
		await vi.waitFor(() => expect(asked).toBe(true));
		await mcp.close();
		expect(server.closed()).toBe(true);
		await expect(opening).rejects.toThrow();
	});

	it("closes the client detached after its session expired once its call has ended", async () => {
		const answer = (method: string) =>
			method === "tools/list"
				? Promise.resolve(toolList())
				: method === "tools/call"
					? Promise.resolve({ content: [{ type: "text", text: "ok" }] })
					: undefined;
		const first = fakeServer(answer);
		const send = first.client.send.bind(first.client);
		// The HTTP transport's 404 for a session the server no longer knows.
		first.client.send = async (message: JsonRpcMessage) => {
			if ("method" in message && message.method === "tools/call") throw new McpSessionExpiredError("gone");
			return send(message);
		};
		const second = fakeServer(answer);
		const mcp = connection([() => first.client, () => second.client]);
		expect(await mcp.callTool("echo", {}, {})).toEqual({ content: [{ type: "text", text: "ok" }] });
		await vi.waitFor(() => expect(first.closed()).toBe(true));
		expect(second.closed()).toBe(false);
		await mcp.close();
		expect(second.closed()).toBe(true);
	});
});

describe("fork: MCP lists follow the newest answer", () => {
	it("keeps the newer tool and resource lists when an older refresh answers last", async () => {
		const stale = { tools: deferred<Record<string, unknown>>(), resources: deferred<Record<string, unknown>>() };
		const calls = { "tools/list": 0, "resources/list": 0 };
		const server = fakeServer(
			(method) => {
				if (method === "resources/templates/list") return Promise.resolve({ resourceTemplates: [] });
				if (method !== "tools/list" && method !== "resources/list") return undefined;
				const call = ++calls[method];
				const current =
					method === "tools/list" ? toolList("kept") : { resources: [{ uri: "docs://kept", name: "kept" }] };
				const removed =
					method === "tools/list"
						? toolList("kept", "removed")
						: {
								resources: [
									{ uri: "docs://kept", name: "kept" },
									{ uri: "docs://removed", name: "removed" },
								],
							};
				// Setup reads the list with a removed entry, the first refresh answers late with it, the second at once.
				if (call === 1) return Promise.resolve(removed);
				if (call === 2) return (method === "tools/list" ? stale.tools : stale.resources).promise;
				return Promise.resolve(current);
			},
			{ tools: {}, resources: {} },
		);
		const mcp = connection([() => server.client]);
		await mcp.getClient();
		for (const method of ["notifications/tools/list_changed", "notifications/resources/list_changed"]) {
			await server.notify(method);
			await server.notify(method);
		}
		await vi.waitFor(() => expect(mcp.tools.map((tool) => tool.name)).toEqual(["kept"]));
		await vi.waitFor(() => expect(mcp.resources.map((resource) => resource.name)).toEqual(["kept"]));
		stale.tools.resolve(toolList("kept", "removed"));
		stale.resources.resolve({
			resources: [
				{ uri: "docs://kept", name: "kept" },
				{ uri: "docs://removed", name: "removed" },
			],
		});
		await tick();
		await tick();
		expect(mcp.tools.map((tool) => tool.name)).toEqual(["kept"]);
		expect(mcp.resources.map((resource) => resource.name)).toEqual(["kept"]);
		await mcp.close();
	});

	it("reads the tools again when they changed while the server was being set up", async () => {
		const setupList = deferred<Record<string, unknown>>();
		let lists = 0;
		const server = fakeServer((method) => {
			if (method !== "tools/list") return undefined;
			lists++;
			return lists === 1 ? setupList.promise : Promise.resolve(toolList("kept"));
		});
		const mcp = connection([() => server.client]);
		const opening = mcp.getClient();
		await vi.waitFor(() => expect(lists).toBe(1));
		await server.notify("notifications/tools/list_changed");
		await tick();
		setupList.resolve(toolList("kept", "removed"));
		await opening;
		await vi.waitFor(() => expect(mcp.tools.map((tool) => tool.name)).toEqual(["kept"]));
		await mcp.close();
	});
});

// fork: a resource refresh runs without await; its failure must not escape as a rejection.
describe("fork: a failed MCP resource refresh", () => {
	it("shows the failure on the server instead of an unhandled rejection", async () => {
		const server = fakeServer(
			(method) => {
				if (method === "resources/templates/list") return Promise.resolve({ resourceTemplates: [] });
				if (method === "resources/list") return Promise.resolve({ resources: [{ uri: "docs://a", name: "a" }] });
				return undefined;
			},
			{ resources: {} },
		);
		// Setup publishes the lists; the refresh's publication fails, as from a session that has ended.
		let published = 0;
		const onTools = () => {
			if (++published > 1) throw new Error("This extension ctx is stale");
		};
		const escaped: unknown[] = [];
		const onRejection = (reason: unknown) => escaped.push(reason);
		process.on("unhandledRejection", onRejection);
		try {
			const mcp = connection([() => server.client], onTools);
			await mcp.getClient();
			await server.notify("notifications/resources/list_changed");
			await vi.waitFor(() => expect(published).toBe(2));
			await tick();
			await tick();
			expect(escaped).toEqual([]);
			expect(mcp.error).toBe("Failed to refresh resources: This extension ctx is stale");
			await mcp.close();
		} finally {
			process.off("unhandledRejection", onRejection);
		}
	});
});

describe("fork: an MCP server switched off before it started", () => {
	let agentDir: string;
	const harnesses: Harness[] = [];
	const context: SectionContext = { advanced: () => true, requestRender: vi.fn() };

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-mcp-lifetime-"));
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
	});
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) {
			await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			harness.cleanup();
		}
		setSettingsHost(undefined);
		vi.unstubAllEnvs();
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("stays off: no transport, no tool, and the config says off", async () => {
		const updateConfig = vi.fn();
		const createTransport = vi.fn(() => fakeServer(() => Promise.resolve(toolList("search"))).client);
		const harness = await createHarness({
			extensionFactories: [
				createMcpExtension({
					loadConfig: () => ({
						servers: [
							{
								name: "docs",
								config: { url: "http://unused.invalid", enabled: false },
								source: join(agentDir, "mcp.json"),
								scope: "global",
							},
						],
						errors: [],
					}),
					updateConfig,
					createTransport,
				}),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });
		const section = settingsSections().find((candidate) => candidate.domain === "servers")!;
		// The settings list does not wait for a switch to apply before the next one.
		section.onChange!("mcp-enabled:docs", "on");
		section.onChange!("mcp-enabled:docs", "off");
		for (let index = 0; index < 20; index++) await tick();
		expect(createTransport).not.toHaveBeenCalled();
		expect(updateConfig).toHaveBeenLastCalledWith(expect.objectContaining({ name: "docs" }), { enabled: false });
		expect(section.items(context)[0]!.currentValue).toBe("off");
		expect(harness.session.getAllTools().filter((tool) => tool.name.includes("search"))).toEqual([]);
	});
});
