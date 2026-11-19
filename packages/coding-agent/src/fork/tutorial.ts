/**
 * fork: /tutorial, nine short modules in a window over the screen. The modules on the left, ✓ for the ones done; the chosen module on the
 * right: two short pages, then an exercise Prism checks itself, without calling the model. The exercises happen
 * inside the window: the configured key pressed, the command typed on a practice line, and for modules 1 and 2
 * a demo answer written by Prism. « Try it now » then closes the tutorial and opens the real
 * command. Progress is kept in tutorial.json in the agent directory.
 *
 * fork: the window keeps one height and its buttons one place on every page; Enter and →
 * go on to the next module once an exercise is done, as « Next module »; a command typed in an exercise shows
 * a simulated menu to pick from, which changes nothing.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type Component,
	getKeybindings,
	Input,
	type Keybinding,
	type KeyId,
	matchesKey,
	setKeybindings,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { getAgentDir } from "../config.ts";
import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";
import { KeybindingsManager } from "../core/keybindings.ts";
import { BUILTIN_SLASH_COMMANDS } from "../core/slash-commands.ts";
import { formatKeyText, keyText } from "../modes/interactive/components/keybinding-hints.ts";
import { theme } from "../modes/interactive/theme/theme.ts";
import { getLanguage, t } from "./i18n/index.ts";
import { TUTORIAL_EVENT, type TutorialRequest } from "./onboarding.ts";
import { onBg, paint, tok } from "./prism/lib/palette.ts";
import type { PrismState } from "./prism/lib/state.ts";

/** The window's widest size. */
export const TUTORIAL_MAX_WIDTH = 100;

/** A key as the user configured it. */
export interface TutorialKey {
	label: string;
	matches: (data: string) => boolean;
	/** The key ids behind it, for the window, which matches its own key events. */
	ids: readonly string[];
}

export interface TutorialKeys {
	interrupt: TutorialKey;
	followUp: TutorialKey;
	dequeue: TutorialKey;
	toolsExpand: TutorialKey;
	thinkingToggle: TutorialKey;
	thinkingCycle: TutorialKey;
	modelSelect: TutorialKey;
	modelCycle: TutorialKey;
	goalMenu: TutorialKey;
	filesBrowse: TutorialKey;
	/** Plan mode's key; undefined when the Plan mode module is off. */
	plan?: TutorialKey;
}

export interface TutorialProgress {
	done: string[];
	skipped: string[];
}

type Exercise =
	| { kind: "interrupt" }
	| { kind: "file" }
	| { kind: "command"; command: string }
	| { kind: "key"; mock: "tool" | "plan" | "files"; key: TutorialKey };

interface ModuleDef {
	id: string;
	title: string;
	/** The /docs topic on the same subject. */
	doc: string;
	pages: Array<(keys: TutorialKeys) => string[]>;
	exercise?: (keys: TutorialKeys) => { text: string; exercise: Exercise } | undefined;
	/** The command « Try it now » runs once the exercise is done. */
	tryIt?: string;
}

/** `text` in the interface language, with `{0}`, `{1}`… replaced by `parts`. */
function say(text: string, ...parts: string[]): string {
	return parts.reduce((out, part, i) => out.replace(`{${i}}`, part), t(text));
}

const typeCommand = (command: string) => ({
	text: say("Type {0} and press Enter.", `/${command}`),
	exercise: { kind: "command", command } as const,
});

