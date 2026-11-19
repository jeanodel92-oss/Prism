/**
 * fork: a model setting saved from /settings re-applied the
 * model it was saved for. When the user chose another model during that model's auth check, the old one came back.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import modelSettings from "../src/fork/model-settings.ts";
import type * as ModelPage from "../src/fork/settings-model-page.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

type PagesOptions = Parameters<typeof ModelPage.modelPagesSection>[0];
const captured = vi.hoisted(() => ({ options: undefined as unknown }));
vi.mock("../src/fork/settings-model-page.ts", async (importOriginal) => {
	const real = await importOriginal<typeof ModelPage>();
	return {
		...real,
		modelPagesSection: (options: PagesOptions) => {
			captured.options = options;
			return real.modelPagesSection(options);
		},
	};
});

describe("fork: a model setting saved from /settings", () => {
	const harnesses: Harness[] = [];
	let agentDir: string | undefined;

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		vi.unstubAllEnvs();
		if (agentDir) rmSync(agentDir, { recursive: true, force: true });
	});

	it("keeps the model chosen while the saved model's auth was being checked", async () => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-settings-model-reload-"));
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		const harness = await createHarness({
			models: [{ id: "first" }, { id: "second" }],
			extensionFactories: [{ name: "model-settings", factory: modelSettings }],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });
		const options = captured.options as PagesOptions;
		const first = harness.session.model!;
		const second = harness.models.find((model) => model.id === "second")!;
		expect(first.id).toBe("first");

		const runtime = harness.session.modelRuntime;
		const checkAuth = runtime.checkAuth.bind(runtime);
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let checking = false;
		runtime.checkAuth = async (...args) => {
			// The first check is the saved model's; the user's selection passes at once.
			if (!checking) {
				checking = true;
				await held;
			}
			return await checkAuth(...args);
		};
		const saving = options.reload(first);
		await vi.waitFor(() => expect(checking).toBe(true));
		await harness.session.setModel(second);
		release();
		await saving;
		expect(harness.session.model?.id).toBe("second");
	});
});
