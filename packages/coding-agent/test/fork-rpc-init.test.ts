// `/init` as native screens over the real view transport; the command keeps resolving the plan,
// building the review and starting the turn with Prism's instruction.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setViewsClient } from "../src/fork/interactive-client.ts";
import projectContinuity from "../src/fork/project-continuity.ts";
import { RpcViews } from "../src/fork/rpc-views.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, createTestUiContext, getMessageText, type Harness } from "./suite/harness.ts";

interface Item {
	id: string;
	label: string;
}
interface Menu {
	screenId: string;
	kind: string;
	title: string;
	lines?: string[];
	hint?: string;
	items?: Item[];
	content?: string;
	format?: { kind: string };
	confirm?: Item;
	multiline?: boolean;
	value?: string;
}
type Record_ = { type: string; id?: string; menu?: Menu };

describe("fork: native /init", () => {
	const harnesses: Harness[] = [];

	beforeEach(() => initTheme("dark"));
	afterEach(() => {
		setViewsClient();
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function engine(setup: (cwd: string) => void = () => {}) {
		const records: Record_[] = [];
		const notes: string[] = [];
		// The terminal's dialogs: none opens in the window.
		const dialogs: string[] = [];
		const views = new RpcViews((record) => records.push(record as Record_));
		views.handleCommand({ type: "set_views", columns: 100, rows: 30, nativeMenus: true });
		const harness = await createHarness({
			extensionFactories: [{ name: "project-continuity", factory: projectContinuity }],
		});
		harnesses.push(harness);
		setup(harness.tempDir);
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				custom: (factory, opts) => views.custom(factory, opts),
				notify: (message) => void notes.push(message),
				select: async (title) => void dialogs.push(title),
				editor: async (title) => void dialogs.push(title),
				confirm: async (title) => {
					dialogs.push(title);
					return false;
				},
			}),
			mode: "rpc",
		});
		const prompts: string[] = [];
		harness.setResponses([
			() => {
				prompts.push(harness.session.systemPrompt);
				return fauxAssistantMessage("ok");
			},
		]);
		const menu = () => records.filter((record) => record.type === "view_frame").at(-1)?.menu as Menu;
		const viewId = () => records.filter((record) => record.type === "view_open").at(-1)?.id ?? "";
		const act = (action: object) => views.handleCommand({ type: "view_action", viewId: viewId(), action });
		const close = () => views.handleCommand({ type: "view_close", viewId: viewId() });
		const at = (screenId: string) => vi.waitFor(() => expect(menu()?.screenId).toBe(screenId));
		const choose = (label: string) => {
			const item = menu().items?.find((entry) => entry.label === label);
			if (!item) throw new Error(`No item ${label} in ${menu().title}`);
			return act({ kind: "activate", itemId: item.id });
		};
		const confirm = () => act({ kind: "activate", itemId: menu().confirm?.id });
		const sent = () =>
			harness.session.messages.flatMap((message) => (message.role === "user" ? [getMessageText(message)] : []));
		/** Runs /init; the turn it starts is not awaited by the command. */
		const run = (args = "") => harness.session.prompt(`/init${args ? ` ${args}` : ""}`);
		const settled = async (turn: boolean) => {
			if (turn) await vi.waitFor(() => expect(prompts.length).toBeGreaterThan(0), { timeout: 5_000 });
			// The request /init sends is not awaited: leave it time to start if it was wrongly sent.
			else await new Promise((done) => setTimeout(done, 200));
			await harness.session.waitForIdle();
		};
		return { harness, records, notes, dialogs, prompts, menu, act, close, at, choose, confirm, sent, run, settled };
	}

	// without a plan, /init offers to write one first in plan mode.
	it("offers to plan first in plan mode when there is no plan and plan mode is off", async () => {
		const key = Symbol.for("prism.plan-mode");
		let on = false;
		let toggles = 0;
		(globalThis as Record<symbol, unknown>)[key] = {
			toggle: () => {
				toggles++;
				on = !on;
			},
			enabled: () => on,
		};
		try {
			const e = await engine();
			const done = e.run();
			await e.at("start");
			expect(e.menu().items?.map((item) => item.label)).toEqual([
				"From a plan",
				"From the existing repository",
				"No plan yet: write one first in plan mode",
			]);
			e.choose("No plan yet: write one first in plan mode");
			await done;
			await e.settled(false);
			expect(toggles).toBe(1);
			expect(e.notes.some((note) => note.includes("export it (PLAN.md) and run /init again"))).toBe(true);
			expect(e.prompts).toHaveLength(0);

			// Plan mode already on, or a plan in the project: not offered.
			const again = e.run();
			await vi.waitFor(() => expect(e.menu()?.screenId === "start" && e.menu().items?.length === 2).toBe(true));
			e.act({ kind: "back" });
			await again;
			on = false;
			writeFileSync(join(e.harness.tempDir, "PLAN.md"), "# Plan\n");
			const withPlan = e.run();
			await vi.waitFor(() =>
				expect(e.menu()?.items?.map((item) => item.label)).toEqual([
					"From the plan PLAN.md",
					"From a plan",
					"From the existing repository",
				]),
			);
			e.act({ kind: "back" });
			await withPlan;
		} finally {
			delete (globalThis as Record<symbol, unknown>)[key];
		}
	});

	it("offers the starting points in the terminal's order, reviews the documents and starts from the repository", async () => {
		const e = await engine((cwd) => {
			writeFileSync(join(cwd, "package.json"), "{}");
			writeFileSync(join(cwd, "AGENTS.md"), "# rules\n");
			writeFileSync(join(cwd, "README.md"), "# app\n");
			writeFileSync(join(cwd, "PLAN.md"), "# Plan\n");
		});
		const done = e.run();
		await e.at("start");
		expect(e.menu()).toMatchObject({ kind: "choice", title: "Start from", hint: "close" });
		expect(e.menu().items?.map((item) => item.label)).toEqual([
			"From the plan PLAN.md",
			"From the existing repository",
			"From a plan",
		]);
		const stale = e.menu().items![0]!.id;

		e.choose("From the existing repository");
		await e.at("review");
		expect(e.menu()).toMatchObject({
			kind: "review",
			title: "Set up project continuity?",
			hint: "back",
			format: { kind: "markdown" },
			confirm: { label: "Set up" },
		});
		expect(e.menu().lines).toEqual([`Project: ${e.harness.tempDir}`, "Starting point: the existing repository"]);
		expect(e.menu().content).toContain("| adapt | `AGENTS.md` |");
		expect(e.menu().content).toContain("| create | `project/SPEC.md` |");
		expect(e.menu().content).toContain("Already present, reused rather than copied: README.md");
		expect(e.menu().content).toContain("your permission rules apply");
		expect(e.act({ kind: "activate", itemId: stale })).toMatchObject({ success: false });

		e.act({ kind: "back" });
		await e.at("start");
		e.choose("From the existing repository");
		await e.at("review");
		e.confirm();
		await done;
		await e.settled(true);
		expect(e.sent()).toEqual(["/init"]);
		expect(e.prompts[0]).toContain(
			"The user ran /init: set up the project continuity documents from the existing repository.",
		);
		expect(e.dialogs).toEqual([]);
		expect(e.records.some((record) => record.type === "view_closed")).toBe(true);
	});

	it("asks for a pasted plan on a multi-line field, keeps it on Back and sends it as the user's message", async () => {
		const e = await engine();
		const done = e.run();
		await e.at("start");
		// An empty folder: a plan first.
		expect(e.menu().items?.map((item) => item.label)).toEqual(["From a plan", "From the existing repository"]);
		e.choose("From a plan");
		await e.at("plan");
		expect(e.menu()).toMatchObject({
			kind: "input",
			title: "Paste the plan, or the path of a plan file",
			multiline: true,
			value: "",
			hint: "back",
		});
		const plan = "Build a todo CLI\n- add, list, done";
		e.act({ kind: "input", value: `${plan}\n` });
		await e.at("review");
		expect(e.menu().lines?.[1]).toBe("Starting point: your plan");
		e.act({ kind: "back" });
		await e.at("plan");
		expect(e.menu().value).toBe(plan);
		e.act({ kind: "input", value: plan });
		await e.at("review");
		e.confirm();
		await done;
		await e.settled(true);
		expect(e.sent()).toEqual([plan]);
		expect(e.prompts[0]).toContain("from the plan in their message");
	});

	it("reads a plan file named in the field, and an empty plan ends /init", async () => {
		const e = await engine((cwd) => writeFileSync(join(cwd, "notes.txt"), "# Plan\n"));
		let done = e.run();
		await e.at("start");
		e.choose("From a plan");
		await e.at("plan");
		e.act({ kind: "input", value: "  " });
		await done;
		await e.settled(false);
		expect(e.prompts).toEqual([]);
		expect(e.notes).toEqual([]);

		done = e.run();
		await e.at("start");
		e.choose("From a plan");
		await e.at("plan");
		e.act({ kind: "input", value: "notes.txt" });
		await e.at("review");
		e.confirm();
		await done;
		await e.settled(true);
		expect(e.sent()).toEqual(["/init"]);
		expect(e.prompts[0]).toContain(`from the plan in ${join(e.harness.tempDir, "notes.txt")}`);
	});

	it("closing on the confirmation writes nothing and says so; closing before says nothing", async () => {
		const e = await engine();
		let done = e.run();
		await e.at("start");
		expect(e.close()).toMatchObject({ success: true });
		await done;
		expect(e.notes).toEqual([]);

		done = e.run();
		await e.at("start");
		e.choose("From the existing repository");
		await e.at("review");
		e.close();
		await done;
		await e.settled(false);
		expect(e.notes).toEqual(["Nothing was written."]);
		expect(e.prompts).toEqual([]);
		expect(e.sent()).toEqual([]);
		expect(existsSync(join(e.harness.tempDir, "project"))).toBe(false);
	});

	it("with a plan on the command line, shows only the confirmation; Back refuses", async () => {
		const e = await engine();
		let done = e.run("Build a todo CLI");
		await e.at("review");
		expect(e.menu().lines?.[1]).toBe("Starting point: your plan");
		e.act({ kind: "back" });
		await done;
		await e.settled(false);
		expect(e.notes).toEqual(["Nothing was written."]);
		expect(e.prompts).toEqual([]);

		done = e.run("Build a todo CLI");
		await e.at("review");
		e.confirm();
		await done;
		await e.settled(true);
		expect(e.sent()).toEqual(["/init Build a todo CLI"]);
	});
});
