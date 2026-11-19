// fork: language servers are suggested for coding projects only, once, and never installed
// without the user running the command.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME, ENV_AGENT_DIR } from "../src/config.ts";
import lspSetup, {
	hasOwnLspConfig,
	LSP_SERVERS,
	markNoticed,
	onPath,
	ownLspCommands,
	projectExtensions,
	serversFor,
	suggestionNotice,
	wasNoticed,
} from "../src/fork/lsp-setup.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

// Exercise the config directory used by the branded binary, even in a source checkout.
vi.mock("../src/config.ts", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	CONFIG_DIR_NAME: ".prism",
}));

describe("fork: language server suggestions", () => {
	const dirs: string[] = [];
	let harness: Harness | undefined;
	const temp = () => {
		const dir = mkdtempSync(join(tmpdir(), "prism-lsp-"));
		dirs.push(dir);
		return dir;
	};
	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
		vi.unstubAllEnvs();
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("finds the project's own source files, not its dependencies", () => {
		const root = temp();
		mkdirSync(join(root, "src", "lib"), { recursive: true });
		mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
		writeFileSync(join(root, "src", "lib", "main.ts"), "");
		writeFileSync(join(root, "node_modules", "dep", "index.go"), "");
		writeFileSync(join(root, "README.md"), "");
		const found = projectExtensions(root);
		expect(found.has(".ts")).toBe(true);
		expect(found.has(".go")).toBe(false);
	});

	it("suggests nothing for a project without code", () => {
		const root = temp();
		writeFileSync(join(root, "notes.md"), "");
		writeFileSync(join(root, "report.pdf"), "");
		const statuses = serversFor(projectExtensions(root), () => false);
		expect(statuses).toEqual([]);
		expect(suggestionNotice(statuses)).toBeUndefined();
	});

	it("names the missing servers of the project's languages as to install", () => {
		const installed = new Set(["ruff", "uv"]);
		const statuses = serversFor(new Set([".py", ".rs"]), (command) => installed.has(command));
		expect(statuses.map((status) => [status.server.name, status.ready])).toEqual([
			["ruff", true],
			["ty", false],
			["rust-analyzer", false],
		]);
		expect(statuses[1]?.install?.command).toBe("uv tool install ty");
		// No rustup on PATH: nothing to offer but the tool to install first.
		expect(statuses[2]?.install).toBeUndefined();
		const notice = suggestionNotice(statuses);
		expect(notice).toContain("ty (Python (types)), rust-analyzer (Rust)");
		expect(notice).not.toContain("ruff");
		expect(suggestionNotice(statuses.filter((status) => status.ready))).toBeUndefined();
	});

	it("tells each project once", () => {
		const agentDir = temp();
		expect(wasNoticed("/work/a", agentDir)).toBe(false);
		markNoticed("/work/a", agentDir);
		markNoticed("/work/a", agentDir);
		expect(wasNoticed("/work/a", agentDir)).toBe(true);
		expect(wasNoticed("/work/b", agentDir)).toBe(false);
	});

	it.each([
		["project", "pi-lsp.json"],
		["project", "lsp.json"],
		["agent", "pi-lsp.json"],
		["agent", "lsp.json"],
	])("detects the %s configuration %s read by pi-lsp", (scope, name) => {
		const cwd = temp();
		const agentDir = temp();
		expect(hasOwnLspConfig(cwd, agentDir)).toBe(false);
		const dir = scope === "project" ? join(cwd, CONFIG_DIR_NAME) : agentDir;
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, name), "{}");
		expect(hasOwnLspConfig(cwd, agentDir)).toBe(true);
	});

	it.each([
		["wrapped", { servers: { ts: { command: ["/usr/bin/biome", "lsp-proxy"], extensions: [".ts"] } } }],
		["flat", { ts: { command: ["biome", "lsp-proxy"], extensions: [".ts"] } }],
	])("only calls servers listed in the user's %s pi-lsp.json ready", (_shape, config) => {
		const cwd = temp();
		const agentDir = temp();
		expect(ownLspCommands(cwd, agentDir)).toBeUndefined();
		writeFileSync(join(agentDir, "pi-lsp.json"), JSON.stringify(config));
		const own = ownLspCommands(cwd, agentDir);
		expect([...(own?.keys() ?? [])]).toEqual(["biome"]);
		const statuses = serversFor(new Set([".ts", ".py"]), () => true, own);
		// fork: the server goes by its name in the configuration, as in pi-lsp.
		expect(statuses.map(({ server, ready, configured }) => [server.name, ready, configured])).toEqual([
			["ts", true, true],
			["ruff", false, false],
			["ty", false, false],
		]);
		writeFileSync(join(agentDir, "pi-lsp.json"), JSON.stringify({ servers: {} }));
		expect(serversFor(new Set([".ts"]), () => true, ownLspCommands(cwd, agentDir)).some((s) => s.ready)).toBe(false);
	});

	/**
	 * A session with /lsp-setup, PATH holding only `tools` (each one a script that leaves a marker if run), and a
	 * project holding `file`. `answers` are the choices made in the lists it shows, in order.
	 */
	async function manager(tools: string[], file: string | undefined, answers: Array<string | undefined>) {
		const agentDir = temp();
		const bin = temp();
		const marker = join(bin, "executed");
		for (const command of tools) {
			writeFileSync(join(bin, command), `#!/bin/sh\nprintf executed > '${marker}'\n`);
			chmodSync(join(bin, command), 0o755);
		}
		vi.stubEnv("PATH", bin);
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		harness = await createHarness({
			extensionFactories: [
				lspSetup,
				(pi) => pi.registerCommand("lsp", { description: "Test availability", handler: async () => {} }),
			],
		});
		if (file) writeFileSync(join(harness.tempDir, file), "");
		const ui = {
			editor: "unfinished message",
			notices: [] as string[],
			lists: [] as Array<{ title: string; options: string[] }>,
		};
		const errors: string[] = [];
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				select: async (title, options) => {
					ui.lists.push({ title, options });
					const answer = answers.shift();
					return answer === undefined ? undefined : options.find((option) => option.startsWith(answer));
				},
				notify: (message) => void ui.notices.push(message),
				getEditorText: () => ui.editor,
				setEditorText: (text) => {
					ui.editor = text;
				},
			}),
			onError: (error) => errors.push(error.error),
		});
		const executeBash = vi.spyOn(harness.session, "executeBash");
		return {
			ui,
			agentDir,
			run: async (line = "/lsp-setup") => {
				await harness!.session.prompt(line);
				expect(errors).toEqual([]);
				expect(executeBash).not.toHaveBeenCalled();
				expect(existsSync(marker)).toBe(false);
				expect(harness!.session.messages).toEqual([]);
			},
		};
	}

	// fork: /lsp-setup was a list whose lines only led to a notice or a confirmation; it is
	// the manager of /settings › Servers.
	it("puts a server's install command in the input box, without running it", async () => {
		const { ui, run } = await manager(["npm"], "main.ts", ["biome", "Install"]);
		await run();
		expect(ui.lists[0]!.options).toEqual(["biome — JavaScript / TypeScript — to install", "Every language server…"]);
		expect(ui.lists[1]!.title).toBe("biome — JavaScript / TypeScript\nNot installed: pi-lsp cannot start it.");
		expect(ui.lists[1]!.options).toEqual(["Install: put npm install -g @biomejs/biome in the input box", "Turn off"]);
		expect(ui.editor).toBe("!npm install -g @biomejs/biome");
		expect(ui.lists).toHaveLength(2);
	});

	it("only shows a command that needs sudo, and comes back to the list", async () => {
		const { ui, run } = await manager(["apt", "sudo"], "main.cpp", ["clangd", "Install"]);
		await run();
		expect(ui.notices.at(-1)).toContain("sudo apt install clangd");
		expect(ui.editor).toBe("unfinished message");
		expect(ui.lists).toHaveLength(3);
	});

	it("turns a server off and on for every session, and shows it in the list", async () => {
		const { ui, run, agentDir } = await manager(["biome"], "main.ts", ["biome", "Turn off", "biome", "Turn on"]);
		await run();
		const settings = () => JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")) as { lsp?: unknown };
		expect(ui.lists.map((list) => list.options[0])).toEqual([
			"biome — JavaScript / TypeScript — ready",
			"Turn off",
			"biome — JavaScript / TypeScript — turned off",
			"Turn on",
			"biome — JavaScript / TypeScript — ready",
		]);
		expect(ui.lists[1]!.options).toEqual(["Turn off"]);
		expect(settings().lsp).not.toHaveProperty("disabled");
	});

	it("lists every server in a project without source code, and from the list of a project", async () => {
		const empty = await manager([], undefined, []);
		await empty.run();
		expect(empty.ui.lists[0]!.title.split("\n")[0]).toBe("No source code in this project: every language server");
		expect(empty.ui.lists[0]!.options).toHaveLength(LSP_SERVERS.length);
		harness!.cleanup();

		const project = await manager([], "main.go", ["Every language server"]);
		await project.run();
		expect(project.ui.lists[0]!.options).toEqual(["gopls — Go — to install", "Every language server…"]);
		expect(project.ui.lists[1]!.title.split("\n")[0]).toBe("Language servers");
		expect(project.ui.lists[1]!.options).toHaveLength(LSP_SERVERS.length);
	});

	it("looks for executables on PATH", () => {
		const bin = temp();
		writeFileSync(join(bin, "gopls"), "#!/bin/sh\n");
		chmodSync(join(bin, "gopls"), 0o755);
		writeFileSync(join(bin, "clangd"), "");
		expect(onPath("gopls", bin)).toBe(true);
		expect(onPath("clangd", bin)).toBe(false);
		expect(onPath("ruff", bin)).toBe(false);
	});
});
