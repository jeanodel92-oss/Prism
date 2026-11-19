/**
 * fork: a full-screen viewer for a `DocumentPreview`: text, Markdown, CSV/TSV as columns,
 * images when the terminal can show them, extracted text with its note. Typing searches; terminal
 * controls in names and content never reach the terminal.
 */
import { basename, extname } from "node:path";
import {
	type Component,
	decodeKittyPrintable,
	getCapabilities,
	getImageDimensions,
	getKeybindings,
	Image,
	Markdown,
	stripTerminalSequences,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { getMarkdownTheme, theme } from "../modes/interactive/theme/theme.ts";
import type { DocumentPreview } from "./document-preview.ts";
import { fill, getLanguage, t } from "./i18n/index.ts";

function displayName(text: string): string {
	return text.replace(/[\x00-\x1f\x7f-\x9f]/g, "�");
}

function cleanContent(text: string): string {
	return stripTerminalSequences(text.replace(/\r\n?/g, "\n"))
		.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
		.replaceAll("\t", "    ");
}

function tableLines(text: string, delimiter: string, width: number): string[] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const char = text[i]!;
		if (char === '"' && (quoted || field === "")) {
			if (quoted && text[i + 1] === '"') {
				field += '"';
				i++;
			} else quoted = !quoted;
		} else if (!quoted && (char === delimiter || char === "\n")) {
			row.push(cleanContent(field));
			field = "";
			if (char === "\n") {
				rows.push(row);
				row = [];
			}
		} else field += char === "\n" ? " ↵ " : char;
	}
	if (field || row.length) rows.push([...row, cleanContent(field)]);
	const widths: number[] = [];
	for (const cells of rows) {
		for (const [i, cell] of cells.entries())
			widths[i] = Math.min(width, Math.max(widths[i] ?? 0, visibleWidth(cell)));
	}
	return rows.map((cells) => {
		let line = "";
		for (const [i, cell] of cells.entries()) {
			if (visibleWidth(line) >= width) break;
			const cut = truncateToWidth(cell, widths[i]!, "…");
			line += `${i ? " │ " : ""}${cut}${" ".repeat(Math.max(0, widths[i]! - visibleWidth(cut)))}`;
		}
		return truncateToWidth(line, width, "…");
	});
}

export class DocumentViewer implements Component {
	private readonly preview: DocumentPreview;
	private readonly height: () => number;
	private readonly onClose: () => void;
	private readonly requestRender: () => void;
	private top = 0;
	private search = "";
	private matches: number[] = [];
	private match = 0;
	private jumpToMatch = false;
	private lines: string[] = [];
	private cachedWidth = 0;
	private cachedRows = 0;
	private cachedLanguage = "";
	private image: Image | undefined;

	constructor(options: {
		preview: DocumentPreview;
		height: () => number;
		onClose: () => void;
		requestRender: () => void;
	}) {
		this.preview = options.preview;
		this.height = options.height;
		this.onClose = options.onClose;
		this.requestRender = options.requestRender;
	}

	invalidate(): void {
		this.cachedWidth = 0;
		this.image?.invalidate();
	}

	private visibleRows(): number {
		return Math.max(1, this.height() - 5);
	}

	private body(width: number): string[] {
		const preview = this.preview;
		if (preview.problem) return wrapTextWithAnsi(cleanContent(t(preview.problem)), width);
		const notes = preview.note ? wrapTextWithAnsi(cleanContent(t(preview.note)), width).concat("") : [];
		if (preview.kind === "missing") return wrapTextWithAnsi(t("File is missing or is not a regular file."), width);
		if (preview.kind === "unsupported") return wrapTextWithAnsi(t("Unsupported document format."), width);
		if (preview.kind === "image") {
			if (preview.image) {
				const { data, mimeType } = preview.image;
				if (getCapabilities().images) {
					this.image = new Image(
						data,
						mimeType,
						{ fallbackColor: (text) => theme.fg("dim", t(text)) },
						{
							maxWidthCells: width,
							maxHeightCells: Math.max(1, this.visibleRows() - notes.length),
							imageId: this.image?.getImageId(),
						},
					);
					return [...notes, ...this.image.render(width)];
				}
				const dimensions = getImageDimensions(data, mimeType);
				return [
					...notes,
					...wrapTextWithAnsi(t("This terminal cannot display images."), width),
					...(dimensions
						? [fill("Dimensions: {0} × {1} px", String(dimensions.widthPx), String(dimensions.heightPx))]
						: []),
				];
			}
			return notes;
		}
		const text = preview.text ?? "";
		if (preview.kind === "csv") {
			return [
				...notes,
				...tableLines(
					stripTerminalSequences(text.replace(/\r\n?/g, "\n")),
					extname(preview.path).toLowerCase() === ".tsv" ? "\t" : ",",
					width,
				),
			];
		}
		const content = cleanContent(text);
		return [
			...notes,
			...(preview.kind === "markdown"
				? new Markdown(content, 0, 0, getMarkdownTheme()).render(width)
				: content.split("\n").flatMap((line) => wrapTextWithAnsi(line, width))),
		];
	}

