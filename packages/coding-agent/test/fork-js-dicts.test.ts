// fork: names that come from outside (tools, servers, form fields,
// variables, translated words) are read and written as data, never as the members every object inherits.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { getMcpToolExposure, type McpServerConfig } from "../src/core/mcp-servers.ts";
import { addMcpServerConfig } from "../src/extensions/mcp/config.ts";
import { commandAliases } from "../src/fork/command-aliases.ts";
import { answerMessage, type UiDocument } from "../src/fork/generated-ui.ts";
import { setLanguage, t } from "../src/fork/i18n/index.ts";
import { mcpToolChanges } from "../src/fork/mcp-trust.ts";
import { projectGrantsProblem, projectRoot, readProjectGrants } from "../src/fork/project-permissions.ts";
import { commandEnv, parseSecretSettings } from "../src/fork/secrets/env.ts";
import { cloneSharingStrings } from "../src/fork/share-strings-clone.ts";

const INHERITED = ["constructor", "toString", "hasOwnProperty", "valueOf", "__proto__"];

describe("fork: names from outside used as dictionary keys", () => {
	let root: string;
	let agentDir: string;
	let project: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "prism-js-dicts-"));
		agentDir = join(root, "agent");
		project = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(project);
		vi.stubEnv("HOME", root);
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
	});

	afterEach(() => {
		setLanguage("en");
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	it("058: an MCP tool named like an Object member gets the server's exposure", () => {
		const server = { command: "x" } as McpServerConfig;
		for (const name of INHERITED) {
			expect(getMcpToolExposure(server, name), name).toBe("codemode");
			expect(getMcpToolExposure({ ...server, toolExposure: { "*": "direct" } }, name), name).toBe("direct");
		}
	});

	it("066: the context copy keeps a __proto__ key as data", () => {
		const value = JSON.parse('{"args":{"__proto__":{"polluted":1},"b":2}}');
		const copy = cloneSharingStrings(value);
		expect(JSON.stringify(copy)).toBe(JSON.stringify(value));
		expect(Object.getPrototypeOf(copy.args)).toBe(Object.prototype);
	});

	it("067: an MCP server named like an Object member is written and is not a replacement", () => {
		const file = join(root, "mcp.json");
		for (const name of INHERITED.filter((name) => name !== "hasOwnProperty")) {
			expect(addMcpServerConfig(file, name, { command: "x" } as McpServerConfig), name).toBe(false);
		}
		const written = JSON.parse(readFileSync(file, "utf8")).mcpServers;
		expect(Object.keys(written).sort()).toEqual(["__proto__", "constructor", "toString", "valueOf"]);
		expect(addMcpServerConfig(file, "__proto__", { command: "y" } as McpServerConfig)).toBe(true);
	});

	it("095: a command named like an Object member has no aliases", () => {
		for (const name of INHERITED) expect(commandAliases(name), name).toBeUndefined();
		expect(commandAliases("quit")).toContain("exit");
	});

	it("289: French leaves Object member names as they are, alone or in a pattern", () => {
		setLanguage("fr");
		for (const name of INHERITED) {
			expect(t(name), name).toBe(name);
			expect(t(`Answer to “${name}”:`), name).toBe(`Réponse à « ${name} » :`);
		}
	});

	it("327: a form field named like an Object member keeps its answer", () => {
		const document: UiDocument = {
			version: 1,
			blocks: [
				{
					type: "form",
					fields: [
						{ name: "__proto__", label: "Nom", kind: "text", required: true },
						{ name: "constructor", label: "Actif", kind: "toggle", required: false },
						{ name: "toString", label: "Note", kind: "text", required: false },
					],
				},
			],
		} as UiDocument;
		const answer = answerMessage(document, { values: JSON.parse('{"__proto__":"Ada","constructor":true}') });
		expect(answer).toMatchObject({ message: expect.stringContaining("Ada") });
		expect(answer).toMatchObject({ message: expect.stringContaining("yes") });
		expect(JSON.stringify(answer)).not.toContain("native code");
	});

	it("408: a secret variable named like an Object member is removed, or passed by its own rule", () => {
		const stored = new Map([["stored-key-value", "a stored key"]]);
		for (const name of INHERITED) {
			const env = { [name]: "stored-key-value", PATH: "/bin" };
			Object.defineProperty(env, name, { value: "stored-key-value", enumerable: true });
			const removed = commandEnv(env, "bash", "ls", parseSecretSettings({}), stored);
			expect(removed.removed, name).toEqual([name]);
			const rules = parseSecretSettings(JSON.parse(`{"passEnv":{${JSON.stringify(name)}:["bash"]}}`));
			expect(commandEnv(env, "bash", "ls", rules, stored).passed, name).toEqual([name]);
		}
	});

	it("415: a project rule that does not parse keeps the last valid rules, or refuses without one", () => {
		const file = join(agentDir, "project-permissions.json");
		const write = (deny: unknown[]) =>
			writeFileSync(file, JSON.stringify({ projects: { [projectRoot(project)]: { deny } } }));
		write(["bash(npm run*)"]);
		expect(readProjectGrants(project, agentDir).deny).toEqual(["bash(npm run*)"]);
		write(["bash(npm run*"]);
		expect(readProjectGrants(project, agentDir).deny).toEqual(["bash(npm run*)"]);
		const fresh = join(root, "fresh-agent");
		mkdirSync(fresh);
		writeFileSync(
			join(fresh, "project-permissions.json"),
			JSON.stringify({ projects: { [projectRoot(project)]: { deny: ["bash(npm run*"] } } }),
		);
		expect(projectGrantsProblem(fresh)).toContain("not a valid project permissions file");
	});

	it("430: an MCP fingerprint that is not one keeps the registry and records nothing over it", async () => {
		const file = join(agentDir, "mcp-tools.json");
		for (const entry of [null, false, 0, "", { description: 1 }]) {
			const text = JSON.stringify({ version: 1, tools: { mcp__docs__lookup: entry } });
			writeFileSync(file, text);
			await expect(
				mcpToolChanges([{ name: "mcp__docs__lookup", description: "B", parameters: {} }]),
				JSON.stringify(entry),
			).rejects.toThrow();
			expect(readFileSync(file, "utf8")).toBe(text);
		}
	});

	it("430: MCP tools named like Object members are recorded as new tools", async () => {
		rmSync(join(agentDir, "mcp-tools.json"), { force: true });
		const tools = INHERITED.map((name) => ({ name, description: "A", parameters: {} }));
		expect((await mcpToolChanges(tools)).size).toBe(0);
		const recorded = JSON.parse(readFileSync(join(agentDir, "mcp-tools.json"), "utf8")).tools;
		expect(Object.keys(recorded).sort()).toEqual([...INHERITED].sort());
		const changed = await mcpToolChanges(tools.map((tool) => ({ ...tool, description: "B" })));
		expect([...changed.keys()].sort()).toEqual([...INHERITED].sort());
	});
});