export const TUTORIAL_MODULES: readonly ModuleDef[] = [
	{
		id: "first-steps",
		title: "First steps",
		doc: "usage",
		pages: [
			() => [
				say(
					"Write what you want in the box at the bottom and press Enter. The model answers in the chat above; to do it, it may read files and run commands.",
				),
				say("Each of its actions shows as a line in the chat, so you can follow what it does."),
			],
			(keys) => [
				say("Press {0} to stop the model at any time. What it already did stays.", keys.interrupt.label),
				say(
					"While it works you can still write: {0} adds an instruction it reads at its next step, and {1} takes the last one back to change it.",
					keys.followUp.label,
					keys.dequeue.label,
				),
			],
		],
		exercise: (keys) => ({
			text: say("Send a request, then stop the answer with {0}.", keys.interrupt.label),
			exercise: { kind: "interrupt" },
		}),
	},
	{
		id: "asking",
		title: "Asking well",
		doc: "quickstart",
		pages: [
			() => [
				say("A good request says three things: the goal, the context, and how you will know it is done."),
				say(
					"For example: “Add a --verbose flag to src/cli.ts that prints each step; the existing tests must still pass.”",
				),
			],
			() => [
				say(
					"Type @ and a file name to attach that file: the model reads it before answering, instead of searching for it.",
				),
				say(
					"For a large change, ask for a plan first, then the code. Split big work into steps, and say what must not be touched.",
				),
			],
		],
		exercise: () => ({
			text: say("Send a request that attaches a file with @, for example: explain @README.md"),
			exercise: { kind: "file" },
		}),
	},
	{
		id: "following",
		title: "Following the work",
		doc: "usage",
		pages: [
			(keys) => [
				say(
					"Each tool the model uses is one line in the chat: the files it reads, the commands it runs, the changes it makes. {0} shows or hides their full output.",
					keys.toolsExpand.label,
				),
			],
			(keys) => [
				say(
					"Some models think before they answer. {0} shows or hides that thinking, and {1} changes how much the model thinks.",
					keys.thinkingToggle.label,
					keys.thinkingCycle.label,
				),
				say(
					"The bar at the bottom shows the model, how full its context is, and what the session has cost so far.",
				),
			],
		],
		exercise: (keys) => ({
			text: say("Show this tool's output with {0}.", keys.toolsExpand.label),
			exercise: { kind: "key", mock: "tool", key: keys.toolsExpand },
		}),
	},
	{
		id: "permissions",
		title: "Permissions",
		doc: "permissions",
		pages: [
			() => [
				say(
					"Before an action that matters, Prism asks you: changing a file, running a command, going on the internet. You allow it once, for 15 minutes, for the session, or save a rule.",
				),
			],
			() => [
				say(
					"Four modes decide what is asked. Safe only reads, Ask asks before changes, Broad works in the project without asking, Unrestricted asks nothing. /perm shows them and changes the mode.",
				),
				say("These rules check what an action looks like; they do not isolate files or commands."),
			],
		],
		exercise: () => typeCommand("perm"),
		tryIt: "/perm",
	},
	{
		id: "plan-goal",
		title: "Plan and goal",
		doc: "usage",
		pages: [
			(keys) => [
				say(
					"In Plan mode the model reads and proposes, but changes nothing. {0} turns it on and off: ask for the plan, then turn it off to carry it out.",
					keys.plan?.label ?? "/plan",
				),
			],
			(keys) => [
				say(
					"A goal is a target the model keeps working on over several turns, until it is reached. {0} opens the Goal menu: start, pause or clear a goal.",
					keys.goalMenu.label,
				),
			],
		],
		// Without the Plan mode module there is nothing to practise: the module is done once read.
		exercise: (keys) =>
			keys.plan && {
				text: say("Turn Plan mode on, then off, with {0}.", keys.plan.label),
				exercise: { kind: "key", mock: "plan", key: keys.plan },
			},
	},
	{
		id: "sessions",
		title: "Sessions",
		doc: "sessions",
		pages: [
			() => [
				say(
					"Each conversation is a session, saved as you go. /new starts a new one, /resume reopens an earlier one, /name gives the current one a name.",
				),
			],
			() => [
				say(
					"/tree shows the conversation as a tree: pick an earlier point to continue from there, and the rest is kept. /compact summarizes older messages when the context is full; /export saves the session as a page.",
				),
			],
		],
		exercise: () => typeCommand("tree"),
		tryIt: "/tree",
	},
	{
		id: "models",
		title: "Models and settings",
		doc: "models",
		pages: [
			(keys) => [
				say(
					"/model, or {0}, chooses the model. {1} switches to the next of the models you use.",
					keys.modelSelect.label,
					keys.modelCycle.label,
				),
				say("/login connects a model service: a subscription, an API key, or a server on your computer."),
			],
			() => [
				say(
					"/settings holds the settings by domain: appearance, language, behaviour, tools. /model-settings adjusts the current model, such as its thinking level.",
				),
			],
		],
		exercise: () => typeCommand("settings"),
		tryIt: "/settings",
	},
	{
		id: "project",
		title: "Working on a project",
		doc: "configuration",
		pages: [
			() => [
				say(
					"An AGENTS.md file at the root of a project gives the model its rules: how to build, how to test, what to avoid. /init writes a first one, with the continuity documents.",
				),
			],
			(keys) => [
				say(
					"/handoff writes down where the work stands, so that a new session can pick it up. {0} opens the file browser, to look through the project and add files to your message.",
					keys.filesBrowse.label,
				),
			],
		],
		exercise: (keys) => ({
			text: say("Open the file browser with {0}.", keys.filesBrowse.label),
			exercise: { kind: "key", mock: "files", key: keys.filesBrowse },
		}),
		tryIt: "/files",
	},
	{
		id: "further",
		title: "Going further",
		doc: "skills",
		pages: [
			() => [
				say(
					"Prism grows with modules (/settings, then Modules), MCP servers, skills, prompt templates and extensions.",
				),
			],
			() => [
				say("/docs has a page on each of them, and /help lists the keys and commands."),
				say("That is the whole tutorial. /tutorial opens it again at any time."),
			],
		],
	},
];

const DEMO_ANSWER =
	"Here is how I would go about it. First I read the files that matter for your request, then I make the change in small steps and check each one before the next. When I am done, I tell you what changed and what to look at.";

const TOOL_OUTPUT = ['1  import { run } from "./run.ts";', "2", "3  run(process.argv.slice(2));"];

/**
 * What each exercise's command shows, simulated once the command is typed. `picked` says what the real command
 * would do with the line picked: nothing changes.
 */
const COMMAND_MOCKS: Record<
	string,
	{ items: Array<{ text: string; indent?: number; answer?: true }>; picked: string }
> = {
	perm: {
		items: [{ text: "Ask" }, { text: "Read only" }, { text: "Broad" }, { text: "Unrestricted" }],
		picked: "Demo: the permission mode would now be {0}. Your real mode has not changed.",
	},
	tree: {
		items: [
			{ text: "Add a --verbose flag to src/cli.ts" },
			{ text: "Added the flag; the tests pass.", indent: 1, answer: true },
			{ text: "Also print how long each step takes", indent: 1 },
			{ text: "Done: each step prints its time.", indent: 2, answer: true },
			{ text: "Instead, write the steps to a log file", indent: 1 },
		],
		picked:
			"Demo: the conversation would go on from « {0} »; what came after stays in the tree. Your sessions have not changed.",
	},
	settings: {
		items: [
			{ text: "Appearance" },
			{ text: "Conversation" },
			{ text: "Models" },
			{ text: "Permissions & sandbox" },
			{ text: "Terminal" },
			{ text: "Notifications" },
		],
		picked: "Demo: /settings would open « {0} ». No setting has changed.",
	},
};

/** The notes an exercise shows, by name, so that the window's height can count the longest. */
const NOTES = {
	complete: (keys: TutorialKeys) =>
		say("The answer is complete. Send another request and press {0} before it ends.", keys.interrupt.label),
	stopped: () => say("Stopped. What was already written stays."),
	typeRequest: () => say("Type a request in the box, then press Enter."),
	pressKey: (key: string) => say("Press {0} to do this exercise.", key),
	noFile: () => say("No file attached: add one with @, for example @README.md"),
	fileDone: () => say("Done: the file came with the request."),
	typeExactly: (command: string) => say("Type {0} exactly, then Enter.", command),
	commandDone: (real: boolean) => (real ? say("Done. « Try it now » opens it for real.") : say("Done.")),
	mockOpen: (command: string) =>
		say("Demo: this is what {0} shows. Pick a line with ↑↓ and Enter; nothing changes for real.", command),
	picked: (command: string, item: string, real: boolean) => {
		const done = say(COMMAND_MOCKS[command]!.picked, item);
		return real ? `${done} ${say("« Try it now » opens it for real.")}` : done;
	},
	planOn: (key: string) => say("Plan mode is on. Press {0} again to turn it off.", key),
	hidden: (key: string) => say("Hidden again. {0} shows it.", key),
	planOff: () => say("Done: Plan mode is off again."),
	toolDone: (key: string) => say("Done: {0} again hides it.", key),
	filesDone: (real: boolean) => (real ? say("Done. « Try it now » opens the real file browser.") : say("Done.")),
};

/** The buttons, by place: one variant of each place at a time, the same places on every page. */
const PLACES: Button[][] = [["back"], ["next"], ["skip", "restart"], ["docs"], ["try"]];

