import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import lspSetup, { type LspSetupState, lspSetupPanel } from "../src/fork/lsp-setup.ts";
import { handleInspectCommand } from "../src/fork/rpc-inspect.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

describe("native language server setup", () => {
	let testHome: string;
	let agentDir: string;
	let bin: string;
	let marker: string;
	const harnesses: Harness[] = [];
	beforeEach(() => {
		testHome = mkdtempSync(join(tmpdir(), "prism-lsp-panel-"));
		agentDir = join(testHome, "agent");
		bin = join(testHome, "bin");
		marker = join(testHome, "executed");
		mkdirSync(agentDir);
		mkdirSync(bin);
		vi.stubEnv("HOME", testHome);
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		vi.stubEnv("PRISM_SECRET_SERVICE", "off");
		vi.stubEnv("PATH", bin);
	});
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) {
			await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			harness.cleanup();
		}
		const executed = existsSync(marker);
		vi.unstubAllEnvs();
		rmSync(testHome, { recursive: true, force: true });
		expect(executed).toBe(false);
	});
	async function engine(tools: string[] = [], available = true) {
		for (const name of tools) {
			writeFileSync(join(bin, name), `#!/bin/sh\nprintf executed > '${marker}'\n`);
			chmodSync(join(bin, name), 0o755);
		}
		const harness = await createHarness({
			extensionFactories: [
				lspSetup,
				...(available
					? [(pi: Parameters<typeof lspSetup>[0]) => pi.registerCommand("lsp", { handler: async () => {} })]
					: []),
			],
		});
		harnesses.push(harness);
		writeFileSync(join(harness.tempDir, "main.ts"), "");
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });
		const call = (type: string, fields: Record<string, unknown> = {}) =>
			handleInspectCommand({ type, ...fields }, harness.session);
		const state = async (all = false) => (await call("lsp_setup_get", { all })) as LspSetupState;
		return { harness, call, state };
	}

	it("shows project servers, then the full catalog, with their actual states", async () => {
		const { state } = await engine(["biome"]);
		expect((await state()).servers).toMatchObject([{ name: "biome", ready: true, enabled: true, configured: true }]);
		expect((await state()).all).toBe(false);
		expect((await state(true)).servers.length).toBeGreaterThan(5);
	});
	it("applies the same per-server setting without starting a server", async () => {
		const { call, state } = await engine(["biome"]);
		await call("lsp_setup_set", { name: "biome", enabled: false });
		expect((await state()).servers[0]).toMatchObject({ name: "biome", enabled: false, state: "turned off" });
		expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).lsp.disabled).toEqual(["biome"]);
		await call("lsp_setup_set", { name: "biome", enabled: true });
		expect((await state()).servers[0]?.enabled).toBe(true);
		await expect(call("lsp_setup_set", { name: "unknown", enabled: true })).rejects.toThrow(/Unknown/);
		await expect(call("lsp_setup_set", { name: "biome", enabled: "true" })).rejects.toThrow(/boolean/);
	});
	it("prepares a command without running it, and refuses sudo or a missing prerequisite", async () => {
		const { call } = await engine(["npm", "apt"]);
		await expect(call("lsp_setup_install", { name: "biome" })).resolves.toEqual({
			line: "!npm install -g @biomejs/biome",
		});
		await expect(call("lsp_setup_install", { name: "clangd" })).rejects.toThrow(/Run this in a terminal/);
		await expect(call("lsp_setup_install", { name: "ruff" })).rejects.toThrow(/first/);
	});
	it("respects a user catalog instead of enabling a server absent from it", async () => {
		writeFileSync(join(agentDir, "pi-lsp.json"), JSON.stringify({ servers: {} }));
		const { call, state } = await engine(["npm"]);
		expect(await state()).toMatchObject({
			notice: expect.any(String),
			servers: [{ name: "biome", configured: false }],
		});
		await expect(call("lsp_setup_set", { name: "biome", enabled: true })).rejects.toThrow(/only the servers/);
		await expect(call("lsp_setup_install", { name: "biome" })).rejects.toThrow(/only the servers/);
		expect(existsSync(join(agentDir, "settings.json"))).toBe(false);
	});
	it("refuses an untrusted project and removes the control at shutdown", async () => {
		const { call, harness } = await engine(["npm"]);
		harness.settingsManager.setProjectTrusted(false);
		await expect(call("lsp_setup_get")).rejects.toThrow(/not trusted/);
		await expect(call("lsp_setup_install", { name: "biome" })).rejects.toThrow(/not trusted/);
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		expect(lspSetupPanel(harness.session.extensionRunner.createContext())).toBeUndefined();
	});
	it("refuses when the LSP module is off", async () => {
		const { call } = await engine([], false);
		await expect(call("lsp_setup_get")).rejects.toThrow(/pi-lsp module is off/);
		await expect(call("lsp_setup_set", { name: "biome", enabled: false })).rejects.toThrow(/pi-lsp module is off/);
	});
	it("does not overwrite an invalid settings file", async () => {
		const { call } = await engine(["biome"]);
		const broken = '{"lsp":';
		writeFileSync(join(agentDir, "settings.json"), broken);
		await expect(call("lsp_setup_set", { name: "biome", enabled: false })).rejects.toThrow();
		expect(readFileSync(join(agentDir, "settings.json"), "utf8")).toBe(broken);
	});
});
