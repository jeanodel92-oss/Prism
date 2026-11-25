// `/onboarding` as native screens over the real view transport; the command keeps writing the
// choices, applying the permission mode and the modules, and reloading.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { setLanguage } from "../src/fork/i18n/index.ts";
import { setViewsClient } from "../src/fork/interactive-client.ts";
import onboarding, { onboardingPath } from "../src/fork/onboarding.ts";
import permissionsExtension from "../src/fork/permissions.ts";
import { RpcViews } from "../src/fork/rpc-views.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

interface Item {
	id: string;
	label: string;
	description?: string;
	details?: string[];
	selected?: boolean;
}
interface Menu {
	screenId: string;
	kind: string;
	title: string;
	lines?: string[];
	hint?: string;
	items: Item[];
	actions?: Item[];
	currentItemId?: string;
}
type Record_ = { type: string; id?: string; menu?: Menu };

describe("fork: native /onboarding", () => {
	let agentDir: string;
	const harnesses: Harness[] = [];

	beforeEach(() => {
		initTheme("dark");
		agentDir = mkdtempSync(join(tmpdir(), "prism-onboarding-native-"));
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
	});
	afterEach(() => {
		setViewsClient();
		setLanguage("en");
		for (const harness of harnesses.splice(0)) harness.cleanup();
		vi.unstubAllEnvs();
		rmSync(agentDir, { recursive: true, force: true });
	});

	async function engine(accept = true) {
		const records: Record_[] = [];
		const notes: string[] = [];
		const selects: string[] = [];
		const views = new RpcViews((record) => records.push(record as Record_));
		views.handleCommand({ type: "set_views", columns: 100, rows: 30, nativeMenus: true });
		const harness = await createHarness({
			extensionFactories: [
				{ name: "permissions", factory: permissionsExtension },
				{ name: "onboarding", factory: onboarding },
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				custom: (factory, opts) => views.custom(factory, opts),
				notify: (message) => notes.push(message),
				select: async (title, choices) => {
					selects.push(title);
					return accept ? choices[0] : choices.at(-1);
				},
			}),
			mode: "rpc",
		});
		// The command's `ctx.reload()`; this harness binds no session actions, so it is observed where the runner calls it.
		const reload = vi.fn(async () => {});
		(harness.session.extensionRunner as unknown as { reloadHandler: () => Promise<void> }).reloadHandler = reload;
		const menu = () => records.filter((record) => record.type === "view_frame").at(-1)?.menu as Menu;
		const viewId = () => records.filter((record) => record.type === "view_open").at(-1)?.id ?? "";
		const act = (action: object) => views.handleCommand({ type: "view_action", viewId: viewId(), action });
		const item = (label: string) => {
			const found = [...(menu().items ?? []), ...(menu().actions ?? [])].find((entry) => entry.label === label);
			if (!found) throw new Error(`No item ${label} in ${menu().title}: ${menu().items.map((i) => i.label)}`);
			return found;
		};
		const choose = async (step: string, label: string) => {
			await vi.waitFor(() => expect(menu()?.screenId).toBe(`step:${step}`));
			return act({ kind: "activate", itemId: item(label).id });
		};
		const toggle = (label: string, selected: boolean) =>
			act({ kind: "multiSelect", itemId: item(label).id, selected });
		const settings = () => JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
		const permissions = () => JSON.parse(readFileSync(join(agentDir, "permissions.json"), "utf8"));
		const done = () => JSON.parse(readFileSync(onboardingPath(agentDir), "utf8"));
		const close = () => views.handleCommand({ type: "view_close", viewId: viewId() });
		const run = () => harness.session.prompt("/onboarding");
		return {
			records,
			notes,
			selects,
			reload,
			menu,
			act,
			close,
			item,
			choose,
			toggle,
			settings,
			permissions,
			done,
			run,
		};
	}

	it("walks every step, goes back, and saves the choices, the permission mode and the modules", async () => {
		const e = await engine();
		const finished = e.run();
		await vi.waitFor(() => expect(e.menu()?.screenId).toBe("step:language"));
		expect(e.menu()).toMatchObject({ kind: "choice", title: "Language", hint: "close" });
		expect(e.menu().lines).toEqual([
			"Welcome to Prism · Step 1 of 7",
			"The language of Prism's own interface. The model answers in the language you write in.",
		]);
		expect(e.menu().currentItemId).toBe(e.item("Automatic").id);

		// The next steps are worded in the chosen language; Back returns with the answer marked. No theme step:
		// the window's theme is Window › Theme.
		await e.choose("language", "Français");
		await vi.waitFor(() => expect(e.menu().screenId).toBe("step:display"));
		expect(e.menu()).toMatchObject({ title: "Affichage", hint: "back" });
		e.act({ kind: "back" });
		await vi.waitFor(() => expect(e.menu().screenId).toBe("step:language"));
		expect(e.menu().title).toBe("Langue");
		expect(e.menu().currentItemId).toBe(e.item("Français").id);
		await e.choose("language", "English");

		await e.choose("display", "Advanced");
		await vi.waitFor(() => expect(e.menu().screenId).toBe("step:permissions"));
		// Unrestricted shows what to know before choosing it.
		expect(e.item("Unrestricted").details?.[0]).toContain("No confirmation for anything");
		const stale = e.item("Broad").id;
		await e.choose("permissions", "Read only");

		await vi.waitFor(() => expect(e.menu().screenId).toBe("step:modules"));
		expect(e.menu().kind).toBe("multiSelect");
		expect(e.item("Web search").selected).toBe(true);
		expect(e.item("Memory").selected).toBe(false);
		e.toggle("Web search", false);
		await vi.waitFor(() => expect(e.item("Web search").selected).toBe(false));
		e.toggle("Memory", true);
		await vi.waitFor(() => expect(e.item("Memory").selected).toBe(true));
		// A click left on an earlier screen is refused.
		expect(e.act({ kind: "activate", itemId: stale })).toMatchObject({ success: false });
		e.act({ kind: "activate", itemId: e.item("Continue").id });

		// fork: computer use, a step of its own, all off at first.
		await vi.waitFor(() => expect(e.menu().screenId).toBe("step:computer"));
		expect(e.item("Your browser").selected).toBe(false);
		e.act({ kind: "activate", itemId: e.item("Continue").id });

		// the privacy step, on at first; no Exa row, web search was turned off above.
		await vi.waitFor(() => expect(e.menu().screenId).toBe("step:privacy"));
		expect(e.item("Model list from pi.dev").selected).toBe(true);
		expect(e.menu().items.map((entry: { label: string }) => entry.label)).toEqual(["Model list from pi.dev"]);
		e.act({ kind: "activate", itemId: e.item("Continue").id });

		await vi.waitFor(() => expect(e.menu().screenId).toBe("step:connection"));
		await e.choose("connection", "Keep this model");
		await finished;

		expect(e.settings()).toMatchObject({ language: "en", interfaceMode: "advanced" });
		expect(e.settings().theme).toBeUndefined();
		expect(e.settings().extensions).toEqual(["-builtin:web", "+builtin:memory"]);
		expect(e.permissions().mode).toBe("safe");
		expect(e.done().skipped).toBe(false);
		expect(e.reload).toHaveBeenCalledOnce();
		expect(e.notes).toContain("Run /onboarding to go through these choices again.");
		expect(e.records.at(-1)?.type).toBe("view_closed");
	});

	it("closing the panel keeps the steps already passed and skips the rest", async () => {
		const e = await engine();
		const finished = e.run();
		await e.choose("language", "English");
		await vi.waitFor(() => expect(e.menu().screenId).toBe("step:display"));
		expect(e.close()).toMatchObject({ success: true });
		await finished;
		expect(e.settings()).toMatchObject({ language: "en" });
		expect(e.settings().interfaceMode).toBeUndefined();
		expect(existsSync(join(agentDir, "permissions.json"))).toBe(false);
		expect(e.done().skipped).toBe(true);
		expect(e.reload).not.toHaveBeenCalled();
	});

	it("Back from the first step leaves, and unrestricted still asks to accept its warning", async () => {
		const e = await engine(false);
		let finished = e.run();
		await vi.waitFor(() => expect(e.menu()?.screenId).toBe("step:language"));
		e.act({ kind: "back" });
		await finished;
		expect(e.done().skipped).toBe(true);

		finished = e.run();
		for (const [step, label] of [
			["language", "Automatic"],
			["display", "Simple"],
			["permissions", "Unrestricted"],
		] as const)
			await e.choose(step, label);
		await vi.waitFor(() => expect(e.menu().screenId).toBe("step:modules"));
		e.act({ kind: "activate", itemId: e.item("Continue").id });
		await vi.waitFor(() => expect(e.menu().screenId).toBe("step:computer"));
		e.act({ kind: "activate", itemId: e.item("Continue").id });
		await vi.waitFor(() => expect(e.menu().screenId).toBe("step:privacy"));
		e.act({ kind: "activate", itemId: e.item("Continue").id });
		await e.choose("connection", "Keep this model");
		await finished;
		expect(e.selects).toHaveLength(1);
		expect(existsSync(join(agentDir, "permissions.json"))).toBe(false);
		expect(e.notes).toContain("Unrestricted mode not enabled. Run /onboarding to go through these choices again.");
	});
});
