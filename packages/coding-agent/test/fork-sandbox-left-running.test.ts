// a process a sandboxed bash command leaves running (`sleep 400 &`) ends with the
// command; the result says which, so the model does not believe it still running.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import permissionsExtension from "../src/fork/permissions.ts";
import { buildLayout, DEFAULT_SANDBOX_SETTINGS } from "../src/fork/sandbox/layout.ts";
import { sandboxPromptSection } from "../src/fork/sandbox/notes.ts";
import { findBwrap, removeSessionTmpDir, sessionSandbox } from "../src/fork/sandbox/runtime.ts";
import { createHarness, createTestUiContext, getMessageText, getToolResult, type Harness } from "./suite/harness.ts";

const bwrap = findBwrap();

describe.skipIf(!bwrap)("fork: processes a sandboxed command leaves running", () => {
	let base: string | undefined;
	let harness: Harness | undefined;

	beforeEach(() => {
		base = realpathSync(mkdtempSync("/var/tmp/prism-left-running-"));
		const home = join(base, "home");
		const agentDir = join(base, "agent");
		mkdirSync(home, { recursive: true });
		mkdirSync(agentDir);
		vi.stubEnv("HOME", home);
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		vi.stubEnv("TMPDIR", base);
		vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
		writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode: "broad" }));
	});

	afterEach(() => {
		if (harness) {
			removeSessionTmpDir(harness.sessionManager.getSessionId());
			harness.cleanup();
			harness = undefined;
		}
		vi.unstubAllEnvs();
		if (base) rmSync(base, { recursive: true, force: true });
		base = undefined;
	});

	async function bash(command: string): Promise<string> {
		harness = await createHarness({ extensionFactories: [{ name: "permissions", factory: permissionsExtension }] });
		await harness.session.bindExtensions({ uiContext: createTestUiContext({}) });
		expect(sessionSandbox(harness.sessionManager)).toMatchObject({ bwrap });
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		return getMessageText(getToolResult(harness, "bash"));
	}

	it("names the process it stopped", async () => {
		// The command ends only once its background job runs `sleep`: stopped before that
		// , the job still carried the shell's command line, which is the right name then.
		const result = await bash(
			'sleep 417 & until read -r name </proc/$!/comm && [ "$name" = sleep ]; do :; done; echo started',
		);
		expect(result).toContain("started");
		expect(result).toMatch(/Prism sandbox: stopped 1 process\(es\) this command left running.*\d+ sleep 417/);
	});

	it("says nothing when the command leaves nothing running", async () => {
		const result = await bash("sleep 0.1 & wait; echo finished");
		expect(result).toContain("finished");
		expect(result).not.toContain("Prism sandbox: stopped");
	});

	it("tells the model in the sandbox section of the system prompt", async () => {
		const layout = buildLayout({
			cwd: base!,
			home: join(base!, "home"),
			agentDir: join(base!, "agent"),
			settings: DEFAULT_SANDBOX_SETTINGS,
		});
		expect(sandboxPromptSection(layout)).toContain("is stopped when that command ends");
	});
});