type Button = "back" | "next" | "try" | "skip" | "restart" | "docs";

export interface TutorialViewOptions {
	keys: TutorialKeys;
	progress: TutorialProgress;
	save: (progress: TutorialProgress) => void;
	/** Whether a command exists in this session, for « Try it now ». */
	available: (command: string) => boolean;
	/** The terminal's height, read at each render. */
	height: () => number;
	requestRender: () => void;
	/** Closes the window; `then` is a command line to run once it is closed. */
	onClose: (then?: string) => void;
	/** Calls `tick` every `ms` while a demo answer is written; returns what stops it. */
	every?: (ms: number, tick: () => void) => () => void;
}

/** A line of the module's side, with the buttons it carries. */
interface ContentLine {
	text: string;
	/** Lines a short terminal may drop, the highest first. */
	drop?: number;
	/** A line of the pages' text, cut from the end when the terminal is too short even so. */
	prose?: boolean;
	/** a line of the instruction typed in an exercise, cut after the prose. */
	echo?: boolean;
	buttons?: Array<{ from: number; to: number; button: Button }>;
}

/** Fits `text` to exactly `width` columns. */
function padTo(text: string, width: number): string {
	const cut = truncateToWidth(text, Math.max(0, width), "…");
	return `${cut}${" ".repeat(Math.max(0, width - visibleWidth(cut)))}`;
}

export class TutorialView implements Component {
	private readonly options: TutorialViewOptions;
	private readonly progress: TutorialProgress;
	private readonly input = new Input();
	private module = 0;
	private page = 0;
	private focusedButton: number | undefined;
	// The exercise of the module on screen.
	private asked: string | undefined;
	private answer: string[] = [];
	private shown = 0;
	private stopTimer: (() => void) | undefined;
	private note: { text: string; color: "muted" | "warning" | "success" } | undefined;
	private presses = 0;
	/** The command's simulated menu, open once the command is typed; `picked` once a line is chosen. */
	private mock: { cursor: number; picked?: number } | undefined;
	/** The body's height for a width and language: the tallest page or exercise state. */
	private stable: { key: string; rows: number } | undefined;
	private geometry: {
		close: number;
		list: Array<{ y: number; to: number; module: number }>;
		buttons: Array<{ y: number; from: number; to: number; button: Button }>;
	} = { close: -1, list: [], buttons: [] };

	constructor(options: TutorialViewOptions) {
		this.options = options;
		this.progress = { done: [...options.progress.done], skipped: [...options.progress.skipped] };
		const next = TUTORIAL_MODULES.findIndex(
			(module) => !this.progress.done.includes(module.id) && !this.progress.skipped.includes(module.id),
		);
		this.module = Math.max(0, next);
		this.input.focused = true;
	}

	invalidate(): void {}

	dispose(): void {
		this.stopTimer?.();
		this.stopTimer = undefined;
	}

	private get current(): ModuleDef {
		return TUTORIAL_MODULES[this.module]!;
	}

	private exercise(): { text: string; exercise: Exercise } | undefined {
		return this.current.exercise?.(this.options.keys);
	}

	private get lastPage(): number {
		return this.current.pages.length - (this.exercise() ? 0 : 1);
	}

	/** The exercise when it is on screen. */
	private exerciseHere(): Exercise | undefined {
		return this.page === this.current.pages.length ? this.exercise()?.exercise : undefined;
	}

	private get streaming(): boolean {
		return this.stopTimer !== undefined;
	}

	private isDone(id = this.current.id): boolean {
		return this.progress.done.includes(id);
	}

	private select(index: number): void {
		this.dispose();
		this.module = Math.max(0, Math.min(TUTORIAL_MODULES.length - 1, index));
		this.focusedButton = undefined;
		this.input.setValue("");
		this.asked = undefined;
		this.answer = [];
		this.shown = 0;
		this.note = undefined;
		this.presses = 0;
		this.mock = undefined;
		this.goTo(0);
	}

	private goTo(page: number): void {
		this.page = Math.max(0, Math.min(this.lastPage, page));
		// A module without an exercise is done once its last page is read.
		if (!this.exercise() && this.page === this.lastPage) this.complete();
	}

	private complete(): void {
		const id = this.current.id;
		if (!this.progress.done.includes(id)) this.progress.done.push(id);
		this.progress.skipped = this.progress.skipped.filter((other) => other !== id);
		this.options.save(this.progress);
	}

	private buttons(): Button[] {
		const buttons: Button[] = [];
		if (this.page > 0) buttons.push("back");
		if (this.page < this.lastPage || this.module < TUTORIAL_MODULES.length - 1) buttons.push("next");
		if (!this.isDone() && !this.progress.skipped.includes(this.current.id)) buttons.push("skip");
		else buttons.push("restart");
		buttons.push("docs");
		// Last, so that the others keep their place when it shows.
		const tryIt = this.current.tryIt;
		if (this.exerciseHere() && this.isDone() && tryIt && this.options.available(tryIt.slice(1))) buttons.push("try");
		return buttons;
	}

	private buttonLabel(button: Button, last = this.page === this.lastPage): string {
		if (button === "back") return `‹ ${t("Back")}`;
		if (button === "next") return `${last ? t("Next module") : t("Next")} ›`;
		if (button === "try") return `${t("Try it now")} ›`;
		if (button === "skip") return t("Skip");
		if (button === "restart") return t("Restart");
		return `${t("Docs")} ›`;
	}

	private activate(button: Button): void {
		this.focusedButton = undefined;
		if (button === "back") this.goTo(this.page - 1);
		else if (button === "next") {
			if (this.page < this.lastPage) this.goTo(this.page + 1);
			else this.select(this.module + 1);
		} else if (button === "try") this.options.onClose(this.current.tryIt);
		else if (button === "docs") this.options.onClose(`/docs ${this.current.doc}`);
		else if (button === "skip") {
			this.progress.skipped.push(this.current.id);
			this.options.save(this.progress);
			if (this.module < TUTORIAL_MODULES.length - 1) this.select(this.module + 1);
		} else {
			this.progress.done = this.progress.done.filter((id) => id !== this.current.id);
			this.progress.skipped = this.progress.skipped.filter((id) => id !== this.current.id);
			this.options.save(this.progress);
			this.select(this.module);
		}
	}

	/** One step of the demo answer: the next word. */
	tick(): void {
		if (!this.streaming) return;
		this.shown++;
		if (this.shown >= this.answer.length) {
			this.dispose();
			this.note = { text: NOTES.complete(this.options.keys), color: "muted" };
		}
		this.options.requestRender();
	}

