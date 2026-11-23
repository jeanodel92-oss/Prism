// fork: the Prism visual pack ships as the built-in extension `builtin:prism`, with its theme.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Component,
	getMarkdownTokenHook,
	Markdown,
	setMarkdownTokenHook,
	TuiMainScreen,
	type TuiMouseEvent,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import {
	formatNoApiKeyFoundMessage,
	formatNoModelSelectedMessage,
	formatNoModelsAvailableMessage,
} from "../src/core/auth-guidance.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import { EditorSlot } from "../src/fork/editor-slot.ts";
import { helpEntries } from "../src/fork/help.ts";
import { setLanguage, t } from "../src/fork/i18n/index.ts";
import { NoticeText } from "../src/fork/notice-text.ts";
import { OptionLine } from "../src/fork/option-line.ts";
import { LOGO_LARGE, LOGO_MINI, LOGO_SMALL } from "../src/fork/prism/art.ts";
import { dialogFrameHook, RULE } from "../src/fork/prism/dialogs.ts";
import { createEditorFactory, glint } from "../src/fork/prism/editor.ts";
import {
	autoCompactEnabled,
	chip,
	compactionState,
	createFooterFactory,
	gauge,
	gaugeLevel,
} from "../src/fork/prism/footer.ts";
import { createHeaderFactory, logoFor } from "../src/fork/prism/header.ts";
import prismExtension from "../src/fork/prism/index.ts";
import { chroma, hexToRgb, isLightTheme, lightness, step, tok } from "../src/fork/prism/lib/palette.ts";
import { createState } from "../src/fork/prism/lib/state.ts";
import { noticeHooks } from "../src/fork/prism/notices.ts";
import { markdownTokenHook, transcriptHooks } from "../src/fork/prism/transcript.ts";
import { renderHooks, setRenderHooks, type ToolExecutionView } from "../src/fork/render-hooks.ts";
import { shellOutcome } from "../src/fork/shell-outcome.ts";
import {
	AssistantMessageComponent,
	DynamicBorder,
	ToolExecutionComponent,
	UserMessageComponent,
} from "../src/modes/interactive/components/index.ts";
import { wcagContrast } from "../src/modes/interactive/theme/system-theme.ts";
import {
	getAvailableThemes,
	getMarkdownTheme,
	getResolvedThemeColors,
	initTheme,
	theme,
} from "../src/modes/interactive/theme/theme.ts";

// Stands in for a branded binary, whose config lives in `.prism`.
const prismConfig = vi.hoisted(() => ({ agentDir: undefined as string | undefined }));
vi.mock("../src/config.ts", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/config.ts")>();
	return {
		...original,
		CONFIG_DIR_NAME: ".prism",
		getAgentDir: () => prismConfig.agentDir ?? original.getAgentDir(),
	};
});

describe("fork: Prism pack", () => {
	it("is a built-in extension, so -builtin:prism, --no-extensions and --safe turn it off", () => {
		const entry = builtInExtensions.find(
			(extension) => typeof extension !== "function" && extension.name === "prism",
		);
		expect(entry).toEqual({ name: "prism", factory: prismExtension, builtin: true });
	});

	it("does not mark the footer as taken until the extension loads", () => {
		expect((globalThis as Record<symbol, unknown>)[Symbol.for("pi-prism.footer")]).toBeUndefined();
	});

	it("ships the prism theme and its light variant next to dark and light", () => {
		expect(getAvailableThemes()).toEqual(expect.arrayContaining(["dark", "light", "prism", "prism-light"]));
	});

	describe("footer auto-compaction flag", () => {
		const dirs: string[] = [];
		const savedEnv = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };

		afterEach(() => {
			prismConfig.agentDir = undefined;
			process.env.HOME = savedEnv.HOME;
			if (savedEnv.PI_CODING_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = savedEnv.PI_CODING_AGENT_DIR;
			for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
		});

		function settings(dir: string, enabled: boolean) {
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "settings.json"), JSON.stringify({ compaction: { enabled } }));
		}

		function setup() {
			const root = mkdtempSync(join(tmpdir(), "prism-footer-"));
			dirs.push(root);
			const home = join(root, "home");
			const cwd = join(root, "project");
			prismConfig.agentDir = join(root, "prism-agent");
			mkdirSync(prismConfig.agentDir, { recursive: true });
			mkdirSync(cwd, { recursive: true });
			// pi's config says "off" everywhere: Prism must not read it.
			process.env.HOME = home;
			process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");
			settings(join(home, ".pi", "agent"), false);
			settings(join(cwd, ".pi"), false);
			return { cwd, agentDir: prismConfig.agentDir };
		}

		it("ignores pi's config and defaults to on", () => {
			const { cwd } = setup();
			expect(autoCompactEnabled(cwd)).toBe(true);
		});

		it("reads Prism's global settings, then its project settings", () => {
			const { cwd, agentDir } = setup();
			settings(agentDir, false);
			expect(autoCompactEnabled(cwd)).toBe(false);
			settings(join(cwd, ".prism"), true);
			expect(autoCompactEnabled(cwd)).toBe(true);
		});
	});
});

