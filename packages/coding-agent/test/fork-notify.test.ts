// fork: desktop notifications (src/fork/notify.ts) for a call that waits on the permission gate.
import type * as ChildProcess from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const childProcessMocks = vi.hoisted(() => ({ execFile: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof ChildProcess>()),
	execFile: childProcessMocks.execFile,
}));

import { ENV_AGENT_DIR } from "../src/config.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import { APP_DISPLAY_NAME } from "../src/fork/brand.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

describe("fork: desktop notifications", () => {
	let agentDir: string;
	let harness: Harness | undefined;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-notify-"));
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		childProcessMocks.execFile.mockReset();
	});
	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("notifies while the permission gate's question is still open, with the built-in load order", async () => {
		// The real order of the built-in list: notify's `tool_call` handler must arm its timer before the gate
		// awaits the answer, or the timer only starts once the question is answered.
		const extensions = builtInExtensions.filter((entry) => entry.name === "notify" || entry.name === "permissions");
		expect(extensions).toHaveLength(2);
		const timers: Array<{ delay: number | undefined; callback: () => void }> = [];
		const realSetTimeout = globalThis.setTimeout;
		vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay?: number) => {
			timers.push({ delay, callback });
			return realSetTimeout(callback, delay);
		}) as typeof setTimeout);
		const sent: string[][] = [];
		harness = await createHarness({ extensionFactories: extensions });
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				select: async () => {
					// The question is on screen: the approval timer is already running; fire it now.
					const approval = timers.find((timer) => timer.delay === 15_000);
					approval?.callback();
					sent.push(...childProcessMocks.execFile.mock.calls.map((call) => call[1] as string[]));
					return "Block this action once";
				},
			}),
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "sudo -n true 2>&1; echo done" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		const notification = sent.find((args) => args.some((arg) => arg.endsWith("waiting for you")));
		expect(notification).toBeDefined();
		expect(notification?.at(-1)).toBe("bash: sudo -n true 2>&1; echo done");
		// "Prism" in a release build, "Pi" from source: capitalized either way.
		expect(notification).toContain(`--app-name=${APP_DISPLAY_NAME}`);
		expect(notification?.at(-2)).toBe(`${APP_DISPLAY_NAME} — waiting for you`);
		expect(APP_DISPLAY_NAME).toMatch(/^[A-Z]/);
	});
});
