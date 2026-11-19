// fork: a path too wide for a question breaks after a "/", not inside its file name
// ("/tmp/pi-drive-ws.smgYKM/approval.t" then "xt" at 40 columns).
import { Text, visibleWidth } from "@earendil-works/pi-tui";

/** Breaks each word wider than `width` after its slashes, continuing under the line's indent. */
export function breakLongPaths(text: string, width: number): string {
	return text
		.split("\n")
		.map((line) => {
			const indent = /^\s*/.exec(line)?.[0] ?? "";
			const room = width - visibleWidth(indent);
			return line.replace(/\S+/g, (word) => {
				if (visibleWidth(word) <= room || !word.includes("/")) return word;
				const lines: string[] = [];
				let current = "";
				for (const part of word.split(/(?<=\/)/)) {
					if (current && visibleWidth(current + part) > room) {
						lines.push(current);
						current = part;
					} else current += part;
				}
				lines.push(current);
				return lines.join(`\n${indent}`);
			});
		})
		.join("\n");
}

/** A text whose plain content breaks its long paths at the width it is drawn at, then takes its style. */
export class PathText extends Text {
	private plain: string;
	private readonly style: (text: string) => string;
	private readonly padding: number;

	constructor(plain: string, style: (text: string) => string, paddingX: number) {
		super(style(plain), paddingX, 0);
		this.plain = plain;
		this.style = style;
		this.padding = paddingX;
	}

	setPlain(plain: string): void {
		this.plain = plain;
	}

	override render(width: number): string[] {
		this.setText(this.style(breakLongPaths(this.plain, width - this.padding * 2)));
		return super.render(width);
	}
}
