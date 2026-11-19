// fork: a read-only page of `/settings`, such as the sandbox's state as `/sandbox` prints it. Moved out of
// settings-permissions.ts for fork.10, so settings-pages.ts draws it too.
import {
	type Component,
	getKeybindings,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { theme } from "../modes/interactive/theme/theme.ts";
import { t } from "./i18n/index.ts";

/** A read-only page: the sandbox's state as `/sandbox` printed it. */
export class TextPage implements Component {
	private readonly title: string;
	private readonly lines: string[];
	private readonly done: () => void;

	constructor(title: string, lines: string[], done: () => void) {
		this.title = title;
		this.lines = lines;
		this.done = done;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const out = [theme.bold(theme.fg("accent", t(this.title))), ""];
		for (const line of this.lines) out.push(...wrapTextWithAnsi(theme.fg("text", line), width));
		return out.map((line) => {
			const cut = truncateToWidth(line, width, "…");
			return `${cut}${" ".repeat(Math.max(0, width - visibleWidth(cut)))}`;
		});
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (
			kb.matches(data, "tui.select.cancel") ||
			kb.matches(data, "tui.select.confirm") ||
			kb.matches(data, "tui.editor.cursorLeft")
		)
			this.done();
	}
}
