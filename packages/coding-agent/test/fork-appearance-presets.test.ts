// fork.9 QA: named animation styles and nine core theme colours.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Component, colorToHex, colorToOklch, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";
import { indicator, reveal } from "../src/fork/animation-frames.ts";
import {
	ANIMATION_PRESETS,
	ANIMATION_STYLES,
	ANIMATIONS,
	type AnimationStyles,
	animationOn,
	animationPreset,
	animationStyle,
	readAnimationStyles,
	STYLE_LABELS,
} from "../src/fork/animations.ts";
import { setLanguage, t } from "../src/fork/i18n/index.ts";
import { OnboardingWizard } from "../src/fork/onboarding.ts";
import { dialogFrameHook, menuPreview } from "../src/fork/prism/dialogs.ts";
import { workingLine } from "../src/fork/prism/editor.ts";
import { createHeaderFactory, INTRO_MS, logoFor, logoFrame } from "../src/fork/prism/header.ts";
import { createState } from "../src/fork/prism/lib/state.ts";
import { createTitleSpinner } from "../src/fork/prism/title.ts";
import { stateMark, thinking } from "../src/fork/prism/transcript.ts";
import { PANEL_OPEN_MS, transitionHooks } from "../src/fork/prism/transitions.ts";
import { AnimationsMenu, animationPreview } from "../src/fork/settings-animations.ts";
import { createSettingsDomainExtras } from "../src/fork/settings-domain-extras.ts";
import { groupSettingsByDomain } from "../src/fork/settings-domains.ts";
import { SettingsView } from "../src/fork/settings-view.ts";
import { type EditableTheme, ThemeEditor, themeCopy, themeFromJson } from "../src/fork/theme-editor.ts";
import { coreColors, deriveTheme, THEME_ROLES, themeTextContrast } from "../src/fork/theme-roles.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";
let home: string;

function replace(editor: ThemeEditor, text: string): void {
	editor.handleInput(ENTER);
	for (let i = 0; i < 40; i++) editor.handleInput("\x7f");
	for (const char of text) editor.handleInput(char);
}

function editor(active = "prism") {
	const preview = vi.fn();
	const apply = vi.fn();
	return {
		preview,
		apply,
		component: new ThemeEditor({
			active,
			requestRender: () => {},
			done: () => {},
			host: { setting: () => active, preview, apply, restore: () => {} },
		}),
	};
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "prism-appearance-"));
	vi.stubEnv("HOME", home);
	vi.stubEnv(ENV_AGENT_DIR, home);
	vi.stubEnv("PI_CODING_AGENT_DIR", home);
	initTheme("prism");
});
afterEach(() => {
	setLanguage("en");
	vi.useRealTimers();
	vi.unstubAllEnvs();
	rmSync(home, { recursive: true, force: true });
});

