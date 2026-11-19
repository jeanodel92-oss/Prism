// `/mcp` as native screens over the real view transport; the manager keeps its operations.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type JsonRpcRequest, LATEST_PROTOCOL_VERSION } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import type { McpServerEntry } from "../src/extensions/mcp/config.ts";
import { createMcpExtension } from "../src/extensions/mcp/index.ts";
import { setLanguage } from "../src/fork/i18n/index.ts";
import { setViewsClient } from "../src/fork/interactive-client.ts";
import { NativeMcpView } from "../src/fork/mcp-native.ts";
import { RpcViews } from "../src/fork/rpc-views.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

interface Item {
	id: string;
	label: string;
	description?: string;
	details?: string[];
}
interface Menu {
	screenId: string;
	menuId: string;
	kind: string;
	title: string;
	lines?: string[];
	errors?: string[];
	items?: Item[];
	initialItemId?: string;
	busy?: boolean;
	link?: string;
}
type Record_ = { type: string; id?: string; menu?: Menu; reason?: string };

/** An MCP server over an in-memory transport; `gate` holds back the answer to `initialize`. */
function fakeServer(gate?: Promise<void>) {
	const pair = createInMemoryTransportPair();
	const respond = (request: JsonRpcRequest): unknown => {
		if (request.method === "initialize")
			return {
				protocolVersion: LATEST_PROTOCOL_VERSION,
				capabilities: { tools: {} },
				serverInfo: { name: "docs", version: "1.0.0" },
			};
		if (request.method === "tools/list")
			return {
				tools: [
					{ name: "search", description: "Search the docs.\nSecond line.", inputSchema: { type: "object" } },
					{ name: "fetch", description: "Fetch a page.", inputSchema: { type: "object" } },
				],
			};
		return {};
	};
	pair.server.onMessage((message) => {
		if (!("id" in message) || !("method" in message)) return;
		const request = message as JsonRpcRequest;
		const send = () => void pair.server.send({ jsonrpc: "2.0", id: request.id, result: respond(request) });
		if (request.method === "initialize" && gate) void gate.then(send);
		else queueMicrotask(send);
	});
	void pair.server.start();
	return pair.client;
}

