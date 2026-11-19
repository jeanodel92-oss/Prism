/**
 * fork: what changes the session's context waits for, or refuses, what is already
 * changing it.
 * - a second manual compaction asked before the first started shared, then cleared, its state.
 * - a prompt stopped while it was being prepared (a slow before_agent_start hook) still started.
 * - a prompt sent while the session tree was being navigated was accepted on the branch being left.
 * - a navigation cancelled while its hook ran still moved the session.
 */
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { createHarness, type Harness } from "./suite/harness.ts";
import { userMsg } from "./utilities.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const until = async (check: () => boolean) => {
	for (let index = 0; index < 200 && !check(); index++) await new Promise((resolve) => setTimeout(resolve, 5));
	expect(check()).toBe(true);
};

describe("fork: changes to the session's context", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	/** A session whose hook `event` waits for `held` once `holding` is set. */
	async function start(event: "before_agent_start" | "session_before_tree" | "session_before_compact") {
		const held = deferred();
		const state = { holding: false, waiting: false };
		const harness = await createHarness({
			extensionFactories: [
				(pi: ExtensionAPI) => {
					const hold = async () => {
						if (!state.holding) return false;
						state.waiting = true;
						await held.promise;
						return true;
					};
					if (event === "before_agent_start") pi.on(event, async () => void (await hold()));
					if (event === "session_before_tree") pi.on(event, async () => void (await hold()));
					if (event === "session_before_compact")
						pi.on(event, async ({ preparation }) =>
							(await hold())
								? {
										compaction: {
											summary: "summary",
											firstKeptEntryId: preparation.firstKeptEntryId,
											tokensBefore: 1,
										},
									}
								: undefined,
						);
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		return { harness, held, state };
	}

	it("refuses a second manual compaction while the first runs", async () => {
		const { harness, held, state } = await start("session_before_compact");
		harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 10 } });
		for (const text of ["one", "two", "three"]) {
			harness.setResponses([fauxAssistantMessage(`answer ${text}`)]);
			await harness.session.prompt(text);
		}
		state.holding = true;
		const first = harness.session.compact();
		const second = harness.session.compact();
		await expect(second).rejects.toThrow("Compaction is already in progress.");
		await until(() => state.waiting);
		held.resolve();
		await expect(first).resolves.toMatchObject({ summary: "summary" });
		expect(harness.session.isCompacting).toBe(false);
	});

	it("starts nothing when stopped while the prompt was being prepared", async () => {
		const { harness, held, state } = await start("before_agent_start");
		harness.setResponses([fauxAssistantMessage("must not be sent")]);
		state.holding = true;
		const prompt = harness.session.prompt("hello");
		await until(() => state.waiting);
		await harness.session.abort();
		held.resolve();
		await expect(prompt).rejects.toThrow("The prompt was cancelled before it started.");
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.session.messages).toEqual([]);
		expect(harness.session.isStreaming).toBe(false);
		// The session still takes the next prompt.
		state.holding = false;
		await harness.session.prompt("again");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("refuses a prompt while the tree is navigated", async () => {
		const { harness, held, state } = await start("session_before_tree");
		const target = harness.sessionManager.appendMessage(userMsg("first"));
		harness.sessionManager.appendMessage(userMsg("second"));
		harness.setResponses([fauxAssistantMessage("must not be sent")]);
		state.holding = true;
		const navigation = harness.session.navigateTree(target, { summarize: false });
		await until(() => state.waiting);
		await expect(harness.session.prompt("on which branch?")).rejects.toThrow(
			"Cannot submit a prompt while the session tree is being navigated",
		);
		held.resolve();
		await expect(navigation).resolves.toMatchObject({ cancelled: false });
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("refuses to navigate while a prompt is being prepared", async () => {
		const { harness, held, state } = await start("before_agent_start");
		const target = harness.sessionManager.appendMessage(userMsg("first"));
		harness.setResponses([fauxAssistantMessage("answer")]);
		state.holding = true;
		const prompt = harness.session.prompt("hello");
		await until(() => state.waiting);
		await expect(harness.session.navigateTree(target, { summarize: false })).rejects.toThrow(
			"Wait for the current response to finish before navigating the session tree.",
		);
		held.resolve();
		await prompt;
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("stays where it was when the navigation is cancelled during its hook", async () => {
		const { harness, held, state } = await start("session_before_tree");
		const target = harness.sessionManager.appendMessage(userMsg("first"));
		harness.sessionManager.appendMessage(userMsg("second"));
		const leaf = harness.sessionManager.getLeafId();
		state.holding = true;
		const navigation = harness.session.navigateTree(target, { summarize: false, label: "kept?" });
		await until(() => state.waiting);
		harness.session.abortBranchSummary();
		held.resolve();
		await expect(navigation).resolves.toMatchObject({ cancelled: true, aborted: true });
		expect(harness.sessionManager.getLeafId()).toBe(leaf);
		expect(harness.sessionManager.getLabel(target)).toBeUndefined();
	});
});