describe("animation presets", () => {
	it("validates styles on every read and retains both legacy off settings", async () => {
		for (const malformed of [null, 5, [], "dots", { working: "unknown", tools: 4 }]) {
			expect(animationStyle(malformed, "working")).toBe("default");
			expect(() => readAnimationStyles(malformed)).not.toThrow();
		}
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () =>
			JSON.stringify({ animationStyles: { working: "unknown", tools: "meter" }, animationsOff: ["thinking"] }),
		);
		const settings = SettingsManager.fromStorage(storage);
		expect(settings.getAnimationStyles()).toMatchObject({ working: "default", tools: "meter" });
		settings.setAnimationStyles(animationPreset("Lively"));
		await settings.flush();
		expect(SettingsManager.fromStorage(storage).getAnimationStyles()).toEqual(animationPreset("Lively"));
		expect(settings.getAnimationsOff()).toEqual(["thinking"]);
		expect(animationOn({ animationStyles: { working: "off" } }, "working")).toBe(false);
		for (const { id } of ANIMATIONS) {
			expect(animationOn({ animations: false, animationStyles: animationPreset("Lively") }, id)).toBe(false);
			expect(animationOn({ animationsOff: [id], animationStyles: animationPreset("Lively") }, id)).toBe(false);
		}
	});

	it("persists styles through Appearance and applies global presets to all categories", async () => {
		const settings = SettingsManager.inMemory({});
		const extras = await createSettingsDomainExtras({
			settings,
			loadedExtensionPaths: [],
			hasWebKeyCommand: false,
			onWebSearchKey: () => {},
		});
		const row = groupSettingsByDomain([], () => {}, extras)
			.domains()
			.flatMap((domain) => domain.items())
			.find((entry) => entry.id === "animations")!;
		const menu = row.submenu!("on", () => {}) as AnimationsMenu;
		menu.handleInput(DOWN);
		menu.handleInput(DOWN); // working
		menu.handleInput(ENTER);
		menu.handleInput(ENTER); // off, dots
		expect(settings.getAnimationStyles().working).toBe("dots");
		expect(settings.getAnimationsOff()).toEqual([]);
		for (let i = 0; i < ANIMATIONS.length - 1; i++) menu.handleInput(DOWN);
		for (const preset of ANIMATION_PRESETS) {
			menu.handleInput(ENTER);
			expect(settings.getAnimationStyles()).toEqual(animationPreset(preset));
			expect(settings.getAnimations()).toBe(preset !== "off");
			expect(settings.getAnimationsOff()).toEqual([]);
		}
		menu.dispose();
		await settings.flush();
	});

	it("offers three distinct moving styles per terminal category and a stable final frame when off", () => {
		for (const { id } of ANIMATIONS) {
			const signatures = new Set<string>();
			const styles = ANIMATION_STYLES[id].filter((style) => style !== "off");
			expect(styles.length).toBeGreaterThanOrEqual(id === "title" ? 2 : 3);
			for (const style of styles) {
				const frames = Array.from({ length: 24 }, (_, i) =>
					animationPreview(id, true, i * 53, 40, style).join("\n"),
				);
				expect(new Set(frames).size, `${id}/${style}`).toBeGreaterThan(1);
				signatures.add(frames.join("\n"));
				const last = animationPreview(id, false, 0, 40, style);
				expect(animationPreview(id, false, 999, 40, style)).toEqual(last);
				for (const width of [40, 64, 100, 140]) {
					for (const line of animationPreview(id, true, 159, width, style))
						expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				}
			}
			expect(signatures.size, id).toBe(styles.length);
		}
	});

	it("uses the real renderers in the preview and preserves implicit original styles", () => {
		const now = 160;
		for (const style of ANIMATION_STYLES.working) {
			const on = style !== "off";
			expect(animationPreview("working", on, now, 40, style)).toEqual([
				workingLine(theme, "Working", now, on, style).join(" "),
			]);
		}
		for (const style of ANIMATION_STYLES.thinking) {
			const state = { ...createState(), animates: () => style !== "off", animationStyle: () => style };
			expect(animationPreview("thinking", true, now, 40, style)).toEqual(
				thinking(theme, true, ["Thinking…"], true, state, now),
			);
		}
		for (const style of ANIMATION_STYLES.tools)
			expect(animationPreview("tools", true, now, 40, style)[0]).toBe(
				`${stateMark(theme, { isPartial: true, isError: false }, true, style !== "off", style, now)} ${theme.fg("text", "bash")}`,
			);
		for (const style of ANIMATION_STYLES.intro)
			expect(animationPreview("intro", true, now, 40, style)).toEqual(
				logoFrame(theme, logoFor(40), style === "off" ? INTRO_MS : now, style),
			);
		expect(workingLine(theme, "Working", now, true)).toEqual(workingLine(theme, "Working", now, true, "default"));
		expect(logoFrame(theme, logoFor(40), now)).toEqual(logoFrame(theme, logoFor(40), now, "default"));
		expect(menuPreview(theme, ["example"], 30, now)).toEqual(menuPreview(theme, ["example"], 30, now, "default"));
	});

	it("measures discrete style changes at 160 ms and retains existing timer intervals", () => {
		for (const style of ["dots", "meter", "spinner"] as const) {
			const changes: number[] = [];
			for (let ms = 1; ms <= 960; ms++) if (indicator(style, ms) !== indicator(style, ms - 1)) changes.push(ms);
			expect(changes).toEqual([160, 320, 480, 640, 800, 960]);
		}
		expect(animationPreview("thinking", true, 159, 40, "pulse")).toEqual(
			animationPreview("thinking", true, 0, 40, "pulse"),
		);
		expect(animationPreview("thinking", true, 160, 40, "pulse")).not.toEqual(
			animationPreview("thinking", true, 159, 40, "pulse"),
		);
		vi.useFakeTimers();
		vi.setSystemTime(0);
		for (const style of ["wipe", "dissolve"] as const) {
			const state = { ...createState(), theme, animates: () => true, animationStyle: () => style };
			const times: number[] = [];
			const header = createHeaderFactory(state, true)({ requestRender: () => times.push(Date.now()) });
			const start = Date.now();
			vi.advanceTimersByTime(99);
			expect(times.map((at) => at - start)).toEqual([33, 66, 99]);
			header.dispose();
		}
		for (const style of ["wipe", "slide"] as const) {
			const times: number[] = [];
			const state = {
				...createState(),
				theme,
				animates: () => true,
				animationStyle: () => style,
				requestRender: () => times.push(Date.now()),
			};
			const panel: Component = { render: () => ["a", "b", "c", "d"], invalidate: () => {} };
			const start = Date.now();
			transitionHooks(state).panel!(panel, false);
			vi.advanceTimersByTime(48);
			expect(times.map((at) => at - start)).toEqual([16, 32, 48]);
			expect(panel.render(40)).toEqual(reveal(["a", "b", "c", "d"], 48 / PANEL_OPEN_MS, style));
			vi.runAllTimers();
			class SettingsSelector {
				render() {
					return ["→ a", "b"];
				}
				invalidate() {}
			}
			times.length = 0;
			const frame = dialogFrameHook(state);
			frame(new SettingsSelector(), 40);
			const began = Date.now();
			vi.advanceTimersByTime(48);
			expect(times.map((at) => at - began)).toEqual([16, 32, 48]);
			vi.runAllTimers();
			expect(frame(new SettingsSelector(), 40)?.lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
			vi.runAllTimers();
		}
		const titleTimes: number[] = [];
		const state = { ...createState(), animates: () => true, animationStyle: () => "dots" as const };
		const title = createTitleSpinner(state);
		title.attach({ terminal: { setTitle: () => titleTimes.push(Date.now()) } });
		const start = Date.now();
		title.start();
		vi.advanceTimersByTime(480);
		title.stop();
		expect(titleTimes.slice(0, 3).map((at) => at - start)).toEqual([160, 320, 480]);
		const renders = vi.fn();
		const menu = new AnimationsMenu({
			enabled: true,
			off: [],
			requestRender: renders,
			onEnabledChange: () => {},
			onOffChange: () => {},
			done: () => {},
		});
		menu.render(40);
		vi.advanceTimersByTime(120);
		menu.dispose();
		expect(renders).toHaveBeenCalledTimes(3); // existing 40 ms preview timer
	});

	it("shows the focused style in French within 40 columns, including the global presets", () => {
		setLanguage("fr");
		expect(t("Custom")).toBe("Personnalisé");
		const styles: AnimationStyles = animationPreset("Lively");
		const menu = new AnimationsMenu({
			enabled: true,
			off: [],
			styles,
			requestRender: () => {},
			onEnabledChange: () => {},
			onOffChange: () => {},
			done: () => {},
		});
		for (let i = 0; i < ANIMATIONS.length + 2; i++) {
			const lines = menu.render(40);
			expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
			menu.handleInput(DOWN);
		}
		for (const style of Object.keys(STYLE_LABELS))
			expect(t(STYLE_LABELS[style as keyof typeof STYLE_LABELS])).not.toBe(
				STYLE_LABELS[style as keyof typeof STYLE_LABELS],
			);
		menu.dispose();
	});

	it("keeps the animation preview visible inside the real settings window at 40 columns", () => {
		const model = groupSettingsByDomain(
			Array.from({ length: 10 }, (_, index) => ({ id: `padding-${index}`, label: "Example", currentValue: "on" })),
			() => {},
			{
				builtinExtensions: [],
				onBuiltinExtensionChange: () => {},
				animations: true,
				animationStyles: animationPreset("Lively"),
			},
		);
		const view = new SettingsView(model, {
			onClose: () => {},
			rows: () => 40,
			domain: "appearance",
			item: "animations",
			openItem: true,
		});
		const lines = view.render(40);
		expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
		expect(lines.map(stripAnsi).join("\n")).toContain("Preview");
		view.handleInput(ESC);
	});

	it("uses intro styles for the onboarding beam without changing its final frame", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const beams = new Set<string>();
		for (const style of ["default", "wipe", "dissolve"] as const) {
			const renders: number[] = [];
			const start = Date.now();
			const wizard = new OnboardingWizard({
				steps: [{ id: "a", title: "A", help: "", options: [{ value: "a", label: "A" }] }],
				initial: {},
				animate: true,
				animationStyle: style,
				requestRender: () => renders.push(Date.now() - start),
				onPreview: () => {},
				onDone: () => {},
				onSkip: () => {},
			});
			vi.advanceTimersByTime(200);
			beams.add(wizard.render(40)[2]!);
			expect(renders).toEqual([33, 66, 99, 132, 165, 198]);
			vi.advanceTimersByTime(450);
			expect(visibleWidth(wizard.render(40)[2]!)).toBe(37);
			wizard.dispose();
		}
		expect(beams.size).toBe(3);
	});
});