// fork: the pack restyles pi through typed render hooks, without prototype patches.
describe("fork: Prism render hooks", () => {
	const hookedMethods = () => [
		UserMessageComponent.prototype.render,
		AssistantMessageComponent.prototype.render,
		ToolExecutionComponent.prototype.render,
		DynamicBorder.prototype.render,
		(Markdown.prototype as unknown as Record<string, unknown>).renderToken,
		EditorSlot.prototype.render,
	];

	afterEach(() => {
		setRenderHooks({});
		setMarkdownTokenHook(undefined);
	});

	it("sets the hooks when it loads, patches no prototype, and clears the hooks on shutdown", async () => {
		const before = hookedMethods();
		const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
		const pi = {
			on: (event: string, handler: never) => handlers.set(event, handler),
			registerShortcut: () => {},
			registerEntryRenderer: () => {},
			registerCommand: () => {},
			events: { on: () => {} },
		};
		prismExtension(pi as unknown as ExtensionAPI);

		expect(hookedMethods()).toEqual(before);
		expect(Object.keys(renderHooks).sort()).toEqual([
			"assistantMessage",
			"cacheKey",
			"dialogFrame",
			"dynamicBorder",
			"loadedSummary",
			"notice",
			"panel",
			"toolExecution",
			"unfold",
			"unfolding",
			"userMessage",
		]);
		expect(getMarkdownTokenHook()).toBeTypeOf("function");

		await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "reload" }, {});
		expect(renderHooks).toEqual({});
		expect(getMarkdownTokenHook()).toBeUndefined();
	});

	it("falls back to upstream rendering when a hook declines", () => {
		const vanilla = new DynamicBorder((s) => s).render(5);
		setRenderHooks({ dynamicBorder: () => undefined });
		expect(new DynamicBorder((s) => s).render(5)).toEqual(vanilla);
		setRenderHooks({ dynamicBorder: (width) => [`hooked ${width}`] });
		expect(new DynamicBorder((s) => s).render(5)).toEqual(["hooked 5"]);
	});

	it("maps mouse rows of a framed menu back to the menu's own rows", () => {
		const received: TuiMouseEvent[] = [];
		const menu: Component = {
			render: () => ["first", "second"],
			handleMouse: (event) => {
				received.push(event);
				return { handled: true };
			},
			invalidate: () => {},
		};
		setRenderHooks({
			dialogFrame: (_child, width) => ({
				lines: ["╭ title ╮", "│first │", "│second│", "╰ hints ╯"],
				rows: [-1, 0, 1, -1],
				innerWidth: width - 4,
				innerHeight: 2,
				offsetX: 2,
			}),
		});
		const slot = new EditorSlot();
		slot.addChild(menu);
		expect(slot.render(40)).toHaveLength(4);
		const click = (y: number): TuiMouseEvent => ({
			type: "click",
			button: "left",
			x: 10,
			y,
			screenX: 10,
			screenY: y,
			width: 40,
			height: 4,
			shift: false,
			alt: false,
			ctrl: false,
		});

		expect(slot.handleMouse(click(0))).toBeUndefined();
		expect(slot.handleMouse(click(2))?.handled).toBe(true);
		expect(received).toHaveLength(1);
		expect(received[0]).toMatchObject({ x: 8, y: 1, width: 36, height: 2 });
	});
});

