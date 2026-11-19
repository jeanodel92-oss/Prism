// fork: /tutorial, the nine modules in a window over the screen, with
// exercises Prism checks itself (demo answer for modules 1 and 2, overlay window, offered at the end of the onboarding and in « more… »)
// .
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURSOR_MARKER, setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { setLanguage } from "../src/fork/i18n/index.ts";
import { buildSteps, TUTORIAL_EVENT, type TutorialRequest } from "../src/fork/onboarding.ts";
import { createState } from "../src/fork/prism/lib/state.ts";
import { moreMenuEntries } from "../src/fork/prism/more-menu.ts";
import {
	installTutorial,
	loadProgress,
	saveProgress,
	TUTORIAL_MODULES,
	type TutorialKeys,
	type TutorialProgress,
	TutorialView,
	type TutorialViewOptions,
	tutorialKeys,
} from "../src/fork/tutorial.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const ESC = "\x1b";
const ENTER = "\r";
const TAB = "\t";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const CTRL_O = "\x0f";
const ALT_P = "\x1bp";
const ALT_E = "\x1be";

const key = (label: string, data: string) => ({ label, matches: (input: string) => input === data, ids: [label] });

function keys(withPlan = true): TutorialKeys {
	return {
		interrupt: key("escape", ESC),
		followUp: key("alt+enter", "\x1b\r"),
		dequeue: key("alt+up", "\x1b\x1b[A"),
		toolsExpand: key("ctrl+o", CTRL_O),
		thinkingToggle: key("ctrl+t", "\x14"),
		thinkingCycle: key("shift+tab", "\x1b[Z"),
		modelSelect: key("ctrl+l", "\x0c"),
		modelCycle: key("ctrl+p", "\x10"),
		goalMenu: key("alt+g", "\x1bg"),
		filesBrowse: key("alt+e", ALT_E),
		...(withPlan ? { plan: key("alt+p", ALT_P) } : {}),
	};
}

function view(options: Partial<TutorialViewOptions> = {}) {
	const saved: TutorialProgress[] = [];
	const onClose = vi.fn<(then?: string) => void>();
	let tick: (() => void) | undefined;
	const component = new TutorialView({
		keys: keys(),
		progress: { done: [], skipped: [] },
		save: (progress) => saved.push(structuredClone(progress)),
		available: () => true,
		height: () => 40,
		requestRender: () => {},
		onClose,
		every: (_ms, next) => {
			tick = next;
			return () => {
				tick = undefined;
			};
		},
		...options,
	});
	const send = (...inputs: string[]) => {
		for (const input of inputs) component.handleInput(input);
	};
	const type = (text: string) => send(...text);
	const screen = (width = 100) =>
		component.render(width).map((line) => stripAnsi(line.replaceAll(CURSOR_MARKER, "")).trimEnd());
	const text = (width = 100) => screen(width).join("\n");
	const done = () => saved.at(-1)?.done ?? [];
	return { component, send, type, screen, text, onClose, saved, done, tick: () => tick?.() };
}

/** The module's side of the window as one line, so that a wrapped sentence reads whole. */
function prose(v: ReturnType<typeof view>): string {
	return v
		.screen()
		.map((line) => line.split("│").slice(2, -1).join("│").trim())
		.join(" ")
		.replace(/\s+/g, " ");
}

/** To module `index` (0-based) from the first one, then to its exercise page. */
function toExercise(v: ReturnType<typeof view>, index: number) {
	for (let i = 0; i < index; i++) v.send(DOWN);
	for (let i = 0; i < TUTORIAL_MODULES[index]!.pages.length; i++) v.send(RIGHT);
}