	private get real(): boolean {
		const tryIt = this.current.tryIt;
		return tryIt !== undefined && this.options.available(tryIt.slice(1));
	}

	private submit(exercise: Exercise): void {
		const value = this.input.getValue().trim();
		// Sent, as from the composer: the line is cleared whatever the result.
		this.input.setValue("");
		if (exercise.kind === "interrupt") {
			if (!value) {
				// Enter on an empty line says what to do instead of doing nothing.
				if (!this.streaming) this.note = { text: NOTES.typeRequest(), color: "warning" };
				return;
			}
			this.dispose();
			this.asked = value;
			this.answer = say(DEMO_ANSWER).split(" ");
			this.shown = 0;
			this.note = undefined;
			const every =
				this.options.every ??
				((ms: number, tick: () => void) => {
					const timer = setInterval(tick, ms);
					return () => clearInterval(timer);
				});
			this.stopTimer = every(120, () => this.tick());
		} else if (exercise.kind === "file") {
			const file = /@(\S+)/.exec(value)?.[1];
			if (!file) {
				this.note = { text: NOTES.noFile(), color: "warning" };
				return;
			}
			this.asked = value;
			this.answer = say(
				"I read {0} before answering. With the file attached I do not have to search for it, and I answer about the file you meant.",
				file,
			).split(" ");
			this.shown = this.answer.length;
			this.note = { text: NOTES.fileDone(), color: "success" };
			this.complete();
		} else if (exercise.kind === "command") {
			const command = `/${exercise.command}`;
			if (value !== command && !value.startsWith(`${command} `)) {
				this.note = { text: NOTES.typeExactly(command), color: "warning" };
				return;
			}
			if (COMMAND_MOCKS[exercise.command]) {
				// Done once a line of the simulated menu is picked.
				this.mock = { cursor: 0 };
				this.note = { text: NOTES.mockOpen(command), color: "muted" };
				return;
			}
			this.note = { text: NOTES.commandDone(this.real), color: "success" };
			this.complete();
		}
	}

	private pick(exercise: Extract<Exercise, { kind: "command" }>, mock: { cursor: number }): void {
		const item = COMMAND_MOCKS[exercise.command]!.items[mock.cursor]!;
		this.mock = { cursor: mock.cursor, picked: mock.cursor };
		this.note = { text: NOTES.picked(exercise.command, t(item.text), this.real), color: "success" };
		this.complete();
	}

