// fork: the time budget.
// it counts while the agent runs, not while the session waits for the next prompt.
// a limit whose next check is further away than setTimeout can wait does not re-arm the timer every 1 ms.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import budgetsExtension from "../src/fork/budgets.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

describe("time budget", () => {
	let agentDir: string;
	const saved = process.env[ENV_AGENT_DIR];
	const harnesses: Harness[] = [];
	const notices: string[] = [];
	const uiContext = createTestUiContext({ notify: (message) => notices.push(message) });
	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-budget-idle-"));
		process.env[ENV_AGENT_DIR] = agentDir;
		notices.length = 0;
	});
	afterEach(() => {
		vi.restoreAllMocks();
		for (const harness of harnesses.splice(0)) harness.cleanup();
		if (saved === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = saved;
		rmSync(agentDir, { recursive: true, force: true });
	});
	async function start(): Promise<Harness> {
		const harness = await createHarness({ extensionFactories: [{ name: "budgets", factory: budgetsExtension }] });
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext });
		return harness;
	}

	it("does not count the time between a finished answer and the next prompt", async () => {
		const harness = await start();
		await harness.session.prompt("/budget time 60");
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("first");
		// Half an hour reading the answer.
		const realNow = Date.now.bind(Date);
		vi.spyOn(Date, "now").mockImplementation(() => realNow() + 30 * 60_000);
		await harness.session.prompt("/budget status");
		expect(notices.at(-1)).toContain("time: 0.00 min / 60 min");
		harness.setResponses([fauxAssistantMessage("done again")]);
		await harness.session.prompt("second");
		await harness.session.prompt("/budget status");
		expect(notices.at(-1)).toContain("time: 0.00 min / 60 min");
		expect(notices.at(-1)).toContain("State: active");
	});

	it("never asks setTimeout for a delay it would cut to 1 ms", async () => {
		const MAX = 2_147_483_647;
		const delays: number[] = [];
		const realSetTimeout = globalThis.setTimeout;
		vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay?: number) => {
			delays.push(delay ?? 0);
			// An overlong delay would fire after 1 ms, again and again: record it without running it.
			return delay !== undefined && delay > MAX ? realSetTimeout(() => {}, 0) : realSetTimeout(callback, delay);
		}) as typeof setTimeout);
		const harness = await start();
		// Sixty days: the warning, at 80%, is 48 days away.
		await harness.session.prompt("/budget time 86400");
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("go");
		expect(delays.filter((delay) => delay > 24 * 3_600_000)).not.toHaveLength(0);
		expect(delays.filter((delay) => delay > MAX)).toEqual([]);
	});
});
