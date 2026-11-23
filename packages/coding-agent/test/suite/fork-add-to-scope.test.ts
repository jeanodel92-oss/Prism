// fork: ctx.addToScope, with which server-model-refresh.ts puts a server's new models in a
// scope that /scoped-models narrowed. It adds them as a model made the default is: to the session's scope and to
// enabledModels, and only when the scope is not empty (empty means every model).
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../../src/index.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("fork: extensions add models to a narrowed scope", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(enabledModels: string[] | undefined) {
		let context: ExtensionContext | undefined;
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One" },
				{ id: "faux-2", name: "Two" },
				{ id: "org/faux-3", name: "Three" },
			],
			settings: enabledModels ? { enabledModels } : {},
			extensionFactories: [
				(pi) => {
					pi.on("model_select", async (_event, ctx) => {
						context = ctx;
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.setModel(harness.getModel("faux-2")!);
		return { harness, context: context! };
	}

	it("adds a model to a narrowed scope and to enabledModels, once", async () => {
		const { harness, context } = await setup(undefined);
		const provider = harness.getModel().provider;
		harness.settingsManager.setEnabledModels([`${provider}/faux-1`]);
		harness.session.setScopedModels([{ model: harness.getModel("faux-1")! }]);

		const third = harness.getModel("org/faux-3")!;
		context.addToScope?.([third]);
		context.addToScope?.([third]);
		expect(harness.session.scopedModels.map((entry) => entry.model.id)).toEqual(["faux-1", "org/faux-3"]);
		expect(harness.settingsManager.getEnabledModels()).toEqual([`${provider}/faux-1`, `${provider}/org/faux-3`]);
	});

	it("leaves an empty scope (every model) alone", async () => {
		const { harness, context } = await setup(undefined);
		context.addToScope?.([harness.getModel("org/faux-3")!]);
		expect(harness.session.scopedModels).toEqual([]);
		expect(harness.settingsManager.getEnabledModels()).toBeUndefined();
	});
});
