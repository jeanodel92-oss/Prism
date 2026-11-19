// `/scoped-models` in the Prism window: the terminal's operations (scoped-models-operations.ts)
// as native screens over the real view transport (scoped-models-native.ts). Each change applies to the session's
// Ctrl+P scope at once, Save writes the settings, as the terminal's selector does.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { setViewsClient } from "../src/fork/interactive-client.ts";
import { handleBuiltinCommand } from "../src/fork/rpc-builtins.ts";
import { RpcViews } from "../src/fork/rpc-views.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

interface Item {
	id: string;
	label: string;
	selected?: boolean;
	currentValue?: string;
	values?: string[];
}
interface Menu {
	screenId: string;
	kind: string;
	title: string;
	lines?: string[];
	items: Item[];
	actions?: Item[];
}
type Record_ = { type: string; id?: string; menu?: Menu };

describe("fork.10: native /scoped-models", () => {
	let dir: string;
	const harnesses: Harness[] = [];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "prism-scoped-models-native-"));
		vi.stubEnv(ENV_AGENT_DIR, dir);
		initTheme("dark");
	});
	afterEach(() => {
		setViewsClient();
		for (const harness of harnesses.splice(0)) harness.cleanup();
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		rmSync(dir, { recursive: true, force: true });
	});

	async function engine(nativeMenus = true) {
		const records: Record_[] = [];
		const notes: string[] = [];
		const views = new RpcViews((record) => records.push(record as Record_));
		views.handleCommand({ type: "set_views", columns: 100, rows: 30, nativeMenus });
		const harness = await createHarness({
			models: [
				{ id: "alpha", name: "Alpha" },
				{ id: "beta", name: "Beta" },
				{ id: "gamma", name: "Gamma" },
			],
		});
		harnesses.push(harness);
		vi.spyOn(harness.session.modelRuntime, "refresh").mockResolvedValue({ aborted: false, errors: new Map() });
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				custom: (factory, opts) => views.custom(factory, opts),
				notify: (message) => notes.push(message),
			}),
			mode: "rpc",
		});
		const run = () =>
			handleBuiltinCommand(
				{ type: "scoped_models", id: "scoped" },
				harness.session,
				{} as never,
				views,
				async () => {},
			) as Promise<{
				success: boolean;
				error?: string;
			}>;
		const menu = () => records.filter((record) => record.type === "view_frame").at(-1)?.menu as Menu;
		const viewId = () => records.filter((record) => record.type === "view_open").at(-1)?.id ?? "";
		const act = (action: object) => views.handleCommand({ type: "view_action", viewId: viewId(), action });
		const find = (label: string) => {
			const found = [...menu().items, ...(menu().actions ?? [])].find((item) => item.label === label);
			if (!found) throw new Error(`No ${label} in ${menu().screenId}`);
			return found;
		};
		const scoped = () => harness.session.scopedModels.map((entry) => entry.model.id);
		return { harness, notes, run, menu, act, find, scoped, settings: harness.settingsManager };
	}

	it("turns models on and off for the session, orders them and saves them", async () => {
		const e = await engine();
		const done = e.run();
		await vi.waitFor(() => expect(e.menu()?.lines).toContain("Model catalogs refreshed."));
		expect(e.menu()).toMatchObject({ screenId: "scoped-models", kind: "multiSelect", title: "Model Configuration" });
		expect(e.menu().items.map((item) => [item.label, item.selected])).toEqual([
			["alpha", true],
			["beta", true],
			["gamma", true],
		]);
		expect(e.menu().lines).toContain("all enabled");

		e.act({ kind: "multiSelect", itemId: e.find("beta").id, selected: false });
		await vi.waitFor(() => expect(e.scoped()).toEqual(["alpha", "gamma"]));
		await vi.waitFor(() => expect(e.menu().lines).toContain("2/3 enabled (unsaved)"));
		expect(e.settings.getEnabledModels()).toBeUndefined();

		e.act({ kind: "activate", itemId: e.find("Change the order").id });
		await vi.waitFor(() => expect(e.menu().screenId).toBe("scoped-models:order"));
		expect(e.menu().items.map((item) => [item.label, item.currentValue])).toEqual([
			["alpha", "1"],
			["gamma", "2"],
		]);
		e.act({ kind: "setting", itemId: e.find("gamma").id, value: "1" });
		await vi.waitFor(() => expect(e.scoped()).toEqual(["gamma", "alpha"]));
		await vi.waitFor(() => expect(e.menu().items.map((item) => item.label)).toEqual(["gamma", "alpha"]));
		e.act({ kind: "back" });
		await vi.waitFor(() => expect(e.menu().screenId).toBe("scoped-models"));
		// the window's model picker reads them, in their Ctrl+P order.
		const listed = (await handleBuiltinCommand(
			{ type: "get_scoped_models", id: "listed" },
			e.harness.session,
			{} as never,
			new RpcViews(() => {}),
			async () => {},
		)) as { data: { models: Array<{ provider: string; id: string }> } };
		expect(listed.data.models).toEqual([
			{ provider: "faux", id: "gamma" },
			{ provider: "faux", id: "alpha" },
		]);

		e.act({ kind: "activate", itemId: e.find("Save to settings").id });
		await vi.waitFor(() => expect(e.settings.getEnabledModels()).toEqual(["faux/gamma", "faux/alpha"]));
		expect(e.notes).toContain("Model selection saved to settings");
		await vi.waitFor(() => expect(e.menu().lines).toContain("2/3 enabled"));

		e.act({ kind: "activate", itemId: e.find("Enable all").id });
		await vi.waitFor(() => expect(e.scoped()).toEqual([]));
		await vi.waitFor(() => expect(e.menu().items.every((item) => item.selected)).toBe(true));
		e.act({ kind: "activate", itemId: e.find("Clear all").id });
		await vi.waitFor(() => expect(e.menu().items.every((item) => !item.selected)).toBe(true));
		e.act({ kind: "back" });
		expect(await done).toMatchObject({ success: true });
	});

	it("starts from the saved selection", async () => {
		const e = await engine();
		e.settings.setEnabledModels(["faux/gamma"]);
		const done = e.run();
		await vi.waitFor(() => expect(e.menu()?.lines).toContain("Model catalogs refreshed."));
		expect(e.menu().items.map((item) => [item.label, item.selected])).toEqual([
			["gamma", true],
			["alpha", false],
			["beta", false],
		]);
		expect(e.scoped()).toEqual(["gamma"]);
		e.act({ kind: "back" });
		await done;
	});

	it("is refused without native screens", async () => {
		const e = await engine(false);
		await expect(e.run()).rejects.toThrow("/scoped-models opens in the terminal or the Prism window.");
	});
});