describe("fork: native /mcp", () => {
	let root: string;
	const saved = { agent: process.env[ENV_AGENT_DIR], home: process.env.HOME };
	const harnesses: Harness[] = [];
	beforeEach(() => {
		initTheme("dark");
		root = mkdtempSync(join(tmpdir(), "prism-mcp-native-"));
		process.env.HOME = root;
		process.env[ENV_AGENT_DIR] = root;
	});
	afterEach(async () => {
		setViewsClient();
		setLanguage("en");
		for (const harness of harnesses.splice(0)) {
			await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			harness.cleanup();
		}
		for (const [key, value] of [
			[ENV_AGENT_DIR, saved.agent],
			["HOME", saved.home],
		] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	});

	async function engine(options: { gate?: Promise<void>; errors?: string[] } = {}) {
		const config = join(root, "mcp.json");
		writeFileSync(config, JSON.stringify({ mcpServers: { docs: { url: "http://docs.invalid" } } }));
		const entry: McpServerEntry = {
			name: "docs",
			config: { url: "http://docs.invalid" },
			source: config,
			scope: "global",
		};
		const records: Record_[] = [];
		const views = new RpcViews((record) => records.push(record as Record_));
		views.handleCommand({ type: "set_views", columns: 100, rows: 30, nativeMenus: true });
		let api: ExtensionAPI | undefined;
		const connections = new Map<string, number>();
		const harness = await createHarness({
			initialActiveToolNames: [],
			extensionFactories: [
				(pi) => {
					api = pi;
				},
				createMcpExtension({
					loadConfig: () => ({ servers: [entry], errors: options.errors ?? [] }),
					// `gate` holds back every connection but the first to docs: /mcp opens after the startup connections.
					createTransport: (server) => {
						const count = (connections.get(server.name) ?? 0) + 1;
						connections.set(server.name, count);
						return fakeServer(server.name === "docs" && count === 1 ? undefined : options.gate);
					},
				}),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({ custom: (factory, opts) => views.custom(factory, opts) }),
			mode: "rpc",
		});
		const frames = () => records.filter((record) => record.type === "view_frame");
		const menu = () => frames().at(-1)?.menu as Menu;
		const viewId = () => records.find((record) => record.type === "view_open")?.id ?? "";
		const act = (action: object) => views.handleCommand({ type: "view_action", viewId: viewId(), action });
		const activate = (label: string) => {
			const item = menu().items?.find((candidate) => candidate.label === label);
			if (!item) throw new Error(`No item ${label} in ${menu().title}`);
			return act({ kind: "activate", itemId: item.id });
		};
		const run = () => {
			const command = harness.session.extensionRunner.getCommand("mcp");
			if (!command) throw new Error("No /mcp command");
			return command.handler("", harness.session.extensionRunner.createCommandContext());
		};
		const saved = () => JSON.parse(readFileSync(config, "utf8")).mcpServers.docs as Record<string, unknown>;
		const register = (name: string) => api?.registerMcpServer(name, { url: `http://${name}.invalid` });
		return { harness, records, views, frames, menu, viewId, act, activate, run, saved, register };
	}

	it("updates the open server list while a server connects, in the same panel", async () => {
		let open = () => {};
		const gate = new Promise<void>((resolve) => {
			open = resolve;
		});
		const e = await engine({ gate, errors: ['server "bad" needs either "command" or "url"'] });
		const done = e.run();
		await vi.waitFor(() => expect(e.menu()?.title).toBe("MCP servers"));
		expect(e.menu()).toMatchObject({ kind: "choice", screenId: "menu:MCP servers" });
		expect(e.menu().errors).toEqual(['config: server "bad" needs either "command" or "url"']);
		expect(e.menu().items?.map((item) => item.label)).toEqual(["docs", "Add a server"]);
		e.register("late");
		await vi.waitFor(() => expect(e.menu().items?.map((item) => item.label)).toContain("late"));
		const late = () => e.menu().items?.find((item) => item.label === "late");
		expect(late()?.description).toMatch(/^connecting/);
		const before = e.frames().length;
		open();
		await vi.waitFor(() => expect(late()?.description).toMatch(/^connected/));
		expect(e.frames().length).toBeGreaterThan(before);
		expect(e.records.filter((record) => record.type === "view_open")).toHaveLength(1);
		expect(new Set(e.frames().map((frame) => frame.menu?.menuId)).size).toBe(1);
		expect(e.act({ kind: "back" })).toMatchObject({ success: true });
		await done;
		expect(e.records.at(-1)).toMatchObject({ type: "view_closed", reason: "done" });
	});

	it("runs the manager's own actions: tools, exposure saved to mcp.json, reconnect and disable", async () => {
		const e = await engine();
		await vi.waitFor(() =>
			expect(e.harness.session.getAllTools().some((tool) => tool.name === "mcp__docs__search")).toBe(true),
		);
		const done = e.run();
		await vi.waitFor(() => expect(e.menu()?.items?.[0]?.description).toMatch(/^connected/));
		e.activate("docs");
		await vi.waitFor(() => expect(e.menu().title).toBe("MCP server docs"));
		expect(e.menu().items?.map((item) => item.label)).toEqual([
			"Tools",
			"Reconnect",
			"Sign out",
			"Exposure",
			"Disable",
			"Remove",
		]);
		expect(e.menu().initialItemId).toBe(e.menu().items?.[0]?.id);
		expect(e.menu().lines).toContain("State: connected · 2 tools");

		// Tools only lists what the server offers: read-only, with the description as the detail.
		e.activate("Tools");
		await vi.waitFor(() => expect(e.menu().title).toBe("Tools of docs"));
		expect(e.menu().kind).toBe("browse");
		expect(e.menu().items?.map((item) => [item.label, item.details])).toEqual([
			["search", ["Search the docs."]],
			["fetch", ["Fetch a page."]],
		]);
		e.act({ kind: "back" });
		await vi.waitFor(() => expect(e.menu().title).toBe("MCP server docs"));

		e.activate("Exposure");
		await vi.waitFor(() => expect(e.menu().title).toBe("Exposure of docs"));
		const exposure = e.menu();
		expect(exposure.initialItemId).toBe(exposure.items?.find((item) => item.label.endsWith("codemode"))?.id);
		e.activate("  direct");
		await vi.waitFor(() => expect(e.menu().title).toBe("MCP server docs"));
		expect(e.saved()).toMatchObject({ exposure: "direct" });
		// A click from the exposure screen, sent after it closed, is refused.
		const stale = exposure.items?.[0]?.id;
		expect(e.act({ kind: "activate", itemId: stale })).toMatchObject({ success: false });

		// A quick reconnect can replace its status screen before the frame is drawn; the next test holds it.
		// The server menu shown again is a new screen, with new identifiers.
		const shown = e.menu().items?.[0]?.id;
		e.activate("Reconnect");
		await vi.waitFor(() => expect(e.menu().items?.[0]?.id).not.toBe(shown));
		expect(e.menu().title).toBe("MCP server docs");
		expect(e.menu().lines).toContain("State: connected · 2 tools");

		e.activate("Disable");
		await vi.waitFor(() => expect(e.menu().items?.map((item) => item.label)).toEqual(["Enable", "Remove"]));
		expect(e.saved()).toMatchObject({ enabled: false });
		expect(e.harness.session.getCallableToolNames()).not.toContain("mcp__docs__search");
		e.activate("Enable");
		await vi.waitFor(() => expect(e.menu().lines).toContain("State: connected · 2 tools"));
		expect(e.saved().enabled).toBeUndefined();

		expect(e.act({ kind: "activate", itemId: "1:docs" })).toMatchObject({ success: false });
		expect(e.act({ kind: "setting", itemId: e.menu().items?.[0]?.id, value: "x" })).toMatchObject({ success: false });
		e.act({ kind: "back" });
		await vi.waitFor(() => expect(e.menu().title).toBe("MCP servers"));
		e.act({ kind: "back" });
		await done;
		expect(e.records.filter((record) => record.type === "view_open")).toHaveLength(1);
	});

	// the manager's own texts in French; ids, values, server and tool names stay as they are.
	it("shows the manager in French, with the same values and saved exposure", async () => {
		setLanguage("fr");
		const e = await engine({ errors: ['server "bad" needs either "command" or "url"'] });
		await vi.waitFor(() =>
			expect(e.harness.session.getAllTools().some((tool) => tool.name === "mcp__docs__search")).toBe(true),
		);
		const done = e.run();
		await vi.waitFor(() => expect(e.menu()?.title).toBe("Serveurs MCP"));
		expect(e.menu().errors).toEqual(['configuration : server "bad" needs either "command" or "url"']);
		await vi.waitFor(() => expect(e.menu().items?.[0]?.description).toMatch(/^connecté · 2 outils · codemode · /));
		e.activate("docs");
		await vi.waitFor(() => expect(e.menu().title).toBe("Serveur MCP docs"));
		expect(e.menu().items?.map((item) => item.label)).toEqual([
			"Outils",
			"Reconnecter",
			"Se déconnecter",
			"Exposition",
			"Désactiver",
			"Supprimer",
		]);
		expect(e.menu().lines).toContain("État : connecté · 2 outils");
		e.activate("Outils");
		await vi.waitFor(() => expect(e.menu().title).toBe("Outils de docs"));
		expect(e.menu().lines?.[0]).toBe(
			"Exposition codemode : appelés depuis les scripts codemode, qui les trouvent avec searchTools()",
		);
		expect(e.menu().items?.map((item) => item.label)).toEqual(["search", "fetch"]);
		e.act({ kind: "back" });
		await vi.waitFor(() => expect(e.menu().title).toBe("Serveur MCP docs"));
		e.activate("Exposition");
		await vi.waitFor(() => expect(e.menu().title).toBe("Exposition de docs"));
		expect(e.menu().lines?.[0]).toMatch(/^Enregistré dans .*mcp\.json\.$/);
		expect(e.menu().items?.find((item) => item.label === "  direct")?.description).toBe(
			"déclarés au modèle comme les outils intégrés",
		);
		e.activate("  direct");
		await vi.waitFor(() => expect(e.menu().title).toBe("Serveur MCP docs"));
		expect(e.saved()).toMatchObject({ exposure: "direct" });
		e.act({ kind: "back" });
		await vi.waitFor(() => expect(e.menu().title).toBe("Serveurs MCP"));
		e.act({ kind: "back" });
		await done;
	});

	it("closing the panel during an operation ends the command without bringing back a parent screen", async () => {
		const e = await engine({ gate: new Promise<void>(() => {}) });
		const done = e.run();
		await vi.waitFor(() => expect(e.menu()?.items?.[0]?.description).toMatch(/^connected/));
		e.activate("docs");
		await vi.waitFor(() => expect(e.menu().title).toBe("MCP server docs"));
		e.activate("Reconnect");
		await vi.waitFor(() => expect(e.menu().screenId).toBe("status"));
		expect(e.menu().busy).toBe(true);
		expect(e.act({ kind: "back" })).toMatchObject({ success: false });
		expect(e.views.handleCommand({ type: "view_close", viewId: e.viewId() })).toMatchObject({ success: true });
		await done;
		expect(e.records.filter((record) => record.type === "view_open")).toHaveLength(1);
		expect(e.records.filter((record) => record.type === "view_closed")).toEqual([
			{ type: "view_closed", id: e.viewId(), reason: "client" },
		]);
		const count = e.frames().length;
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(e.frames()).toHaveLength(count);
	});
});

describe("fork: native /mcp sign-in screen", () => {
	const view = () => {
		let changes = 0;
		const native = new NativeMcpView(() => changes++);
		return { native, changes: () => changes };
	};

	it("shows the authorization URL, keeps waiting on an empty paste and returns the pasted URL", async () => {
		const { native } = view();
		const pending = native.redirectUrl(
			"Sign in to docs",
			"https://auth.example/authorize?x=1",
			new AbortController().signal,
		);
		expect(native.nativeMenu).toMatchObject({
			kind: "input",
			title: "Sign in to docs",
			link: "https://auth.example/authorize?x=1",
		});
		expect(native.handleNativeMenuInput({ kind: "input", value: "   " })).toBe(true);
		expect(native.handleNativeMenuInput({ kind: "activate", itemId: "x" })).toBe(false);
		expect(native.handleNativeMenuInput({ kind: "input", value: " http://localhost/cb?code=1 " })).toBe(true);
		await expect(pending).resolves.toBe("http://localhost/cb?code=1");
		expect(native.handleNativeMenuInput({ kind: "back" })).toBe(false);
	});

	it("resolves undefined on Back, when the browser reached the callback, and after the panel closed", async () => {
		const { native } = view();
		const back = native.redirectUrl("t", "https://a.example", new AbortController().signal);
		native.handleNativeMenuInput({ kind: "back" });
		await expect(back).resolves.toBeUndefined();

		const controller = new AbortController();
		const callback = native.redirectUrl("t", "https://a.example", controller.signal);
		controller.abort();
		await expect(callback).resolves.toBeUndefined();

		const closing = native.redirectUrl("t", "https://a.example", new AbortController().signal);
		native.close();
		await expect(closing).resolves.toBeUndefined();
		await expect(
			native.menu(() => ({ title: "x", items: [], confirmLabel: "", cancelLabel: "back" })),
		).resolves.toBeUndefined();
		const screen = native.nativeMenu;
		native.status("x", "y");
		expect(native.nativeMenu).toBe(screen);
	});
});
