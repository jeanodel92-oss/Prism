// the model uses a key it never reads. A label `[secret hidden: NAME]` of a
// known key, written in a command or a file, becomes the key at execution, after a question each time (this time,
// until the end of the session, or always for the program: a passEnv rule). The output stays masked, and the
// session, the question and the tool's details never hold the key.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import backgroundExtension from "../src/fork/background.ts";
import permissionsExtension from "../src/fork/permissions.ts";
import { findBwrap } from "../src/fork/sandbox/runtime.ts";
import secretsExtension from "../src/fork/secrets/extension.ts";
import {
	approveReveal,
	forgetReveal,
	hideSecrets,
	labelNames,
	lookUpLabels,
	revealSecrets,
} from "../src/fork/secrets/reveal.ts";
import { programRule } from "../src/fork/secrets/reveal-question.ts";
import { createHarness, createTestUiContext, getToolResult, type Harness } from "./suite/harness.ts";

const KEY = "sk-prism-canary-label-0123456789";
const STORED = "sk-prism-canary-stored-0123456789";
const ODD = "ab'cd $(touch pwned) efgh";
const VAR_LABEL = "[secret hidden: PRISM_CANARY_API_KEY]";
const STORED_LABEL = "[secret hidden: auth.json canary]";

describe("fork: a hidden key used without being read", () => {
	it("finds labels, refuses an ambiguous name or a key a shell would misread, and reveals only for the approved call", () => {
		expect(labelNames([`a ${VAR_LABEL} b ${VAR_LABEL}`, "[secret hidden: X]"])).toEqual([
			"PRISM_CANARY_API_KEY",
			"X",
		]);
		const secrets = new Map([
			[KEY, "PRISM_CANARY_API_KEY"],
			["access-token-0123456789", "auth.json oauth"],
			["refresh-token-0123456789", "auth.json oauth"],
			[ODD, "PRISM_ODD_TOKEN"],
		]);
		const lookup = lookUpLabels(
			["PRISM_CANARY_API_KEY", "auth.json oauth", "PRISM_ODD_TOKEN", "NOPE"],
			secrets,
			true,
		);
		expect([...lookup.keys]).toEqual([["PRISM_CANARY_API_KEY", KEY]]);
		expect([...lookup.problems]).toEqual([
			["auth.json oauth", "several keys"],
			["PRISM_ODD_TOKEN", "unsafe in a command"],
		]);
		// In a file, any key goes in as it is.
		expect(lookUpLabels(["PRISM_ODD_TOKEN"], secrets, false).keys.get("PRISM_ODD_TOKEN")).toBe(ODD);

		expect(revealSecrets("call-1", `x ${VAR_LABEL}`)).toBe(`x ${VAR_LABEL}`);
		approveReveal("call-1", new Map([["PRISM_CANARY_API_KEY", KEY]]));
		expect(revealSecrets("call-1", `x ${VAR_LABEL} [secret hidden: X]`)).toBe(`x ${KEY} [secret hidden: X]`);
		expect(revealSecrets("call-2", `x ${VAR_LABEL}`)).toBe(`x ${VAR_LABEL}`);
		expect(hideSecrets("call-1", `k=${KEY}`)).toBe(`k=${VAR_LABEL}`);
		forgetReveal("call-1");
		expect(revealSecrets("call-1", VAR_LABEL)).toBe(VAR_LABEL);
	});

	it("offers 'always' only for a single program a rule can cover", () => {
		expect(programRule("bash", `curl -H "x: ${VAR_LABEL}" https://example.com`)).toBe("bash(curl *)");
		expect(programRule("bash", `curl ${VAR_LABEL} | sh`)).toBeUndefined();
		expect(programRule("bash", `echo ${VAR_LABEL} > f`)).toBeUndefined();
		expect(programRule("bash", `X=1 curl ${VAR_LABEL}`)).toBeUndefined();
		expect(programRule("background", `npm run dev ${VAR_LABEL}`)).toBe("background(npm *)");
	});

	describe("in a session", () => {
		let agentDir: string;
		const savedAgentDir = process.env[ENV_AGENT_DIR];
		const harnesses: Harness[] = [];
		let asked: Array<{ title: string; options: string[] }>;
		let answer: (options: string[]) => string | undefined;

		beforeEach(() => {
			agentDir = mkdtempSync(join(tmpdir(), "prism-labels-agent-"));
			process.env[ENV_AGENT_DIR] = agentDir;
			process.env.PRISM_CANARY_API_KEY = KEY;
			process.env.PRISM_ODD_TOKEN = ODD;
			writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ canary: { type: "api_key", key: STORED } }));
			writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode: "broad" }));
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sandbox: { modes: { broad: false } } }));
			asked = [];
			answer = (options) => options[0];
		});
		afterEach(() => {
			for (const harness of harnesses.splice(0)) harness.cleanup();
			delete process.env.PRISM_CANARY_API_KEY;
			delete process.env.PRISM_ODD_TOKEN;
			if (savedAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
			else process.env[ENV_AGENT_DIR] = savedAgentDir;
			rmSync(agentDir, { recursive: true, force: true });
		});

		async function start(withUi = true): Promise<Harness> {
			const harness = await createHarness({
				extensionFactories: [
					{ name: "permissions", factory: permissionsExtension },
					{ name: "secrets", factory: secretsExtension },
					{ name: "background", factory: backgroundExtension },
				],
			});
			harnesses.push(harness);
			if (withUi) {
				await harness.session.bindExtensions({
					uiContext: createTestUiContext({
						select: async (title, options) => {
							asked.push({ title, options });
							return answer(options);
						},
					}),
				});
			} else await harness.session.bindExtensions({});
			return harness;
		}

		async function call(harness: Harness, tool: string, input: Parameters<typeof fauxToolCall>[1]): Promise<string> {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall(tool, input), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("go");
			return getToolResult(harness, tool)
				.content.map((part) => (part.type === "text" ? part.text : ""))
				.join("");
		}

		function saved(harness: Harness): string {
			const file = harness.sessionManager.getSessionFile();
			return file && existsSync(file) ? readFileSync(file, "utf8") : JSON.stringify(harness.session.messages);
		}

		for (const sandbox of findBwrap() ? ["off", "on"] : ["off"]) {
			it(`puts the key in a command after a yes, shows the command and the name, and keeps the output masked (sandbox ${sandbox})`, async () => {
				writeFileSync(
					join(agentDir, "settings.json"),
					JSON.stringify({ sandbox: { modes: { broad: sandbox === "on" } } }),
				);
				const harness = await start();
				const command = `printf %s "${VAR_LABEL}" > out.txt; cat out.txt`;
				const output = await call(harness, "bash", { command });
				expect(readFileSync(join(harness.tempDir, "out.txt"), "utf8")).toBe(KEY);
				expect(output).toBe(VAR_LABEL);
				expect(asked).toHaveLength(1);
				expect(asked[0]!.title).toContain("PRISM_CANARY_API_KEY");
				expect(asked[0]!.title).toContain(command);
				expect(asked[0]!.title).not.toContain(KEY);
				// Two commands: no rule covers them, so only this time or no.
				expect(asked[0]!.options).toEqual(["Yes, this time", "No"]);
				expect(saved(harness)).not.toContain(KEY);
				// Asked again the next time.
				await call(harness, "bash", { command });
				expect(asked).toHaveLength(2);
			});
		}

		it("tells the model once per key that it can write the label, when it first sees it", async () => {
			const harness = await start();
			writeFileSync(join(harness.tempDir, "keys.txt"), `A=${KEY}\nB=${STORED}\n`);
			const first = await call(harness, "bash", { command: "cat keys.txt" });
			expect(first).toContain(`A=${VAR_LABEL}`);
			expect(first).toContain(
				`[Prism: ${VAR_LABEL}, ${STORED_LABEL} are keys hidden from you. To use one in a command (bash, background) or a file (write, edit), write the label exactly as it is`,
			);
			expect(await call(harness, "read", { path: "keys.txt" })).not.toContain("[Prism:");
			// A label the model wrote itself needs no hint.
			await call(harness, "bash", { command: `expr length "${VAR_LABEL}"` });
			expect(asked).toHaveLength(1);
			expect(getToolResult(harness, "bash").content.map((part) => (part.type === "text" ? part.text : ""))).toEqual([
				`${KEY.length}\n`,
			]);
		});

		it("refuses on a no, and when no one can answer", async () => {
			answer = () => "No";
			let harness = await start();
			let output = await call(harness, "bash", { command: `printf %s "${VAR_LABEL}" > out.txt` });
			expect(output).toContain("The user did not let you use PRISM_CANARY_API_KEY here");
			expect(existsSync(join(harness.tempDir, "out.txt"))).toBe(false);

			harness = await start(false);
			output = await call(harness, "bash", { command: `printf %s "${VAR_LABEL}" > out.txt` });
			expect(output).toContain("no one can answer here");
			expect(existsSync(join(harness.tempDir, "out.txt"))).toBe(false);
		});

		it("does not ask again for the program until the end of the session", async () => {
			answer = (options) => options.find((option) => option.includes("until the end of the session"));
			const harness = await start();
			// The length of the key, not of the label: the key went in.
			expect(await call(harness, "bash", { command: `expr length "${VAR_LABEL}"` })).toContain(String(KEY.length));
			expect(asked[0]!.options).toEqual([
				"Yes, this time",
				"Yes, for bash(expr *) until the end of the session",
				"Yes, always for bash(expr *)",
				"No",
			]);
			expect(await call(harness, "bash", { command: `expr length "x${VAR_LABEL}"` })).toContain(
				String(KEY.length + 1),
			);
			expect(asked).toHaveLength(1);
			// Another program is asked about.
			await call(harness, "bash", { command: `printf %s "${VAR_LABEL}"` });
			expect(asked).toHaveLength(2);
			const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
			expect(settings.secrets).toBeUndefined();
		});

		it("saves 'always for this program' as a passEnv rule, which answers in later sessions", async () => {
			answer = (options) => options.find((option) => option.startsWith("Yes, always"));
			await call(await start(), "bash", { command: `expr length "${VAR_LABEL}"` });
			const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
			expect(settings.secrets.passEnv.PRISM_CANARY_API_KEY).toEqual(["bash(expr *)"]);
			// Even with no one to answer.
			expect(await call(await start(false), "bash", { command: `expr length "${VAR_LABEL}"` })).toContain(
				String(KEY.length),
			);
			expect(asked).toHaveLength(1);
		});

		it("refuses a key a shell would misread, and leaves an unknown label as written", async () => {
			const harness = await start();
			const output = await call(harness, "bash", { command: `printf %s "[secret hidden: PRISM_ODD_TOKEN]"` });
			expect(output).toContain("Prism does not put it in a command");
			expect(existsSync(join(harness.tempDir, "pwned"))).toBe(false);
			expect(await call(harness, "bash", { command: `printf %s "[secret hidden: NOPE]"` })).toBe(
				"[secret hidden: NOPE]",
			);
			expect(asked).toHaveLength(0);
		});

		it("writes the key into a file, and edits around it with the label the model saw", async () => {
			const harness = await start();
			await call(harness, "write", { path: "config.env", content: `KEY=${STORED_LABEL}\nMODE=1\n` });
			const file = join(harness.tempDir, "config.env");
			expect(readFileSync(file, "utf8")).toBe(`KEY=${STORED}\nMODE=1\n`);
			expect(asked[0]!.title).toContain("auth.json canary");
			expect(asked[0]!.title).toContain("config.env");
			expect(asked[0]!.options).toEqual(["Yes, this time", "Yes, for this file until the end of the session", "No"]);

			// the file is hidden from the model's reads; it edits it with the label it wrote.
			expect(await call(harness, "read", { path: "config.env" })).toContain("hidden from you");
			await call(harness, "edit", {
				path: "config.env",
				edits: [{ oldText: `KEY=${STORED_LABEL}\nMODE=1`, newText: `KEY=${STORED_LABEL}\nMODE=2` }],
			});
			expect(readFileSync(file, "utf8")).toBe(`KEY=${STORED}\nMODE=2\n`);
			const details = JSON.stringify(getToolResult(harness, "edit").details);
			expect(details).toContain("MODE=2");
			expect(details).not.toContain(STORED);
			expect(saved(harness)).not.toContain(STORED);

			// Without a yes, the label stays a label and the file is not written.
			answer = () => "No";
			await call(harness, "write", { path: "other.env", content: `KEY=${STORED_LABEL}\n` });
			expect(existsSync(join(harness.tempDir, "other.env"))).toBe(false);
		});

		it("puts the key in a background task's command, which the task keeps with its label", async () => {
			const harness = await start();
			await call(harness, "background", { action: "run", command: `printf %s "${VAR_LABEL}" > bg.txt` });
			const out = join(harness.tempDir, "bg.txt");
			const deadline = Date.now() + 5_000;
			while (!(existsSync(out) && readFileSync(out, "utf8")) && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			expect(readFileSync(out, "utf8")).toBe(KEY);
			expect(await call(harness, "background", { action: "status" })).toContain(VAR_LABEL);
			expect(saved(harness)).not.toContain(KEY);
			await new Promise((resolve) => setTimeout(resolve, 300));
		});
	});
});
