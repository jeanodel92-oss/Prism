// fork: a warning or error line of the transcript that a render hook (the Prism
// pack) may draw instead, e.g. as a boxed notice with a coloured bar on every wrapped line.
// Without the hook it is upstream's ThemedText.
import { sanitizeTerminalText } from "@earendil-works/pi-tui";
import { ThemedText } from "../modes/interactive/components/themed-text.ts";
import { renderHooks } from "./render-hooks.ts";

export class NoticeText extends ThemedText {
	private readonly kind: "warning" | "error";
	private readonly message: string;

	constructor(kind: "warning" | "error", message: string, build: () => string, paddingX = 1) {
		super(build, paddingX, 0);
		this.kind = kind;
		// fork: the hook draws the message itself, so Text's cleaning is not there.
		this.message = sanitizeTerminalText(message);
	}

	override render(width: number): string[] {
		return renderHooks.notice?.(this.kind, this.message, width) ?? super.render(width);
	}
}
