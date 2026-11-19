/**
 * fork: the verdicts every path gets from each tool that
 * reaches it, in one table, then the cases a table cannot show (a search, a moved Cargo folder).
 *
 * The table was first printed from the code before this lot; the rows this lot changed carry the finding's number.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME, ENV_AGENT_DIR } from "../src/config.ts";
import permissionsExtension, { decidePermission } from "../src/fork/permissions.ts";
import { realPath } from "../src/fork/real-path.ts";
import { buildLayout, DEFAULT_SANDBOX_SETTINGS, type SandboxSettings } from "../src/fork/sandbox/layout.ts";
import { isReadable, readableSet } from "../src/fork/sandbox/read-limit.ts";
import { rebuiltSettingsCopies } from "../src/fork/sandbox/tool-settings.ts";
import { createHarness, createTestUiContext, getToolResult, type Harness } from "./suite/harness.ts";

/**
 * Columns: read, write, write unrestricted, grep, MCP read, MCP write, MCP write unrestricted, all in broad mode
 * unless said. `!` marks the dangerous tier. `<p>` is the project, `<a>` the agent folder, `~` the home folder.
 */
const TABLE: [string, string][] = [
	["<p>/.env", "prompt! prompt! allow prompt! prompt! prompt! allow"], // MCP was allow
	["<p>/.env.local", "prompt! prompt! allow prompt! prompt! prompt! allow"],
	["<p>/src/.env", "prompt! prompt! allow prompt! prompt! prompt! allow"],
	["<p>/src/a.ts", "allow allow allow allow allow allow allow"],
	["<p>/id_rsa", "prompt! prompt! allow prompt! prompt! prompt! allow"],
	["<p>/key.pem", "prompt! prompt! allow prompt! prompt! prompt! allow"],
	["<p>/.git/config", "prompt! prompt! allow prompt! prompt! prompt! allow"],
	["<p>/.git/hooks/pre-commit", "prompt! prompt! allow prompt! prompt! prompt! allow"],
	["<p>/.pi/permissions.json", "prompt! block! block! prompt! prompt! block! block!"], // MCP write was allow
	["<p>/.pi/settings.json", "prompt! block! block! prompt! prompt! block! block!"],
	["<p>/.pi/mcp.json", "allow block! block! allow allow block! block!"],
	["<p>/.pi/lsp.json", "allow block! block! allow allow block! block!"],
	["<p>/.pi/pi-lsp.json", "allow block! block! allow allow block! block!"], // was allow everywhere
	["<p>/.pi/pi-goal.json", "allow block! block! allow allow block! block!"],
	["<p>/.pi/agents/x.md", "allow block! block! allow allow block! block!"],
	["<p>/.pi/scheduled/t.json", "allow block! block! allow allow block! block!"],
	["<p>/.agents/skills/s/SKILL.md", "allow block! block! allow allow block! block!"],
	["<p>/trust.json", "prompt! prompt! allow prompt! prompt! prompt! allow"],
	["<a>/auth.json", "prompt! block! block! prompt! prompt! block! block!"],
	["<a>/permissions.json", "prompt! block! block! prompt! prompt! block! block!"],
	["<a>/checkpoint.key", "prompt! block! block! prompt! prompt! block! block!"],
	["<a>/mcp-tools.json", "prompt block! block! prompt! prompt block! block!"], // write was prompt!/allow
	["<a>/pi-lsp.json", "prompt block! block! prompt! prompt block! block!"],
	["<a>/pi-goal.json", "prompt block! block! prompt! prompt block! block!"],
	["<a>/remote/peers.json", "prompt block! block! prompt! prompt block! block!"],
	["<a>/sessions/x.jsonl", "prompt prompt! allow prompt! prompt prompt allow"],
	["~/.ssh/id_ed25519", "prompt! prompt! allow prompt! prompt! prompt! allow"],
	["~/.netrc", "prompt! prompt! allow prompt! prompt! prompt! allow"],
	["~/.config/gh/hosts.yml", "prompt! prompt! allow prompt! prompt! prompt! allow"],
	["~/Documents/notes.txt", "prompt prompt! allow prompt prompt prompt allow"],
	["~/.gitconfig", "allow prompt! allow allow allow allow allow"],
];

let root: string;
let home: string;
let agent: string;
let project: string;
const saved = { agent: process.env[ENV_AGENT_DIR] };

beforeEach(() => {
	root = realPath(mkdtempSync(join(tmpdir(), "prism-reserved-")));
	home = join(root, "home");
	agent = join(home, ".pi", "agent");
	project = join(home, "project");
	mkdirSync(agent, { recursive: true });
	mkdirSync(join(project, ".git"), { recursive: true });
	vi.stubEnv("HOME", home);
	process.env[ENV_AGENT_DIR] = agent;
});

afterEach(() => {
	vi.unstubAllEnvs();
	if (saved.agent === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = saved.agent;
	rmSync(root, { recursive: true, force: true });
});

const put = (path: string, content = "x") => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
};

