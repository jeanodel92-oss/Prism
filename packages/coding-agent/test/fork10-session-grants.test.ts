// a conversation whose engine the window puts to sleep keeps its grants. The rules "in
// this session" are in the session file already; the dangerous actions allowed "in this session" are in memory only,
// and go through the window (perm_export / perm_import). A fresh engine without them asks again.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import permissionsExtension, { exportSessionGrants, importSessionGrants } from "../src/fork/permissions.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

describe("fork.10: session grants kept while the engine sleeps", () => {
	let agentDir: string;
	const saved = process.env[ENV_AGENT_DIR];
	const harnesses: Harness[] = [];

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-grants-"));
		process.env[ENV_AGENT_DIR] = agentDir;
		// No sandbox: the command must not depend on bubblewrap here.
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sandbox: { modes: { broad: false } } }));
		writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode: "broad" }));
	});
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		if (saved === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = saved;
		rmSync(agentDir, { recursive: true, force: true });
	});

	async function engine(answer: string) {
		const harness = await createHarness({
			extensionFactories: [{ name: "permissions", factory: permissionsExtension }],
		});
		harnesses.push(harness);
		const titles: string[] = [];
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				select: async (title, options) => {
					titles.push(title);
					return options.find((option) => option.startsWith(answer));
				},
			}),
		});
		const run = async (command: string) => {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("bash", { command }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("go");
		};
		return { harness, titles, run };
	}

	it("gives back the dangerous actions allowed in this session, and only to the engine they are given to", async () => {
		// A dangerous command whose effect is harmless here: `crontab -r` with no crontab binary does nothing useful.
		const command = "crontab -r -u nobody-prism-test 2>/dev/null; true";
		const first = await engine("Allow this action in this session");
		await first.run(command);
		expect(first.titles).toHaveLength(1);
		const grants = exportSessionGrants(first.harness.sessionManager);
		expect(grants?.danger.map(([, what]) => what)).toEqual([`bash(${command})`]);

		// The engine that wakes, given the grants: no question.
		const woken = await engine("Block this action once");
		expect(importSessionGrants(woken.harness.sessionManager, JSON.parse(JSON.stringify(grants)))).toBe(true);
		await woken.run(command);
		expect(woken.titles).toEqual([]);

		// Another engine, not given them: it asks again.
		const other = await engine("Block this action once");
		await other.run(command);
		expect(other.titles).toHaveLength(1);
	});

	it("ignores malformed grants", async () => {
		const { harness } = await engine("Block");
		expect(importSessionGrants(harness.sessionManager, "x")).toBe(false);
		expect(importSessionGrants(harness.sessionManager, { danger: [[1, 2], "x"], hosts: [3, "Example.COM"] })).toBe(
			true,
		);
		expect(exportSessionGrants(harness.sessionManager)).toEqual({ danger: [], hosts: ["example.com"] });
	});
});
