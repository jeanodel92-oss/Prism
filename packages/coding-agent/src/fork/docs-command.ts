/**
 * fork: `/docs`, the shipped documentation inside Prism. Messages used to point at deep
 * npm paths of Markdown files ("les paths sont beaucoup trop compliqués pour rien, faut absolument une commande docs")
 * . `/docs` lists the topics of
 * docs/docs.json; `/docs <file or words>` opens the matching one directly. A document opens in
 * a scrollable reader: arrows and Page Up/Down scroll, Esc closes.
 *
 * fork: in French, titles come from docs/fr/titles.json and a page from docs/fr/ when
 * it is translated; the developer reference stays in English.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type Component,
	Container,
	decodeKittyPrintable,
	getKeybindings,
	Input,
	Markdown,
	SelectList,
	Spacer,
	sliceByColumn,
	stripTerminalSequences,
	Text,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { getDocsPath } from "../config.ts";
import type { ExtensionAPI } from "../core/extensions/types.ts";
import { getMarkdownTheme, getSelectListTheme, theme } from "../modes/interactive/theme/theme.ts";
import { fill, getLanguage, type Language, t } from "./i18n/index.ts";

interface NavItem {
	title: string;
	path?: string;
	items?: NavItem[];
}

export interface DocTopic {
	/** "Group › Title", as listed. */
	label: string;
	/** File name under docs/. */
	path: string;
}

/** Translated titles of docs.json for `language`, English title to translated title. */
function docTitles(docsDir: string, language: Language): Record<string, string> {
	if (language === "en") return {};
	try {
		return JSON.parse(readFileSync(join(docsDir, language, "titles.json"), "utf-8")) as Record<string, string>;
	} catch {
		return {};
	}
}

/** The file to read for `path` in `language`: the translated page when there is one, else the English one. */
export function docFile(path: string, docsDir = getDocsPath(), language = getLanguage()): string {
	const translated = join(docsDir, language, path);
	return language !== "en" && existsSync(translated) ? translated : join(docsDir, path);
}

/** Topics of docs.json, in its order, each with its group path, titled in `language`. */
export function docTopics(docsDir = getDocsPath(), language = getLanguage()): DocTopic[] {
	let navigation: NavItem[] = [];
	try {
		navigation =
			(JSON.parse(readFileSync(join(docsDir, "docs.json"), "utf-8")) as { navigation?: NavItem[] }).navigation ?? [];
	} catch {
		return [];
	}
	const titles = docTitles(docsDir, language);
	const topics: DocTopic[] = [];
	const walk = (items: NavItem[], trail: string[]) => {
		for (const item of items) {
			const title = titles[item.title] ?? item.title;
			if (item.path) topics.push({ label: [...trail, title].join(" › "), path: item.path });
			if (item.items) walk(item.items, [...trail, title]);
		}
	};
	walk(navigation, []);
	return topics;
}

/** The topic for `/docs <query>`: a file name, or words found in a title. */
export function findTopic(topics: DocTopic[], query: string): DocTopic | undefined {
	const q = query.trim().toLowerCase();
	if (!q) return undefined;
	return (
		topics.find((topic) => topic.path.toLowerCase() === q || topic.path.toLowerCase() === `${q}.md`) ??
		topics.find((topic) => q.split(/\s+/).every((word) => topic.label.toLowerCase().includes(word)))
	);
}

/** Lower case, without accents: "Réglages" and "reglages" match. */
const fold = (text: string) => text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");

/** A topic with its folded text, for the search. */
export interface SearchableTopic extends DocTopic {
	text: string;
	/** The page's lines without Markdown marks, and the same prepared for the search (topicExcerpt). */
	lines: string[];
	prepared: SearchLine[];
}

