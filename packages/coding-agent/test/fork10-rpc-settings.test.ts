// `/settings` in the Prism window: the terminal's settings, grouping and operations as native
// screens over the real view transport (settings-native.ts). Each change is saved by the same operation as in the
// terminal; the window only draws the rows.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { setLanguage } from "../src/fork/i18n/index.ts";
import { setViewsClient } from "../src/fork/interactive-client.ts";
import { handleBuiltinCommand } from "../src/fork/rpc-builtins.ts";
import { RpcViews } from "../src/fork/rpc-views.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

interface Item {
	id: string;
	label: string;
	description?: string;
	currentValue?: string;
	values?: string[];
	disabled?: boolean;
	group?: string;
}
interface Menu {
	screenId: string;
	kind: string;
	title: string;
	hint?: string;
	sections?: { id: string; label: string }[];
	section?: string;
	root?: boolean;
	interfaceMode?: "simple" | "advanced";
	searching?: string;
	lines?: string[];
	errors?: string[];
	items: Item[];
}
type Record_ = { type: string; id?: string; menu?: Menu };

describe("fork.10: native /settings", () => {
	let dir: string;
	const harnesses: Harness[] = [];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "prism-settings-native-"));
		vi.stubEnv(ENV_AGENT_DIR, dir);
		writeFileSync(
			join(dir, "settings.json"),
			JSON.stringify({ sandbox: { modes: { safe: false, ask: false, broad: false } } }),
		);
		initTheme("dark");
	});
	afterEach(() => {
		setViewsClient();
		setLanguage("en");
		for (const harness of harnesses.splice(0)) harness.cleanup();
		vi.unstubAllEnvs();
		rmSync(dir, { recursive: true, force: true });
	});

	async function engine(nativeMenus = true) {
		const records: Record_[] = [];
		const notes: [string, string | undefined][] = [];
		const views = new RpcViews((record) => records.push(record as Record_));
		views.handleCommand({ type: "set_views", columns: 100, rows: 30, nativeMenus });
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				custom: (factory, opts) => views.custom(factory, opts),
				notify: (message, type) => notes.push([message, type]),
			}),
			mode: "rpc",
		});
		let reloads = 0;
		const run = (command: Record<string, unknown> = {}) =>
			handleBuiltinCommand(
				{ type: "settings", id: "settings-id", ...command },
				harness.session,
				{} as never,
				views,
				async () => {
					reloads++;
				},
			) as Promise<{ success: boolean; data?: { line?: string; reloaded?: boolean }; error?: string }>;
		const menu = () => records.filter((record) => record.type === "view_frame").at(-1)?.menu as Menu;
		const viewId = () => records.filter((record) => record.type === "view_open").at(-1)?.id ?? "";
		const act = (action: object) => views.handleCommand({ type: "view_action", viewId: viewId(), action });
		const row = (label: string) => {
			const found = menu().items.find((item) => item.label === label);
			if (!found)
				throw new Error(
					`No row ${label} in ${menu().title}: ${menu()
						.items.map((i) => i.label)
						.join(", ")}`,
				);
			return found;
		};
		const open = (label: string) => act({ kind: "activate", itemId: row(label).id });
		const set = (label: string, value?: string) =>
			act({ kind: "setting", itemId: row(label).id, value: value ?? row(label).currentValue });
		return {
			harness,
			records,
			notes,
			run,
			menu,
			act,
			row,
			open,
			set,
			settings: harness.session.settingsManager,
			reloads: () => reloads,
		};
	}

	/** Opens `label` on the screen shown and waits for the next screen. */
	async function into(e: Awaited<ReturnType<typeof engine>>, label: string, screenId: string) {
		e.open(label);
		await vi.waitFor(() => expect(e.menu().screenId).toBe(screenId));
	}

	it("shows the domains, then a domain's settings, and saves a change as the terminal does", async () => {
		const e = await engine();
		const done = e.run();
		await vi.waitFor(() => expect(e.menu()?.screenId).toBe("settings:domains"));
		expect(e.menu()).toMatchObject({ kind: "choice", title: "Settings", hint: "close" });
		expect(e.menu().items.map((item) => item.label)).toEqual(
			expect.arrayContaining(["Appearance", "Conversation", "Models"]),
		);

		await into(e, "Appearance", "settings:appearance");
		expect(e.menu()).toMatchObject({ kind: "settings", title: "Appearance" });
		expect(e.row("Mermaid diagrams")).toMatchObject({
			currentValue: "streaming",
			values: ["off", "final", "streaming"],
		});
		const before = e.row("Mermaid diagrams").id;
		expect(e.set("Mermaid diagrams", "final")).toMatchObject({ success: true });
		await vi.waitFor(() => expect(e.row("Mermaid diagrams").currentValue).toBe("final"));
		expect(e.settings.getMermaidRenderingMode()).toBe("final");
		// The rows are drawn again: an action on the previous screen is refused, as is a value the row does not have.
		expect(e.act({ kind: "setting", itemId: before, value: "off" })).toMatchObject({ success: false });
		expect(e.set("Mermaid diagrams", "maybe")).toMatchObject({ success: false });

		e.act({ kind: "back" });
		await vi.waitFor(() => expect(e.menu().screenId).toBe("settings:domains"));
		e.act({ kind: "back" });
		expect(await done).toMatchObject({ success: true, data: {} });
		expect(e.records.at(-1)?.type).toBe("view_closed");
	});

	it("shows the advanced settings once the interface is advanced", async () => {
		const e = await engine();
		const done = e.run({ domain: "interface" });
		await vi.waitFor(() => expect(e.menu()?.screenId).toBe("settings:interface"));
		e.act({ kind: "back" });
		await vi.waitFor(() => expect(e.menu().screenId).toBe("settings:domains"));
		await into(e, "Appearance", "settings:appearance");
		const simple = e.menu().items.length;
		e.act({ kind: "back" });
		await vi.waitFor(() => expect(e.menu().screenId).toBe("settings:domains"));
		await into(e, "Interface", "settings:interface");
		e.set("Interface", "advanced");
		await vi.waitFor(() => expect(e.row("Interface").currentValue).toBe("advanced"));
		expect(e.settings.getInterfaceMode()).toBe("advanced");
		e.act({ kind: "back" });
		await vi.waitFor(() => expect(e.menu().screenId).toBe("settings:domains"));
		await into(e, "Appearance", "settings:appearance");
		expect(e.menu().items.length).toBeGreaterThan(simple);
		e.act({ kind: "back" });
		e.act({ kind: "back" });
		await done;
	});

	it("leaves out the settings only the terminal draws", async () => {
		const e = await engine();
		e.settings.setInterfaceMode("advanced");
		const done = e.run();
		await vi.waitFor(() => expect(e.menu()?.screenId).toBe("settings:domains"));
		expect(e.menu().items.map((item) => item.label)).not.toContain("Terminal");
		await into(e, "Appearance", "settings:appearance");
		const ids = e.menu().items.map((item) => item.id.replace(/^[^:]*:/, ""));
		expect(ids).toContain("mermaid-rendering");
		// Described by what it keeps in the window.
		expect(JSON.stringify(e.menu())).toContain("Thinking text, diagrams and suggestions");
		expect(JSON.stringify(e.menu())).not.toContain("startup messages");
		for (const id of [
			"animations",
			// the window's theme is Window › Theme, not the terminal's setting.
			"theme",
			"theme-customize",
			"show-hardware-cursor",
			"editor-padding",
			"output-padding",
			"quiet-startup",
		])
			expect(ids).not.toContain(id);
		e.act({ kind: "back" });
		await vi.waitFor(() => expect(e.menu().screenId).toBe("settings:domains"));
		await into(e, "Notifications", "settings:notifications");
		const notices = e.menu().items.map((item) => item.id.replace(/^[^:]*:/, ""));
		expect(notices).toContain("local-cloud-warning");
		for (const id of ["warnings", "cache-miss-notices", "collapse-changelog"]) expect(notices).not.toContain(id);
		e.act({ kind: "back" });
		await vi.waitFor(() => expect(e.menu().screenId).toBe("settings:domains"));
		e.act({ kind: "back" });
		await done;
	});

	it("shows the window how the conversation is drawn", async () => {
		const e = await engine();
		const ask = async (type: string) =>
			(
				(await handleBuiltinCommand(
					{ type, id: type },
					e.harness.session,
					{} as never,
					new RpcViews(() => {}),
					async () => {},
				)) as {
					data: Record<string, { name?: string } | boolean | number | string>;
				}
			).data;
		expect(await ask("get_display")).toEqual({
			hideThinkingBlock: true,
			mermaidRendering: "streaming",
			autocompleteMaxVisible: 5,
			interfaceMode: "simple",
		});
		const done = e.run({ domain: "appearance" });
		await vi.waitFor(() => expect(e.menu()?.screenId).toBe("settings:appearance"));
		e.set("Hide thinking", "false");
		await vi.waitFor(async () => expect((await ask("get_display")).hideThinkingBlock).toBe(false));
		await vi.waitFor(() => expect(e.row("Hide thinking").currentValue).toBe("false"));
		e.act({ kind: "back" });
		e.act({ kind: "back" });
		await done;
	});

	it("lists the domains beside each screen for the window's Settings dialog", async () => {
		const e = await engine();
		// the per-model levels are an advanced setting.
		e.settings.setInterfaceMode("advanced");
		const done = e.run({ layout: "sections" });
		await vi.waitFor(() => expect(e.menu()?.screenId).toBe("settings:appearance"));
		expect(e.menu()).toMatchObject({ kind: "settings", section: "appearance", root: true });
		expect(e.menu().sections?.map((section) => section.label)).toEqual(
			expect.arrayContaining(["Appearance", "Conversation", "Models", "Interface"]),
		);
		expect(e.records.some((record) => record.menu?.screenId === "settings:domains")).toBe(false);

		// From a page: the page is left as Back leaves it, and nothing it changed is saved.
		expect(e.act({ kind: "section", sectionId: "models" })).toMatchObject({ success: true });
		await vi.waitFor(() => expect(e.menu().screenId).toBe("settings:models"));
		e.set("Thinking level for each model");
		await vi.waitFor(() => expect(e.menu().screenId).toBe("settings-step:model"));
		expect(e.menu()).toMatchObject({ section: "models", root: false });
		const model = e.harness.session.model!;
		const modelRow = e.menu().items.find((item) => item.id.endsWith(`${model.provider}/${model.id}`))!;
		e.act({ kind: "activate", itemId: modelRow.id });
		await vi.waitFor(() => expect(e.menu().screenId).toBe("settings-step:level"));
		expect(e.act({ kind: "section", sectionId: "conversation" })).toMatchObject({ success: true });
		await vi.waitFor(() => expect(e.menu().screenId).toBe("settings:conversation"));
		expect(e.menu()).toMatchObject({ section: "conversation", root: true });
		expect(e.settings.getModelThinkingLevel(model.provider, model.id)).toBeUndefined();
		expect(e.act({ kind: "section", sectionId: "terminal" })).toMatchObject({ success: false });

		e.act({ kind: "back" });
		expect(await done).toMatchObject({ success: true, data: {} });
		expect(e.records.at(-1)?.type).toBe("view_closed");
	});

	// the window's Simple / Advanced switch, always at hand as in the terminal.
	it("says the interface mode on each screen and switches it from the dialog", async () => {
		const e = await engine();
		const done = e.run({ layout: "sections" });
		await vi.waitFor(() => expect(e.menu()?.screenId).toBe("settings:appearance"));
		const mode = () => e.menu().items.find((item) => item.id.endsWith(":interface-mode"))?.currentValue;
		expect(e.menu().interfaceMode).toBe("simple");
		expect(e.act({ kind: "interface-mode", value: "advanced" })).toMatchObject({ success: true });
		await vi.waitFor(() => expect(e.menu().interfaceMode).toBe("advanced"));
		e.act({ kind: "section", sectionId: "interface" });
		await vi.waitFor(() => expect(e.menu()?.screenId).toBe("settings:interface"));
		expect(mode()).toBe("advanced");
		expect(e.settings.getInterfaceMode()).toBe("advanced");
		expect(e.act({ kind: "interface-mode", value: "loud" })).toMatchObject({ success: false });
		e.act({ kind: "interface-mode", value: "simple" });
		await vi.waitFor(() => expect(e.menu().interfaceMode).toBe("simple"));
		expect(mode()).toBe("simple");
		e.act({ kind: "back" });
		await done;
	});

	// the window's settings search, across every domain as in the terminal.
	it("searches the settings of every domain and changes one in place", async () => {
		const e = await engine();
		const done = e.run({ layout: "sections", domain: "models" });
		await vi.waitFor(() => expect(e.menu()?.screenId).toBe("settings:models"));
		e.act({ kind: "search", query: "  APPEARANCE  " });
		await vi.waitFor(() => expect(e.menu()?.screenId).toBe("settings:search"));
		expect(e.menu()).toMatchObject({ title: "Search results", searching: "APPEARANCE", root: true });
		expect(e.menu().items.length).toBeGreaterThan(1);
		expect(e.menu().items.every((item) => item.group === "Appearance")).toBe(true);
		const row = e.menu().items.find((item) => item.values?.length === 3)!;
		const next = row.values!.find((value) => value !== row.currentValue)!;
		e.act({ kind: "setting", itemId: row.id, value: next });
		await vi.waitFor(() => expect(e.menu().items.find((item) => item.label === row.label)?.currentValue).toBe(next));
		expect(e.menu().screenId).toBe("settings:search");

		// Every word, in the label, the description or the domain.
		e.act({ kind: "search", query: "appearance zzzz" });
		await vi.waitFor(() => expect(e.menu().lines).toEqual(["No setting matches."]));
		expect(e.menu().items).toEqual([]);
		// An empty search comes back to the domain shown.
		e.act({ kind: "search", query: "" });
		await vi.waitFor(() => expect(e.menu()?.screenId).toBe("settings:models"));
		expect(e.menu().searching).toBeUndefined();
		expect(e.menu().items.every((item) => item.group === undefined)).toBe(true);
		e.act({ kind: "back" });
		await done;
	});

	it("starts the Settings dialog on the domain asked", async () => {
		const e = await engine();
		const done = e.run({ layout: "sections", domain: "models" });
		await vi.waitFor(() => expect(e.menu()?.screenId).toBe("settings:models"));
		expect(e.menu()).toMatchObject({ section: "models", root: true });
		e.act({ kind: "back" });
		await done;
	});

	it("ends with the command a row runs, for the window to run as typed", async () => {
		const e = await engine();
		const done = e.run({ domain: "other" });
		await vi.waitFor(() => expect(e.menu()?.screenId).toBe("settings:other"));
		e.set("Trust this folder");
		expect(await done).toMatchObject({ success: true, data: { line: "/trust" } });
		expect(e.records.at(-1)?.type).toBe("view_closed");
	});

	it("reloads the session after modules were turned on or off", async () => {
		const e = await engine();
		const done = e.run({ domain: "modules" });
		await vi.waitFor(() => expect(e.menu()?.screenId).toBe("settings:modules"));
		const [first] = e.menu().items;
		e.act({ kind: "setting", itemId: first!.id, value: first!.currentValue === "on" ? "off" : "on" });
		await vi.waitFor(() => expect(e.menu().items[0]?.currentValue).not.toBe(first!.currentValue));
		expect(e.reloads()).toBe(0);
		e.act({ kind: "back" });
		e.act({ kind: "back" });
		expect(await done).toMatchObject({ success: true, data: { reloaded: true } });
		expect(e.reloads()).toBe(1);
	});

	it("shows French values and saves the setting's own", async () => {
		setLanguage("fr");
		const e = await engine();
		const done = e.run({ domain: "appearance" });
		await vi.waitFor(() => expect(e.menu()?.screenId).toBe("settings:appearance"));
		const row = e.menu().items.find((item) => item.values?.length === 3)!;
		expect(row.values).not.toEqual(["off", "final", "streaming"]);
		e.act({ kind: "setting", itemId: row.id, value: row.values![1] });
		await vi.waitFor(() => expect(e.settings.getMermaidRenderingMode()).toBe("final"));
		e.act({ kind: "back" });
		e.act({ kind: "back" });
		await done;
	});

	it("changes a model's thinking level step by step", async () => {
		const e = await engine();
		// the per-model levels are an advanced setting.
		e.settings.setInterfaceMode("advanced");
		const done = e.run({ domain: "models" });
		await vi.waitFor(() => expect(e.menu()?.screenId).toBe("settings:models"));
		e.set("Thinking level for each model");
		await vi.waitFor(() => expect(e.menu().screenId).toBe("settings-step:model"));
		const model = e.harness.session.model!;
		const modelRow = e.menu().items.find((item) => item.id.endsWith(`${model.provider}/${model.id}`))!;
		e.act({ kind: "activate", itemId: modelRow.id });
		await vi.waitFor(() => expect(e.menu().screenId).toBe("settings-step:level"));
		// The levels the model has ("off" only without reasoning).
		const [level] = e.menu().items;
		e.act({ kind: "activate", itemId: level!.id });
		// The steps loop back to the model, as in the terminal.
		await vi.waitFor(() => expect(e.menu().screenId).toBe("settings-step:model"));
		expect(level!.id.endsWith(`:${e.settings.getModelThinkingLevel(model.provider, model.id)}`)).toBe(true);
		e.act({ kind: "back" });
		await vi.waitFor(() => expect(e.row("Thinking level for each model").currentValue).toBe("1 configured"));
		e.act({ kind: "back" });
		e.act({ kind: "back" });
		await done;
	});

	it("is refused without native screens", async () => {
		const e = await engine(false);
		await expect(e.run()).rejects.toThrow("/settings opens in the terminal or the Prism window.");
	});
});
