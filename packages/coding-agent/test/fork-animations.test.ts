// fork: each animation has its own switch under the global one, in /settings > Appearance >
// Animations, with a live preview drawn by the animation's own code.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { ANIMATIONS, type AnimationId, animationOn } from "../src/fork/animations.ts";
import prismExtension from "../src/fork/prism/index.ts";
import { createState } from "../src/fork/prism/lib/state.ts";
import { thinking } from "../src/fork/prism/transcript.ts";
import { renderHooks, setRenderHooks } from "../src/fork/render-hooks.ts";
import { AnimationsMenu, animationPreview, animationsSetting } from "../src/fork/settings-animations.ts";
import { createSettingsDomainExtras } from "../src/fork/settings-domain-extras.ts";
import { groupSettingsByDomain } from "../src/fork/settings-domains.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const ENTER = "\r";
const DOWN = "\x1b[B";
const ESC = "\x1b";

function menu(enabled = true, off: string[] = []) {
	const saved = { enabled, off, done: undefined as string | undefined };
	const component = new AnimationsMenu({
		enabled,
		off,
		onEnabledChange: (value) => {
			saved.enabled = value;
		},
		onOffChange: (ids) => {
			saved.off = ids;
		},
		requestRender: () => {},
		done: (value) => {
			saved.done = value;
		},
	});
	return { component, saved };
}

/** The menu's preview rows, between "Preview" and the blank line after them. */
function preview(component: AnimationsMenu): string[] {
	const lines = component.render(60);
	component.dispose();
	const start = lines.findIndex((line) => stripAnsi(line).startsWith("Preview"));
	const end = lines.indexOf("", start);
	return lines.slice(start + 1, end);
}