describe("fork: /tutorial", () => {
	beforeAll(() => initTheme("prism"));
	afterEach(() => setLanguage("en"));

	it("lists the nine modules of the plan in order, and opens on the first one not done or skipped", () => {
		expect(TUTORIAL_MODULES.map((module) => module.title)).toEqual([
			"First steps",
			"Asking well",
			"Following the work",
			"Permissions",
			"Plan and goal",
			"Sessions",
			"Models and settings",
			"Working on a project",
			"Going further",
		]);
		const v = view({ progress: { done: ["first-steps"], skipped: ["asking"] } });
		const lines = v.screen();
		expect(lines[1]).toMatch(/Tutorial {2}1 of 9 modules done +✕ │$/);
		expect(lines.find((line) => line.includes("1  First steps"))).toMatch(/│ ✓ 1 {2}First steps/);
		expect(lines.find((line) => line.includes("2  Asking well"))).toMatch(/│ – 2 {2}Asking well/);
		expect(lines.find((line) => line.includes("3  Following"))).toMatch(/│▌ {2}3 {2}Following the work +│/);
		expect(lines).toContainEqual(expect.stringMatching(/│ Following the work {2}1\/3 +│$/));
	});

	it("fits every width: two columns when wide, the module alone when narrow", () => {
		const v = view();
		for (const width of [100, 80, 64, 50, 40]) {
			for (const line of v.component.render(width)) expect([...stripAnsi(line)].length).toBeLessThanOrEqual(width);
		}
		expect(v.text(60)).toContain("1/9 · First steps  1/3");
		expect(v.text(60)).not.toContain("Asking well");
		// The key hints wrap instead of being cut.
		const hints = v.screen(44).slice(-3, -1).join("\n");
		expect(hints).toContain("close");
		expect(hints).not.toContain("…");
		// A short terminal drops the spacers, then the end of the text, but keeps the buttons.
		const short = view({ height: () => 12 });
		const lines = short.screen(60);
		expect(lines.length).toBeLessThanOrEqual(12);
		expect(lines.join("\n")).toMatch(/\[ Next › +\]/);
	});

	it("module 1: a demo answer that the interrupt key stops, which Esc otherwise closes", () => {
		const v = view();
		toExercise(v, 0);
		expect(v.text()).toContain("Send a request, then stop the answer with escape.");
		expect(v.text()).toContain("Demo: Prism writes this answer itself; no model is called.");
		v.type("fix the bug");
		v.send(ENTER);
		v.tick();
		v.tick();
		v.tick();
		expect(v.text()).toContain("› fix the bug");
		expect(v.text()).toMatch(/─ Here is how ▍/);
		expect(v.text()).toContain("escape stops the answer");
		v.send(ESC);
		expect(v.onClose).not.toHaveBeenCalled();
		expect(v.done()).toEqual(["first-steps"]);
		expect(v.text()).toContain("Stopped. What was already written stays.");
		v.send(ESC);
		expect(v.onClose).toHaveBeenCalledWith();
	});

	it("module 1: an answer left to finish does not count", () => {
		const v = view();
		toExercise(v, 0);
		v.type("go");
		v.send(ENTER);
		for (let i = 0; i < 100; i++) v.tick();
		expect(v.done()).toEqual([]);
		expect(v.text()).toContain("The answer is complete. Send another request and press escape before");
	});

	it("module 2: the request must attach a file with @", () => {
		const v = view();
		toExercise(v, 1);
		v.type("explain the readme");
		v.send(ENTER);
		expect(v.done()).toEqual([]);
		expect(v.text()).toContain("No file attached");
		v.type("explain @README.md");
		v.send(ENTER);
		expect(v.done()).toEqual(["asking"]);
		expect(v.text()).toContain("─ I read README.md before answering.");
	});

	it("module 3: the configured key shows the tool's output", () => {
		const v = view();
		toExercise(v, 2);
		expect(v.text()).not.toContain("import { run }");
		v.send(CTRL_O);
		expect(v.text()).toContain('1  import { run } from "./run.ts";');
		expect(v.done()).toEqual(["following"]);
	});

	it("module 4: typing the command, then « Try it now » opens the real one; Docs opens its page", () => {
		const v = view();
		toExercise(v, 3);
		expect(v.text()).not.toContain("Try it now");
		v.type("/prem");
		v.send(ENTER);
		expect(v.done()).toEqual([]);
		expect(v.text()).toContain("Type /perm exactly, then Enter.");
		v.type("/perm");
		v.send(ENTER, ENTER);
		expect(v.done()).toEqual(["permissions"]);
		expect(v.text()).toMatch(/\[ ‹ Back \] \[ Next module › \] \[ Restart \] \[ Docs › \] \[ Try it now › \]/);
		v.send(TAB, TAB, TAB, TAB, TAB, ENTER);
		expect(v.onClose).toHaveBeenCalledWith("/perm");
		v.send(TAB, TAB, TAB, TAB, ENTER);
		expect(v.onClose).toHaveBeenLastCalledWith("/docs permissions");

		// Without the command in this session, no « Try it now ».
		const without = view({ available: () => false });
		toExercise(without, 3);
		without.type("/perm");
		without.send(ENTER, ENTER);
		expect(without.done()).toEqual(["permissions"]);
		expect(without.text()).not.toContain("Try it now");
	});

	it("module 5: Plan mode on then off; without the Plan module, reading it is enough", () => {
		const v = view();
		toExercise(v, 4);
		v.send(ALT_P);
		expect(v.text()).toContain("● Plan mode  on");
		expect(v.done()).toEqual([]);
		v.send(ALT_P);
		expect(v.done()).toEqual(["plan-goal"]);

		const without = view({ keys: keys(false) });
		for (let i = 0; i < 4; i++) without.send(DOWN);
		expect(without.text()).toContain("/plan turns it on and off");
		without.send(RIGHT);
		expect(without.done()).toEqual(["plan-goal"]);
		expect(without.text()).toContain("✓ Module done");
	});

	it("modules 6 to 9: the commands, the file browser key, and the last module done once read", () => {
		const v = view();
		toExercise(v, 5);
		v.type("/tree");
		v.send(ENTER, ENTER);
		v.send(UP, DOWN, DOWN);
		for (let i = 0; i < 2; i++) v.send(RIGHT);
		v.type("/settings");
		v.send(ENTER, ENTER);
		v.send(DOWN, RIGHT, RIGHT, ALT_E);
		expect(v.text()).toContain("The file browser opens here");
		v.send(DOWN, RIGHT);
		expect(v.done()).toEqual(["sessions", "models", "project", "further"]);
		expect(v.text()).not.toContain("Next");
	});

	// fork: the buttons moved from page to page, « Next module » did not answer the keyboard as
	// « Next » does, and the command exercises only asked to try the command for real.
	it("keeps the window's height and the buttons' places on every page and exercise state", () => {
		for (const width of [100, 64, 40]) {
			const v = view();
			const places = new Set<string>();
			const record = () => {
				const lines = v.screen(width);
				const y = lines.findIndex((line) => line.includes("Docs ›"));
				places.add(`${lines.length} ${y} ${lines[y]!.indexOf("Docs ›")}`);
			};
			// → walks every page, then on to the next module.
			const pages = TUTORIAL_MODULES.reduce((sum, module, i) => sum + module.pages.length + (i < 8 ? 1 : 0), 0);
			for (let i = 0; i < pages; i++) {
				record();
				v.send(RIGHT);
			}
			expect(v.text(width)).toContain("Going further");
			const exercises = view();
			toExercise(exercises, 0);
			exercises.type("go");
			exercises.send(ENTER);
			for (let i = 0; i < 100; i++) exercises.tick();
			const record2 = (other: ReturnType<typeof view>) => {
				const lines = other.screen(width);
				const y = lines.findIndex((line) => line.includes("Docs ›"));
				places.add(`${lines.length} ${y} ${lines[y]!.indexOf("Docs ›")}`);
			};
			record2(exercises);
			const tree = view();
			toExercise(tree, 5);
			tree.type("/tree");
			tree.send(ENTER);
			record2(tree);
			tree.send(DOWN, DOWN, ENTER);
			record2(tree);
			expect([...places]).toHaveLength(1);
		}
	});

	it("goes on to the next module with Enter or → once an exercise is done, as « Next module »", () => {
		const v = view();
		toExercise(v, 5);
		v.type("/tree");
		v.send(ENTER, ENTER);
		expect(v.done()).toEqual(["sessions"]);
		v.send(ENTER);
		expect(v.text()).toContain("Models and settings  1/3");

		const right = view();
		toExercise(right, 3);
		right.type("/perm");
		right.send(ENTER, ENTER, RIGHT);
		expect(right.text()).toContain("Plan and goal  1/3");

		// Not done yet: Enter checks the line instead.
		const early = view();
		toExercise(early, 5);
		early.send(ENTER);
		expect(early.text()).toContain("Sessions  3/3");
		expect(early.text()).toContain("Type /tree exactly, then Enter.");
	});

	it("Enter on an unfinished exercise with nothing typed says what to do, without completing or leaving it", () => {
		const request = view();
		toExercise(request, 0);
		request.send(ENTER);
		expect(request.text()).toContain("Type a request in the box, then press Enter.");
		expect(request.text()).toContain("First steps  3/3");
		expect(request.done()).toEqual([]);

		const file = view();
		toExercise(file, 1);
		file.send(ENTER);
		expect(file.text()).toContain("No file attached");
		expect(file.done()).toEqual([]);

		const tool = view();
		toExercise(tool, 2);
		tool.send(ENTER);
		expect(tool.text()).toContain("Press ctrl+o to do this exercise.");
		expect(tool.text()).toContain("Following the work  3/3");
		expect(tool.done()).toEqual([]);
		// « Next module » and → still go on.
		tool.send(RIGHT);
		expect(tool.text()).toContain("Permissions  1/");
	});

	it("simulates what the command shows, without changing anything", () => {
		const v = view();
		toExercise(v, 5);
		v.type("/tree");
		v.send(ENTER);
		expect(v.done()).toEqual([]);
		expect(v.text()).toContain("› Add a --verbose flag to src/cli.ts");
		expect(v.text()).toContain("    ─ Done: each step prints its time.");
		expect(v.text()).toContain("Demo: this is what /tree shows.");
		v.send(DOWN, DOWN);
		expect(v.text()).toContain("Sessions  3/3");
		v.send(ENTER);
		expect(v.done()).toEqual(["sessions"]);
		expect(v.text()).toContain("● ");
		expect(prose(v)).toContain(
			"Demo: the conversation would go on from « Also print how long each step takes »; what came after stays in the tree. Your sessions have not changed.",
		);
		expect(v.onClose).not.toHaveBeenCalled();

		const perm = view();
		toExercise(perm, 3);
		perm.type("/perm");
		perm.send(ENTER, DOWN, DOWN, ENTER);
		expect(prose(perm)).toContain("Demo: the permission mode would now be Broad. Your real mode has not changed.");
	});

	it("skips and restarts a module; Enter on a page goes on", () => {
		const v = view();
		v.send(TAB, ENTER); // the first button of the first page: Next
		expect(v.text()).toContain("First steps  2/3");
		v.send(TAB, TAB, TAB, ENTER); // Back, Next, Skip
		expect(v.saved.at(-1)).toEqual({ done: [], skipped: ["first-steps"] });
		expect(v.text()).toContain("Asking well  1/3");
		v.send(UP);
		expect(v.text()).toMatch(/\[ Restart \]/);
		v.send(TAB, TAB, ENTER); // Next, Restart
		expect(v.saved.at(-1)).toEqual({ done: [], skipped: [] });
		v.send(ENTER);
		expect(v.text()).toContain("First steps  2/3");
	});

	// a pasted instruction taller than the terminal was drawn whole and
	// pushed the buttons out of the window.
	it("keeps the buttons in a short window after a very long instruction, in both typing exercises", () => {
		const long = Array.from({ length: 150 }, (_, i) => `word${i}`).join(" ");
		for (const [index, typed] of [
			[0, long],
			[1, `explain @README.md ${long}`],
		] as const) {
			for (const width of [100, 50]) {
				const v = view({ height: () => 20 });
				toExercise(v, index);
				v.type(typed);
				v.send(ENTER);
				const lines = v.screen(width);
				expect(lines.length).toBeLessThanOrEqual(20);
				const row = lines.findIndex((line) => line.includes("‹ Back"));
				expect(row).toBeGreaterThan(0);
				const echo = `› ${typed.slice(0, 12)}`;
				expect(lines.join("\n")).toContain(echo);
				// The button is still where a click lands: « Back » leaves the exercise.
				const x = lines[row]!.indexOf("‹ Back") + 1;
				v.component.handleMouse({ type: "click", button: "left", x, y: row } as never);
				expect(v.text(width)).not.toContain(echo);
			}
		}
	});

	it("takes clicks on the modules, the buttons and ✕", () => {
		const v = view();
		const lines = v.screen();
		const row = lines.findIndex((line) => line.includes("4  Permissions"));
		v.component.handleMouse({ type: "click", button: "left", x: 5, y: row } as never);
		expect(v.text()).toContain("Permissions  1/3");
		const buttons = v.screen().findIndex((line) => /\[ Next › +\]/.test(line));
		const x = v.screen()[buttons]!.indexOf("[ Next ›");
		v.component.handleMouse({ type: "click", button: "left", x: x + 2, y: buttons } as never);
		expect(v.text()).toContain("Permissions  2/3");
		v.component.handleMouse({ type: "click", button: "left", x: lines[1]!.indexOf("✕"), y: 1 } as never);
		expect(v.onClose).toHaveBeenCalledWith();
	});

	it("speaks French, keys included", () => {
		setLanguage("fr");
		const v = view();
		v.send(RIGHT);
		const text = v.text();
		expect(text).toContain("Tutoriel");
		expect(text).toContain("modules faits : 0 sur 9");
		expect(text).toContain("Appuyez sur escape pour arrêter le modèle à tout moment.");
		expect(text).toContain("Premiers pas");
		expect(text).toContain("↑↓ module · ←→ page · Tab : boutons · Échap ou ✕ : fermer");
		for (const width of [100, 60, 40]) {
			for (const line of v.component.render(width)) expect([...stripAnsi(line)].length).toBeLessThanOrEqual(width);
		}
	});

	it("keeps its progress in tutorial.json, ignoring what it does not know", () => {
		const dir = mkdtempSync(join(tmpdir(), "prism-tutorial-"));
		try {
			const path = join(dir, "sub", "tutorial.json");
			expect(loadProgress(path)).toEqual({ done: [], skipped: [] });
			saveProgress(path, { done: ["asking"], skipped: ["sessions"] });
			expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ done: ["asking"], skipped: ["sessions"] });
			writeFileSync(path, JSON.stringify({ done: ["asking", "gone", 3], skipped: "x" }));
			expect(loadProgress(path)).toEqual({ done: ["asking"], skipped: [] });
			writeFileSync(path, "{");
			expect(loadProgress(path)).toEqual({ done: [], skipped: [] });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("names and checks the keys the user configured", () => {
		setKeybindings(new KeybindingsManager({ "app.tools.expand": "ctrl+y" }));
		const state = createState();
		state.modes.plan = true;
		state.planShortcut = () => "alt+p";
		const configured = tutorialKeys(state);
		expect(configured.toolsExpand.label).toBe("ctrl+y");
		expect(configured.toolsExpand.matches("\x19")).toBe(true);
		expect(configured.toolsExpand.matches(CTRL_O)).toBe(false);
		expect(configured.interrupt.label).toBe("escape");
		expect(configured.plan?.matches(ALT_P)).toBe(true);
		state.modes.plan = false;
		expect(tutorialKeys(state).plan).toBeUndefined();
		setKeybindings(new KeybindingsManager());
	});

	it("is a command, in « more… », and the onboarding's last step when loaded", async () => {
		const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
		const listeners = new Map<string, (data: unknown) => void>();
		const pi = {
			on: () => {},
			registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
				commands.set(name, options),
			events: { on: (name: string, listener: (data: unknown) => void) => listeners.set(name, listener) },
			getCommands: () => [],
		} as unknown as ExtensionAPI;
		installTutorial(pi, createState());
		expect(commands.has("tutorial")).toBe(true);
		const notify = vi.fn();
		const request: TutorialRequest = { ctx: { hasUI: false, ui: { notify } } as never };
		listeners.get(TUTORIAL_EVENT)!(request);
		expect(await request.opened).toBe(false);
		expect(notify).toHaveBeenCalledWith("The tutorial needs the interactive interface.", "warning");

		expect(moreMenuEntries(new Set(["tutorial"])).map((entry) => entry.command)).toContain("tutorial");
		expect(moreMenuEntries(new Set()).map((entry) => entry.command)).not.toContain("tutorial");
		expect(buildSteps("faux/model").map((step) => step.id)).not.toContain("tutorial");
		const last = buildSteps("faux/model", true).at(-1)!;
		expect(last.id).toBe("tutorial");
		expect(last.options.map((option) => option.value)).toEqual(["start", "later"]);
	});
});