	private findMatches(): void {
		this.matches = [];
		if (!this.search) return;
		const query = this.search.toLocaleLowerCase();
		for (const [row, line] of this.lines.entries()) {
			const plain = stripTerminalSequences(line).toLocaleLowerCase();
			let at = plain.indexOf(query);
			while (at !== -1) {
				this.matches.push(row);
				at = plain.indexOf(query, at + query.length);
			}
		}
		this.match = Math.min(this.match, Math.max(0, this.matches.length - 1));
	}

	render(width: number): string[] {
		width = Math.max(1, width);
		if (
			this.cachedWidth !== width ||
			this.cachedRows !== this.visibleRows() ||
			this.cachedLanguage !== getLanguage()
		) {
			this.lines = this.body(width);
			this.cachedWidth = width;
			this.cachedRows = this.visibleRows();
			this.cachedLanguage = getLanguage();
			this.findMatches();
		}
		if (this.jumpToMatch) {
			if (this.matches.length) this.top = this.matches[this.match]!;
			this.jumpToMatch = false;
		}
		const rows = this.visibleRows();
		this.top = Math.max(0, Math.min(this.top, Math.max(0, this.lines.length - rows)));
		const preview = this.preview;
		const lines = [
			theme.bold(theme.fg("accent", displayName(basename(preview.path)))),
			`${displayName(t(preview.type))}${preview.size === undefined ? "" : ` · ${fill("{0} bytes", String(preview.size))}`}`,
			theme.fg("dim", displayName(preview.path)),
			...this.lines.slice(this.top, this.top + rows),
		];
		while (lines.length < rows + 3) lines.push("");
		const status = this.search
			? this.matches.length
				? fill("match {0}/{1}", String(this.match + 1), String(this.matches.length))
				: t("no match")
			: "";
		const suffix = status ? ` · ${status}` : "";
		lines.push(
			`${truncateToWidth(fill("Search: {0}", this.search), Math.max(1, width - visibleWidth(suffix)), "…")}${suffix}`,
		);
		lines.push(theme.fg("dim", t("↑↓ scroll · enter next match · esc clear/close")));
		return lines.map((line) => truncateToWidth(line, width, "…"));
	}

	handleInput(data: string): void {
		const keys = getKeybindings();
		if (keys.matches(data, "tui.select.cancel")) {
			if (!this.search) {
				this.onClose();
				return;
			}
			this.search = "";
			this.findMatches();
		} else if (keys.matches(data, "tui.select.up")) this.top--;
		else if (keys.matches(data, "tui.select.down")) this.top++;
		else if (keys.matches(data, "tui.select.pageUp")) this.top -= this.visibleRows();
		else if (keys.matches(data, "tui.select.pageDown")) this.top += this.visibleRows();
		else if (keys.matches(data, "tui.editor.cursorLineStart")) this.top = 0;
		else if (keys.matches(data, "tui.editor.cursorLineEnd")) this.top = this.lines.length;
		else if (keys.matches(data, "tui.select.confirm")) {
			if (this.matches.length) this.match = (this.match + 1) % this.matches.length;
			this.jumpToMatch = true;
		} else {
			if (keys.matches(data, "tui.editor.deleteCharBackward")) this.search = [...this.search].slice(0, -1).join("");
			else {
				const printable = decodeKittyPrintable(data) ?? data;
				if (!printable || /[\x00-\x1f\x7f-\x9f]/.test(printable)) return;
				this.search += printable;
			}
			this.match = 0;
			this.findMatches();
			this.jumpToMatch = true;
		}
		this.top = Math.max(0, this.top);
		this.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel") {
			this.top = Math.max(0, this.top + Math.sign(event.wheelDelta ?? 0));
			this.requestRender();
		}
		return { handled: true };
	}
}