export function searchableTopics(topics: DocTopic[], docsDir = getDocsPath()): SearchableTopic[] {
	return topics.map((topic) => {
		let raw = "";
		try {
			raw = readFileSync(docFile(topic.path, docsDir), "utf-8");
		} catch {
			// The reader reports a missing file if the user opens this topic.
		}
		const lines = raw.split("\n").map((line) => line.replace(/[#*`]/g, "").trim());
		return { ...topic, text: fold(raw), lines, prepared: prepareDocSearch(lines) };
	});
}

/**
 * fork: the topics holding every typed word, those whose title holds them first. Whole
 * words of the text, not a fuzzy match: spread over a long page, any letters would match.
 */
export function matchTopics(topics: SearchableTopic[], query: string): SearchableTopic[] {
	const words = fold(query).split(/\s+/).filter(Boolean);
	if (words.length === 0) return topics;
	const inTitle = topics.filter((topic) => words.every((word) => fold(topic.label).includes(word)));
	const inText = topics.filter(
		(topic) => !inTitle.includes(topic) && words.every((word) => topic.text.includes(word)),
	);
	return [...inTitle, ...inText];
}

/**
 * fork.9 QA: what in a page answers the search, shown before it is opened: how many places hold the first word found,
 * and the first of them with the typed words underlined. Undefined when only the title matches.
 */
export function topicExcerpt(topic: SearchableTopic, query: string, width = 70): string | undefined {
	const found = topicMatches(topic, query, 6, width);
	return found && `${found.count}× ${found.excerpt}`;
}

/** How often a topic matches the query, and its first match with `before` columns of context, highlighted. */
export function topicMatches(
	topic: SearchableTopic,
	query: string,
	before: number,
	width: number,
): { count: number; excerpt: string } | undefined {
	const words = fold(query).split(/\s+/).filter(Boolean);
	const matches = words.map((word) => findDocMatches(topic.lines, word, topic.prepared)).find((found) => found.length);
	const first = matches?.[0];
	if (!matches || !first) return undefined;
	const start = Math.max(0, first.from - before);
	const text = sliceByColumn(topic.lines[first.row]!, start, width, true);
	const places = words.flatMap((word) => findDocMatches([text], word)).map((match) => ({ ...match, current: false }));
	return { count: matches.length, excerpt: `${start > 0 ? "…" : ""}${highlight(text, places)}` };
}

/**
 * a page opened from the search is searched for what was typed, so it shows where the
 * words are. The whole query when the page holds it as typed, otherwise its first word the page holds.
 */
export function pageQuery(topic: SearchableTopic, query: string): string {
	const words = [query.trim(), ...query.trim().split(/\s+/)].filter(Boolean);
	return words.find((word) => findDocMatches(topic.lines, word, topic.prepared).length > 0) ?? "";
}

/** The topic list: typing filters it (matchTopics), arrows move, Enter opens, Esc closes. */
class DocPicker extends Container {
	private readonly topics: SearchableTopic[];
	private readonly input = new Input();
	private readonly onSelect: (path: string) => void;
	private readonly onCancel: () => void;
	private list: SelectList;
	private readonly listIndex: number;

	constructor(topics: SearchableTopic[], selected: string, onSelect: (path: string) => void, onCancel: () => void) {
		super();
		this.topics = topics;
		this.onSelect = onSelect;
		this.onCancel = onCancel;
		this.addChild(new Text(theme.bold(theme.fg("accent", t("Documentation"))), 0, 0));
		this.addChild(this.input);
		this.addChild(new Spacer(1));
		this.list = this.buildList(topics, selected);
		this.listIndex = this.children.length;
		this.addChild(this.list);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(theme.fg("dim", t("  Type to search titles and pages · Enter to open · Esc to close")), 0, 0),
		);
	}

	getQuery(): string {
		return this.input.getValue();
	}

	private buildList(topics: SearchableTopic[], selected: string): SelectList {
		const query = this.input.getValue();
		const items = topics.map((topic) => ({
			value: topic.path,
			label: topic.label,
			description: query ? topicExcerpt(topic, query) : undefined,
		}));
		const list = new SelectList(items, Math.min(Math.max(items.length, 1), 10), getSelectListTheme(), {
			minPrimaryColumnWidth: 20,
			maxPrimaryColumnWidth: 34,
		});
		const index = items.findIndex((item) => item.value === selected);
		if (index !== -1) list.setSelectedIndex(index);
		list.onSelect = (item) => this.onSelect(item.value);
		list.onCancel = this.onCancel;
		return list;
	}

	handleInput(data: string): void {
		const keys = getKeybindings();
		if (
			keys.matches(data, "tui.select.up") ||
			keys.matches(data, "tui.select.down") ||
			keys.matches(data, "tui.select.pageUp") ||
			keys.matches(data, "tui.select.pageDown") ||
			keys.matches(data, "tui.select.confirm") ||
			keys.matches(data, "tui.select.cancel")
		) {
			this.list.handleInput(data);
			return;
		}
		this.input.handleInput(data);
		this.list = this.buildList(matchTopics(this.topics, this.input.getValue()), "");
		this.children[this.listIndex] = this.list;
	}
}

/** A match of the reader's search: a row of the rendered page and its columns. */
export interface DocMatch {
	row: number;
	from: number;
	to: number;
}

/** A rendered line without its escapes, and folded: computed once per width, not at each key. */
interface SearchLine {
	plain: string;
	whole: string;
}

export function prepareDocSearch(lines: readonly string[]): SearchLine[] {
	return lines.map((line) => {
		const plain = stripTerminalSequences(line);
		return { plain, whole: fold(plain) };
	});
}

/**
 * fork: the places of `query` in rendered lines, folded as the topic search is
 * ("reglage" finds "Réglage"), in columns so they can be highlighted.
 */
export function findDocMatches(
	lines: readonly string[],
	query: string,
	prepared: readonly SearchLine[] = prepareDocSearch(lines),
): DocMatch[] {
	const needle = fold(query);
	if (!needle.trim()) return [];
	const matches: DocMatch[] = [];
	for (const [row, { plain, whole }] of prepared.entries()) {
		if (!whole.includes(needle)) continue;
		// Folding usually keeps one unit per unit ("é" → "e"); otherwise, map each folded unit to its source.
		let folded = whole;
		let source = (at: number) => at;
		if (whole.length !== plain.length) {
			const units: number[] = [];
			folded = "";
			let offset = 0;
			for (const char of plain) {
				const unit = fold(char);
				folded += unit;
				for (let k = 0; k < unit.length; k++) units.push(offset);
				offset += char.length;
			}
			units.push(offset);
			source = (at) => units[at]!;
		}
		const column = (at: number) => visibleWidth(plain.slice(0, at));
		for (let at = folded.indexOf(needle); at !== -1; at = folded.indexOf(needle, at + needle.length)) {
			const last = source(at + needle.length - 1);
			const end = last + (plain.codePointAt(last)! > 0xffff ? 2 : 1);
			matches.push({ row, from: column(source(at)), to: column(end) });
		}
	}
	return matches;
}

/** `line` with its matches underlined, the current one in reverse video. */
function highlight(line: string, matches: Array<DocMatch & { current: boolean }>): string {
	const width = visibleWidth(line);
	for (const match of [...matches].sort((a, b) => b.from - a.from)) {
		const before = sliceByColumn(line, 0, match.from, true);
		const text = sliceByColumn(line, match.from, match.to - match.from, true);
		const after = sliceByColumn(line, match.to, Math.max(0, width - match.to), true);
		line = `${before}${match.current ? `\x1b[7m${text}\x1b[27m` : `\x1b[4m${text}\x1b[24m`}${after}`;
	}
	return line;
}

/**
 * A Markdown document in a fixed-height window; arrows and Page Up/Down scroll, Esc goes back or closes.
 * fork: typing searches the page, as in the document viewer; Enter and Shift+Enter (the
 * transcript search's keys) go to the next and previous match, Esc clears the search before it closes.
 */
export class DocReader implements Component {
	private readonly markdown: Markdown;
	private readonly title: string;
	private readonly height: () => number;
	private readonly onClose: () => void;
	private readonly requestRender: () => void;
	private readonly closeLabel: string;
	private top = 0;
	private lastLineCount = 0;
	private query = "";
	private matches: DocMatch[] = [];
	private current = 0;
	private jump = false;
	/** The search came with the page (pageQuery): Esc leaves at once instead of clearing a search not typed here. */
	private carried = false;
	private searchedLines: string[] | undefined;
	private prepared: SearchLine[] = [];

	constructor(
		title: string,
		text: string,
		height: () => number,
		onClose: () => void,
		requestRender: () => void,
		closeLabel: string,
		query = "",
	) {
		this.title = title;
		this.query = query;
		this.jump = query !== "";
		this.carried = query !== "";
		this.markdown = new Markdown(text, 1, 0, getMarkdownTheme());
		this.height = height;
		this.onClose = onClose;
		this.requestRender = requestRender;
		this.closeLabel = closeLabel;
	}

	invalidate(): void {
		this.markdown.invalidate();
	}

	render(width: number): string[] {
		const lines = this.markdown.render(width);
		this.lastLineCount = lines.length;
		if (lines !== this.searchedLines) {
			// A new width rewraps the page: the matches move with it.
			this.searchedLines = lines;
			this.prepared = prepareDocSearch(lines);
			this.matches = findDocMatches(lines, this.query, this.prepared);
			this.current = Math.min(this.current, Math.max(0, this.matches.length - 1));
		}
		const body = Math.max(3, this.height() - 3);
		if (this.jump && this.matches.length > 0) this.top = this.matches[this.current]!.row - 2;
		this.jump = false;
		this.top = Math.max(0, Math.min(this.top, lines.length - body));
		const end = Math.min(lines.length, this.top + body);
		const position = lines.length > body ? `  ${this.top + 1}-${end} / ${lines.length}` : "";
		const shown = lines.slice(this.top, end).map((line, index) => {
			const row = this.top + index;
			const here = this.matches
				.map((match, at) => ({ ...match, current: at === this.current }))
				.filter((match) => match.row === row);
			return here.length > 0 ? highlight(line, here) : line;
		});
		const status = !this.query
			? ""
			: this.matches.length > 0
				? ` · ${fill("match {0}/{1}", String(this.current + 1), String(this.matches.length))}`
				: ` · ${t("no match")}`;
		const search = this.query
			? `${truncateToWidth(fill("Search: {0}", this.query), Math.max(1, width - visibleWidth(status)), "…")}${theme.fg("dim", status)}`
			: theme.fg("dim", t("Type to search this page"));
		const hints = this.query
			? t(`Enter next · Shift+Enter previous · Esc ${this.carried ? this.closeLabel : "clear"}`)
			: t(`↑↓ scroll · PgUp/PgDn page · Home/End top/bottom · Esc ${this.closeLabel}`);
		return [
			truncateToWidth(`${theme.bold(theme.fg("accent", this.title))}${theme.fg("dim", position)}`, width),
			...shown,
			truncateToWidth(search, width),
			truncateToWidth(theme.fg("dim", hints), width),
		];
	}

	private search(query: string): void {
		this.carried = false;
		this.query = query;
		this.matches = this.searchedLines ? findDocMatches(this.searchedLines, query, this.prepared) : [];
		// The first match from the page shown, not from the top of the document.
		const next = this.matches.findIndex((match) => match.row >= this.top);
		this.current = Math.max(0, next);
		this.jump = true;
	}

	handleInput(data: string): void {
		const keys = getKeybindings();
		const page = Math.max(1, this.height() - 4);
		const step = (direction: 1 | -1) => {
			if (this.matches.length === 0) return;
			this.current = (this.current + direction + this.matches.length) % this.matches.length;
			this.jump = true;
		};
		if (keys.matches(data, "tui.select.cancel")) {
			if (!this.query || this.carried) {
				this.onClose();
				return;
			}
			this.search("");
		} else if (this.query && keys.matches(data, "tui.altScreen.searchPrevious")) step(-1);
		else if (this.query && keys.matches(data, "tui.altScreen.searchNext")) step(1);
		else if (keys.matches(data, "tui.select.up")) this.top -= 1;
		else if (keys.matches(data, "tui.select.down")) this.top += 1;
		else if (keys.matches(data, "tui.select.pageUp")) this.top -= page;
		else if (keys.matches(data, "tui.select.pageDown")) this.top += page;
		else if (keys.matches(data, "tui.editor.cursorLineStart")) this.top = 0;
		else if (keys.matches(data, "tui.editor.cursorLineEnd")) this.top = this.lastLineCount;
		else if (keys.matches(data, "tui.editor.deleteCharBackward")) {
			if (!this.query) return;
			this.search([...this.query].slice(0, -1).join(""));
		} else {
			const printable = decodeKittyPrintable(data) ?? data;
			if (!printable || /[\x00-\x1f\x7f-\x9f]/.test(printable)) return;
			this.search(this.query + printable);
		}
		this.requestRender();
	}

	/** fork: the wheel scrolls one line per notch, as the arrows do. */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "wheel" || !event.wheelDelta) return undefined;
		this.top += Math.sign(event.wheelDelta);
		this.requestRender();
		return { handled: true };
	}
}

export default function docsCommand(pi: ExtensionAPI) {
	pi.registerCommand("docs", {
		description: "Read Prism's documentation: /docs, or /docs <topic>",
		handler: async (args, ctx) => {
			const topics = docTopics();
			if (topics.length === 0) {
				ctx.ui.notify(t("The documentation is not installed with this build."), "warning");
				return;
			}
			let topic = findTopic(topics, args ?? "");
			const openedDirectly = topic !== undefined;
			if (!topic && !ctx.hasUI) {
				ctx.ui.notify(topics.map((item) => `${item.label}: /docs ${item.path.replace(/\.md$/, "")}`).join("\n"));
				return;
			}
			let selectedPath = topic?.path;
			// Read once per /docs, not at each return to the list.
			const searchable = openedDirectly ? [] : searchableTopics(topics);
			let searched = "";
			while (true) {
				if (!topic) {
					let picker: DocPicker | undefined;
					const choice = await ctx.ui.custom<string>(
						(_tui, _theme, _keybindings, done) => {
							picker = new DocPicker(searchable, selectedPath ?? "", done, () => done(""));
							return picker;
						},
						{ overlay: true, overlayOptions: { anchor: "bottom-center", width: "100%", maxHeight: "100%" } },
					);
					topic = topics.find((item) => item.path === choice);
					if (!topic) return;
					selectedPath = topic.path;
					const found = searchable.find((item) => item.path === choice);
					searched = found ? pageQuery(found, picker?.getQuery() ?? "") : "";
				}

				let text: string;
				try {
					text = readFileSync(docFile(topic.path), "utf-8");
				} catch {
					ctx.ui.notify(fill("Could not read {0}.", topic.path), "error");
					return;
				}
				const chosen = topic;
				// An overlay: in fullscreen mode, Page Up/Down and End otherwise scroll the conversation.
				await ctx.ui.custom<void>(
					(tui, _theme, _keybindings, done) =>
						new DocReader(
							chosen.label,
							text,
							() => Math.max(8, Math.floor(tui.terminal.rows * 0.75)),
							() => done(undefined),
							() => tui.requestRender(),
							openedDirectly ? "close" : "back",
							searched,
						),
					{ overlay: true, overlayOptions: { anchor: "bottom-center", width: "100%", maxHeight: "100%" } },
				);
				if (openedDirectly) return;
				topic = undefined;
			}
		},
	});
}
