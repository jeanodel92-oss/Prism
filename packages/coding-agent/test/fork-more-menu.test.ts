// fork: the footer's "more…" button opens a menu of the common commands, built-in
// ones included, so they can be reached with the mouse. the "init" button runs /init.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings, TuiMainScreen, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { setLanguage } from "../src/fork/i18n/index.ts";
import { createEditorFactory } from "../src/fork/prism/editor.ts";
import { createFooterFactory, findText } from "../src/fork/prism/footer.ts";
import { installModeSwitches } from "../src/fork/prism/index.ts";
import { createState, type PrismState } from "../src/fork/prism/lib/state.ts";
import { chooseFromMoreMenu, moreMenuEntries } from "../src/fork/prism/more-menu.ts";
import { INIT_STATUS } from "../src/fork/project-continuity.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

const plain = (line: string) => line.replace(/\x1b\[[0-9;:]*m/g, "");

function click(x: number, y: number): TuiMouseEvent {
	return {
		type: "click",
		button: "left",
		x,
		y,
		screenX: x,
		screenY: y,
		width: 100,
		height: 2,
		shift: false,
		alt: false,
		ctrl: false,
	};
}

describe("fork: footer buttons, more… and init", () => {
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

	function footer(state: PrismState, statuses: Record<string, string>) {
		const root = mkdtempSync(join(tmpdir(), "prism-more-"));
		dirs.push(root);
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
			getGitBranch: () => undefined,
			getExtensionStatuses: () => new Map(Object.entries(statuses)),
			onBranchChange: () => () => {},
		};
		return createFooterFactory(state)({ requestRender() {} }, theme, footerData);
	}

	it("lists the common commands that exist in the session, each with its command", () => {
		const names = (extensions: string[]) => moreMenuEntries(new Set(extensions)).map((entry) => entry.command);
		expect(names([])).toEqual(["help", "settings", "model", "session", "new", "resume", "tree", "export", "compact"]);
		expect(names(["docs", "perm"])).toEqual([
			"help",
			"docs",
			"settings",
			"perm",
			"model",
			"session",
			"new",
			"resume",
			"tree",
			"export",
			"compact",
		]);
	});

	it("returns the chosen command line, in the interface language", async () => {
		setLanguage("fr");
		const select = vi.fn(async (_title: string, options: string[]) => options[2]);
		expect(await chooseFromMoreMenu(select, new Set(["docs"]))).toBe("/settings");
		expect(select.mock.calls[0]![0]).toBe("Plus");
		expect(select.mock.calls[0]![1].slice(0, 3)).toEqual([
			"Aide et raccourcis  /help",
			"Documentation  /docs",
			"Réglages  /settings",
		]);
		expect(await chooseFromMoreMenu(async () => undefined, new Set())).toBeUndefined();
	});

	it("draws the button next to the permission chip; a click on it opens the menu, not /perm", () => {
		const state = createState();
		state.openMenu = vi.fn();
		state.openCommand = vi.fn();
		const view = footer(state, { permissions: "perm: ask" });
		for (const width of [120, 64, 40]) {
			const lines = view.render(width).map(plain);
			const hit = findText(lines, "• more…");
			expect(hit, `width ${width}: ${lines.join(" | ")}`).toBeDefined();
			for (const line of lines) expect([...line].length).toBeLessThanOrEqual(width);
			view.handleMouse(click(hit!.from + 2, hit!.row));
		}
		expect(state.openMenu).toHaveBeenCalledTimes(3);
		expect(state.openCommand).not.toHaveBeenCalled();

		const lines = view.render(120).map(plain);
		const perm = findText(lines, "▐ask▌")!;
		view.handleMouse(click(perm.from + 1, perm.row));
		expect(state.openCommand).toHaveBeenCalledWith("perm window");
	});

	it("runs /init when project continuity's init button is clicked", () => {
		const state = createState();
		state.openCommand = vi.fn();
		const view = footer(state, { [INIT_STATUS]: "init" });
		for (const width of [120, 60]) {
			const lines = view.render(width).map(plain);
			const hit = findText(lines, "• init");
			expect(hit, `width ${width}: ${lines.join(" | ")}`).toBeDefined();
			view.handleMouse(click(hit!.from + 3, hit!.row));
		}
		expect(state.openCommand).toHaveBeenCalledTimes(2);
		expect(state.openCommand).toHaveBeenCalledWith("init");
	});

	it("draws no button when nothing opens the menu", () => {
		const view = footer(createState(), {});
		expect(view.render(120).map(plain).join("\n")).not.toContain("more…");
	});

	it("runs a built-in command through the composer's submit path and gives the draft back", async () => {
		const state = createState();
		state.theme = theme;
		const editor = createEditorFactory(state)(
			new TuiMainScreen(new VirtualTerminal()),
			defaultEditorTheme,
			new KeybindingsManager({}),
		) as unknown as { setText(text: string): void; getText(): string; onSubmit?: (text: string) => Promise<void> };
		const submitted: string[] = [];
		editor.onSubmit = async (text) => {
			submitted.push(text);
			editor.setText(""); // what interactive mode does after /settings
		};
		editor.setText("half-written prompt");
		state.submitCommand?.("/settings");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(submitted).toEqual(["/settings"]);
		expect(editor.getText()).toBe("half-written prompt");
	});

	it("opens the menu from the extension and runs the choice", async () => {
		const sent: string[] = [];
		const pi = {
			on: () => {},
			getCommands: () => [{ name: "docs", source: "extension" }],
			sendUserMessage: async (text: string) => {
				sent.push(text);
			},
		};
		const state = createState();
		const select = vi.fn(async (_title: string, options: string[]) => options.find((o) => o.endsWith("/docs")));
		state.ctx = { hasUI: true, ui: { select, notify: () => {} } } as unknown as ExtensionContext;
		installModeSwitches(pi as unknown as ExtensionAPI, state);
		state.submitCommand = vi.fn();
		state.openMenu?.();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(state.submitCommand).toHaveBeenCalledWith("/docs");
		expect(sent).toEqual([]);
	});
});
