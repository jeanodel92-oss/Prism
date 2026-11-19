/**
 * fork: an extension left out after loading takes back what it published
 * to the runtime shared with the extensions kept: its MCP servers and its event bus subscriptions. Before, a project
 * extension refused for registering `/perm`, or a replaceable extension replaced by another, kept both.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME, ENV_AGENT_DIR } from "../src/config.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import type { ExtensionAPI, InlineExtension } from "../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";

process.env.NPM_CONFIG_UPDATE_NOTIFIER = "false";

type Heard = { heard?: string[] };

describe("fork: an extension left out leaves nothing in the shared runtime", () => {
	let agentDir: string;
	const saved = process.env[ENV_AGENT_DIR];

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-withdrawn-extension-"));
		process.env[ENV_AGENT_DIR] = agentDir;
		(globalThis as Heard).heard = [];
	});
	afterEach(() => {
		if (saved === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = saved;
		delete (globalThis as Heard).heard;
		rmSync(agentDir, { recursive: true, force: true });
	});

	/** Registers `command`, an MCP server and a bus subscription that records what it hears. */
	const source = (command: string, server: string) => `export default function (pi) {
  pi.registerCommand(${JSON.stringify(command)}, { description: "x", handler: async () => {} });
  pi.registerMcpServer(${JSON.stringify(server)}, { url: "http://unused.invalid" });
  pi.events.on("probe", (data) => globalThis.heard.push(${JSON.stringify(server)} + ":" + data));
}`;

	const load = async (cwd: string, extensionFactories: InlineExtension[] = []) => {
		const eventBus = createEventBus();
		const loader = new DefaultResourceLoader({ cwd, agentDir, eventBus, extensionFactories });
		await loader.reload();
		const result = loader.getExtensions();
		eventBus.emit("probe", "ping");
		return {
			paths: result.extensions.map((extension) => extension.path),
			servers: result.runtime.mcpServers.list().map((server) => server.name),
			heard: (globalThis as Heard).heard,
		};
	};

	it("a project extension refused for registering /perm", async () => {
		const cwd = join(agentDir, "project");
		mkdirSync(join(cwd, CONFIG_DIR_NAME, "extensions"), { recursive: true });
		writeFileSync(join(cwd, CONFIG_DIR_NAME, "extensions", "perm.ts"), source("perm", "project-docs"));
		const gate: InlineExtension = {
			name: "permissions",
			replaceable: true,
			userReplaceableOnly: true,
			factory: (pi: ExtensionAPI) => pi.registerCommand("perm", { description: "gate", handler: async () => {} }),
		};
		const loaded = await load(cwd, [gate]);
		expect(loaded.paths).toEqual(["<inline:permissions>"]);
		expect(loaded.servers).toEqual([]);
		expect(loaded.heard).toEqual([]);
	});

	it("a replaceable extension replaced by another", async () => {
		const cwd = join(agentDir, "project");
		mkdirSync(cwd, { recursive: true });
		const user = join(agentDir, "extensions", "docs.ts");
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		writeFileSync(user, source("docs", "user-docs"));
		const replaced: InlineExtension = {
			name: "docs",
			replaceable: true,
			factory: (pi: ExtensionAPI) => {
				pi.registerCommand("docs", { description: "built in", handler: async () => {} });
				pi.registerMcpServer("builtin-docs", { url: "http://unused.invalid" });
				pi.events.on("probe", (data) => (globalThis as Heard).heard?.push(`builtin-docs:${String(data)}`));
			},
		};
		const loaded = await load(cwd, [replaced]);
		expect(loaded.paths).toEqual([user]);
		expect(loaded.servers).toEqual(["user-docs"]);
		expect(loaded.heard).toEqual(["user-docs:ping"]);
	});
});
