/**
 * fork: an optional file browser in a side panel. The owner asked for a sidebar, opened by
 * a key and by a visible button, to browse the project and send files to the model
 * , without turning Prism into an IDE. `app.files.browse` (alt+e) or `/files` opens it on the right of the
 * screen (full width on a narrow terminal); Enter on a file adds `@path` to the message being
 * written, as the `@` completion does; Tab marks several files first. It is an overlay: closing
 * it leaves the conversation and its scroll position as they were. A built-in extension, so
 * `/settings` turns it off.
 *
 * fork: a second tab, "Produced", lists the files the session produced (`produced-files.ts`)
 * with their state, and offers to read, attach, copy the path of, open or copy each one. The same key
 * (`app.files.browse`) or a click on the tab switches tabs.
 */
import { closeSync, type Dirent, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import {
	type Component,
	getKeybindings,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { CONFIG_DIR_NAME } from "../config.ts";
import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";
import { keyText } from "../modes/interactive/components/keybinding-hints.ts";
import { theme } from "../modes/interactive/theme/theme.ts";
import { copyToClipboard } from "../utils/clipboard.ts";
import { openBrowser } from "../utils/open-browser.ts";
import { copyFileExclusive } from "./bounded-read.ts";
import { previewDocument } from "./document-preview.ts";
import { DocumentViewer } from "./document-viewer.ts";
import { fill, t } from "./i18n/index.ts";
import { relativeInside } from "./path-within.ts";
import { type ProducedFile, type ProducedState, producedState, trackProducedFiles } from "./produced-files.ts";

const FOLDER = "";
const FILE = "";
/** Columns below which the panel takes the whole width instead of a side. */
const NARROW = 72;
/** Rows of the panel that are not entries: title, path, blank, blank, two hint lines. */
const CHROME = 6;

export type BrowserTab = "project" | "produced";
export type ProducedAction = "view" | "attach" | "copy" | "open" | "export";
export type BrowserResult = { attach: string[] } | { action: ProducedAction; file: ProducedFile };

const ACTIONS: { action: ProducedAction; label: string }[] = [
	{ action: "view", label: "Read in Prism" },
	{ action: "attach", label: "Add to message" },
	{ action: "copy", label: "Copy the path" },
	{ action: "open", label: "Open with the system's application" },
	{ action: "export", label: "Copy to a folder" },
];
const SOURCE_LABEL: Record<ProducedFile["source"], string> = {
	write: "written",
	edit: "edited",
	bash: "by a command",
	output: "command output",
};
/** The system's application might run these instead of showing them. */
const RUNNABLE_EXTENSIONS = new Set([
	".desktop",
	".sh",
	".bash",
	".zsh",
	".run",
	".appimage",
	".bin",
	".exe",
	".msi",
	".bat",
	".cmd",
	".ps1",
	".jar",
	".deb",
	".rpm",
	".flatpakref",
	".flatpak",
	".snap",
	".py",
	".pl",
	".rb",
	".js",
	".mjs",
	".cjs",
	".command",
	".scpt",
	".vbs",
	".lnk",
]);

/** Pages a browser would open and run scripts in. */
const WEB_PAGE_EXTENSIONS = new Set([
	".html",
	".htm",
	".xhtml",
	".xht",
	".shtml",
	".svg",
	".svgz",
	".mht",
	".mhtml",
	".hta",
]);
const WEB_PAGE_REFUSAL =
	"Web pages are not opened in the browser, which would run their scripts: Prism shows their code.";
const SNIFF_BYTES = 512;

/** The start of the file, as the desktop's type detection reads it, without a byte-order mark or leading blanks. */
function sniff(head: Buffer): string {
	return head
		.toString("utf8")
		.replace(/^\uFEFF/, "")
		.trimStart()
		.toLowerCase();
}

/**
 * Whether Prism shows this file's code instead of opening it: a web page by its name, or by its content when the
 * name has no extension (with one, the desktop goes by the extension: a `.xml` or `.txt` file stays openable).
 */
export function opensAsCode(path: string, head?: Buffer): boolean {
	const extension = extname(path).toLowerCase();
	if (WEB_PAGE_EXTENSIONS.has(extension)) return true;
	return (
		extension === "" &&
		head !== undefined &&
		/^<(?:!doctype html|html|head|body|script|svg|\?xml)\b/.test(sniff(head))
	);
}

/** Why the system's application must not open this file, or undefined when it may. */
export function openRefusal(path: string): string | undefined {
	let mode: number;
	try {
		const stat = statSync(path);
		if (!stat.isFile()) return "Not a regular file.";
		mode = stat.mode;
	} catch {
		return "The file is no longer there.";
	}
	if (mode & 0o111) return "Executable files are not opened, to avoid running them.";
	if (RUNNABLE_EXTENSIONS.has(extname(path).toLowerCase()))
		return "Scripts and programs are not opened, to avoid running them.";
	let head = Buffer.alloc(SNIFF_BYTES);
	try {
		const fd = openSync(path, "r");
		try {
			head = head.subarray(0, readSync(fd, head, 0, SNIFF_BYTES, 0));
		} finally {
			closeSync(fd);
		}
	} catch {
		return "The file cannot be read.";
	}
	// xdg-open picks the application by type, read from the content when the name says nothing.
	if (head.subarray(0, 2).toString("latin1") === "#!" || sniff(head).startsWith("[desktop entry]"))
		return "Scripts and programs are not opened, to avoid running them.";
	return opensAsCode(path, head) ? WEB_PAGE_REFUSAL : undefined;
}

export interface BrowserEntry {
	name: string;
	dir: boolean;
}

/**
 * Folders first, then files, by name; dot files after the others. `.git` is left out, and so is an empty
 * configuration folder: the sandbox reserves one in each project.
 */
export function listDirectory(dir: string): BrowserEntry[] {
	let dirents: Dirent[];
	try {
		dirents = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const emptyReservation = (entry: Dirent) => {
		if (!entry.isDirectory() || (entry.name !== CONFIG_DIR_NAME && entry.name !== ".pi")) return false;
		try {
			return readdirSync(join(dir, entry.name)).length === 0;
		} catch {
			return false;
		}
	};
	return dirents
		.filter((entry) => entry.name !== ".git" && !emptyReservation(entry))
		.map((entry) => ({ name: entry.name, dir: entry.isDirectory() }))
		.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

function rank(entry: BrowserEntry): number {
	return (entry.name.startsWith(".") ? 2 : 0) + (entry.dir ? 0 : 1);
}

/** Untrusted names must not send terminal commands; keep the real path for attachment. */
function displayName(name: string): string {
	return name.replace(/[\x00-\x1f\x7f-\x9f]/g, "�");
}

/** Add references to prose, or literal POSIX shell arguments to a `!` command. */
export function appendReferences(text: string, paths: string[]): string {
	if (paths.length === 0) return text;
	const refs = paths
		.map((path) =>
			text.startsWith("!") ? `'${path.replaceAll("'", "'\\''")}'` : `@${/\s/.test(path) ? `"${path}"` : path}`,
		)
		.join(" ");
	const glue = text === "" || /\s$/.test(text) ? "" : " ";
	return `${text}${glue}${refs} `;
}

export class FileBrowser implements Component {
	private readonly root: string;
	private readonly height: () => number;
	private readonly onAttach: (paths: string[]) => void;
	private readonly onAction: (action: ProducedAction, file: ProducedFile) => void;
	private readonly onClose: () => void;
	private readonly requestRender: () => void;
	private readonly produced: () => ProducedFile[];
	private tab: BrowserTab;
	private dir: string;
	private entries: BrowserEntry[] = [];
	private files: { file: ProducedFile; state: ProducedState }[] = [];
	/** The produced file whose actions are listed, with the selected action. */
	private menu: { file: ProducedFile; state: ProducedState; selected: number } | undefined;
	private selected = 0;
	private top = 0;
	/** Marked files, relative to the root. */
	private readonly marked = new Set<string>();
	/** First rendered entry row, for mouse hits. */
	private listRow = 0;
	/** Columns where the "Produced" tab title starts on the first row, for mouse hits. */
	private producedColumn = 0;
	private lastClicked: string | undefined;

	constructor(options: {
		root: string;
		height: () => number;
		onAttach: (paths: string[]) => void;
		onAction?: (action: ProducedAction, file: ProducedFile) => void;
		onClose: () => void;
		requestRender: () => void;
		produced?: () => ProducedFile[];
		tab?: BrowserTab;
	}) {
		this.root = options.root;
		this.dir = options.root;
		this.height = options.height;
		this.onAttach = options.onAttach;
		this.onAction = options.onAction ?? (() => {});
		this.onClose = options.onClose;
		this.requestRender = options.requestRender;
		this.produced = options.produced ?? (() => []);
		this.tab = options.tab ?? "project";
		this.load();
	}

	invalidate(): void {}

	private load(): void {
		this.lastClicked = undefined;
		if (this.tab === "produced") this.files = this.produced().map((file) => ({ file, state: producedState(file) }));
		else this.entries = listDirectory(this.dir);
		this.selected = Math.min(this.selected, Math.max(0, this.rowCount() - 1));
	}

	private rowCount(): number {
		if (this.menu) return ACTIONS.length;
		return this.tab === "produced" ? this.files.length : this.entries.length;
	}

	private switchTab(): void {
		this.tab = this.tab === "project" ? "produced" : "project";
		this.menu = undefined;
		this.selected = 0;
		this.top = 0;
		this.load();
	}

	private relativePath(name: string): string {
		return relative(this.root, join(this.dir, name)).split(sep).join("/");
	}

	/** A produced file's path as the user reads it: relative inside the project, absolute outside. */
	private shownPath(path: string): string {
		const inside = relativeInside(this.root, path);
		return inside ? inside.split(sep).join("/") : path;
	}

	private visibleRows(): number {
		return Math.max(1, this.height() - CHROME);
	}

	private stateText(state: ProducedState): string {
		if (state === "absent") return theme.fg("error", t("no longer there"));
		if (state === "changed") return theme.fg("warning", t("changed since"));
		return "";
	}

	private row(index: number): string {
		if (this.menu) {
			const item = ACTIONS[index]!;
			const unavailable = this.menu.state === "absent" && item.action !== "copy";
			return `  ${theme.fg(unavailable ? "dim" : "text", t(item.label))}`;
		}
		if (this.tab === "produced") {
			const { file, state } = this.files[index]!;
			const where = dirname(this.shownPath(file.path));
			const parts = [
				`${theme.fg("dim", FILE)} ${theme.fg(state === "absent" ? "dim" : "text", displayName(basename(file.path)))}`,
				this.stateText(state),
				theme.fg("dim", t(SOURCE_LABEL[file.source])),
				where === "." ? "" : theme.fg("dim", displayName(where)),
			];
			return `  ${parts.filter(Boolean).join("  ")}`;
		}
		const entry = this.entries[index]!;
		const mark = !entry.dir && this.marked.has(this.relativePath(entry.name)) ? theme.fg("accent", "●") : " ";
		const icon = entry.dir ? theme.fg("mdLink", FOLDER) : theme.fg("dim", FILE);
		const color = entry.name.startsWith(".") ? "dim" : entry.dir ? "mdLink" : "text";
		const name = theme.fg(color, displayName(entry.dir ? `${entry.name}/` : entry.name));
		return `${mark} ${icon} ${name}`;
	}

	render(width: number): string[] {
		const inner = Math.max(1, width - 2);
		// the selected row also gets the accent bar of /settings, as the band alone reads faintly.
		const pad = (line: string, bar = " ") => {
			const cut = truncateToWidth(line, inner, "…");
			return `${theme.fg("borderMuted", "│")}${bar}${cut}${" ".repeat(Math.max(0, inner - visibleWidth(cut)))}`;
		};
		const rows = this.visibleRows();
		const count = this.rowCount();
		if (this.selected < this.top) this.top = this.selected;
		if (this.selected >= this.top + rows) this.top = this.selected - rows + 1;
		this.top = Math.max(0, Math.min(this.top, Math.max(0, count - rows)));

		const title = (tab: BrowserTab, text: string) =>
			this.tab === tab ? theme.bold(theme.fg("accent", text)) : theme.fg("muted", text);
		const filesTitle = t("Files");
		const marks =
			this.tab === "project" && this.marked.size > 0
				? theme.fg("accent", fill("  {0} marked", String(this.marked.size)))
				: "";
		// "│ " in front of every row, then the first title and its separator.
		this.producedColumn = 2 + visibleWidth(filesTitle) + 3;
		let subtitle: string;
		if (this.menu) subtitle = displayName(this.shownPath(this.menu.file.path));
		else if (this.tab === "produced") subtitle = t("Files this session wrote or changed");
		else subtitle = displayName(relative(this.root, this.dir) || ".");
		const lines = [
			pad(`${title("project", filesTitle)}${theme.fg("dim", " · ")}${title("produced", t("Produced"))}${marks}`),
			pad(theme.fg("dim", subtitle)),
			pad(""),
		];
		this.listRow = lines.length;
		if (count === 0) {
			lines.push(pad(theme.fg("dim", this.tab === "produced" ? t("(nothing produced yet)") : t("(empty)"))));
		}
		for (let at = this.top; at < Math.min(count, this.top + rows); at++) {
			let line = this.row(at);
			if (at === this.selected) {
				const plain = truncateToWidth(line, inner, "…");
				line = theme.bg("selectedBg", `${plain}${" ".repeat(Math.max(0, inner - visibleWidth(plain)))}`);
			}
			lines.push(pad(line, at === this.selected ? theme.fg("accent", "▌") : " "));
		}
		while (lines.length < this.listRow + rows) lines.push(pad(""));
		lines.push(pad(""));
		const other = this.tab === "project" ? t("produced files") : t("project files");
		if (this.menu) {
			lines.push(pad(theme.fg("dim", t("enter choose"))));
			lines.push(pad(theme.fg("dim", t("esc back"))));
		} else if (this.tab === "produced") {
			lines.push(pad(theme.fg("dim", t("enter actions"))));
			lines.push(pad(theme.fg("dim", `${t("esc close")} · ${keyText("app.files.browse")} ${other}`)));
		} else {
			lines.push(pad(theme.fg("dim", t("enter add to message · tab mark"))));
			lines.push(pad(theme.fg("dim", `${t("← back · esc close")} · ${keyText("app.files.browse")} ${other}`)));
		}
		return lines;
	}

	private activate(): void {
		if (this.menu) {
			const { file, state } = this.menu;
			const item = ACTIONS[this.selected];
			if (!item || (state === "absent" && item.action !== "copy")) return;
			this.onAction(item.action, file);
			return;
		}
		if (this.tab === "produced") {
			const row = this.files[this.selected];
			if (!row) return;
			this.menu = { ...row, selected: this.selected };
			this.selected = row.state === "absent" ? ACTIONS.findIndex((item) => item.action === "copy") : 0;
			this.top = 0;
			return;
		}
		const entry = this.entries[this.selected];
		if (!entry && this.marked.size === 0) return;
		if (entry?.dir) {
			this.dir = join(this.dir, entry.name);
			this.selected = 0;
			this.top = 0;
			this.load();
			return;
		}
		const paths = [...this.marked];
		if (entry && !this.marked.has(this.relativePath(entry.name))) paths.push(this.relativePath(entry.name));
		this.onAttach(paths);
	}

	private up(): void {
		if (this.menu) {
			this.selected = this.menu.selected;
			this.menu = undefined;
			return;
		}
		if (this.tab === "produced" || this.dir === this.root) return;
		const left = this.dir.slice(this.dir.lastIndexOf(sep) + 1);
		this.dir = join(this.dir, "..");
		this.load();
		this.selected = Math.max(
			0,
			this.entries.findIndex((entry) => entry.name === left),
		);
	}

	handleInput(data: string): void {
		this.lastClicked = undefined;
		const keys = getKeybindings();
		const page = Math.max(1, this.visibleRows() - 1);
		const last = Math.max(0, this.rowCount() - 1);
		if (keys.matches(data, "tui.select.cancel")) {
			if (this.menu) this.up();
			else {
				this.onClose();
				return;
			}
		} else if (keys.matches(data, "app.files.browse")) this.switchTab();
		else if (keys.matches(data, "tui.select.up")) this.selected = Math.max(0, this.selected - 1);
		else if (keys.matches(data, "tui.select.down")) this.selected = Math.min(last, this.selected + 1);
		else if (keys.matches(data, "tui.select.pageUp")) this.selected = Math.max(0, this.selected - page);
		else if (keys.matches(data, "tui.select.pageDown")) this.selected = Math.min(last, this.selected + page);
		else if (keys.matches(data, "tui.select.confirm")) this.activate();
		else if (keys.matches(data, "tui.editor.cursorLeft") || keys.matches(data, "tui.editor.deleteCharBackward"))
			this.up();
		else if (keys.matches(data, "tui.editor.cursorRight")) {
			if (this.tab === "project" && !this.menu && this.entries[this.selected]?.dir) this.activate();
		} else if (keys.matches(data, "tui.input.tab")) {
			const entry = this.tab === "project" && !this.menu ? this.entries[this.selected] : undefined;
			if (entry && !entry.dir) {
				const path = this.relativePath(entry.name);
				if (!this.marked.delete(path)) this.marked.add(path);
				this.selected = Math.min(last, this.selected + 1);
			}
		} else return;
		this.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel") {
			this.lastClicked = undefined;
			const last = Math.max(0, this.rowCount() - 1);
			// fork: one entry per notch, as in every other list.
			this.selected = Math.max(0, Math.min(last, this.selected + Math.sign(event.wheelDelta ?? 0)));
			this.requestRender();
			return { handled: true };
		}
		if (event.type !== "click") return { handled: true };
		const previousClick = this.lastClicked;
		this.lastClicked = undefined;
		if (event.button !== "left") return { handled: true };
		if (event.y === 0) {
			const onProduced = event.x >= this.producedColumn;
			if (onProduced !== (this.tab === "produced")) {
				this.switchTab();
				this.requestRender();
			}
			return { handled: true };
		}
		const index = this.top + event.y - this.listRow;
		if (event.y >= this.listRow && index < this.rowCount() && event.y < this.listRow + this.visibleRows()) {
			const key = this.menu
				? `action:${index}`
				: this.tab === "produced"
					? this.files[index]!.file.path
					: this.relativePath(this.entries[index]!.name);
			this.selected = index;
			if (key === previousClick) this.activate();
			else this.lastClicked = key;
			this.requestRender();
		}
		return { handled: true };
	}
}

/** Copies the file into `folder` without replacing a file there; the copy's path, or why it failed (English). */
export function exportFile(path: string, folder: string): { copy: string } | { problem: string } {
	try {
		if (!statSync(folder).isDirectory()) return { problem: "Not a folder." };
	} catch {
		return { problem: "This folder does not exist." };
	}
	const copy = join(folder, basename(path));
	try {
		// fork: a copy that ends at the end it reads, never stuck on a truncated source.
		copyFileExclusive(path, copy, Number.MAX_SAFE_INTEGER);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return { problem: code === "EEXIST" ? "A file with this name is already there." : (error as Error).message };
	}
	return { copy };
}

/**
 * what a client's own file screen reads (rpc-builtins.ts,
 * files_*): the files Prism produced in this session, by session. The project's folders are read by path.
 */
const producedBySession = new WeakMap<ExtensionContext["sessionManager"], (ctx: ExtensionContext) => ProducedFile[]>();
export function producedFilesOf(ctx: ExtensionContext): ProducedFile[] {
	return producedBySession.get(ctx.sessionManager)?.(ctx) ?? [];
}

/**
 * fork: the files this session's exports wrote (`request_export`, `doctor_export`), by session. A
 * client that is not on the engine's machine (the phone) reads them back with `files_read`; no other command reaches
 * them, since an export may go anywhere the user typed.
 */
const exportedBySession = new WeakMap<ExtensionContext["sessionManager"], Set<string>>();
export function noteExported(ctx: ExtensionContext, path: string): void {
	const known = exportedBySession.get(ctx.sessionManager) ?? new Set<string>();
	known.add(path);
	exportedBySession.set(ctx.sessionManager, known);
}
export function exportedFilesOf(ctx: ExtensionContext): string[] {
	return [...(exportedBySession.get(ctx.sessionManager) ?? [])];
}

export default function fileBrowser(pi: ExtensionAPI) {
	const produced = trackProducedFiles(pi);
	pi.on("session_start", (_event, ctx) => {
		producedBySession.set(ctx.sessionManager, produced);
	});

	const view = async (ctx: ExtensionContext, path: string): Promise<void> => {
		const preview = await previewDocument(path);
		await ctx.ui.custom<void>(
			(tui, _theme, _keybindings, done) =>
				new DocumentViewer({
					preview,
					height: () => tui.terminal.rows,
					onClose: () => done(),
					requestRender: () => tui.requestRender(),
				}),
			{ overlay: true, overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" } },
		);
	};

	const act = async (ctx: ExtensionContext, action: ProducedAction, file: ProducedFile): Promise<void> => {
		if (action === "copy") {
			await copyToClipboard(file.path);
			ctx.ui.notify(fill("Path copied: {0}", file.path), "info");
		} else if (action === "open") {
			const refusal = openRefusal(file.path);
			if (refusal === WEB_PAGE_REFUSAL) {
				ctx.ui.notify(t(refusal), "warning");
				await view(ctx, file.path);
			} else if (refusal) ctx.ui.notify(`${t(refusal)} ${file.path}`, "warning");
			else {
				openBrowser(file.path);
				ctx.ui.notify(fill("Asked the system to open {0}", file.path), "info");
			}
		} else if (action === "export") {
			const answer = await ctx.ui.input(t("Copy to which folder? (empty: your home folder)"), homedir());
			if (answer === undefined) return;
			const folder =
				answer.trim() === "" ? homedir() : resolve(ctx.cwd, answer.trim().replace(/^~(?=$|\/)/, homedir()));
			const result = exportFile(file.path, folder);
			if ("copy" in result) ctx.ui.notify(fill("Copied to {0}", result.copy), "info");
			else ctx.ui.notify(`${t(result.problem)} ${folder}`, "warning");
		}
	};

	const open = async (ctx: ExtensionContext, tab: BrowserTab = "project") => {
		if (!ctx.hasUI) {
			ctx.ui.notify(t("The file browser needs the interactive terminal."), "warning");
			return;
		}
		let render: (() => void) | undefined;
		let columns = () => process.stdout.columns ?? NARROW;
		const result = await ctx.ui.custom<BrowserResult | undefined>(
			(tui, _theme, _keybindings, done) => {
				render = () => tui.requestRender();
				columns = () => tui.terminal.columns;
				return new FileBrowser({
					root: ctx.cwd,
					height: () => tui.terminal.rows,
					onAttach: (chosen) => done({ attach: chosen }),
					onAction: (action, file) => done({ action, file }),
					onClose: () => done(undefined),
					requestRender: () => tui.requestRender(),
					produced: () => produced(ctx),
					tab,
				});
			},
			{
				overlay: true,
				// The UI resolves overlayOptions once; the TUI reads these getters each render.
				overlayOptions: {
					get anchor() {
						return columns() < NARROW ? "center" : "right-center";
					},
					get width() {
						return columns() < NARROW ? "100%" : "35%";
					},
					get minWidth() {
						return columns() < NARROW ? undefined : 32;
					},
					maxHeight: "100%",
				},
			},
		);
		if (!result) return;
		let paths: string[];
		if ("attach" in result) paths = result.attach;
		else if (result.action === "view") {
			await view(ctx, result.file.path);
			// Back to the list the file was chosen from.
			await open(ctx, "produced");
			return;
		} else if (result.action === "attach") {
			const inside = relativeInside(ctx.cwd, result.file.path);
			paths = [inside ? inside.split(sep).join("/") : result.file.path];
		} else {
			await act(ctx, result.action, result.file);
			return;
		}
		if (paths.length === 0) return;
		ctx.ui.setEditorText(appendReferences(ctx.ui.getEditorText(), paths));
		// Setting the editor text does not redraw the screen by itself.
		render?.();
	};
	pi.registerCommand("files", {
		description: t("Browse the project's files and add them to your message (alt+e)"),
		handler: async (_args, ctx) => open(ctx),
	});
}