describe("fork: reserved files, per tool", () => {
	it("gives each path the same verdict whatever tool names it", () => {
		const where = (row: string) =>
			row.replace("<p>", project).replace("<a>", agent).replace(/^~/, home).replace("/.pi/", `/${CONFIG_DIR_NAME}/`);
		for (const [row] of TABLE) put(where(row), row.endsWith(".json") ? "{}" : "x");
		const read = { namespace: { name: "mcp__fs" }, annotations: { readOnlyHint: true, openWorldHint: false } };
		const write = { namespace: { name: "mcp__fs" }, annotations: { readOnlyHint: false, openWorldHint: false } };
		const cell = ({ effect, tier }: { effect: string; tier?: string }) => `${effect}${tier === "danger" ? "!" : ""}`;
		for (const [row, expected] of TABLE) {
			const path = where(row);
			const decide = (tool: string, mode: "broad" | "unrestricted", declaration?: typeof read) =>
				cell(decidePermission(tool, { path, content: "y" }, project, { mode }, { declaration }));
			const verdicts = [
				decide("read", "broad"),
				decide("write", "broad"),
				decide("write", "unrestricted"),
				decide("grep", "broad"),
				decide("mcp__fs__read_file", "broad", read),
				decide("mcp__fs__write_file", "broad", write),
				decide("mcp__fs__write_file", "unrestricted", write),
			];
			expect([row, verdicts.join(" ")]).toEqual([row, expected]);
		}
	});
});

describe("fork: a search shows no line of a protected file", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function grep(mode: string, input: { pattern: string; path: string }) {
		writeFileSync(join(agent, "permissions.json"), JSON.stringify({ mode, unrestrictedAccepted: true }));
		const harness = await createHarness({
			extensionFactories: [{ name: "permissions", factory: permissionsExtension }],
			initialActiveToolNames: ["grep"],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });
		put(join(harness.tempDir, ".env"), "TOKEN=hunter2-secret\n");
		put(join(harness.tempDir, "keys", "deploy.pem"), "TOKEN in a key\n");
		put(join(harness.tempDir, "src", "a.ts"), "const TOKEN = process.env.TOKEN;\n");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("grep", input), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("search");
		return getToolResult(harness, "grep")
			.content.map((part) => (part.type === "text" ? part.text : ""))
			.join("");
	}

	it("leaves out the matches of files read would ask for, and says how many", async () => {
		const text = await grep("broad", { pattern: "TOKEN", path: "." });
		expect(text).toContain("src/a.ts");
		expect(text).not.toContain("hunter2");
		expect(text).not.toContain("deploy.pem");
		expect(text).toContain("2 protected files");
	});

	it("says so when only protected files matched", async () => {
		const text = await grep("broad", { pattern: "hunter2", path: "." });
		expect(text).toContain("No matches found");
		expect(text).toContain("1 protected file ");
	});

	it("shows them in unrestricted mode, where read does not ask either", async () => {
		expect(await grep("unrestricted", { pattern: "hunter2", path: "." })).toContain("hunter2");
	});
});

describe("fork: a moved CARGO_HOME keeps its credentials hidden", () => {
	const limited: SandboxSettings = {
		...DEFAULT_SANDBOX_SETTINGS,
		read: { limit: "project", allow: [], toolsOff: [] },
	};

	it("hides its credentials and rebuilds its config.toml, as for ~/.cargo", () => {
		const cargo = join(home, "toolchains", "cargo");
		put(join(cargo, "credentials.toml"), '[registry]\ntoken = "cio-secret"\n');
		put(join(cargo, "config.toml"), '[build]\njobs = 2\n[registry]\ntoken = "cio-secret"\n');
		put(join(cargo, "bin", "cargo"));
		const env = { PATH: "/usr/bin", CARGO_HOME: cargo };
		const set = readableSet({ cwd: project, home, env, git: () => undefined });
		expect(isReadable(set, join(cargo, "bin", "cargo"))).toBe(true);
		expect(isReadable(set, join(cargo, "credentials.toml"))).toBe(false);
		expect(isReadable(set, join(cargo, "config.toml"))).toBe(false);
		const layout = buildLayout({ cwd: project, home, agentDir: agent, settings: limited, env });
		expect(layout.home?.settings).toContain(join(cargo, "config.toml"));
		const [[copy, original]] = rebuiltSettingsCopies(join(root, "copies"), [join(cargo, "config.toml")]);
		expect(original).toBe(join(cargo, "config.toml"));
		expect(readFileSync(copy!, "utf8")).toContain("jobs = 2");
		expect(readFileSync(copy!, "utf8")).not.toContain("cio-secret");
	});

	it("makes read ask for them, as for the files of ~/.cargo", () => {
		const cargo = join(home, "toolchains", "cargo");
		put(join(cargo, "credentials.toml"), "x");
		put(join(cargo, "bin", "cargo"));
		vi.stubEnv("CARGO_HOME", cargo);
		const decide = (path: string) => decidePermission("read", { path }, project, { mode: "broad" }).effect;
		expect(decide(join(cargo, "bin", "cargo"))).toBe("allow");
		expect(decide(join(cargo, "credentials.toml"))).toBe("prompt");
	});
});