	private press(exercise: Extract<Exercise, { kind: "key" }>): void {
		this.presses++;
		const key = exercise.key.label;
		if (exercise.mock === "plan" && this.presses % 2 === 1) {
			this.note = { text: NOTES.planOn(key), color: "muted" };
		} else if (exercise.mock === "tool" && this.presses % 2 === 0) {
			this.note = { text: NOTES.hidden(key), color: "muted" };
		} else {
			if (exercise.mock === "plan") this.note = { text: NOTES.planOff(), color: "success" };
			else if (exercise.mock === "tool") this.note = { text: NOTES.toolDone(key), color: "success" };
			else this.note = { text: NOTES.filesDone(this.options.available("files")), color: "success" };
			this.complete();
		}
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		const exercise = this.exerciseHere();
		// While the demo answer is written, the interrupt key stops it (Esc by default, which otherwise closes).
		if (this.streaming && this.options.keys.interrupt.matches(data)) {
			this.dispose();
			this.note = { text: NOTES.stopped(), color: "success" };
			this.complete();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.options.onClose();
			return;
		}
		if (exercise?.kind === "key" && exercise.key.matches(data)) {
			this.press(exercise);
			return;
		}
		const buttons = this.buttons();
		// The simulated menu takes ↑↓ and Enter until a line is picked.
		const command = exercise?.kind === "command" ? exercise : undefined;
		const mock = command && this.focusedButton === undefined ? this.choosing() : undefined;
		if (kb.matches(data, "tui.input.tab")) {
			const next = this.focusedButton === undefined ? 0 : this.focusedButton + 1;
			this.focusedButton = next < buttons.length ? next : undefined;
		} else if (command && mock && (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down"))) {
			const count = COMMAND_MOCKS[command.command]!.items.length;
			const step = kb.matches(data, "tui.select.up") ? -1 : 1;
			mock.cursor = Math.max(0, Math.min(count - 1, mock.cursor + step));
		} else if (command && mock && kb.matches(data, "tui.select.confirm") && this.input.getValue().trim() === "") {
			this.pick(command, mock);
		} else if (kb.matches(data, "tui.select.up")) this.select(this.module - 1);
		else if (kb.matches(data, "tui.select.down")) this.select(this.module + 1);
		else if (kb.matches(data, "tui.editor.cursorLeft") || kb.matches(data, "tui.editor.cursorRight")) {
			const step = kb.matches(data, "tui.editor.cursorLeft") ? -1 : 1;
			if (this.focusedButton !== undefined) {
				this.focusedButton = (this.focusedButton + step + buttons.length) % buttons.length;
			} else if (step === 1 && this.page === this.lastPage) {
				// The last page: → goes on as « Next module ».
				if (buttons.includes("next")) this.activate("next");
			} else this.goTo(this.page + step);
		} else if (kb.matches(data, "tui.select.confirm")) {
			if (this.focusedButton !== undefined) this.activate(buttons[this.focusedButton]!);
			// An exercise done and nothing typed: Enter goes on, as « Next module ».
			else if (exercise && exercise.kind !== "key" && (!this.isDone() || this.input.getValue().trim() !== ""))
				this.submit(exercise);
			// A key exercise not done yet: Enter says which key, rather than leaving the module unfinished.
			else if (exercise?.kind === "key" && !this.isDone())
				this.note = { text: NOTES.pressKey(exercise.key.label), color: "warning" };
			else if (buttons.includes("next")) this.activate("next");
		} else if (exercise && exercise.kind !== "key") this.input.handleInput(data);
	}

	/** The simulated menu while a line is still to pick. */
	private choosing(): { cursor: number } | undefined {
		return this.mock && this.mock.picked === undefined ? this.mock : undefined;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel") return { handled: true };
		if (event.button !== "left") return { handled: true };
		if (event.type !== "click") return { handled: true, focus: true };
		const { x, y } = event;
		const g = this.geometry;
		if (y === 1 && x >= g.close && x < g.close + 3) {
			this.options.onClose();
			return { handled: true };
		}
		const row = g.list.find((entry) => entry.y === y && x < entry.to);
		if (row) this.select(row.module);
		const button = g.buttons.find((entry) => entry.y === y && x >= entry.from && x < entry.to);
		if (button) this.activate(button.button);
		return { handled: true, focus: true, render: true };
	}

	render(width: number): string[] {
		const inner = Math.max(20, width - 2);
		const wide = inner >= 72;
		const listWidth = wide ? 26 : 0;
		// The module's side: after the list and " │ " when wide, after one space when narrow; one space at the end.
		const origin = wide ? 1 + listWidth + 3 : 2;
		const side = wide ? inner - listWidth - 4 : inner - 2;
		const border = (s: string) => paint(tok(theme, "borderAccent"), s);
		const muted = (s: string) => theme.fg("muted", s);

		const content = this.content(side, wide);
		const buttons = this.buttonLines(side);
		const list = wide ? this.list(listWidth) : [];
		// Fit the terminal: border, title, rule, the body, rule, the hints (wrapped when narrow), border. The hints
		// take as many lines as the longest of them, so that the window keeps its height.
		const hintWidth = Math.max(1, inner - 2);
		const hints = wrapTextWithAnsi(this.hints(), hintWidth);
		const hintRows = Math.max(...this.allHints().map((hint) => wrapTextWithAnsi(hint, hintWidth).length));
		while (hints.length < hintRows) hints.push("");
		const room = Math.max(4, this.options.height() - 5 - hintRows);
		// The text, a blank line, then the buttons at the bottom of the body.
		const space = Math.max(1, room - buttons.length - 1);
		while (content.length > space) {
			const highest = Math.max(0, ...content.map((line) => line.drop ?? 0));
			if (highest === 0) break;
			content.splice(
				content.findLastIndex((line) => line.drop === highest),
				1,
			);
		}
		while (content.length > space) {
			const at = content.findLastIndex((line) => line.prose);
			if (at === -1) break;
			content.splice(at, 1);
			if (content[at - 1]?.prose) content[at - 1] = { ...content[at - 1]!, text: `${content[at - 1]!.text} …` };
		}
		// a pasted instruction taller than the window keeps its first lines, and
		// whatever is still too tall is cut, so the buttons stay in the window.
		while (content.length > space) {
			const at = content.findLastIndex((line) => line.echo);
			if (at === -1 || !content[at - 1]?.echo) break;
			content.splice(at, 1);
			content[at - 1] = { ...content[at - 1]!, text: `${content[at - 1]!.text} …` };
		}
		if (content.length > space) content.splice(space);
		const tallest = Math.max(this.stableRows(side, wide), content.length) + 1 + buttons.length;
		const rows = Math.max(Math.min(room, Math.max(tallest, list.length)), content.length + buttons.length);
		while (content.length < rows - buttons.length) content.push({ text: "" });
		content.push(...buttons);

		const geometry: TutorialView["geometry"] = { close: 1 + inner - 3, list: [], buttons: [] };
		const out: string[] = [border(`┌${"─".repeat(inner)}┐`)];
		const count = say("{0} of {1} modules done", String(this.doneCount()), String(TUTORIAL_MODULES.length));
		const title = ` ${theme.bold(theme.fg("text", t("Tutorial")))}  ${muted(count)}`;
		out.push(`${border("│")}${padTo(title, inner - 3)}${muted(" ✕ ")}${border("│")}`);
		out.push(border(`├${"─".repeat(inner)}┤`));
		const separator = paint(tok(theme, "borderMuted"), "│");
		for (let i = 0; i < rows; i++) {
			const y = 3 + i;
			const line = content[i];
			for (const button of line?.buttons ?? []) {
				geometry.buttons.push({ y, from: origin + button.from, to: origin + button.to, button: button.button });
			}
			const right = padTo(line?.text ?? "", side);
			if (wide) {
				// The list starts with a blank line.
				if (i > 0 && i < list.length) geometry.list.push({ y, to: 1 + listWidth, module: i - 1 });
				out.push(`${border("│")}${padTo(list[i] ?? "", listWidth)} ${separator} ${right} ${border("│")}`);
			} else out.push(`${border("│")} ${right} ${border("│")}`);
		}
		out.push(border(`├${"─".repeat(inner)}┤`));
		for (const hint of hints) out.push(`${border("│")}${padTo(theme.fg("dim", ` ${hint}`), inner)}${border("│")}`);
		out.push(border(`└${"─".repeat(inner)}┘`));
		this.geometry = geometry;
		return out.map((l) => onBg(l, tok(theme, "userMessageBg"), width));
	}

	private doneCount(): number {
		return TUTORIAL_MODULES.filter((module) => this.isDone(module.id)).length;
	}

	private list(width: number): string[] {
		return [
			"",
			...TUTORIAL_MODULES.map((module, i) => {
				const here = i === this.module;
				const mark = this.isDone(module.id)
					? theme.fg("success", "✓")
					: this.progress.skipped.includes(module.id)
						? theme.fg("dim", "–")
						: " ";
				const name = `${i + 1}  ${t(module.title)}`;
				const text = here ? theme.bold(theme.fg("text", name)) : theme.fg("thinkingText", name);
				return padTo(`${here ? theme.fg("accent", "▌") : " "}${mark} ${text}`, width);
			}),
		];
	}

	private content(width: number, wide: boolean): ContentLine[] {
		const lines: ContentLine[] = [{ text: "", drop: 3 }];
		const module = this.current;
		const exercise = this.exercise();
		const pages = module.pages.length + (exercise ? 1 : 0);
		const name = theme.bold(theme.fg("text", t(module.title)));
		const where = theme.fg("dim", `  ${this.page + 1}/${pages}`);
		lines.push({ text: wide ? `${name}${where}` : `${theme.fg("muted", `${this.module + 1}/9 ·`)} ${name}${where}` });
		lines.push({ text: "", drop: 2 });
		const wrap = (
			text: string,
			color: "text" | "thinkingText" | "muted" | "dim" | "warning" | "success" | "accent",
		) => wrapTextWithAnsi(theme.fg(color, text), Math.max(1, width));
		const here = this.exerciseHere();
		const paragraphs = here ? [exercise!.text] : module.pages[this.page]!(this.options.keys);
		paragraphs.forEach((paragraph, i) => {
			if (i > 0) lines.push({ text: "", drop: 2 });
			for (const text of wrap(paragraph, here ? "accent" : "text")) lines.push({ text, prose: !here });
		});
		if (here) lines.push(...this.practice(here, width, wrap));
		if (!here && this.isDone() && this.page === this.lastPage) {
			lines.push({ text: "", drop: 2 });
			lines.push({ text: theme.fg("success", `✓ ${t("Module done")}`) });
		}
		return lines;
	}

	/** The tallest the module's side gets at this width: every page, and each exercise with its most text shown. */
	private stableRows(side: number, wide: boolean): number {
		const key = `${side}/${wide}/${getLanguage()}`;
		if (this.stable?.key === key) return this.stable.rows;
		const saved = {
			module: this.module,
			page: this.page,
			asked: this.asked,
			answer: this.answer,
			shown: this.shown,
			note: this.note,
			presses: this.presses,
			mock: this.mock,
			done: this.progress.done,
		};
		const longest = (texts: string[]) =>
			texts.reduce((a, b) => (wrapTextWithAnsi(b, side).length > wrapTextWithAnsi(a, side).length ? b : a), "");
		const keys = this.options.keys;
		let rows = 0;
		// Done, for the « Module done » line.
		this.progress.done = TUTORIAL_MODULES.map((module) => module.id);
		TUTORIAL_MODULES.forEach((_, module) => {
			this.module = module;
			for (let page = 0; page <= this.lastPage; page++) {
				this.page = page;
				this.asked = undefined;
				this.answer = [];
				this.shown = 0;
				this.note = undefined;
				this.presses = 0;
				this.mock = undefined;
				rows = Math.max(rows, this.content(side, wide).length);
				const exercise = this.exerciseHere();
				if (!exercise) continue;
				if (exercise.kind === "interrupt" || exercise.kind === "file") {
					this.asked = "explain @README.md";
					this.answer = (
						exercise.kind === "interrupt"
							? say(DEMO_ANSWER)
							: say(
									"I read {0} before answering. With the file attached I do not have to search for it, and I answer about the file you meant.",
									"README.md",
								)
					).split(" ");
					this.shown = this.answer.length;
					const notes =
						exercise.kind === "interrupt"
							? [NOTES.complete(keys), NOTES.stopped(), NOTES.typeRequest()]
							: [NOTES.noFile(), NOTES.fileDone()];
					this.note = { text: longest(notes), color: "muted" };
				} else if (exercise.kind === "key") {
					this.presses = 1;
					const key = exercise.key.label;
					const notes = [
						NOTES.planOn(key),
						NOTES.planOff(),
						NOTES.hidden(key),
						NOTES.toolDone(key),
						NOTES.pressKey(key),
					];
					this.note = { text: longest([...notes, NOTES.filesDone(true)]), color: "muted" };
				} else {
					const items = COMMAND_MOCKS[exercise.command]?.items ?? [];
					if (items.length > 0) this.mock = { cursor: 0, picked: 0 };
					const command = `/${exercise.command}`;
					const notes = [NOTES.typeExactly(command), NOTES.mockOpen(command), NOTES.commandDone(true)];
					for (const item of items) notes.push(NOTES.picked(exercise.command, t(item.text), true));
					this.note = { text: longest(notes), color: "muted" };
				}
				rows = Math.max(rows, this.content(side, wide).length);
			}
		});
		this.module = saved.module;
		this.page = saved.page;
		this.asked = saved.asked;
		this.answer = saved.answer;
		this.shown = saved.shown;
		this.note = saved.note;
		this.presses = saved.presses;
		this.mock = saved.mock;
		this.progress.done = saved.done;
		this.stable = { key, rows };
		return rows;
	}

	private practice(
		exercise: Exercise,
		width: number,
		wrap: (text: string, color: "muted" | "dim" | "warning" | "success" | "text") => string[],
	): ContentLine[] {
		const lines: ContentLine[] = [{ text: "", drop: 2 }];
		if (exercise.kind === "interrupt" || exercise.kind === "file") {
			for (const text of wrap(t("Demo: Prism writes this answer itself; no model is called."), "dim"))
				lines.push({ text, drop: 1 });
		}
		if (exercise.kind === "key") {
			if (exercise.mock === "tool") {
				lines.push({ text: `${theme.fg("success", "●")} ${theme.fg("text", t("Read file src/app.ts"))}` });
				if (this.presses % 2 === 1)
					for (const row of TOOL_OUTPUT) lines.push({ text: theme.fg("dim", `    ${row}`) });
			} else if (exercise.mock === "plan") {
				const on = this.presses % 2 === 1;
				const chip = on ? theme.fg("accent", `● ${t("Plan mode")}`) : theme.fg("muted", `○ ${t("Plan mode")}`);
				lines.push({ text: `${chip}  ${theme.fg("dim", on ? t("on") : t("off"))}` });
			} else if (this.presses > 0) {
				for (const text of wrap(t("The file browser opens here, on the right of the chat."), "muted"))
					lines.push({ text });
			}
		} else {
			const line = this.input.render(Math.max(4, width - 2))[0] ?? "";
			lines.push({ text: `${theme.fg("accent", "›")} ${line.replace(/^> /, "")}` });
			const command = exercise.kind === "command" ? exercise.command : undefined;
			const items = command ? COMMAND_MOCKS[command]?.items : undefined;
			if (items && this.mock) {
				const mock = this.mock;
				lines.push({ text: "", drop: 2 });
				items.forEach((item, i) => {
					const mark =
						mock.picked === i
							? theme.fg("success", "●")
							: mock.picked === undefined && mock.cursor === i
								? theme.fg("accent", "❯")
								: " ";
					const marker = command === "tree" ? (item.answer ? "─ " : "› ") : "";
					const text = `${"  ".repeat(item.indent ?? 0)}${marker}${t(item.text)}`;
					const shown = mock.cursor === i ? theme.fg("text", text) : theme.fg(item.answer ? "dim" : "muted", text);
					lines.push({ text: `${mark} ${shown}` });
				});
			}
		}
		if (this.asked !== undefined) {
			lines.push({ text: "", drop: 2 });
			for (const text of wrap(`› ${this.asked}`, "muted")) lines.push({ text, echo: true });
			const written = this.answer.slice(0, this.shown).join(" ") + (this.streaming ? " ▍" : "");
			wrapTextWithAnsi(written, Math.max(1, width - 2)).forEach((text, i) => {
				lines.push({ text: `${i === 0 ? "─ " : "  "}${theme.fg("text", text)}` });
			});
		}
		if (this.note) {
			lines.push({ text: "", drop: 2 });
			for (const text of wrap(this.note.text, this.note.color)) lines.push({ text });
		}
		return lines;
	}

	/**
	 * The buttons, each in its place on every page: a place is as wide as its widest label, « Back » is greyed on a
	 * first page, and « Try it now », last, leaves its place empty while it is not offered.
	 */
	private buttonLines(width: number): ContentLine[] {
		const band = tok(theme, "selectedBg");
		const active = this.buttons();
		const lines: ContentLine[] = [];
		let line: ContentLine & { buttons: NonNullable<ContentLine["buttons"]> } = { text: "", buttons: [] };
		let used = 0;
		for (const place of PLACES) {
			const labels = place.flatMap((button) =>
				button === "next"
					? [this.buttonLabel(button, false), this.buttonLabel(button, true)]
					: [this.buttonLabel(button)],
			);
			const inside = Math.max(...labels.map((label) => visibleWidth(label))) + 2;
			const size = inside + 2;
			if (used > 0 && visibleWidth(line.text) + 1 + size > width) {
				lines.push(line);
				line = { text: "", buttons: [] };
				used = 0;
			}
			if (used > 0) line.text += " ";
			used++;
			const button = place.find((candidate) => active.includes(candidate));
			const from = visibleWidth(line.text);
			if (!button) {
				line.text +=
					place[0] === "back"
						? theme.fg("dim", `[${` ${this.buttonLabel("back")} `.padEnd(inside)}]`)
						: " ".repeat(size);
				continue;
			}
			line.buttons.push({ from, to: from + size, button });
			const label = ` ${this.buttonLabel(button)} `;
			const padded = label + " ".repeat(Math.max(0, inside - visibleWidth(label)));
			const text =
				active.indexOf(button) === this.focusedButton
					? onBg(theme.bold(theme.fg("text", padded)), band, inside)
					: theme.fg("text", padded);
			line.text += `${theme.fg("muted", "[")}${text}${theme.fg("muted", "]")}`;
		}
		lines.push(line);
		return lines;
	}

	private hints(): string {
		if (this.streaming) return say("{0} stops the answer", this.options.keys.interrupt.label);
		if (this.focusedButton !== undefined) return t("←→ move · Enter: press · Tab: back to the page · Esc: close");
		if (this.exerciseHere()?.kind === "command" && this.choosing())
			return t("↑↓ choose · Enter: pick · Tab: buttons · Esc: close");
		return t("↑↓ module · ←→ page · Tab: buttons · Esc or ✕: close");
	}

	private allHints(): string[] {
		return [
			say("{0} stops the answer", this.options.keys.interrupt.label),
			t("←→ move · Enter: press · Tab: back to the page · Esc: close"),
			t("↑↓ choose · Enter: pick · Tab: buttons · Esc: close"),
			t("↑↓ module · ←→ page · Tab: buttons · Esc or ✕: close"),
		];
	}
}

/** The keys the tutorial names and checks, as the user configured them. */
export function tutorialKeys(state: PrismState): TutorialKeys {
	const binding = (id: Keybinding): TutorialKey => ({
		label: keyText(id),
		matches: (data) => getKeybindings().matches(data, id),
		ids: getKeybindings().getKeys(id),
	});
	const plan = state.modes.plan ? state.planShortcut?.() : undefined;
	return {
		interrupt: binding("app.interrupt"),
		followUp: binding("app.message.followUp"),
		dequeue: binding("app.message.dequeue"),
		toolsExpand: binding("app.tools.expand"),
		thinkingToggle: binding("app.thinking.toggle"),
		thinkingCycle: binding("app.thinking.cycle"),
		modelSelect: binding("app.model.select"),
		modelCycle: binding("app.model.cycleForward"),
		goalMenu: binding("app.goal.menu"),
		filesBrowse: binding("app.files.browse"),
		plan: plan
			? { label: formatKeyText(plan), matches: (data) => matchesKey(data, plan as KeyId), ids: [plan] }
			: undefined,
	};
}

export function tutorialPath(agentDir = getAgentDir()): string {
	return join(agentDir, "tutorial.json");
}

export function loadProgress(path: string): TutorialProgress {
	const ids = new Set(TUTORIAL_MODULES.map((module) => module.id));
	const known = (value: unknown) =>
		Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && ids.has(id)) : [];
	try {
		if (!existsSync(path)) return { done: [], skipped: [] };
		const data = JSON.parse(readFileSync(path, "utf8")) as Partial<TutorialProgress>;
		return { done: known(data.done), skipped: known(data.skipped) };
	} catch {
		return { done: [], skipped: [] };
	}
}