describe("core theme colours", () => {
	it("accepts hand-written themes without optional tokens", () => {
		const json = themeCopy("prism").json;
		delete json.colors.mdBold;
		const base = themeFromJson(json);
		const derived = themeFromJson(deriveTheme(json, base, coreColors(base)));
		expect(() => themeTextContrast(derived)).not.toThrow();
		expect(derived.colors.mdBold).toBeUndefined();
	});
	it("derives every token and preserves measured lightness steps on dark and light themes", () => {
		for (const name of ["prism", "prism-light"]) {
			const json = themeCopy(name).json;
			const base = themeFromJson(json);
			const cores = coreColors(base);
			cores.text = name === "prism" ? "#e7f0ff" : "#101e30";
			const derived = deriveTheme(json, base, cores);
			const next = themeFromJson(derived);
			expect(Object.keys(derived.colors).sort()).toEqual(Object.keys(base.colors).sort());
			expect(
				Object.values(derived.colors).every((value) => typeof value === "string" && value.startsWith("#")),
			).toBe(true);
			for (const token of ["thinkingText", "toolOutput", "thinkingHigh"] as const) {
				const step = colorToOklch(next.colors[token]).l - colorToOklch(next.colors.text).l;
				const original = colorToOklch(base.colors[token]).l - colorToOklch(base.colors.text).l;
				expect(Math.abs(step - original)).toBeLessThan(0.005);
			}
			const measured = themeTextContrast(next);
			expect(
				measured.ratio,
				`${name}: ${measured.ratio.toFixed(2)}:1 ${measured.token}/${measured.background}`,
			).toBeGreaterThanOrEqual(4.5);
			console.log(
				`${name}: lowest derived text contrast ${measured.ratio.toFixed(2)}:1 (${measured.token}/${measured.background})`,
			);
		}
	});

	it("changes only the family of the edited role, and tokens with their own hue keep their differences", () => {
		for (const name of ["prism", "prism-light"]) {
			const json = themeCopy(name).json;
			const base = themeFromJson(json);
			const resolved = (theme: ReturnType<typeof themeFromJson>, token: keyof typeof theme.colors) =>
				colorToHex(theme.colors[token]);
			const cores = coreColors(base);
			cores.error = name === "prism" ? "#ff5f7a" : "#a01030";
			const onlyError = themeFromJson(deriveTheme(json, base, cores));
			for (const token of ["syntaxKeyword", "syntaxFunction", "syntaxNumber", "toolSuccessBg", "text"] as const) {
				expect(resolved(onlyError, token), `${name} ${token}`).toBe(resolved(base, token));
			}
			// Another accent turns the syntax colours together: the gap between them stays.
			const accent = coreColors(base);
			accent.accent = "#e0a040";
			const turned = themeFromJson(deriveTheme(json, base, accent));
			const gap = (theme: ReturnType<typeof themeFromJson>) => {
				const turn = Math.abs(
					colorToOklch(theme.colors.syntaxKeyword).h - colorToOklch(theme.colors.syntaxFunction).h,
				);
				return Math.min(turn, 360 - turn);
			};
			// prism-light's keywords are grey, and a grey takes the role's colour.
			if (name === "prism") expect(Math.abs(gap(turned) - gap(base))).toBeLessThan(5);
		}
		// Another surface keeps the green and the red of a tool's result, in a theme that tints them.
		const json = themeCopy("dark").json;
		const base = themeFromJson(json);
		const surface = coreColors(base);
		surface.userMessageBg = "#20242c";
		const lit = themeFromJson(deriveTheme(json, base, surface));
		for (const token of ["toolSuccessBg", "toolErrorBg"] as const) {
			expect(colorToOklch(base.colors[token]).c).toBeGreaterThan(0.02);
			const turn = Math.abs(colorToOklch(lit.colors[token]).h - colorToOklch(base.colors[token]).h) % 360;
			expect(Math.min(turn, 360 - turn), token).toBeLessThan(40);
		}
	});

	it("starts with nine roles and a closed Advanced entry, without rewriting a hand-authored theme", () => {
		const { component } = editor();
		const lines = component.render(60).map(stripAnsi);
		for (const { label } of THEME_ROLES) expect(lines.some((line) => line.includes(label))).toBe(true);
		expect(lines.some((line) => line.includes("Advanced"))).toBe(true);
		expect(lines.join("\n")).not.toContain("syntaxKeyword");
		expect(lines.join("\n")).toContain("carries to the colours");
		for (let i = 0; i < THEME_ROLES.length; i++) component.handleInput(DOWN);
		component.handleInput(ENTER);
		expect(component.render(60).map(stripAnsi).join("\n")).toContain("ink");
		component.handleInput(ESC);
		expect(existsSync(join(home, "themes"))).toBe(false);
	});

	it("saves ordinary complete files, carries an accent to code and links, and retains subsequent core edits", () => {
		const { component, preview } = editor();
		for (let i = 0; i < 4; i++) component.handleInput(DOWN);
		replace(component, "#bdd5e6");
		component.handleInput(ENTER);
		const path = join(home, "themes", "prism-custom.json");
		const json = JSON.parse(readFileSync(path, "utf8")) as EditableTheme;
		expect(json.colors.accent).toBe("#bdd5e6");
		expect(json.colors.mdLink).not.toBe(themeCopy("prism").json.colors.mdLink);
		expect(colorToHex(preview.mock.calls.at(-1)![0].colors.accent)).toBe("#bdd5e6");
		component.handleInput(DOWN);
		replace(component, "#454552");
		component.handleInput(ENTER);
		const second = JSON.parse(readFileSync(path, "utf8")) as EditableTheme;
		expect(second.colors.accent).toBe("#bdd5e6");
		expect(second.colors.border).toBe("#454552");
		expect(second.export).toEqual(json.export); // No cumulative drift after an unrelated core edit.
		expect(() => themeFromJson(second)).not.toThrow();
	});

	it("preserves hand-written tokens when opened or edited through Advanced", () => {
		const json = { ...themeCopy("prism").json, name: "handwritten" };
		json.colors.mdLink = "#123456";
		mkdirSync(join(home, "themes"));
		const path = join(home, "themes", "handwritten.json");
		const bytes = JSON.stringify(json);
		writeFileSync(path, bytes);
		const { component } = editor("handwritten");
		component.handleInput(ESC);
		expect(readFileSync(path, "utf8")).toBe(bytes);
		for (let i = 0; i < THEME_ROLES.length; i++) component.handleInput(DOWN);
		component.handleInput(ENTER);
		const firstColour = Object.keys(json.vars ?? {}).length;
		for (let i = 0; i < firstColour; i++) component.handleInput(DOWN);
		replace(component, "#ffffff");
		component.handleInput(ENTER); // accent only
		const saved = JSON.parse(readFileSync(path, "utf8")) as EditableTheme;
		expect(saved.colors).toEqual({ ...json.colors, accent: "#ffffff" });
	});

	// warn under 4.5:1, never refuse.
	it("saves an unreadable core colour with a warning that gives the measured WCAG ratio", () => {
		const { component, apply, preview } = editor();
		component.handleInput(DOWN);
		component.handleInput(DOWN); // text
		replace(component, "#111111");
		expect(component.render(60).map(stripAnsi).join("\n")).toContain("Low contrast: 1.00:1");
		expect(preview.mock.calls.some(([shown]) => colorToHex(shown.colors.text) === "#111111")).toBe(true);
		component.handleInput(ENTER);
		expect(component.render(60).map(stripAnsi).join("\n")).toContain("Saved with low contrast: 1.00:1");
		expect(apply).toHaveBeenCalled();
		expect(existsSync(join(home, "themes"))).toBe(true);
		for (const width of [40, 64])
			expect(component.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
	});
});
