// fork: with the user's own pi-lsp.json, /lsp-setup turns off the server by
// the name pi-lsp uses (the configuration's key), not the catalog's, and finds a command given as a path.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import lspSetup, { type LspSetupState } from "../src/fork/lsp-setup.ts";
import { handleInspectCommand } from "../src/fork/rpc-inspect.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

describe("language server setup with the user's own pi-lsp.json", () => {
	let testHome: string;
	let agentDir: string;
	let bin: string;
	const harnesses: Harness[] = [];
	beforeEach(() => {
		testHome = mkdtempSync(join(tmpdir(), "prism-lsp-own-"));
		agentDir = join(testHome, "agent");
		bin = join(testHome, "bin");
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
		vi.unstubAllEnvs();
		rmSync(testHome, { recursive: true, force: true });
	});
	const executable = (path: string) => {
		writeFileSync(path, "#!/bin/sh\nexit 0\n");
		chmodSync(path, 0o755);
	};
	async function engine(config: unknown) {
		writeFileSync(join(agentDir, "pi-lsp.json"), JSON.stringify(config));
		const harness = await createHarness({
			extensionFactories: [
				lspSetup,
				(pi: Parameters<typeof lspSetup>[0]) => pi.registerCommand("lsp", { handler: async () => {} }),
			],
		});
		harnesses.push(harness);
		writeFileSync(join(harness.tempDir, "main.ts"), "");
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });
		const call = (type: string, fields: Record<string, unknown> = {}) =>
			handleInspectCommand({ type, ...fields }, harness.session);
		const state = async () => (await call("lsp_setup_get", { all: false })) as LspSetupState;
		return { call, state };
	}

	it("turns off the configured server under its own name", async () => {
		executable(join(bin, "biome"));
		const { call, state } = await engine({
			servers: { ts: { command: ["biome", "lsp-proxy"], extensions: [".ts"] } },
		});
		expect((await state()).servers).toMatchObject([{ name: "ts", configured: true, ready: true, enabled: true }]);
		await call("lsp_setup_set", { name: "ts", enabled: false });
		// pi-lsp leaves out the servers whose configuration name is in lsp.disabled.
		expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).lsp.disabled).toEqual(["ts"]);
		expect((await state()).servers[0]).toMatchObject({ name: "ts", enabled: false, state: "turned off" });
	});

	it("calls a server whose command is a path outside PATH ready", async () => {
		const tools = join(testHome, "tools");
		mkdirSync(tools);
		executable(join(tools, "biome"));
		const { state } = await engine({ ts: { command: [join(tools, "biome"), "lsp-proxy"], extensions: [".ts"] } });
		expect((await state()).servers).toMatchObject([{ name: "ts", configured: true, ready: true }]);
	});
});
