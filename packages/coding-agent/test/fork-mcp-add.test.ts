// MCP servers added and removed by answering questions, not by editing mcp.json.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME, ENV_AGENT_DIR } from "../src/config.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { askMcpServer, parseEnvironment, removeMcpServer, splitCommandLine } from "../src/fork/mcp-add.ts";

let root: string;
let project: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "prism-mcp-add-"));
	project = join(root, "project");
	mkdirSync(project);
	vi.stubEnv(ENV_AGENT_DIR, join(root, "agent"));
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

/** A context whose dialogs answer from `answers`, in order; what they asked and said is kept. */
function scripted(answers: Array<string | boolean | undefined>, trusted = true) {
	const asked: string[] = [];
	const notes: Array<[string, string | undefined]> = [];
	const next = (title: string) => {
		asked.push(title);
		return answers.shift();
	};
	const ctx = {
		cwd: project,
		isProjectTrusted: () => trusted,
		ui: {
			select: async (title: string, options: string[]) => {
				const answer = next(title);
				if (typeof answer === "string" && !options.includes(answer))
					throw new Error(`${answer} is not one of ${options.join(", ")}`);
				return answer;
			},
			input: async (title: string) => next(title),
			confirm: async (title: string) => next(title) === true,
			notify: (message: string, type?: string) => void notes.push([message, type]),
		},
	} as unknown as ExtensionContext;
	return { ctx, asked, notes };
}

const servers = (path: string) => JSON.parse(readFileSync(path, "utf8")).mcpServers as Record<string, unknown>;

describe("fork: MCP servers without editing mcp.json", () => {
	it("splits a command line and its environment as a shell would", () => {
		expect(splitCommandLine(`npx -y "@scope/server name" '.' a\\ b`)).toEqual([
			"npx",
			"-y",
			"@scope/server name",
			".",
			"a b",
		]);
		expect(splitCommandLine(`uvx "open`)).toBeUndefined();
		expect(splitCommandLine("   ")).toEqual([]);
		expect(parseEnvironment(`TOKEN=\${GITHUB_TOKEN} MODE="read only"`)).toEqual({
			// biome-ignore lint/suspicious/noTemplateCurlyInString: literal config value reference
			TOKEN: "${GITHUB_TOKEN}",
			MODE: "read only",
		});
		expect(parseEnvironment("TOKEN")).toBeUndefined();
	});

	it("adds a local server to every project, asking again for a wrong name", async () => {
		const { ctx, asked, notes } = scripted([
			"A program on this computer (a command)",
			"my server",
			"files",
			"npx -y @modelcontextprotocol/server-filesystem .",
			"ROOT=/tmp",
			"Every project",
		]);
		expect(await askMcpServer(ctx)).toBe(true);
		const path = join(root, "agent", "mcp.json");
		expect(servers(path)).toEqual({
			files: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."], env: { ROOT: "/tmp" } },
		});
		expect(asked.filter((title) => title.startsWith("Server name"))).toHaveLength(2);
		expect(notes[0]).toEqual(["Use only letters, digits, - and _ in the name.", "warning"]);
		expect(notes.at(-1)?.[0]).toBe(`MCP server "files" added to ${path}. Prism reloads to connect it.`);
	});

	it("adds a web server to this project with a key from an environment variable", async () => {
		const { ctx } = scripted([
			"A web address (URL)",
			"docs",
			"ftp://docs",
			"https://docs.example.com/mcp",
			"A key read from an environment variable",
			"DOCS_TOKEN",
			"This project only",
		]);
		expect(await askMcpServer(ctx)).toBe(true);
		expect(servers(join(project, CONFIG_DIR_NAME, "mcp.json"))).toEqual({
			// biome-ignore lint/suspicious/noTemplateCurlyInString: literal config value reference
			docs: { url: "https://docs.example.com/mcp", headers: { Authorization: "Bearer ${DOCS_TOKEN}" } },
		});
		expect(existsSync(join(root, "agent", "mcp.json"))).toBe(false);
	});

	it("does not offer the project in an untrusted folder, writes nothing when cancelled, and asks before replacing", async () => {
		const untrusted = scripted(
			["A web address (URL)", "docs", "https://a.example/mcp", "No key: sign in in the browser if the server asks"],
			false,
		);
		expect(await askMcpServer(untrusted.ctx)).toBe(true);
		expect(untrusted.asked).not.toContain("Use this server in");
		const path = join(root, "agent", "mcp.json");
		expect(servers(path)).toEqual({ docs: { url: "https://a.example/mcp" } });

		const cancelled = scripted(["A program on this computer (a command)", "other", undefined]);
		expect(await askMcpServer(cancelled.ctx)).toBe(false);
		expect(Object.keys(servers(path))).toEqual(["docs"]);

		const refused = scripted([
			"A web address (URL)",
			"docs",
			"https://b.example/mcp",
			"No key: sign in in the browser if the server asks",
			"Every project",
			false,
		]);
		expect(await askMcpServer(refused.ctx)).toBe(false);
		expect(refused.asked.at(-1)).toBe("Replace this server?");
		expect(servers(path)).toEqual({ docs: { url: "https://a.example/mcp" } });
	});

	it("removes a server from its mcp.json after a confirmation", async () => {
		const add = scripted([
			"A web address (URL)",
			"docs",
			"https://a.example/mcp",
			"No key: sign in in the browser if the server asks",
			"Every project",
		]);
		await askMcpServer(add.ctx);
		const path = join(root, "agent", "mcp.json");
		expect(await removeMcpServer(scripted([false]).ctx, "docs", path)).toBe(false);
		expect(Object.keys(servers(path))).toEqual(["docs"]);
		const done = scripted([true]);
		expect(await removeMcpServer(done.ctx, "docs", path)).toBe(true);
		expect(servers(path)).toEqual({});
		expect(done.notes.at(-1)).toEqual(['MCP server "docs" removed.', "info"]);
	});
});
