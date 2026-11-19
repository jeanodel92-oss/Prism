// `/export-zip` as native screens over the real view transport; the command keeps its checks (no
// session, size limit), the files offered and refused, the archive's contents and its writing.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { setViewsClient } from "../src/fork/interactive-client.ts";
import { portableExport } from "../src/fork/portable-export.ts";
import { RpcViews } from "../src/fork/rpc-views.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

interface Item {
	id: string;
	label: string;
	description?: string;
	selected?: boolean;
}
interface Menu {
	screenId: string;
	kind: string;
	title: string;
	lines?: string[];
	errors?: string[];
	hint?: string;
	items?: Item[];
	actions?: Item[];
	content?: string;
	format?: { kind: string };
	confirm?: Item;
	value?: string;
}
type Record_ = { type: string; id?: string; menu?: Menu };

describe("fork: native /export-zip", () => {
	let root: string;
	let cwd: string;
	let sessionDir: string;

	beforeEach(() => {
		initTheme("dark");
		root = mkdtempSync(join(tmpdir(), "prism-export-native-"));
		cwd = join(root, "project");
		sessionDir = join(root, "sessions");
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, "AGENTS.md"), "# Rules\n");
		writeFileSync(join(cwd, "src", "app.ts"), "export const a = 1;\n");
		writeFileSync(join(cwd, ".env"), "API_KEY=test\n");
	});
	afterEach(() => {
		setViewsClient();
		rmSync(root, { recursive: true, force: true });
	});

	/** A saved session whose assistant wrote `src/app.ts`, `.env` (refused) and `src/gone.ts` (missing). */
	function session(id: string, text: string, name?: string): SessionManager {
		const manager = SessionManager.create(cwd, sessionDir, { id });
		if (name) manager.appendSessionInfo(name);
		manager.appendMessage({ role: "user", content: text, timestamp: Date.parse("2026-10-28T10:00:00Z") });
		manager.appendMessage({
			role: "assistant",
			content: [
				{ type: "text", text: "Done." },
				{ type: "toolCall", id: "c1", name: "write", arguments: { path: "src/app.ts", content: "x" } },
				{ type: "toolCall", id: "c2", name: "edit", arguments: { path: ".env", edits: [] } },
				{ type: "toolCall", id: "c3", name: "write", arguments: { path: "src/gone.ts", content: "z" } },
			],
			api: "openai-completions",
			provider: "faux",
			model: "faux-model",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.parse("2026-10-28T10:00:05Z"),
		});
		return manager;
	}

	function engine(current: SessionManager, maxSessionBytes?: number) {
		let command: RegisteredCommand | undefined;
		portableExport(
			{
				registerCommand: (_name: string, options: RegisteredCommand) => {
					command = options;
				},
			} as unknown as ExtensionAPI,
			maxSessionBytes,
		);
		const records: Record_[] = [];
		const notes: [string, string | undefined][] = [];
		// The terminal's dialogs: none opens in the window.
		const dialogs: string[] = [];
		const views = new RpcViews((record) => records.push(record as Record_));
		views.handleCommand({ type: "set_views", columns: 100, rows: 30, nativeMenus: true });
		const ctx = {
			hasUI: true,
			mode: "rpc",
			cwd,
			sessionManager: current,
			ui: {
				custom: (factory: never, options: never) => views.custom(factory, options),
				notify: (message: string, type?: string) => notes.push([message, type]),
				select: async (title: string) => void dialogs.push(title),
				confirm: async (title: string) => void dialogs.push(title),
			},
		} as unknown as ExtensionCommandContext;
		const menu = () => records.filter((record) => record.type === "view_frame").at(-1)?.menu as Menu;
		const viewId = () => records.filter((record) => record.type === "view_open").at(-1)?.id ?? "";
		const act = (action: object) => views.handleCommand({ type: "view_action", viewId: viewId(), action });
		const close = () => views.handleCommand({ type: "view_close", viewId: viewId() });
		const at = (screenId: string) => vi.waitFor(() => expect(menu()?.screenId).toBe(screenId));
		const item = (label: string) => {
			const found = [...(menu().items ?? []), ...(menu().actions ?? [])].find((entry) => entry.label === label);
			if (!found) throw new Error(`No item ${label} in ${menu().title}`);
			return found;
		};
		const toggle = (label: string, selected: boolean) =>
			act({ kind: "multiSelect", itemId: item(label).id, selected });
		const next = () => act({ kind: "activate", itemId: item("Continue").id });
		const confirm = () => act({ kind: "activate", itemId: menu().confirm?.id });
		const archives = () => readdirSync(cwd).filter((name) => name.endsWith(".zip"));
		const run = () => command!.handler("", ctx);
		return { records, notes, dialogs, menu, act, close, at, item, toggle, next, confirm, archives, run };
	}

	it("checks the current session, offers the written files unchecked, reviews and writes the archive", async () => {
		session("s1", "older work", "Older");
		const current = session("s2", "current work");
		const e = engine(current);
		const done = e.run();
		await e.at("sessions");
		expect(e.menu()).toMatchObject({ kind: "multiSelect", title: "Sessions to export", hint: "close" });
		expect(e.item("current work")).toMatchObject({ selected: true });
		expect(e.item("current work").description).toMatch(/^2026-.* · 2 messages · this session$/);
		expect(e.item("Older")).toMatchObject({ selected: false });
		const stale = e.item("Older").id;

		e.next();
		await e.at("files");
		expect(e.menu()).toMatchObject({ title: "Files to include (none by default)", hint: "back" });
		// `.env` is refused, never offered; a file no longer on disk says so.
		expect(e.menu().items?.map((entry) => [entry.label, entry.selected])).toEqual([
			["AGENTS.md", false],
			["src/app.ts", false],
			["src/gone.ts (missing)", false],
		]);
		expect(e.act({ kind: "activate", itemId: stale })).toMatchObject({ success: false });
		e.toggle("src/app.ts", true);
		await vi.waitFor(() => expect(e.item("src/app.ts").selected).toBe(true));

		// Back to the sessions and on again: the file keeps its mark.
		e.act({ kind: "back" });
		await e.at("sessions");
		e.toggle("Older", true);
		await vi.waitFor(() => expect(e.item("Older").selected).toBe(true));
		e.next();
		await e.at("files");
		expect(e.item("src/app.ts").selected).toBe(true);
		e.next();

		await e.at("review");
		expect(e.menu()).toMatchObject({
			kind: "review",
			title: "Portable export",
			hint: "back",
			format: { kind: "markdown" },
			confirm: { label: "Create the archive" },
		});
		expect(e.menu().lines?.[0]).toBe("Sessions: 2");
		expect(e.menu().lines?.[1]).toMatch(/^Archive: .*-export-\d{8}-\d{4}\.zip$/);
		expect(e.menu().content).toContain("- Files: src/app.ts");
		expect(e.menu().content).toContain("- Left out: .env (may hold credentials)");
		expect(e.menu().content).toContain("Not analysed:");
		e.act({ kind: "back" });
		await e.at("files");
		e.next();
		await e.at("review");
		e.confirm();
		await done;
		expect(e.archives()).toHaveLength(1);
		expect(e.notes).toEqual([[expect.stringMatching(/^Archive written: .*\.zip$/), "info"]]);
		expect(e.dialogs).toEqual([]);
		expect(e.records.at(-1)?.type).toBe("view_closed");
	});

	it("shows no session and too-large sessions on the sessions screen, and writes nothing", async () => {
		const current = session("s1", "current work");
		const e = engine(current, 10);
		const done = e.run();
		await e.at("sessions");
		e.toggle("current work", false);
		await vi.waitFor(() => expect(e.item("current work").selected).toBe(false));
		e.next();
		await vi.waitFor(() => expect(e.menu().errors).toEqual(["No session chosen: nothing exported."]));
		expect(e.menu().screenId).toBe("sessions");

		e.toggle("current work", true);
		// A new choice clears the error.
		await vi.waitFor(() => expect(e.menu().errors).toBeUndefined());
		e.next();
		await vi.waitFor(() => expect(e.menu().errors?.[0]).toMatch(/an archive can hold: nothing exported/));
		expect(e.menu().screenId).toBe("sessions");
		e.close();
		await done;
		expect(e.notes).toEqual([]);
		expect(e.archives()).toEqual([]);
	});

	it("goes from the sessions to the review when no file is offered; an existing archive is not overwritten", async () => {
		rmSync(join(cwd, "AGENTS.md"));
		const current = SessionManager.create(cwd, sessionDir, { id: "s1" });
		current.appendMessage({ role: "user", content: "just talk", timestamp: Date.parse("2026-10-28T10:00:00Z") });
		const e = engine(current);
		const done = e.run();
		await e.at("sessions");
		e.next();
		await e.at("review");
		expect(e.menu().content).toContain("- Files: none");
		// Back returns to the sessions, the only screen before.
		e.act({ kind: "back" });
		await e.at("sessions");
		e.next();
		await e.at("review");
		const target = e.menu().lines![1]!.slice("Archive: ".length);
		writeFileSync(target, "kept");
		e.confirm();
		await done;
		expect(e.notes).toEqual([[`${target} already exists: nothing written.`, "warning"]]);
	});

	it("changes the archive's destination from the review: a field, its problems, Back keeps the one shown", async () => {
		mkdirSync(join(root, "out"));
		const current = session("s1", "current work");
		const e = engine(current);
		const done = e.run();
		await e.at("sessions");
		e.next();
		await e.at("files");
		e.next();
		await e.at("review");
		expect(e.menu().actions?.map((action) => action.label)).toEqual(["Change the destination"]);
		const generated = e.menu().lines![1]!.slice("Archive: ".length);
		e.act({ kind: "activate", itemId: e.item("Change the destination").id });
		await e.at("destination");
		expect(e.menu()).toMatchObject({
			kind: "input",
			title: "Archive destination (a file or a folder)",
			value: generated,
			hint: "back",
		});
		e.act({ kind: "input", value: "nowhere/a" });
		await vi.waitFor(() => expect(e.menu().errors).toEqual([`Folder not found: ${join(cwd, "nowhere")}`]));
		expect(e.menu()).toMatchObject({ screenId: "destination", value: "nowhere/a" });
		e.act({ kind: "back" });
		await e.at("review");
		expect(e.menu().lines?.[1]).toBe(`Archive: ${generated}`);

		e.act({ kind: "activate", itemId: e.item("Change the destination").id });
		await e.at("destination");
		e.act({ kind: "input", value: "../out" });
		await e.at("review");
		const target = join(root, "out", generated.slice(cwd.length + 1));
		expect(e.menu().lines?.[1]).toBe(`Archive: ${target}`);
		e.confirm();
		await done;
		expect(e.notes).toEqual([[`Archive written: ${target}`, "info"]]);
		expect(e.archives()).toEqual([]);
		expect(readdirSync(join(root, "out"))).toHaveLength(1);
	});

	it("closing on the review writes nothing", async () => {
		const current = session("s1", "current work");
		const e = engine(current);
		const done = e.run();
		await e.at("sessions");
		e.next();
		await e.at("files");
		e.next();
		await e.at("review");
		expect(e.close()).toMatchObject({ success: true });
		await done;
		expect(e.notes).toEqual([]);
		expect(e.archives()).toEqual([]);
	});
});
