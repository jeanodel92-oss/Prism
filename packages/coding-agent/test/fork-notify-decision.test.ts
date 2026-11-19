// fork: a call the permission gate allows without a question must not raise
// the "waiting for you" notification while it runs silently past the approval delay.
import type * as ChildProcess from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import { type PermissionDecisionFact, subscribePermissionDecision } from "../src/fork/permissions.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

describe("fork: approval notification after the gate decided", () => {
	let agentDir: string;
	let harness: Harness | undefined;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-notify-decision-"));
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

	it("does not announce an allowed call that is still running after the delay", async () => {
		writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode: "broad" }));
		const timers = new Map<unknown, { delay: number | undefined; callback: () => void; cleared: boolean }>();
		const realSetTimeout = globalThis.setTimeout;
		const realClearTimeout = globalThis.clearTimeout;
		vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay?: number) => {
			const handle = realSetTimeout(callback, delay);
			timers.set(handle, { delay, callback, cleared: false });
			return handle;
		}) as typeof setTimeout);
		vi.spyOn(globalThis, "clearTimeout").mockImplementation(((handle: NodeJS.Timeout) => {
			const timer = timers.get(handle);
			if (timer) timer.cleared = true;
			realClearTimeout(handle);
		}) as typeof clearTimeout);
		const decisions: PermissionDecisionFact["decision"][] = [];
		const unsubscribe = subscribePermissionDecision((fact) => decisions.push(fact.decision));
		// Runs while the tool's result is handled, before its end: the call is still under way. Every approval timer
		// still armed then is fired, as fifteen silent seconds would.
		const whileRunning: ExtensionFactory = (pi) => {
			pi.on("tool_result", async () => {
				for (const timer of timers.values())
					if (timer.delay === 15_000 && !timer.cleared) {
						timer.cleared = true;
						timer.callback();
					}
			});
		};
		const extensions = builtInExtensions.filter((entry) => entry.name === "notify" || entry.name === "permissions");
		expect(extensions).toHaveLength(2);
		const selects: string[] = [];
		harness = await createHarness({ extensionFactories: [...extensions, whileRunning] });
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				select: async (title: string) => {
					selects.push(title);
					return "Block this action once";
				},
			}),
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "note.txt", content: "x" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		try {
			await harness.session.prompt("go");
		} finally {
			unsubscribe();
		}
		expect(selects).toEqual([]);
		expect(decisions).toEqual(["allowed_by_rule"]);
		// The approval timer was armed for this call, so the check above did observe it.
		expect([...timers.values()].some((timer) => timer.delay === 15_000)).toBe(true);
		const sent = childProcessMocks.execFile.mock.calls.map((call) => call[1] as string[]);
		expect(sent.filter((args) => args.some((arg) => arg.endsWith("waiting for you")))).toEqual([]);
	});
});
