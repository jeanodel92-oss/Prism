// fork: the footer's essential actions (model, context, settings, more…) stay reachable at
// any width, and commands of the "more…" menu can be pinned to the footer, in a saved order.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings, TuiMainScreen, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { setLanguage } from "../src/fork/i18n/index.ts";
import { createEditorFactory } from "../src/fork/prism/editor.ts";
import { createFooterFactory, findText } from "../src/fork/prism/footer.ts";
import { autoCompactionLine, customizeFooter, readFooterActions } from "../src/fork/prism/footer-actions.ts";
import { createState, type PrismState } from "../src/fork/prism/lib/state.ts";
import { CUSTOMIZE_FOOTER, chooseFromMoreMenu } from "../src/fork/prism/more-menu.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

const plain = (line: string) => line.replace(/\x1b\[[0-9;:]*m/g, "");
const GEAR = "";

function click(x: number, y: number): TuiMouseEvent {
	return {
		type: "click",
		button: "left",
		x,
		y,
		screenX: x,
		screenY: y,
		width: 100,
		height: 6,
		shift: false,
		alt: false,
		ctrl: false,
	};
}

describe("fork: footer actions", () => {
	const dirs: string[] = [];
	const savedAgentDir = process.env[ENV_AGENT_DIR];

	beforeAll(() => {
		initTheme("prism");
		setKeybindings(new KeybindingsManager({}));
	});

	afterEach(() => {
		setLanguage("en");
		if (savedAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = savedAgentDir;
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function tempDir() {
		const root = mkdtempSync(join(tmpdir(), "prism-footer-"));
		dirs.push(root);
		return root;
	}

	function footer(state: PrismState, statuses: Record<string, string>) {
		const root = tempDir();
		process.env[ENV_AGENT_DIR] = join(root, "agent");
		state.theme = theme;
		state.ctx = {
			cwd: root,
			isProjectTrusted: () => true,
			model: { provider: "p", id: "m", contextWindow: 100_000 },
			modelRegistry: { isUsingOAuth: () => false },
			getContextUsage: () => ({ tokens: 4900, contextWindow: 100_000, percent: 4.9 }),
			sessionManager: {
				getEntries: () => [],
				getSessionId: () => "s",
				getLeafId: () => "l",
				getCwd: () => root,
				getSessionName: () => undefined,
			},
		} as never;
		const footerData = {
			getGitBranch: () => "feature/a-rather-long-branch-name",
			getExtensionStatuses: () => new Map(Object.entries(statuses)),
			onBranchChange: () => () => {},
		};
		return createFooterFactory(state)({ requestRender() {} }, theme, footerData);
	}

	function wired(pinned: string[] = []) {
		const state = createState();
		state.openMenu = vi.fn();
		state.openCommand = vi.fn();
		state.runAction = vi.fn();
		state.openContext = vi.fn();
		state.footerActions = () => pinned;
		return state;
	}

	// Many long statuses, as in a split screen with Plan, Goal and a server running.
	const BUSY = {
		permissions: "perm: unrestricted (sandbox not working)",
		"plan-mode": "plan active · step 3 of 7",
		goal: "active 12m · automatic 4/25",
		zz: "a long status from another extension",
	};

	it("keeps the settings gear and more… whole at 40, 64 and 120 columns, the statuses cut instead", () => {
		const state = wired();
		const view = footer(state, BUSY);
		for (const width of [40, 52, 64, 120]) {
			const lines = view.render(width).map(plain);
			for (const line of lines) expect([...line].length, `${width}: ${line}`).toBeLessThanOrEqual(width);
			expect(lines.join("\n")).not.toContain("……");
			const more = findText(lines, "• more…");
			const gear = findText(lines, `• ${GEAR}`);
			expect(more, `${width}: ${lines.join(" | ")}`).toBeDefined();
			expect(gear, `${width}: ${lines.join(" | ")}`).toBeDefined();
			view.handleMouse(click(more!.from + 2, more!.row));
			view.handleMouse(click(gear!.from + 2, gear!.row));
		}
		expect(state.openMenu).toHaveBeenCalledTimes(4);
		expect(state.runAction).toHaveBeenCalledTimes(4);
		expect(state.runAction).toHaveBeenCalledWith("settings");
		expect(state.openCommand).not.toHaveBeenCalled();
	});

	it("shows pinned commands in their order, and leaves those that do not fit in more…", () => {
		const state = wired(["docs", "tree"]);
		const view = footer(state, { permissions: "perm: ask" });
		const wide = view.render(140).map(plain);
		const docs = findText(wide, "• /docs")!;
		const tree = findText(wide, "• /tree")!;
		expect(docs.from).toBeLessThan(tree.from);
		expect(findText(wide, `• ${GEAR}`)!.from).toBeGreaterThan(tree.from);
		view.handleMouse(click(tree.from + 2, tree.row));
		expect(state.runAction).toHaveBeenLastCalledWith("tree");

		const narrow = footer(wired(["docs", "tree"]), BUSY)
			.render(40)
			.map(plain);
		expect(narrow.join("\n")).not.toContain("/tree");
		expect(findText(narrow, "• more…")).toBeDefined();
	});

	it("opens /context from the gauge, with what it measures and whether auto is on", () => {
		const state = wired();
		const view = footer(state, {});
		const lines = view.render(120).map(plain);
		const gauge = findText(lines, "4.9%/100k auto")!;
		expect(gauge).toBeDefined();
		view.handleMouse(click(gauge.from + 1, gauge.row));
		expect(state.openContext).toHaveBeenCalledWith(
			expect.objectContaining({ percent: 4.9, window: 100_000, auto: true }),
		);
	});

	// what /context says of auto-compaction, in the terminal and the window.
	it("says whether auto-compaction is on and where it starts", () => {
		expect(autoCompactionLine({ percent: 41.25, window: 200_000, auto: true, mark: 85.4 })).toBe(
			"auto: at 85%, Prism summarises the older messages to make room (auto-compaction).",
		);
		expect(autoCompactionLine({ percent: null, window: 0, auto: true })).toBe(
			"auto: when the context is nearly full, Prism summarises the older messages to make room.",
		);
		setLanguage("fr");
		expect(autoCompactionLine({ percent: null, window: 32_000, auto: false })).toContain(
			"Compaction automatique coupée",
		);
	});

	it("cycles the model on a click on its name, like its key", () => {
		const state = createState();
		state.theme = theme;
		state.ctx = { model: { id: "qwen", provider: "local" } } as unknown as ExtensionContext;
		const editor = createEditorFactory(state)(
			new TuiMainScreen(new VirtualTerminal()),
			defaultEditorTheme,
			new KeybindingsManager({}),
		) as unknown as {
			render(width: number): string[];
			handleMouse(event: TuiMouseEvent): unknown;
			actionHandlers: Map<string, () => void>;
		};
		const cycle = vi.fn();
		editor.actionHandlers.set("app.model.cycleForward", cycle);
		const info = plain(editor.render(100)[4]!);
		const at = [...info.slice(0, info.indexOf("qwen"))].length;
		expect(editor.handleMouse(click(at + 1, 4))).toEqual({ handled: true });
		expect(cycle).toHaveBeenCalledTimes(1);
	});

	it("pins, moves and removes commands from more…, saving each step", async () => {
		expect(await chooseFromMoreMenu(async (_title, options) => options.at(-1), new Set())).toBe(CUSTOMIZE_FOOTER);
		const saved: string[][] = [];
		// Each step: the command to pick in the list, then the action.
		const script = [
			["/docs", "Pin to the footer"],
			["/tree", "Pin to the footer"],
			["/tree", "Move left"],
			["/docs", "Remove from the footer"],
		];
		const titles: string[][] = [];
		let step = 0;
		let picking = true;
		const select = async (_title: string, options: string[]) => {
			if (picking) titles.push(options);
			const [command, action] = script[step] ?? [];
			if (!command) return undefined;
			const choice = picking ? options.find((option) => option.endsWith(command)) : action;
			if (!picking) step++;
			picking = !picking;
			return choice;
		};
		await customizeFooter(select, new Set(["docs"]), [], (names) => {
			saved.push(names);
			return true;
		});
		expect(saved).toEqual([["docs"], ["docs", "tree"], ["tree", "docs"], ["tree"]]);
		// The list numbers the pinned commands in their order.
		expect(titles[3]).toContainEqual("2 Documentation  /docs");
		expect(titles[3]).toContainEqual("1 Session tree  /tree");
		expect(titles[4]).toContainEqual("  Documentation  /docs");
	});

	it("reads the saved order, without unknown or repeated names", () => {
		const dir = tempDir();
		expect(readFooterActions(dir)).toEqual([]);
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ footerActions: ["tree", "nope", 3, "tree", "docs"] }));
		expect(readFooterActions(dir)).toEqual(["tree", "docs"]);
		expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).footerActions).toHaveLength(5);
	});
});