// fork: graphic pass.
describe("fork: Prism graphic pass", () => {
	const plain = (line: string) => line.replace(/\x1b\[[0-9;:]*m/g, "");
	const state = createState();
	state.theme = theme;

	afterEach(() => setRenderHooks({}));

	it("wraps a long selector option under its text", () => {
		const lines = new OptionLine("→ ", "Always allow (save edit(/tmp/project/**) to /tmp/project/.prism)").render(30);
		expect(lines.length).toBeGreaterThan(1);
		expect(plain(lines[0])).toMatch(/^ → Always/);
		for (const line of lines.slice(1)) expect(plain(line)).toMatch(/^ {3}\S/);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(30);
	});

	// the margin and the prefix were added past a width of 3 or less.
	it("keeps a selector option within widths 0 to 3", () => {
		for (const width of [0, 1, 2, 3]) {
			for (const text of ["", "x", "日本語"]) {
				const lines = new OptionLine("→ ", text).render(width);
				for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	it("shows the permission mode as a chip without its prefix", () => {
		initTheme("prism");
		expect(plain(chip(theme, "permissions", "perm: safe (read-only)"))).toBe("▐safe▌ (read-only)");
		expect(plain(chip(theme, "other", "busy"))).toBe("• busy");
	});

	it("draws the context gauge with the auto-compaction threshold", () => {
		initTheme("prism");
		for (const [pct, mark] of [
			[0, undefined],
			[50, 80],
			[100, 100],
			[130, 5],
		] as const) {
			const bar = gauge(theme, pct, mark);
			expect(visibleWidth(bar)).toBe(12);
			expect(plain(bar).replaceAll("▄", "").length).toBe(mark === undefined ? 0 : 1);
		}
		// The tick sits in the cell that ends at the threshold.
		expect(plain(gauge(theme, 0, 50)).indexOf("▀")).toBe(5);
		expect(gaugeLevel(60, 80)).toBeUndefined();
		expect(gaugeLevel(70, 80)).toBe("warning");
		expect(gaugeLevel(80, 80)).toBe("error");
		expect(gaugeLevel(91, undefined)).toBe("warning");
		expect(gaugeLevel(100, undefined)).toBe("error");
	});

	it("places the threshold mark from the compaction settings", () => {
		const model = { provider: "p", id: "m" };
		const at = (compaction: object) =>
			compactionState(SettingsManager.inMemory({ compaction }), model, 200_000)?.mark;
		expect(at({ thresholdPercent: 75 })).toBe(75);
		expect(at({ reserveTokens: 20_000 })).toBe(90);
		expect(at({ enabled: false, thresholdPercent: 75 })).toBeUndefined();
		expect(compactionState(SettingsManager.inMemory(), model, 0)?.mark).toBeUndefined();
	});

	it("moves the shell's duration line to the end of the tool's header line", () => {
		initTheme("prism");
		const view: ToolExecutionView = {
			toolName: "bash",
			isPartial: false,
			isError: false,
			shell: "renderer",
			expanded: true,
			args: {},
			renderSelf: () => [],
			renderParts: () => ["$ ls", "", "a.txt", "", "Took 1.2s"],
			renderText: () => [],
			imageCount: 0,
			renderImages: () => [],
		};
		const lines = transcriptHooks(state).toolExecution!(view, 40)!.map(plain);
		expect(lines[1]).toMatch(/^● \S \$ ls +1\.2s$/);
		// One column of right margin, like the statusline.
		expect(lines[1]).toHaveLength(39);
		expect(lines.some((line) => line.includes("Took"))).toBe(false);
	});

	it("draws warnings through the notice hook and sums up the startup listing", () => {
		initTheme("prism");
		const vanilla = new NoticeText("warning", "careful", () => "Warning: careful").render(40);
		expect(plain(vanilla[0]).trim()).toBe("Warning: careful");
		setRenderHooks(noticeHooks(state));
		const callout = new NoticeText("warning", "careful", () => "Warning: careful").render(40);
		expect(plain(callout[0])).toMatch(/^ ▌ Warning careful +$/);
		const sections = [
			{ name: "Skills", count: 1 },
			{ name: "Extensions", count: 2 },
		];
		const summary = renderHooks.loadedSummary!(sections, 80)!;
		expect(summary.map(plain)).toEqual([expect.stringMatching(/^ 1 skill · 2 extensions · .*for details$/)]);
		// Wrapped lines keep the one-column indent.
		for (const line of renderHooks.loadedSummary!(sections, 20)!) expect(plain(line)).toMatch(/^ \S/);
	});
});

// fork: a click on the composer rows that hold no text (status, padding, gap, badges)
// no longer starts a screen text selection; a double-click there drew a white bar.
describe("fork: Prism composer mouse", () => {
	it("handles presses on its decoration rows and leaves text rows to the screen selection", () => {
		const editor = createEditorFactory(createState())(
			new TuiMainScreen(new VirtualTerminal()),
			defaultEditorTheme,
			new KeybindingsManager({}),
		) as unknown as { render(width: number): string[]; handleMouse(event: TuiMouseEvent): unknown };
		editor.render(60);
		const at = (y: number, type: TuiMouseEvent["type"] = "press"): TuiMouseEvent => ({
			type,
			button: "left",
			x: 10,
			y,
			screenX: 10,
			screenY: y,
			width: 60,
			height: 6,
			shift: false,
			alt: false,
			ctrl: false,
		});
		// One text line: status 0, top edge 1, text 2, gap 3, badges 4, bottom edge 5.
		for (const row of [0, 1, 3, 4, 5]) expect(editor.handleMouse(at(row))).toEqual({ handled: true });
		expect(editor.handleMouse(at(5, "click"))).toEqual({ handled: true, focus: true });
		expect(editor.handleMouse(at(1, "click"))).toEqual({ handled: true, focus: true });
		expect(editor.handleMouse(at(2))).toBeUndefined();
		expect(editor.handleMouse(at(1, "wheel"))).toBeUndefined();
	});
});

describe("fork: Prism visual redesign", () => {
	const plain = (line: string) => line.replace(/\x1b\[[0-9;:]*m/g, "");

	it("steps colours in OKLab: a zero step keeps the colour, a positive one lightens it", () => {
		for (const c of [
			[11, 13, 20],
			[179, 156, 255],
			[246, 244, 239],
		] as const) {
			const same = step(c, 0);
			for (let i = 0; i < 3; i++) expect(Math.abs(same[i]! - c[i]!)).toBeLessThanOrEqual(1);
			expect(lightness(step(c, 1))).toBeGreaterThan(lightness(c));
			expect(lightness(step(c, -1))).toBeLessThan(lightness(c));
		}
	});

	it("tells light themes from dark ones", () => {
		initTheme("prism");
		expect(isLightTheme(theme)).toBe(false);
		initTheme("prism-light");
		expect(isLightTheme(theme)).toBe(true);
		initTheme("prism");
	});

	it("picks the logo size by width", () => {
		expect(logoFor(140)).toBe(LOGO_LARGE);
		expect(logoFor(100)).toBe(LOGO_LARGE);
		expect(logoFor(99)).toBe(LOGO_SMALL);
		expect(logoFor(64)).toBe(LOGO_SMALL);
		expect(logoFor(63)).toBe(LOGO_MINI);
	});

	it("renders the header within the width, with the logo and two pills", () => {
		initTheme("prism");
		const state = createState();
		state.theme = theme;
		const header = createHeaderFactory(state, false)({ requestRender: () => {} });
		for (const width of [20, 40, 64, 100, 140, 200]) {
			const lines = header.render(width);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			const text = lines.map(plain).join("\n");
			expect(text).toMatch(/[▀▄]/);
			if (width >= 64) expect(text).toContain("commands");
		}
		const big = header.render(140).map(plain);
		expect(big.length).toBeGreaterThanOrEqual(LOGO_LARGE.length / 2);
		expect(big.join("\n")).not.toContain("interrupt");
	});

	it("names the thinking level in the interface language", () => {
		initTheme("prism");
		const state = createState();
		state.theme = theme;
		state.thinkingLevel = "medium";
		state.ctx = { cwd: "/w", model: { id: "m", provider: "p", reasoning: true } } as unknown as typeof state.ctx;
		const header = createHeaderFactory(state, false)({ requestRender: () => {} });
		setLanguage("fr");
		try {
			expect(header.render(100).map(plain).join("\n")).toContain("m · p · moyen");
		} finally {
			setLanguage("en");
		}
		expect(header.render(100).map(plain).join("\n")).toContain("m · p · medium");
	});

	it("shows no model, not the placeholder's unknown provider, when none is configured", () => {
		initTheme("prism");
		const state = createState();
		state.theme = theme;
		state.ctx = {
			cwd: "/w",
			model: { id: "unknown", provider: "unknown", api: "unknown" },
		} as unknown as typeof state.ctx;
		const header = createHeaderFactory(state, false)({ requestRender: () => {} });
		const editor = createEditorFactory(state)(
			new TuiMainScreen(new VirtualTerminal()),
			defaultEditorTheme,
			new KeybindingsManager({}),
		) as unknown as { render(width: number): string[] };
		setLanguage("fr");
		try {
			for (const lines of [header.render(100), editor.render(100)]) {
				const text = lines.map(plain).join("\n");
				expect(text).not.toContain("unknown");
				expect(text).toContain("aucun modèle");
			}
			expect(t(formatNoModelsAvailableMessage())).not.toMatch(/Use \/login/);
			expect(t(formatNoModelSelectedMessage())).toContain("Choisissez ensuite un modèle avec /model.");
			expect(t(formatNoApiKeyFoundMessage("unknown"))).toBe(
				"Aucune clé d'accès n'est disponible pour le modèle choisi.\n\nUtilisez /login pour connecter un service ou un serveur de modèles : avec un compte, une clé d'API (une clé d'accès) ou l'adresse d'un serveur. /docs providers explique comment.",
			);
		} finally {
			setLanguage("en");
		}
	});

	it("draws tiles exactly as wide as the screen, from 20 to 200 columns", () => {
		initTheme("prism");
		const state = createState();
		state.theme = theme;
		const editor = createEditorFactory(state)(
			new TuiMainScreen(new VirtualTerminal()),
			defaultEditorTheme,
			new KeybindingsManager({}),
		) as unknown as { render(width: number): string[] };
		const tool: ToolExecutionView = {
			toolName: "bash",
			isPartial: false,
			isError: true,
			shell: "renderer",
			expanded: true,
			args: {},
			renderSelf: () => [],
			// Renderers fill the width they are given.
			renderParts: (w) => ["$ ls", "", "x".repeat(w), "", "Took 1.2s"],
			renderText: () => [],
			imageCount: 0,
			renderImages: () => [],
		};
		setRenderHooks(transcriptHooks(state));
		try {
			for (let width = 20; width <= 200; width++) {
				const composer = editor.render(width).map(plain);
				const top = composer.findIndex((line) => line.startsWith("▗"));
				const bottom = composer.findIndex((line) => line.startsWith("▝"));
				expect(composer[top]).toBe(`▗${"▄".repeat(width - 2)}▖`);
				expect(composer[bottom]).toBe(`▝${"▀".repeat(width - 2)}▘`);
				for (const line of composer.slice(top, bottom + 1)) expect(visibleWidth(line)).toBe(width);

				const user = new UserMessageComponent("hello").render(width).map(plain);
				expect(user[0]!.replace(/^(?:\x1b\][^\x07]*\x07)*/, "")).toBe(`▗${"▄".repeat(width - 2)}▖`);
				expect(user[user.length - 1]!.replace(/^(?:\x1b\][^\x07]*\x07)*/, "")).toBe(`▝${"▀".repeat(width - 2)}▘`);
				for (const line of user) expect(visibleWidth(line)).toBe(width);

				// The output panel reaches the right edge, like the other tiles.
				const lines = transcriptHooks(state).toolExecution!(tool, width)!;
				expect(visibleWidth(lines[2]!)).toBe(width);
				for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		} finally {
			setRenderHooks({});
		}
	});

	it("draws menus as tiles exactly as wide as the slot, without extra rows", () => {
		initTheme("prism");
		const state = createState();
		state.theme = theme;
		state.animates = () => false;
		class ExtensionSelectorComponent {
			render(width: number) {
				return [
					"Pick one",
					"",
					"→ first",
					"  second",
					RULE,
					`  third ${"y".repeat(width)}`,
					"",
					"↑↓ navigate  enter select",
				];
			}
			invalidate() {}
		}
		const hook = dialogFrameHook(state);
		for (let width = 24; width <= 200; width++) {
			const frame = hook(new ExtensionSelectorComponent(), width)!;
			const lines = frame.lines.map(plain);
			for (const line of frame.lines) expect(visibleWidth(line)).toBe(width);
			// Hints too wide for the bottom row stay inside the tile, as before.
			if (width < 35) continue;
			expect(lines).toHaveLength(6);
			expect(lines[0]).toMatch(/^▐ \S Pick one +▌$/);
			expect(lines[5]).toMatch(/^▐ ↑↓ navigate {2}enter select +▌$/);
			expect(lines[1]).toMatch(/^ ▌❯ first/);
			expect(frame.rows).toEqual([-1, 2, 3, 4, 5, -1]);
		}
	});

	it("draws the logo in over about 800 ms, then stops its timer", () => {
		vi.useFakeTimers();
		try {
			initTheme("prism");
			const state = createState();
			state.theme = theme;
			let renders = 0;
			const header = createHeaderFactory(state, true)({ requestRender: () => renders++ });
			const cells = () => header.render(140).join("").match(/[▀▄]/g)?.length ?? 0;
			const start = cells();
			vi.advanceTimersByTime(500);
			const middle = cells();
			vi.advanceTimersByTime(500);
			const end = cells();
			expect(start).toBeLessThan(middle);
			expect(middle).toBeLessThan(end);
			const settled = renders;
			vi.advanceTimersByTime(1000);
			expect(renders).toBe(settled);
			expect(header.render(140)).toEqual(createHeaderFactory(state, false)({ requestRender: () => {} }).render(140));
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("fork: the site's art direction", () => {
	const plain = (line: string) => line.replace(/\x1b\[[0-9;:]*m/g, "");
	const fgOf = (s: string, glyph: string) => new RegExp(`\\x1b\\[38;2;([\\d;]+)m${glyph}`).exec(s)?.[1];

	it("keeps the large prism symmetric around its apex", () => {
		// The maintainer's reference: both edges equally far from the apex on every row, glass between.
		const apex = LOGO_LARGE[0]!.indexOf("*");
		for (const [y, row] of LOGO_LARGE.entries()) {
			if (y === 0) continue;
			const left = row.search(/[Ex]/);
			const right = row.lastIndexOf("R");
			expect(apex - left, `row ${y}`).toBe(right - apex);
			expect(apex - left, `row ${y}`).toBe(Math.floor(y * 0.6 + 0.5));
			expect(row.slice(left + 1, right), `row ${y}`).toMatch(y === LOGO_LARGE.length - 1 ? /^O+$/ : /^[KFSTp]+$/);
		}
	});

	it("draws the large prism's fan on whole text rows, in bands mirrored around its middle", () => {
		// A lone half block next to a coloured cell leaves a dark seam in some terminals.
		const isBand = (ch: string | undefined) => ch !== undefined && /[0-5]/.test(ch);
		const right = LOGO_LARGE.at(-1)!.lastIndexOf("R");
		for (const [y, row] of LOGO_LARGE.entries()) {
			for (let x = 0; x < row.length; x++) {
				if (isBand(row[x])) expect(LOGO_LARGE[y ^ 1]![x], `pixel ${x},${y}`).not.toBe(" ");
			}
		}
		for (let x = right + 1; x < LOGO_LARGE[0]!.length; x++) {
			const column = LOGO_LARGE.map((row) => row[x]!)
				.join("")
				.trim();
			const runs = column.match(/(.)\1*/g)!;
			expect(runs.map((run) => run[0]).join(""), `column ${x}`).toBe("012345");
			const sizes = runs.map((run) => run.length);
			expect(sizes, `column ${x}`).toEqual([...sizes].reverse());
		}
	});

	it("keeps the Prism themes monochrome: colour only for states, diffs and pale syntax and markdown tints", () => {
		// Colour is an event, not a classification. Headings, inline code and links take pale tints, like the syntax.
		const coloured = /^(error|warning|success|toolDiffAdded|toolDiffRemoved)$/;
		for (const name of ["prism", "prism-light"]) {
			for (const [token, hex] of Object.entries(getResolvedThemeColors(name))) {
				if (!hex.startsWith("#") || coloured.test(token)) continue;
				const limit = token.startsWith("syntax") || /^md(Heading|Bold|Code|Link)$/.test(token) ? 0.04 : 0.01;
				expect(chroma(hexToRgb(hex)), `${name} ${token} ${hex}`).toBeLessThanOrEqual(limit);
			}
		}
	});

	it("separates headings, inline code and links from the text with pale tints, readable on both themes", () => {
		// Lot 17, option B: pale tints that blend in, at least 7:1 on the page, greys lifted,
		// state dots and rails at 3:1 or more.
		for (const name of ["prism", "prism-light"]) {
			const colors = getResolvedThemeColors(name);
			const page = hexToRgb(name === "prism" ? "#050505" : "#f2f2f0");
			const rgb = (token: string) => {
				const [r, g, b] = hexToRgb(colors[token]!);
				return { r, g, b };
			};
			const ratio = (token: string) => wcagContrast(rgb(token), { r: page[0], g: page[1], b: page[2] });
			for (const token of ["mdHeading", "mdCode", "mdLink"]) {
				expect(colors[token], `${name} ${token}`).not.toBe(colors.text);
				expect(chroma(hexToRgb(colors[token]!)), `${name} ${token}`).toBeGreaterThan(0.02);
				expect(ratio(token), `${name} ${token}`).toBeGreaterThanOrEqual(7);
			}
			expect(new Set(["mdHeading", "mdCode", "mdLink"].map((token) => colors[token])).size).toBe(3);
			expect(ratio("borderAccent"), `${name} borderAccent`).toBeGreaterThanOrEqual(3);
			if (name === "prism") expect(ratio("muted")).toBeGreaterThanOrEqual(7);
		}
	});

	it("draws # and ## headings in the heading tint, in bold", () => {
		initTheme("prism");
		const state = createState();
		state.theme = theme;
		setMarkdownTokenHook(markdownTokenHook(state));
		try {
			const [first] = new Markdown("# Title\n\nbody", 0, 0, getMarkdownTheme()).render(60);
			expect(fgOf(first!, "Title")).toBe(tok(theme, "mdHeading").join(";"));
			expect(first).toContain("\x1b[1m");
		} finally {
			setMarkdownTokenHook(undefined);
		}
	});

	// fork: a tool or a code language named like an Object
	// member gets the fallback icon, never the source of an inherited function.
	it("gives tools and code languages named like Object members the fallback icon", () => {
		initTheme("prism");
		const state = createState();
		state.theme = theme;
		setMarkdownTokenHook(markdownTokenHook(state));
		try {
			for (const name of ["constructor", "toString", "hasOwnProperty", "valueOf", "__proto__"]) {
				const view: ToolExecutionView = {
					toolName: name,
					isPartial: false,
					isError: false,
					shell: "renderer",
					expanded: true,
					args: {},
					renderSelf: () => [],
					renderParts: () => ["done"],
					renderText: () => [],
					imageCount: 0,
					renderImages: () => [],
				};
				const tool = transcriptHooks(state).toolExecution!(view, 60)!.map(plain).join("\n");
				expect(tool, name).not.toContain("native code");
				expect(tool, name).not.toContain("[object Object]");
				const fence = new Markdown(`\`\`\`${name}\nx\n\`\`\``, 0, 0, getMarkdownTheme()).render(60);
				const code = fence.map(plain).join("\n");
				expect(code, name).not.toContain("native code");
				expect(code, name).not.toContain("[object Object]");
			}
		} finally {
			setMarkdownTokenHook(undefined);
		}
	});

	it("draws the working indicator as a glint on a line, with spectral fringes only while it moves", () => {
		const line = [43, 43, 42] as const;
		const ink3 = [138, 138, 134] as const;
		const ink = [240, 240, 238] as const;
		const still = glint(undefined, line, ink3, ink, false);
		expect(plain(still)).toBe("────━━━─────");
		expect(still).not.toMatch(/38;2;(?!43;43;42|138;138;134|240;240;238)[\d;]+m/);
		const moving = glint(5, line, ink3, ink, false);
		expect(plain(moving)).toHaveLength(12);
		const colours = new Set([...moving.matchAll(/38;2;([\d;]+)m/g)].map((m) => m[1]));
		// The line, ink 3, ink and the two fringes.
		expect(colours.size).toBe(5);
	});

	it("marks a tool's state with one dot: strong line, success, or error with the word failed", () => {
		initTheme("prism");
		const state = createState();
		state.theme = theme;
		state.animates = () => false;
		const view = (isPartial: boolean, isError: boolean, out: string[]): ToolExecutionView => ({
			toolName: "bash",
			isPartial,
			isError,
			shell: "renderer",
			expanded: true,
			args: {},
			renderSelf: () => [],
			renderParts: () => ["$ ls", ...out],
			renderText: () => [],
			imageCount: 0,
			renderImages: () => [],
		});
		const head = (v: ToolExecutionView) =>
			transcriptHooks(state).toolExecution!(v, 60)!.find((l) => plain(l).startsWith("●"))!;
		const rgb = (token: Parameters<typeof tok>[1]) => tok(theme, token).join(";");
		expect(fgOf(head(view(true, false, [])), "●")).toBe(rgb("borderAccent"));
		expect(fgOf(head(view(false, false, ["", "a.txt"])), "●")).toBe(rgb("success"));
		const failed = head(view(false, true, ["", "boom"]));
		expect(fgOf(failed, "●")).toBe(rgb("error"));
		expect(plain(failed)).toContain("failed");
		// Animations off: a streaming call holds the ink.
		expect(fgOf(head(view(true, false, ["", "a.txt"])), "●")).toBe(rgb("text"));
	});
});

describe("fork: simple or advanced display", () => {
	const plain = (line: string) => line.replace(/\x1b\[[0-9;:]*m/g, "");

	const footerLine = (mode: "simple" | "advanced"): string => {
		initTheme("prism");
		const root = mkdtempSync(join(tmpdir(), "prism-r412-"));
		prismConfig.agentDir = join(root, "agent");
		try {
			const state = createState();
			state.theme = theme;
			state.interfaceMode = () => mode;
			const usage = { input: 1000, output: 200, cacheRead: 3000, cacheWrite: 900, cost: { total: 0.01 } };
			const assistant = { role: "assistant", usage, stopReason: "stop", model: "m" };
			state.ctx = {
				cwd: root,
				isProjectTrusted: () => true,
				model: { provider: "p", id: "m", contextWindow: 100_000 },
				modelRegistry: { isUsingOAuth: () => false },
				getContextUsage: () => ({ tokens: 4900, contextWindow: 100_000, percent: 4.9 }),
				sessionManager: {
					getEntries: () => [{ type: "message", message: assistant }],
					getSessionId: () => "s",
					getLeafId: () => "l",
					getCwd: () => root,
					getSessionName: () => undefined,
				},
			} as never;
			const footerData = {
				getGitBranch: () => undefined,
				getExtensionStatuses: () => new Map(),
				onBranchChange: () => () => {},
			};
			const footer = createFooterFactory(state)({ requestRender() {} }, theme, footerData);
			return plain(footer.render(120)[0]!);
		} finally {
			prismConfig.agentDir = undefined;
			rmSync(root, { recursive: true, force: true });
		}
	};

	it("shows one cache figure in the simple statusline and the read/write detail in the advanced one", () => {
		// Hit rate of the latest response: 3000 cached of 4900 prompt tokens.
		const simple = footerLine("simple");
		expect(simple).toContain("sent 1.0k  received 200  cache 61%");
		expect(simple).not.toMatch(/\bR3\.0k|W900|CH/);
		const advanced = footerLine("advanced");
		expect(advanced).toMatch(/↑1\.0k ↓200 {2}R3\.0k W900 CH61\.2%/);
		expect(advanced).not.toContain("cache 61%");
	});

	it("says the simple statusline's figures in French, and /help explains the advanced ones", () => {
		setLanguage("fr");
		try {
			expect(footerLine("simple")).toContain("envoyés 1.0k  reçus 200  cache 61%");
		} finally {
			setLanguage("en");
		}
		const keys = helpEntries(
			() => "x",
			() => true,
		).map((entry) => entry.key);
		for (const key of ["↑ ↓", "R W", "CH", "auto"]) expect(keys).toContain(key);
	});

	it("finds the shell's status line, wherever the duration and truncation notice leave it", () => {
		const id = (line: string) => line;
		expect(shellOutcome(["", "boom", "", "Command exited with code 2"], id)).toEqual({
			label: "failed (code 2)",
			body: ["", "boom"],
		});
		expect(shellOutcome(["x", "", "Command timed out after 30 seconds", "", "[Full output: /tmp/o]"], id)).toEqual({
			label: "stopped after 30 s (time limit)",
			body: ["x", "", "[Full output: /tmp/o]"],
		});
		expect(shellOutcome(["Command aborted"], id)?.label).toBe("stopped");
		// A wrapped status line is left alone: the header says "failed" and the output keeps the line.
		expect(shellOutcome(["Command exited with", "code 2"], id)).toBeUndefined();
	});

	it("says how a failed command ended on its header line in the simple interface only", () => {
		initTheme("prism");
		const state = createState();
		state.theme = theme;
		state.animates = () => false;
		const view: ToolExecutionView = {
			toolName: "bash",
			isPartial: false,
			isError: true,
			shell: "renderer",
			expanded: true,
			args: {},
			renderSelf: () => [],
			renderParts: () => ["$ make", "", "boom", "", "Command exited with code 2", "", "Took 1.2s"],
			renderText: () => [],
			imageCount: 0,
			renderImages: () => [],
		};
		const render = (mode: "simple" | "advanced") => {
			state.interfaceMode = () => mode;
			return transcriptHooks(state).toolExecution!(view, 60)!.map(plain);
		};
		const simple = render("simple");
		expect(simple[1]).toMatch(/^● \S \$ make failed \(code 2\) +1\.2s$/);
		expect(simple.some((line) => line.includes("Command exited"))).toBe(false);
		expect(simple.at(-1)).toMatch(/▏ boom$/);
		const advanced = render("advanced");
		expect(advanced[1]).toMatch(/^● \S \$ make failed +1\.2s$/);
		expect(advanced.at(-1)).toMatch(/▏ Command exited with code 2$/);

		// On a narrow line the command gives way, not the state or the duration.
		state.interfaceMode = () => "simple";
		const long = {
			...view,
			renderParts: () => ["$ make all install check dist", "", "Command exited with code 2", "", "Took 1.2s"],
		};
		const narrow = transcriptHooks(state).toolExecution!(long, 36)!.map(plain);
		expect(narrow[1]).toMatch(/^● \S \$ make al… failed \(code 2\) 1\.2s$/);
		expect(narrow[1]).toHaveLength(35);
	});
});
