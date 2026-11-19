/**
 * the agent's own desktop, live, in the terminal (`/desktop`, when the terminal shows images), as the
 * window's panel does: a picture every 100 ms, asked for only once the previous one arrived, with the agent's pointer
 * drawn on it. It never starts the desktop: while it is not running, it says so and looks again every 2 s.
 */
import { type Component, getKeybindings, Image, truncateToWidth } from "@earendil-works/pi-tui";
import { theme } from "../../modes/interactive/theme/theme.ts";
import { fill, t } from "../i18n/index.ts";

/** A PNG of the desktop, base64, with the agent's pointer drawn; the size is the desktop's, in pixels. */
export interface LiveFrame {
	data: string;
	width: number;
	height: number;
}

// A picture costs about 30 ms at 1280x720: some 7 a second at most.
export const LIVE_MS = 100;
export const IDLE_MS = 2000;

export class DesktopLiveView implements Component {
	private readonly source: () => Promise<LiveFrame | undefined>;
	private readonly height: () => number;
	private readonly onClose: () => void;
	private readonly requestRender: () => void;
	private frame: LiveFrame | undefined;
	private problem: string | undefined;
	private loaded = false;
	private image: Image | undefined;
	private imageId: number | undefined;
	private timer: NodeJS.Timeout | undefined;
	private closed = false;

	constructor(options: {
		/** The desktop now, or undefined when it is not running. */
		source: () => Promise<LiveFrame | undefined>;
		height: () => number;
		onClose: () => void;
		requestRender: () => void;
	}) {
		this.source = options.source;
		this.height = options.height;
		this.onClose = options.onClose;
		this.requestRender = options.requestRender;
		void this.next();
	}

	private async next(): Promise<void> {
		let frame: LiveFrame | undefined;
		let problem: string | undefined;
		try {
			frame = await this.source();
		} catch (error) {
			problem = error instanceof Error ? error.message : String(error);
		}
		if (this.closed) return;
		this.frame = frame;
		this.problem = problem;
		this.loaded = true;
		this.image = undefined;
		this.requestRender();
		this.timer = setTimeout(() => void this.next(), frame ? LIVE_MS : IDLE_MS);
	}

	/** Stops asking for pictures; the overlay is closing. */
	dispose(): void {
		this.closed = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}

	invalidate(): void {
		this.image?.invalidate();
	}

	render(width: number): string[] {
		width = Math.max(1, width);
		const rows = Math.max(1, this.height() - 2);
		const title = theme.bold(theme.fg("accent", t("The agent's own desktop")));
		const header = this.frame
			? `${title} ${theme.fg("dim", fill("· {0}×{1}", String(this.frame.width), String(this.frame.height)))}`
			: title;
		let body: string[];
		if (this.frame) {
			this.image ??= new Image(
				this.frame.data,
				"image/png",
				{ fallbackColor: (text) => theme.fg("dim", t(text)) },
				{ maxWidthCells: width, maxHeightCells: rows, imageId: this.imageId },
			);
			body = this.image.render(width);
			this.imageId = this.image.getImageId();
		} else if (this.problem) {
			body = [theme.fg("error", fill("Could not capture the desktop: {0}", this.problem))];
		} else if (this.loaded) {
			body = [t("The agent's desktop is not running. The agent starts it when it needs it.")];
		} else body = [];
		const lines = [header, ...body.slice(0, rows)];
		while (lines.length < rows + 1) lines.push("");
		lines.push(theme.fg("dim", t("esc close · /desktop stop stops the desktop")));
		// The image's lines are terminal sequences, not text: never cut.
		return lines.map((line, i) =>
			this.frame && i > 0 && i <= body.length ? line : truncateToWidth(line, width, "…"),
		);
	}

	handleInput(data: string): void {
		if (getKeybindings().matches(data, "tui.select.cancel")) {
			this.dispose();
			this.onClose();
		}
	}
}
