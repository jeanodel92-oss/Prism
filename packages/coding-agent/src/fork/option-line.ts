// fork: an option of a selector list whose wrapped lines line up under the
// option's text instead of returning to the left edge (hanging indent):
//   → Always allow (save "edit(/tmp/project/**)" to
//     /tmp/project/.prism/permissions.json)
import {
	type Component,
	sanitizeTerminalText,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

export class OptionLine implements Component {
	private readonly prefix: string;
	private readonly text: string;
	private readonly paddingX: number;

	constructor(prefix: string, text: string, paddingX = 1) {
		this.prefix = prefix;
		// fork.12 security audit: like the text component, only styling reaches the terminal. The callers
		// that put a tool call's target in an option show its controls first (visible-text.ts).
		this.text = sanitizeTerminalText(text);
		this.paddingX = paddingX;
	}

	render(width: number): string[] {
		// the padding never takes the text's last column, and a line is clipped to the
		// width when the prefix alone does not fit.
		const paddingX = Math.max(0, Math.min(this.paddingX, Math.floor((width - 1) / 2)));
		const pad = " ".repeat(paddingX);
		const indent = visibleWidth(this.prefix);
		const room = Math.max(1, width - paddingX * 2 - indent);
		return wrapTextWithAnsi(this.text, room).map((text, i) => {
			const line = `${pad}${i === 0 ? this.prefix : " ".repeat(indent)}${text}`;
			return visibleWidth(line) > width ? truncateToWidth(line, Math.max(0, width), "") : line;
		});
	}

	invalidate(): void {}
}
