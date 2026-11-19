/**
 * fork: a model setting saved over RPC never brings back the model it was
 * saved for when the user chose another one while it was being saved, before or during the selection's auth check.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { handleInspectCommand } from "../src/fork/rpc-inspect.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("fork: a model setting saved over RPC", () => {
	let agentDir: string;
	const harnesses: Harness[] = [];

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-rpc-model-setting-"));
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
	});
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		vi.unstubAllEnvs();
		rmSync(agentDir, { recursive: true, force: true });
	});

	async function start() {
		const harness = await createHarness({ models: [{ id: "first" }, { id: "second" }] });
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });
		const second = harness.models.find((model) => model.id === "second")!;
		expect(harness.session.model?.id).toBe("first");
		const save = () =>
			handleInspectCommand({ type: "model_setting_set", key: "contextWindow", value: "4096" }, harness.session);
		return { harness, second, save };
	}

	it("keeps the model chosen while the setting was being saved", async () => {
		const { harness, second, save } = await start();
		const registry = harness.session.extensionRunner.createContext().modelRegistry;
		const refresh = registry.refresh.bind(registry);
		const held = deferred();
		let refreshing = false;
		registry.refresh = async (options) => {
			refreshing = true;
			await held.promise;
			return await refresh(options);
		};
		const saving = save();
		await vi.waitFor(() => expect(refreshing).toBe(true));
		await harness.session.setModel(second);
		held.resolve();
		await saving;
		expect(harness.session.model?.id).toBe("second");
	});

	it("keeps the model chosen while the saved model's auth was being checked", async () => {
		const { harness, second, save } = await start();
		const runtime = harness.session.modelRuntime;
		const checkAuth = runtime.checkAuth.bind(runtime);
		const held = deferred();
		let checking = false;
		runtime.checkAuth = async (...args) => {
			// The first check is the saved model's; the user's selection passes at once.
			if (!checking) {
				checking = true;
				await held.promise;
			}
			return await checkAuth(...args);
		};
		const saving = save();
		await vi.waitFor(() => expect(checking).toBe(true));
		await harness.session.setModel(second);
		held.resolve();
		await saving;
		expect(harness.session.model?.id).toBe("second");
	});
});