describe("fork: animations one by one", () => {
	beforeAll(() => initTheme("dark"));
	afterEach(() => vi.useRealTimers());

	it("moves only with the global switch on and its own switch on", () => {
		expect(animationOn({}, "working")).toBe(true);
		expect(animationOn({ animations: false }, "working")).toBe(false);
		expect(animationOn({ animationsOff: ["thinking"] }, "thinking")).toBe(false);
		expect(animationOn({ animationsOff: ["thinking"] }, "working")).toBe(true);
	});

	it("lists the global switch then each animation, and saves each switch on its own", () => {
		const { component, saved } = menu();
		const text = component.render(60).map(stripAnsi);
		component.dispose();
		expect(text.some((line) => line.includes("All animations"))).toBe(true);
		for (const { label } of ANIMATIONS) expect(text.some((line) => line.includes(label))).toBe(true);

		component.handleInput(DOWN); // Startup logo
		component.handleInput(DOWN); // Working line
		component.handleInput(ENTER);
		expect(saved.off).toEqual(["working"]);
		expect(saved.enabled).toBe(true);
		component.handleInput(" ");
		expect(saved.off).toEqual([]);

		component.handleInput(DOWN); // Thinking label
		component.handleInput(ENTER);
		component.handleInput(DOWN); // Running tool
		component.handleInput(ENTER);
		expect(saved.off).toEqual(["thinking", "tools"]);
		component.handleInput(ESC);
		expect(saved.done).toBe("on");
	});

	it("turns everything off with the global switch and keeps each switch's own state", () => {
		const { component, saved } = menu(true, ["title"]);
		component.handleInput(ENTER);
		expect(saved.enabled).toBe(false);
		expect(saved.off).toEqual(["title"]);
		const rows = component.render(60).map(stripAnsi);
		component.dispose();
		// Left on under the global switch: "off (all)"; turned off on its own: "off".
		expect(rows.find((line) => line.includes("Working line"))).toMatch(/off \(all\)$/);
		expect(rows.find((line) => line.includes("Terminal title"))).toMatch(/off$/);
		expect(rows.find((line) => line.includes("Terminal title"))).not.toMatch(/\(all\)/);
		component.handleInput(ESC);
		expect(saved.done).toBe("off");
	});

	it("previews the focused animation: moving when on, still when off", () => {
		vi.useFakeTimers();
		const moving = (id: AnimationId, on: boolean) => {
			const frames = new Set<string>();
			for (let i = 0; i < 12; i++) {
				vi.setSystemTime(1_000_000 + i * 137);
				frames.add(animationPreview(id, on, Date.now(), 40).join("\n"));
			}
			return frames.size;
		};
		for (const { id } of ANIMATIONS) {
			expect(moving(id, true), id).toBeGreaterThan(1);
			expect(moving(id, false), id).toBe(1);
		}

		// The menu shows the preview of the row under the cursor, still once that animation is off.
		const { component } = menu();
		component.handleInput(DOWN);
		component.handleInput(DOWN); // Working line
		vi.setSystemTime(2_000_000);
		const first = preview(component);
		vi.setSystemTime(2_000_300);
		expect(preview(component)).not.toEqual(first);
		component.handleInput(ENTER);
		vi.setSystemTime(2_000_600);
		const still = preview(component);
		vi.setSystemTime(2_000_900);
		expect(preview(component)).toEqual(still);
	});

	it("stops drawing the preview again once the menu is no longer shown", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const component = new AnimationsMenu({
			enabled: true,
			off: [],
			onEnabledChange: () => {},
			onOffChange: () => {},
			requestRender,
			done: () => {},
		});
		component.render(60);
		vi.advanceTimersByTime(500);
		expect(requestRender).toHaveBeenCalled();
		vi.advanceTimersByTime(2000);
		const calls = requestRender.mock.calls.length;
		vi.advanceTimersByTime(2000);
		expect(requestRender.mock.calls.length).toBe(calls);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("reads its own switch in the real drawing code: the thinking label stays still when turned off", () => {
		vi.useFakeTimers();
		const label = (animates: (id: AnimationId) => boolean) => {
			const state = { ...createState(), animates };
			const out = new Set<string>();
			for (let i = 0; i < 8; i++) {
				vi.setSystemTime(5_000_000 + i * 400);
				out.add(thinking(theme, true, ["Thinking…"], true, state)[0]!);
			}
			return out.size;
		};
		expect(label(() => true)).toBeGreaterThan(1);
		expect(label((id) => id !== "thinking")).toBe(1);
		expect(label((id) => id === "thinking")).toBeGreaterThan(1);
	});

	it("saves the switches from /settings > Appearance in the user settings", async () => {
		vi.stubEnv("EXA_API_KEY", "from-env");
		const settings = SettingsManager.inMemory({});
		const extras = await createSettingsDomainExtras({
			settings,
			loadedExtensionPaths: [],
			hasWebKeyCommand: false,
			onWebSearchKey: vi.fn(),
		});
		const grouped = groupSettingsByDomain([], vi.fn(), extras);
		const row = grouped
			.domains()
			.flatMap((domain) => domain.items())
			.find((item) => item.id === "animations")!;
		const done = vi.fn();
		const submenu = row.submenu!(row.currentValue, done);
		submenu.handleInput!(DOWN);
		submenu.handleInput!(ENTER); // Startup logo off
		(submenu as AnimationsMenu).dispose();
		expect(settings.getAnimationsOff()).toEqual(["intro"]);
		expect(settings.getGlobalSettings().animationsOff).toEqual(["intro"]);
		expect(row.description).toContain("Turned off: Startup logo.");
		submenu.handleInput!(ESC);
		expect(done).toHaveBeenCalledWith("on");
		vi.unstubAllEnvs();
	});

	it("keeps an unknown or malformed list from breaking the setting", () => {
		const settings = SettingsManager.inMemory({ animationsOff: ["working", 3 as unknown as string] });
		expect(settings.getAnimationsOff()).toEqual(["working"]);
		const row = animationsSetting({
			enabled: true,
			off: [],
			onEnabledChange: () => {},
			onOffChange: () => {},
			requestRender: () => {},
		});
		expect(row.currentValue).toBe("on");
		expect(row.description).not.toContain("Turned off");
	});

	it("applies a switch changed in the settings within a second, without a restart", async () => {
		vi.useFakeTimers();
		const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		const settings: { animations?: boolean; animationsOff?: string[] } = {};
		const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
		const pi = {
			on: (event: string, handler: never) => handlers.set(event, handler),
			registerShortcut: () => {},
			registerEntryRenderer: () => {},
			registerCommand: () => {},
			events: { on: () => {} },
			getSettings: () => structuredClone(settings),
		};
		try {
			prismExtension(pi as unknown as ExtensionAPI);
			const ui = { theme, setHeader: () => {}, setFooter: () => {}, setEditorComponent: () => {} };
			await handlers.get("session_start")?.({ type: "session_start" }, { hasUI: true, ui });
			// The cache key holds each animation's switch, in ANIMATIONS order.
			const switches = () => renderHooks.cacheKey!().slice(3, 3 + ANIMATIONS.length);
			expect(switches()).toEqual(ANIMATIONS.map(() => true));

			settings.animationsOff = ["thinking"];
			expect(switches()).toEqual(ANIMATIONS.map(() => true)); // read again at most once a second
			vi.advanceTimersByTime(1100);
			expect(switches()).toEqual(ANIMATIONS.map(({ id }) => id !== "thinking"));

			settings.animations = false;
			vi.advanceTimersByTime(1100);
			expect(switches()).toEqual(ANIMATIONS.map(() => false));
			await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, {});
		} finally {
			if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
			else delete (process.stdout as { isTTY?: boolean }).isTTY;
			setRenderHooks({});
		}
	});
});
