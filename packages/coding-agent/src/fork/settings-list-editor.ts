/**
 * fork: a list opened from `/settings`: permission rules, protected
 * paths, the sandbox's hosts, commands and paths. « Add… » asks for the text, then for each choice the list
 * needs (a rule's effect, its scope); Enter on an entry asks to remove it, a second Enter removes it. Entries
 * Prism always applies are shown but cannot be removed.
 */
import {
	type Component,
	getKeybindings,
	Input,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { theme } from "../modes/interactive/theme/theme.ts";
import { t } from "./i18n/index.ts";

export interface ListEntry {
	text: string;
	/** Shown after the text: a rule's effect and scope. */
	tag?: string;
	/** Always applied by Prism: shown, never removed. */
	fixed?: boolean;
	/** Where the entry is saved (a rule's file and list), for `onRemove`. */
	key?: string;
}

/** One choice asked after the text, such as a rule's effect. */
export interface ListStep {
	title: string;
	options: Array<{ value: string; label: string }>;
}

export interface ListEditorOptions {
	title: string;
	description: string;
	entries(): ListEntry[];
	/** What to type, shown above the field. */
	addPrompt: string;
	/** Choices asked after the text, in order; their values reach `onAdd`. */
	steps?(): ListStep[];
	/** The entry to save for what was typed, or an Error saying what is expected. */
	parse?(text: string): string | Error;
	/** Saves a new entry; throws when the file cannot be written. */
	onAdd(text: string, choices: string[]): void | Promise<void>;
	/** Removes an entry; throws when the file cannot be written. */
	onRemove(entry: ListEntry): void | Promise<void>;
	requestRender(): void;
	/** Closes the list; `changed` when something was added or removed. */
	done(changed: boolean): void;
}

/** fork: what a removal confirms, compared again before removing. */
function identity(entry: ListEntry): string {
	return JSON.stringify([entry.text, entry.tag ?? "", entry.key ?? "", entry.fixed === true]);
}

function fitCell(text: string, width: number): string {
	const cut = truncateToWidth(text, Math.max(0, width), "…");
	return `${cut}${" ".repeat(Math.max(0, width - visibleWidth(cut)))}`;
}

/**
 * the rows of the last render that must stay in view (the selected entry, or the
 * field, the choices and the message being shown), for a parent that shows only part of the list.
 */
export interface ActiveRows {
	activeRows(): { from: number; to: number } | undefined;
}

export class ListEditor implements Component, ActiveRows {
	private readonly options: ListEditorOptions;
	/** 0 is « Add… », then the entries. */
	private index = 0;
	private input: Input | undefined;
	/** The text being added and the choices made so far, while its steps are asked. */
	private adding: { text: string; choices: string[]; steps: ListStep[]; option: number } | undefined;
	/** The entry the removal question shows, while it waits for the second Enter. */
	private confirmRemove: string | undefined;
	private changed = false;
	private busy = false;
	private message: { text: string; kind: "warning" | "error" | "muted" } | undefined;
	private lineRows = new Map<number, number>();
	private active: { from: number; to: number } | undefined;

	constructor(options: ListEditorOptions) {
		this.options = options;
	}

	invalidate(): void {}

	activeRows(): { from: number; to: number } | undefined {
		return this.active;
	}

	render(width: number): string[] {
		const out: string[] = [];
		const add = (text: string) => out.push(fitCell(text, width));
		const wrap = (text: string) => {
			for (const l of wrapTextWithAnsi(text, width)) add(l);
		};
		const entries = this.options.entries();
		const listFocused = !this.input && !this.adding;
		add(theme.bold(theme.fg("accent", t(this.options.title))));
		wrap(theme.fg("muted", t(this.options.description)));
		add("");
		const textWidth = Math.min(
			Math.max(12, ...entries.map((entry) => visibleWidth(entry.text) + 2)),
			Math.max(12, width - 24),
		);
		this.lineRows.clear();
		const marker = (i: number) => (listFocused && i === this.index ? theme.fg("accent", "→ ") : "  ");
		this.lineRows.set(out.length, 0);
		add(`${marker(0)}${theme.fg("accent", `+ ${t("Add…")}`)}`);
		entries.forEach((entry, i) => {
			const selected = listFocused && i + 1 === this.index;
			const text = selected ? theme.bold(theme.fg("text", entry.text)) : theme.fg("text", entry.text);
			const tag = [entry.tag, entry.fixed ? t("always applied") : undefined].filter(Boolean).join(" · ");
			this.lineRows.set(out.length, i + 1);
			// fork: a rule too long for its column keeps its whole text and puts its scope on
			// the next line; at 40 columns it read "read(data.t…allow · global".
			if (visibleWidth(entry.text) + 2 <= textWidth || !tag) {
				add(`${marker(i + 1)}${fitCell(text, textWidth)}${theme.fg("muted", tag)}`);
				return;
			}
			add(`${marker(i + 1)}${text}`);
			this.lineRows.set(out.length, i + 1);
			add(`    ${theme.fg("muted", tag)}`);
		});
		if (entries.length === 0) add(theme.fg("muted", `  ${t("none")}`));
		add("");
		const below = out.length;
		if (this.input) {
			wrap(theme.fg("text", t(this.options.addPrompt)));
			for (const l of this.input.render(width)) add(l);
		} else if (this.adding) {
			const step = this.adding.steps[this.adding.choices.length]!;
			add(theme.fg("text", `${this.adding.text} · ${t(step.title)}`));
			step.options.forEach((option, i) => {
				const selected = i === this.adding!.option;
				const label = selected ? theme.bold(theme.fg("text", t(option.label))) : theme.fg("text", t(option.label));
				add(`${selected ? theme.fg("accent", "→ ") : "  "}${label}`);
			});
		} else if (this.confirmRemove !== undefined) {
			add(theme.fg("warning", t("Enter again removes it, Esc keeps it")));
		}
		if (this.message) wrap(theme.fg(this.message.kind, this.message.text));
		// The selected entry and whatever is said below the list; the field, the choices and their message when adding.
		const selected = [...this.lineRows].filter(([, index]) => index === this.index).map(([row]) => row);
		const typing = this.input !== undefined || this.adding !== undefined;
		this.active = {
			from: typing ? below : (selected[0] ?? 0),
			to: typing || this.confirmRemove !== undefined || this.message ? out.length - 1 : (selected.at(-1) ?? 0),
		};
		return out;
	}

	async handleInput(data: string): Promise<void> {
		if (this.busy) return;
		if (this.input) {
			this.input.handleInput(data);
			return;
		}
		const kb = getKeybindings();
		const confirm = kb.matches(data, "tui.select.confirm");
		const cancel = kb.matches(data, "tui.select.cancel");
		if (this.adding) {
			const step = this.adding.steps[this.adding.choices.length]!;
			const count = step.options.length;
			if (kb.matches(data, "tui.select.up")) this.adding.option = (this.adding.option - 1 + count) % count;
			else if (kb.matches(data, "tui.select.down")) this.adding.option = (this.adding.option + 1) % count;
			else if (confirm) this.choose(step.options[this.adding.option]!.value);
			else if (cancel) this.adding = undefined;
			return;
		}
		if (this.confirmRemove !== undefined) {
			const shown = this.confirmRemove;
			this.confirmRemove = undefined;
			if (confirm) await this.remove(shown);
			return;
		}
		const count = this.options.entries().length + 1;
		if (kb.matches(data, "tui.select.up")) this.move((this.index - 1 + count) % count);
		else if (kb.matches(data, "tui.select.down")) this.move((this.index + 1) % count);
		else if (confirm || data === " ") this.activate();
		else if (cancel || kb.matches(data, "tui.editor.cursorLeft")) this.options.done(this.changed);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.button !== "left" || this.busy || this.input || this.adding)
			return { handled: true };
		const index = this.lineRows.get(event.y);
		if (index === undefined) return { handled: true };
		this.confirmRemove = undefined;
		this.move(index);
		this.activate();
		return { handled: true, render: true };
	}

	private move(index: number): void {
		this.index = index;
		this.message = undefined;
	}

	private activate(): void {
		if (this.index === 0) {
			this.message = undefined;
			const input = new Input();
			input.focused = true;
			input.onEscape = () => {
				this.input = undefined;
				this.options.requestRender();
			};
			input.onSubmit = (typed) => this.typed(typed);
			this.input = input;
			return;
		}
		const entry = this.options.entries()[this.index - 1];
		if (!entry) return;
		if (entry.fixed) {
			this.message = { text: t("Prism always applies this one; it cannot be removed here."), kind: "muted" };
			return;
		}
		this.confirmRemove = identity(entry);
	}

	private async typed(typed: string): Promise<void> {
		const text = typed.trim();
		if (!text) {
			this.input = undefined;
			this.options.requestRender();
			return;
		}
		const parsed = this.options.parse ? this.options.parse(text) : text;
		if (parsed instanceof Error) {
			this.message = { text: parsed.message, kind: "warning" };
			this.options.requestRender();
			return;
		}
		this.input = undefined;
		this.message = undefined;
		const steps = this.options.steps?.() ?? [];
		this.adding = { text: parsed, choices: [], steps, option: 0 };
		if (steps.length === 0) await this.save();
		this.options.requestRender();
	}

	private async choose(value: string): Promise<void> {
		const adding = this.adding!;
		adding.choices.push(value);
		adding.option = 0;
		if (adding.choices.length === adding.steps.length) await this.save();
	}

	private async save(): Promise<void> {
		const { text, choices } = this.adding!;
		this.adding = undefined;
		await this.write(async () => await this.options.onAdd(text, choices));
		const at = this.options.entries().findIndex((entry) => entry.text === text);
		if (at !== -1) this.index = at + 1;
	}

	private async remove(shown: string): Promise<void> {
		const entries = this.options.entries();
		const entry = entries[this.index - 1];
		// The list changed since the first Enter: the entry it showed is asked about again where it now is, and
		// nothing is removed when it is gone or changed.
		if (!entry || identity(entry) !== shown) {
			const at = entries.findIndex((other) => identity(other) === shown);
			if (at === -1) {
				this.message = {
					text: t("This entry changed or was removed meanwhile; nothing was removed."),
					kind: "warning",
				};
			} else {
				this.index = at + 1;
				this.confirmRemove = shown;
				this.message = { text: t("The list changed; this is the entry you chose."), kind: "warning" };
			}
			this.options.requestRender();
			return;
		}
		await this.write(async () => await this.options.onRemove(entry));
		this.index = Math.min(this.index, this.options.entries().length);
	}

	private async write(change: () => void | Promise<void>): Promise<void> {
		this.busy = true;
		try {
			await change();
			this.changed = true;
		} catch (error) {
			this.message = { text: error instanceof Error ? error.message : String(error), kind: "error" };
		} finally {
			this.busy = false;
			this.options.requestRender();
		}
	}
}
