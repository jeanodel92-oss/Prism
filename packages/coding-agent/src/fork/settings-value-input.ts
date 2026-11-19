/**
 * fork: a value typed in `/settings` (the default budgets): the setting's title and description,
 * its current value, and a field. Enter saves what was typed, an empty field removes the value, Esc keeps it.
 */
import { type Component, Input, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { theme } from "../modes/interactive/theme/theme.ts";
import { t } from "./i18n/index.ts";

export interface ValueInputOptions {
	title: string;
	description: string;
	/** The value now, as the row shows it. */
	current: string;
	/** The value to save for what was typed (never empty), or an Error saying what is expected. */
	parse(text: string): string | Error;
	/** Saves the value, `undefined` to remove it; throws when the file cannot be written. */
	save(value: string | undefined): void | Promise<void>;
	requestRender(): void;
	/** Closes the field; `changed` when a value was saved or removed. */
	done(changed: boolean): void;
}

export class ValueInput implements Component {
	private readonly options: ValueInputOptions;
	private readonly input = new Input();
	private busy = false;
	private message: { text: string; kind: "warning" | "error" } | undefined;

	constructor(options: ValueInputOptions) {
		this.options = options;
		this.input.focused = true;
		this.input.onEscape = () => options.done(false);
		this.input.onSubmit = async (typed) => await this.submit(typed.trim());
	}

	invalidate(): void {}

	render(width: number): string[] {
		const out: string[] = [];
		const add = (text: string) => {
			const cut = truncateToWidth(text, Math.max(0, width), "…");
			out.push(`${cut}${" ".repeat(Math.max(0, width - visibleWidth(cut)))}`);
		};
		const wrap = (text: string) => {
			for (const line of wrapTextWithAnsi(text, width)) add(line);
		};
		add(theme.bold(theme.fg("accent", t(this.options.title))));
		wrap(theme.fg("muted", t(this.options.description)));
		add("");
		wrap(theme.fg("text", `${t("Now")}: ${t(this.options.current)}`));
		wrap(theme.fg("muted", t("Enter saves, an empty field removes it, Esc keeps it.")));
		for (const line of this.input.render(width)) add(line);
		if (this.message) wrap(theme.fg(this.message.kind, this.message.text));
		return out;
	}

	handleInput(data: string): void {
		if (this.busy) return;
		this.input.handleInput(data);
	}

	private async submit(text: string): Promise<void> {
		const value = text === "" ? undefined : this.options.parse(text);
		if (value instanceof Error) {
			this.message = { text: value.message, kind: "warning" };
			this.options.requestRender();
			return;
		}
		try {
			this.busy = true;
			const saved = this.options.save(value);
			if (saved instanceof Promise) await saved;
		} catch (error) {
			this.message = { text: error instanceof Error ? error.message : String(error), kind: "error" };
			this.options.requestRender();
			return;
		} finally {
			this.busy = false;
		}
		this.options.done(true);
	}
}