export function saveProgress(path: string, progress: TutorialProgress): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(progress, null, 2)}\n`);
	} catch {
		// The tutorial still works; only its progress is not kept.
	}
}

/** the same modules and exercises as data, for the window's own /tutorial screen. */
export interface TutorialPanelExercise {
	kind: Exercise["kind"];
	text: string;
	demo?: string;
	/** interrupt: the demo answer; file: the same with {0} for the file named. */
	answer?: string;
	command?: string;
	key?: { label: string; ids: readonly string[] };
	mock?: "tool" | "plan" | "files";
	items?: Array<{ text: string; indent?: number; answer?: true }>;
	/** What the exercise says at each step; {0} in `picked` is the line picked. */
	notes: Record<string, string>;
	tool?: { label: string; output: readonly string[] };
}
export interface TutorialPanelModule {
	id: string;
	title: string;
	doc: string;
	pages: string[][];
	exercise?: TutorialPanelExercise;
	/** Offered once the exercise is done, when the command exists here. */
	tryIt?: string;
}
export interface TutorialPanelState {
	modules: TutorialPanelModule[];
	progress: TutorialProgress;
	labels: Record<
		"back" | "next" | "nextModule" | "try" | "skip" | "restart" | "docs" | "planMode" | "on" | "off",
		string
	>;
	interrupt: { label: string; ids: readonly string[]; hint: string };
}

function panelExercise(
	{ text, exercise }: { text: string; exercise: Exercise },
	keys: TutorialKeys,
	available: (command: string) => boolean,
	real: boolean,
): TutorialPanelExercise {
	const demo = t("Demo: Prism writes this answer itself; no model is called.");
	if (exercise.kind === "interrupt")
		return {
			kind: exercise.kind,
			text,
			demo,
			answer: say(DEMO_ANSWER),
			notes: { typeRequest: NOTES.typeRequest(), complete: NOTES.complete(keys), stopped: NOTES.stopped() },
		};
	if (exercise.kind === "file")
		return {
			kind: exercise.kind,
			text,
			demo,
			answer: t(
				"I read {0} before answering. With the file attached I do not have to search for it, and I answer about the file you meant.",
			),
			notes: { noFile: NOTES.noFile(), done: NOTES.fileDone() },
		};
	if (exercise.kind === "command") {
		const line = `/${exercise.command}`;
		const mock = COMMAND_MOCKS[exercise.command];
		return {
			kind: exercise.kind,
			text,
			command: line,
			items: mock?.items.map((item) => ({ ...item, text: t(item.text) })),
			notes: {
				typeExactly: NOTES.typeExactly(line),
				done: NOTES.commandDone(real),
				open: NOTES.mockOpen(line),
				picked: mock ? NOTES.picked(exercise.command, "{0}", real) : "",
			},
		};
	}
	const label = exercise.key.label;
	return {
		kind: exercise.kind,
		text,
		mock: exercise.mock,
		key: { label, ids: exercise.key.ids },
		tool: { label: t("Read file src/app.ts"), output: TOOL_OUTPUT },
		notes: {
			press: NOTES.pressKey(label),
			planOn: NOTES.planOn(label),
			planOff: NOTES.planOff(),
			hidden: NOTES.hidden(label),
			toolDone: NOTES.toolDone(label),
			filesDone: NOTES.filesDone(available("files")),
			filesOpen: t("The file browser opens here, on the right of the chat."),
		},
	};
}

function tutorialPanelState(state: PrismState, available: (command: string) => boolean): TutorialPanelState {
	// Without a terminal nothing has read the user's keys yet; read on each request, as get_keys (rpc-keys.ts).
	setKeybindings(KeybindingsManager.create());
	const keys = tutorialKeys(state);
	return {
		modules: TUTORIAL_MODULES.map((module) => {
			const exercise = module.exercise?.(keys);
			const real = module.tryIt !== undefined && available(module.tryIt.slice(1));
			return {
				id: module.id,
				title: t(module.title),
				doc: module.doc,
				pages: module.pages.map((page) => page(keys)),
				exercise: exercise && panelExercise(exercise, keys, available, real),
				tryIt: real ? module.tryIt : undefined,
			};
		}),
		progress: loadProgress(tutorialPath()),
		labels: {
			back: t("Back"),
			next: t("Next"),
			nextModule: t("Next module"),
			try: t("Try it now"),
			skip: t("Skip"),
			restart: t("Restart"),
			docs: t("Docs"),
			planMode: t("Plan mode"),
			on: t("on"),
			off: t("off"),
		},
		interrupt: {
			label: keys.interrupt.label,
			ids: keys.interrupt.ids,
			hint: say("{0} stops the answer", keys.interrupt.label),
		},
	};
}

const tutorialPanels = new WeakMap<ExtensionContext["sessionManager"], () => TutorialPanelState>();
/** The tutorial's data for this context; undefined without the Prism pack. */
export function tutorialPanel(ctx: ExtensionContext): TutorialPanelState | undefined {
	return tutorialPanels.get(ctx.sessionManager)?.();
}
/** Keeps what the window finished or skipped, as the terminal's tutorial does; unknown modules are dropped. */
export function saveTutorialProgress(progress: { done?: unknown; skipped?: unknown }): TutorialProgress {
	const ids = new Set(TUTORIAL_MODULES.map((module) => module.id));
	const known = (value: unknown) =>
		Array.isArray(value)
			? [...new Set(value.filter((id): id is string => typeof id === "string" && ids.has(id)))]
			: [];
	const kept = { done: known(progress.done), skipped: known(progress.skipped) };
	saveProgress(tutorialPath(), kept);
	return kept;
}

/** `/tutorial`, and the onboarding's offer to start it (TUTORIAL_EVENT). */
export function installTutorial(pi: ExtensionAPI, state: PrismState): void {
	pi.on("session_start", (_event, ctx) => {
		tutorialPanels.set(ctx.sessionManager, () => {
			const commands = new Set([...BUILTIN_SLASH_COMMANDS, ...pi.getCommands()].map((command) => command.name));
			return tutorialPanelState(state, (command) => commands.has(command));
		});
	});
	/** Resolves once the tutorial is closed: true when it ran a command on closing. */
	const open = async (ctx: ExtensionContext): Promise<boolean> => {
		if (!ctx.hasUI) {
			ctx.ui.notify(t("The tutorial needs the interactive interface."), "warning");
			return false;
		}
		const path = tutorialPath();
		const commands = new Set([...BUILTIN_SLASH_COMMANDS, ...pi.getCommands()].map((command) => command.name));
		let view: TutorialView | undefined;
		let columns = () => process.stdout.columns ?? 80;
		const then = await ctx.ui.custom<string | undefined>(
			(tui, _theme, _keybindings, done) => {
				columns = () => tui.terminal.columns;
				view = new TutorialView({
					keys: tutorialKeys(state),
					progress: loadProgress(path),
					save: (progress) => saveProgress(path, progress),
					available: (command) => commands.has(command),
					height: () => tui.terminal.rows,
					requestRender: () => tui.requestRender(),
					onClose: (line) => done(line),
				});
				return view;
			},
			{
				overlay: true,
				// The UI resolves overlayOptions once; the TUI reads this getter each render.
				overlayOptions: {
					anchor: "center",
					get width() {
						return Math.min(columns() - 2, TUTORIAL_MAX_WIDTH);
					},
					maxHeight: "100%",
				},
			},
		);
		view?.dispose();
		if (!then) return false;
		if (state.submitCommand) state.submitCommand(then);
		else if (
			pi.getCommands().some((entry) => entry.source === "extension" && entry.name === then.slice(1).split(/\s/)[0])
		)
			void pi.sendUserMessage(then, { expandPromptTemplates: true });
		else {
			ctx.ui.notify(say("Type {0} and press Enter.", then), "info");
			return false;
		}
		return true;
	};

	pi.registerCommand("tutorial", {
		description: t("Learn Prism in nine short modules, with exercises"),
		handler: async (_args, ctx) => {
			await open(ctx);
		},
	});
	pi.events.on(TUTORIAL_EVENT, (data) => {
		const request = data as TutorialRequest;
		request.opened = open(request.ctx);
	});
}
