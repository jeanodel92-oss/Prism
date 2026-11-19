// fork.12 security audit, AS-014: a file the user let the agent write a key into
// « without the agent seeing it » is hidden from the agent until the end of the session: refused to the file tools
// that read it, and hidden from its sandboxed commands. Before, `sed 's/./& /g' config.env` (a known-safe command, no
// question) printed the key with a space after each character, which the masking of exact values does not find.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import permissionsExtension from "../src/fork/permissions.ts";
import { findBwrap, removeSessionTmpDir } from "../src/fork/sandbox/runtime.ts";
import secretsExtension from "../src/fork/secrets/extension.ts";
import { addKeyFile, forgetKeyFiles, keyFileAt, keyFiles } from "../src/fork/secrets/key-files.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

const KEY = "prismcanary0123456789abcdefKEY";
const LABEL = "[secret hidden: AUDIT_API_KEY]";

describe("fork.12 AS-014: a file that received a key is hidden from the agent", () => {
	it("keeps the files by session, and finds one from its path or a folder that holds it", () => {
		const session = {};
		const other = {};
		const dir = mkdtempSync(join(tmpdir(), "prism-key-files-"));
		try {
			addKeyFile(session, join(dir, "config.env"), ["AUDIT_API_KEY"]);
			expect(keyFiles(session)).toHaveLength(1);
			expect(keyFiles(other)).toEqual([]);
			expect(keyFileAt(session, join(dir, "config.env"))?.names).toEqual(new Set(["AUDIT_API_KEY"]));
			expect(keyFileAt(session, dir)?.file).toBe(keyFiles(session)[0]);
			expect(keyFileAt(session, join(dir, "other.env"))).toBeUndefined();
			forgetKeyFiles(session);
			expect(keyFileAt(session, join(dir, "config.env"))).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	describe("in a session", () => {
		let agentDir: string;
		const savedAgentDir = process.env[ENV_AGENT_DIR];
		const harnesses: Harness[] = [];
		let asked: string[];

		beforeEach(() => {
			agentDir = mkdtempSync(join(tmpdir(), "prism-key-file-agent-"));
			process.env[ENV_AGENT_DIR] = agentDir;
			// A secret Prism knows: a variable whose name makes it one. The model's commands do not get it.
			process.env.AUDIT_API_KEY = KEY;
			asked = [];
		});
		afterEach(() => {
			for (const harness of harnesses.splice(0)) {
				removeSessionTmpDir(harness.sessionManager.getSessionId());
				harness.cleanup();
			}
			delete process.env.AUDIT_API_KEY;
			if (savedAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
			else process.env[ENV_AGENT_DIR] = savedAgentDir;
			rmSync(agentDir, { recursive: true, force: true });
		});

		async function start(sandbox: boolean, sessionManager?: Harness["sessionManager"]): Promise<Harness> {
			writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode: "broad" }));
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sandbox: { modes: { broad: sandbox } } }));
			const harness = await createHarness({
				initialActiveToolNames: ["read", "bash", "edit", "write", "grep"],
				...(sessionManager ? { sessionManager } : {}),
				extensionFactories: [
					{ name: "permissions", factory: permissionsExtension },
					{ name: "secrets", factory: secretsExtension },
				],
			});
			harnesses.push(harness);
			await harness.session.bindExtensions({
				uiContext: createTestUiContext({
					select: async (title: string, options: string[]) => {
						asked.push(title);
						return options.find((option) => option === "Yes, this time");
					},
				}),
			});
			return harness;
		}

		async function call(harness: Harness, tool: string, input: Parameters<typeof fauxToolCall>[1]) {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall(tool, input), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			const before = harness.session.messages.length;
			await harness.session.prompt("go");
			// This call's result, never an earlier one.
			const result = harness.session.messages
				.slice(before)
				.find((message): message is ToolResultMessage => message.role === "toolResult");
			if (!result) throw new Error(`no result for ${tool}`);
			return {
				text: result.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
				isError: result.isError,
			};
		}

		it.skipIf(!findBwrap())(
			"hides the file from the tools that read it and from sandboxed commands",
			async () => {
				const harness = await start(true);
				const file = join(harness.tempDir, "config.env");
				await call(harness, "write", { path: "config.env", content: `API_KEY=${LABEL}\nMODE=1\n` });
				expect(readFileSync(file, "utf8")).toBe(`API_KEY=${KEY}\nMODE=1\n`);
				// The question says what happens to the file afterwards.
				expect(asked).toHaveLength(1);
				expect(asked[0]).toContain("config.env is then hidden from the agent until the end of the session");

				// A known-safe command that spaces the characters out: the file is unreadable to it.
				const spaced = await call(harness, "bash", { command: "sed 's/./& /g' config.env; cat config.env" });
				expect(spaced.text.replace(/\s/g, "")).not.toContain(KEY);
				expect(spaced.text).toMatch(/Permission denied/);
				// Nor can a command copy it elsewhere first.
				const moved = await call(harness, "bash", { command: "cp config.env copy.txt; mv config.env moved.env" });
				expect(moved.text).toMatch(/cp: .*Permission denied/);
				expect(moved.text).toMatch(/mv: .*Device or resource busy/);
				expect(readFileSync(file, "utf8")).toContain(KEY);
				expect((await call(harness, "bash", { command: "cat copy.txt moved.env" })).text).not.toContain(KEY);

				// The file tools that read its content are refused.
				const read = await call(harness, "read", { path: "config.env" });
				expect(read.isError).toBe(true);
				expect(read.text).toContain("hidden from you");
				const grep = await call(harness, "grep", { pattern: "API_KEY=p", path: "." });
				expect(grep.isError).toBe(true);
				expect(grep.text).toContain("Search a folder that does not hold it");
				// An edit that does not name the key could test guesses of it against the file.
				const guess = await call(harness, "edit", {
					path: "config.env",
					edits: [{ oldText: "API_KEY=p", newText: "API_KEY=q" }],
				});
				expect(guess.isError).toBe(true);
				expect(guess.text).toContain(LABEL);
				expect(readFileSync(file, "utf8")).toBe(`API_KEY=${KEY}\nMODE=1\n`);
				// An edit that names it by its label reads the file with the label in its place, and goes through.
				const edit = await call(harness, "edit", {
					path: "config.env",
					edits: [{ oldText: `API_KEY=${LABEL}\nMODE=1`, newText: `API_KEY=${LABEL}\nMODE=2` }],
				});
				expect(edit.isError).toBe(false);
				expect(readFileSync(file, "utf8")).toBe(`API_KEY=${KEY}\nMODE=2\n`);
			},
			120_000,
		);

		it("without a sandbox, still refuses the file tools and says the commands can read it", async () => {
			const harness = await start(false);
			await call(harness, "write", { path: "config.env", content: `API_KEY=${LABEL}\n` });
			expect(asked[0]).toContain("its commands, which run without the sandbox, can read it");
			const read = await call(harness, "read", { path: "config.env" });
			expect(read.isError).toBe(true);
			expect(read.text).not.toContain(KEY);
			// Another file stays readable.
			writeFileSync(join(harness.tempDir, "notes.txt"), "plain\n");
			expect((await call(harness, "read", { path: "notes.txt" })).text).toContain("plain");
		});

		it("hides it again when the session starts anew from its history (resume)", async () => {
			const first = await start(false);
			const file = join(first.tempDir, "config.env");
			await call(first, "write", { path: file, content: `API_KEY=${LABEL}\n` });
			// A refused write leaves nothing to hide.
			const other = join(first.tempDir, "other.env");
			writeFileSync(other, "plain\n");
			asked = [];
			const refused = await start(false, first.sessionManager);
			await refused.session.bindExtensions({ uiContext: createTestUiContext({ select: async () => "No" }) });
			expect((await call(refused, "write", { path: other, content: `API_KEY=${LABEL}\n` })).isError).toBe(true);
			// What this process kept is gone; the next start rebuilds it from the session's entries.
			forgetKeyFiles(first.sessionManager);
			const resumed = await start(false, first.sessionManager);
			expect(keyFiles(resumed.sessionManager)).toHaveLength(1);
			expect((await call(resumed, "read", { path: file })).isError).toBe(true);
			expect((await call(resumed, "read", { path: other })).text).toContain("plain");
		});
	});
});
