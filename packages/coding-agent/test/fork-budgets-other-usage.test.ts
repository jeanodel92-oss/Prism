/**
 * fork: usage that no assistant message reports (cache warming,
 * compaction, branch summaries, tool results) counts against the budgets once, and no cache refresh is sent past
 * an exhausted budget.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { CacheWarmingDecisionEvent } from "../src/core/cache-warmer.ts";
import budgetsExtension from "../src/fork/budgets.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

function usage(tokens: number, cost: number): Usage {
	return {
		input: tokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: tokens,
		cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

const decision = (warmCost = 0.01): CacheWarmingDecisionEvent => ({
	type: "cache_warming_decision",
	warmCost,
	missCost: 1,
	continuationProbability: 1,
	action: "warm",
});

describe("budgets and usage without an assistant message", () => {
	let agentDir: string;
	const saved = process.env[ENV_AGENT_DIR];
	const harnesses: Harness[] = [];
	const notices: string[] = [];
	const uiContext = createTestUiContext({ notify: (message) => notices.push(message) });

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-budget-usage-"));
		process.env[ENV_AGENT_DIR] = agentDir;
		notices.length = 0;
	});
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		if (saved === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = saved;
		rmSync(agentDir, { recursive: true, force: true });
	});

	async function start(tools: AgentTool[] = []): Promise<Harness> {
		const harness = await createHarness({
			tools,
			models: [{ id: "budget-test", cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } }],
			extensionFactories: [{ name: "budgets", factory: budgetsExtension }],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext });
		return harness;
	}

	async function status(harness: Harness): Promise<string> {
		await harness.session.prompt("/budget status");
		return notices.at(-1) ?? "";
	}

	it("counts a cache refresh once, then stops warming at the cap", async () => {
		const harness = await start();
		await harness.session.prompt("/budget tokens 100");
		const runner = harness.session.extensionRunner;
		expect(await runner.emitCacheWarmingDecision(decision())).toBe("warm");

		harness.sessionManager.appendUsage("cache_warm", "faux", "budget-test", usage(60, 0));
		expect(await runner.emitCacheWarmingDecision(decision())).toBe("warm");
		expect(await runner.emitCacheWarmingDecision(decision())).toBe("warm");
		expect(await status(harness)).toContain("tokens: 60 / 100");

		harness.sessionManager.appendUsage("cache_warm", "faux", "budget-test", usage(50, 0));
		expect(await runner.emitCacheWarmingDecision(decision())).toBe("stop");
		expect(notices.some((notice) => notice.includes("110 consumed of 100"))).toBe(true);
		expect(await status(harness)).toContain("State: paused at tokens");
		expect(await runner.emitCacheWarmingDecision(decision())).toBe("stop");
	});

	it("does not send a refresh that would reach the cost limit", async () => {
		const harness = await start();
		await harness.session.prompt("/budget cost 1");
		const runner = harness.session.extensionRunner;
		harness.sessionManager.appendUsage("cache_warm", "faux", "budget-test", usage(1, 0.95));
		expect(await runner.emitCacheWarmingDecision(decision(0.01))).toBe("warm");
		expect(await runner.emitCacheWarmingDecision(decision(0.1))).toBe("stop");
	});

	it("counts compaction and branch summary usage once", async () => {
		const harness = await start();
		await harness.session.prompt("/budget tokens 1000");
		harness.setResponses([fauxAssistantMessage("first")]);
		await harness.session.prompt("first");
		const before = Number(/tokens: (\d+) \//.exec(await status(harness))?.[1]);

		const compaction = harness.sessionManager.appendCompaction("summary", null, 10, undefined, false, usage(200, 0));
		const entry = harness.sessionManager.getEntry(compaction);
		if (entry?.type !== "compaction") throw new Error("Expected a compaction entry");
		const compact = { type: "session_compact", compactionEntry: entry, fromExtension: false } as const;
		await harness.session.extensionRunner.emit({ ...compact, reason: "manual", willRetry: false });
		await harness.session.extensionRunner.emit({ ...compact, reason: "manual", willRetry: false });
		expect(await status(harness)).toContain(`tokens: ${before + 200} / 1000`);

		harness.sessionManager.branchWithSummary(null, "branch summary", undefined, false, usage(300, 0));
		await harness.session.extensionRunner.emit({ type: "session_tree", newLeafId: null, oldLeafId: null });
		expect(await status(harness)).toContain(`tokens: ${before + 500} / 1000`);
	});

	it("counts the usage a tool result carries", async () => {
		const nested: AgentTool = {
			name: "nested",
			label: "Nested",
			description: "Reports the usage of its nested model calls",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {}, usage: usage(400, 0) }),
		};
		const harness = await start([nested]);
		await harness.session.prompt("/budget tokens 100000");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("nested", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		const assistantTokens = harness.session.messages
			.flatMap((message) => (message.role === "assistant" ? [message.usage] : []))
			.reduce((sum, u) => sum + u.input + u.output + u.cacheRead + u.cacheWrite, 0);
		expect(await status(harness)).toContain(`tokens: ${assistantTokens + 400} / 100000`);
	});
});
