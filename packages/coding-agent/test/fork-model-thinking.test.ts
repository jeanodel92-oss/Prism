// no way to set a model's default thinking level from the window; it should be the
// last one used with that model. Each prompt keeps the level in effect as the model's own, and switching back to the
// model brings it back. Plan mode's own level is not kept.
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { rememberModelThinking } from "../src/fork/model-thinking-memory.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

describe("fork: each model keeps its last thinking level", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		delete (globalThis as Record<symbol, unknown>)[Symbol.for("prism.plan-mode")];
	});

	it("keeps the level a prompt was sent with, and gives it back when the model is chosen again", async () => {
		const harness = await createHarness({
			models: [
				{ id: "thinker-a", reasoning: true },
				{ id: "thinker-b", reasoning: true },
			],
		});
		harnesses.push(harness);
		const session = harness.session;
		const [a, b] = harness.models;
		await session.setModel(a!);
		session.setThinkingLevel("high");
		harness.setResponses([fauxAssistantMessage("ok")]);
		await session.prompt("one");
		expect(harness.settingsManager.getModelThinkingLevel(a!.provider, a!.id)).toBe("high");

		await session.setModel(b!);
		session.setThinkingLevel("low");
		harness.setResponses([fauxAssistantMessage("ok")]);
		await session.prompt("two");
		expect(harness.settingsManager.getModelThinkingLevel(b!.provider, b!.id)).toBe("low");

		await session.setModel(a!);
		expect(session.thinkingLevel).toBe("high");
		// Global default untouched.
		expect(harness.settingsManager.getDefaultThinkingLevel()).toBeUndefined();
	});

	it("does not keep plan mode's level, nor a model without thinking", () => {
		const saved: string[] = [];
		const settings = {
			getModelThinkingLevel: () => undefined,
			setModelThinkingLevel: (_p: string, id: string, level: string) => void saved.push(`${id}:${level}`),
		};
		const model = { provider: "p", id: "m", reasoning: true } as Parameters<typeof rememberModelThinking>[0];
		(globalThis as Record<symbol, unknown>)[Symbol.for("prism.plan-mode")] = {
			toggle: () => {},
			enabled: () => true,
		};
		rememberModelThinking(model, "xhigh", settings);
		expect(saved).toEqual([]);
		(globalThis as Record<symbol, unknown>)[Symbol.for("prism.plan-mode")] = {
			toggle: () => {},
			enabled: () => false,
		};
		rememberModelThinking(model, "medium", settings);
		rememberModelThinking({ ...model!, reasoning: false }, "low", settings);
		expect(saved).toEqual(["m:medium"]);
	});
});
