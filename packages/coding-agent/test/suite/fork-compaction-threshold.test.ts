import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

function seedHistory(harness: Harness, tokens: number, largeHistory = false): void {
	for (const text of ["old", "recent"]) {
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: largeHistory && text === "old" ? "x".repeat(88000) : text.repeat(200) }],
			timestamp: Date.now() - 2000,
		});
		const assistant = fauxAssistantMessage(text.repeat(200), { timestamp: Date.now() - 1000 });
		harness.sessionManager.appendMessage({
			...assistant,
			usage: { ...assistant.usage, input: tokens, totalTokens: tokens },
		});
	}
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

describe("fork: automatic compaction at a configured threshold", () => {
	let harness: Harness | undefined;
	afterEach(() => harness?.cleanup());

	it.each(["pre-prompt", "post-run"] as const)("starts earlier on a small faux context (%s)", async (path) => {
		for (const percent of [undefined, 50]) {
			harness = await createHarness({
				models: [{ id: "faux-1", contextWindow: 40000, maxTokens: 4096 }],
				tools: [],
				// Post-run, the system prompt entry (~450 tokens, its doc paths depend on the checkout) sits after the
				// history: a small budget is reached there wherever the repo lives, so the cut never splits a turn.
				settings: { compaction: { thresholdPercent: percent, keepRecentTokens: path === "post-run" ? 50 : 450 } },
			});
			// At 22k, 50% has crossed 20k; Default has not crossed 40k - 16384 = 23616.
			// Faux recomputes usage from text after streaming; use long history with low prior usage for post-run.
			seedHistory(harness, path === "pre-prompt" ? 22000 : 1000, path === "post-run");
			const reply = fauxAssistantMessage("done");
			harness.setResponses(
				percent === undefined
					? [reply]
					: path === "pre-prompt"
						? [fauxAssistantMessage("summary of older history"), reply]
						: [reply, fauxAssistantMessage("summary of older history")],
			);
			await harness.session.prompt("continue");
			const compactions = harness.eventsOfType("compaction_end");
			expect(compactions).toHaveLength(percent === undefined ? 0 : 1);
			if (percent !== undefined) {
				expect(compactions[0]).toMatchObject({
					reason: "threshold",
					aborted: false,
					willRetry: false,
					result: { summary: "summary of older history", tokensBefore: expect.any(Number) },
				});
				expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(true);
			}
			expect(harness.getPendingResponseCount()).toBe(0);
			harness.cleanup();
			harness = undefined;
		}
	});

	it("honors the safety cap before the requested high percentage", async () => {
		harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 16000, maxTokens: 4096 }],
			tools: [],
			settings: { compaction: { reserveTokens: 4096, keepRecentTokens: 450, thresholdPercent: 95 } },
		});
		seedHistory(harness, 13000); // Below the requested 15200, above the capped 11904.
		harness.setResponses([fauxAssistantMessage("safe summary"), fauxAssistantMessage("done")]);
		await harness.session.prompt("continue");
		expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end")[0]).toMatchObject({
			reason: "threshold",
			result: { summary: "safe summary" },
			aborted: false,
		});
		expect(harness.settingsManager.getCompactionThresholdPercent()).toBe(95);
		expect(harness.getPendingResponseCount()).toBe(0);
	});
});
