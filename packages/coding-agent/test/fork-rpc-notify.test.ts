// the desktop notifications in the Prism window, in its Settings › Notifications (the `settings`
// command, settings-native.ts) over the real view transport; the section applies and saves each change itself. There
// is no /notify command any more: the settings hold all it did.
import type * as ChildProcess from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const childProcessMocks = vi.hoisted(() => ({ execFile: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof ChildProcess>()),
	execFile: childProcessMocks.execFile,
}));

import { ENV_AGENT_DIR } from "../src/config.ts";
import { setLanguage } from "../src/fork/i18n/index.ts";
import { setViewsClient } from "../src/fork/interactive-client.ts";
import notifyExtension from "../src/fork/notify.ts";
import { handleBuiltinCommand } from "../src/fork/rpc-builtins.ts";
import { RpcViews } from "../src/fork/rpc-views.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

interface Item {
	id: string;
	label: string;
	description?: string;
	currentValue: string;
	values?: string[];
}
interface Menu {
	screenId: string;
	kind: string;
	title: string;
	hint?: string;
	items: Item[];
}
type Record_ = { type: string; id?: string; menu?: Menu };
type Callback = (error: Error | null, stdout: string, stderr: string) => void;

describe("fork: desktop notifications in the window's settings", () => {
	let dir: string;
	const harnesses: Harness[] = [];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "prism-notify-native-"));
		vi.stubEnv(ENV_AGENT_DIR, dir);
		childProcessMocks.execFile.mockReset();
		initTheme("dark");
	});
	afterEach(() => {
		setViewsClient();
		setLanguage("en");
		for (const harness of harnesses.splice(0)) harness.cleanup();
		vi.unstubAllEnvs();
		rmSync(dir, { recursive: true, force: true });
	});

	async function engine() {
		const records: Record_[] = [];
		const notes: [string, string | undefined][] = [];
		const views = new RpcViews((record) => records.push(record as Record_));
		views.handleCommand({ type: "set_views", columns: 100, rows: 30, nativeMenus: true });
		const harness = await createHarness({ extensionFactories: [{ name: "notify", factory: notifyExtension }] });
		harnesses.push(harness);
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				custom: (factory, opts) => views.custom(factory, opts),
				notify: (message, type) => notes.push([message, type]),
			}),
			mode: "rpc",
		});
		const menu = () => records.filter((record) => record.type === "view_frame").at(-1)?.menu as Menu;
		const viewId = () => records.filter((record) => record.type === "view_open").at(-1)?.id ?? "";
		const act = (action: object) => views.handleCommand({ type: "view_action", viewId: viewId(), action });
		const row = (label: string) => {
			const found = menu().items.find((item) => item.label === label);
			if (!found) throw new Error(`No row ${label} in ${menu().title}`);
			return found;
		};
		const set = (label: string, value: string) => act({ kind: "setting", itemId: row(label).id, value });
		const run = () =>
			handleBuiltinCommand(
				{ type: "settings", id: "settings-id", domain: "notifications" },
				harness.session,
				{} as never,
				views,
				async () => {},
			);
		const saved = () => JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).desktopNotifications;
		return { harness, records, notes, menu, act, row, set, run, saved };
	}

	it("shows the section's rows, applies and saves a change, and sends a test", async () => {
		const e = await engine();
		const done = e.run();
		await vi.waitFor(() => expect(e.menu()?.screenId).toBe("settings:notifications"));
		expect(e.menu()).toMatchObject({ kind: "settings", title: "Notifications" });
		expect(e.menu().items.map((item) => [item.label, item.currentValue, item.values])).toEqual([
			// The engine's own row of the domain comes first.
			["Local to cloud warning", "on", ["on", "off"]],
			["Desktop notifications", "on", ["on", "off"]],
			["Approval notifications", "on", ["on", "off"]],
			// One value: drawn as a button that sends it.
			["Test notification", "send", undefined],
		]);
		expect(e.row("Desktop notifications").description).not.toContain("/notify");
		expect(e.row("Test notification").description).toBe("Sends a desktop notification now.");

		const before = e.row("Approval notifications").id;
		expect(e.set("Approval notifications", "off")).toMatchObject({ success: true });
		await vi.waitFor(() => expect(e.row("Approval notifications").currentValue).toBe("off"));
		expect(e.saved()).toEqual({ approvals: false });
		// The rows are rebuilt: an action on the previous screen is refused, as is a value the row does not have.
		expect(e.act({ kind: "setting", itemId: before, value: "on" })).toMatchObject({ success: false });
		expect(e.set("Desktop notifications", "maybe")).toMatchObject({ success: false });

		childProcessMocks.execFile.mockImplementationOnce((_file: string, _args: string[], callback: Callback) =>
			callback(null, "61\n", ""),
		);
		e.set("Test notification", "send");
		await vi.waitFor(() => expect(e.notes.at(-1)?.[0]).toContain("61"));
		// fork: by the path the host-program rule finds, never the bare name.
		expect(basename(String(childProcessMocks.execFile.mock.calls[0]?.[0]))).toBe("notify-send");

		e.act({ kind: "back" });
		e.act({ kind: "back" });
		await done;
		expect(e.records.at(-1)?.type).toBe("view_closed");
	});

	it("has no /notify command", async () => {
		const e = await engine();
		expect(e.harness.session.extensionRunner.getCommand("notify")).toBeUndefined();
	});

	it("shows French values and gives the section its own", async () => {
		setLanguage("fr");
		const e = await engine();
		const done = e.run();
		await vi.waitFor(() => expect(e.menu()?.screenId).toBe("settings:notifications"));
		expect(e.row("Notifications de bureau")).toMatchObject({
			currentValue: "activé",
			values: ["activé", "désactivé"],
		});
		// An action row shows its one value translated, as the terminal does.
		expect(e.row("Notification de test").currentValue).toBe("envoyer");
		e.set("Notifications de bureau", "désactivé");
		await vi.waitFor(() => expect(e.row("Notifications de bureau").currentValue).toBe("désactivé"));
		expect(e.saved()).toEqual({ enabled: false });
		e.act({ kind: "back" });
		e.act({ kind: "back" });
		await done;
	});
});
