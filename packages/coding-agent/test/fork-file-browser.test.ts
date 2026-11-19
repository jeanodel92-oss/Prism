// fork: the file browser side panel lists the project, adds `@path` references to the
// message, and leaves the conversation alone when it closes.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Component,
	type OverlayHandle,
	setKeybindings,
	type TUI,
	TuiAltScreen,
	type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import fileBrowser, { appendReferences, FileBrowser, listDirectory } from "../src/fork/file-browser.ts";
import { initTheme, type Theme, theme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, createTestUiContext } from "./suite/harness.ts";

const DOWN = "\x1b[B";
const ENTER = "\r";
const TAB = "\t";
const LEFT = "\x1b[D";
const ESC = "\x1b";

function clickAt(row: number): TuiMouseEvent {
	return {
		type: "click",
		button: "left",
		x: 5,
		y: row,
		screenX: 5,
		screenY: row,
		width: 40,
		height: 20,
		shift: false,
		alt: false,
		ctrl: false,
	};
}

describe("fork: file browser", () => {
	let root: string;
	beforeAll(() => {
		initTheme("prism");
		setKeybindings(new KeybindingsManager({}));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	function project(mainName = "main.ts", folderName = "src") {
		root = mkdtempSync(join(tmpdir(), "prism-files-"));
		mkdirSync(join(root, folderName));
		mkdirSync(join(root, ".git"));
		writeFileSync(join(root, folderName, mainName), "");
		writeFileSync(join(root, "b.txt"), "");
		writeFileSync(join(root, "a file.md"), "");
		writeFileSync(join(root, ".env.example"), "");
		const result: { attached?: string[]; closed: boolean } = { closed: false };
		const browser = new FileBrowser({
			root,
			height: () => 20,
			onAttach: (paths) => {
				result.attached = paths;
			},
			onClose: () => {
				result.closed = true;
			},
			requestRender: () => {},
		});
		return { browser, result };
	}

	it("lists folders, then files, then dot files, without .git", () => {
		project();
		expect(listDirectory(root).map((entry) => entry.name)).toEqual(["src", "a file.md", "b.txt", ".env.example"]);
	});

	it("opens a folder, goes back, and adds the chosen file", () => {
		const { browser, result } = project();
		browser.handleInput(ENTER); // src/
		expect(browser.render(40).join("\n")).toContain("main.ts");
		browser.handleInput(LEFT);
		browser.handleInput(DOWN);
		browser.handleInput(DOWN);
		browser.handleInput(ENTER);
		expect(result.attached).toEqual(["b.txt"]);
	});

	it("adds every marked file, and the one under the cursor", () => {
		const { browser, result } = project();
		browser.handleInput(ENTER);
		browser.handleInput(TAB); // marks src/main.ts, moves on
		browser.handleInput(LEFT);
		browser.handleInput(DOWN);
		browser.handleInput(TAB); // "a file.md"
		browser.handleInput(ENTER); // cursor on b.txt
		expect(result.attached).toEqual(["src/main.ts", "a file.md", "b.txt"]);
	});

	it("marks the selected row with the accent bar, like /settings, not only with the band", () => {
		const { browser } = project();
		const plain = (line: string) => line.replace(/\x1b\[[0-9;:]*m/g, "");
		const rows = browser.render(40).map(plain);
		expect(rows.find((row) => row.includes("src/"))).toMatch(/^│▌/);
		expect(rows.find((row) => row.includes("b.txt"))).toMatch(/^│ /);
		browser.handleInput(DOWN);
		const moved = browser.render(40).map(plain);
		expect(moved.find((row) => row.includes("src/"))).toMatch(/^│ /);
		expect(moved.find((row) => row.includes("a file.md"))).toMatch(/^│▌/);
	});

	it("closes on Escape without adding anything", () => {
		const { browser, result } = project();
		browser.handleInput(ESC);
		expect(result).toEqual({ closed: true });
	});

	it.each(["b.txt", "src", "main.ts"])("selects %s on a first click and activates on a second", (name) => {
		const { browser, result } = project();
		if (name === "main.ts") browser.handleInput(ENTER);
		const lines = browser.render(40);
		const row = lines.findIndex((line) => line.includes(name));
		const click = clickAt(row);
		browser.handleMouse(click);
		expect(result.attached).toBeUndefined();
		if (name === "src") expect(browser.render(40).join("\n")).not.toContain("main.ts");
		browser.render(40);
		browser.handleMouse(click);
		if (name === "src") expect(browser.render(40).join("\n")).toContain("main.ts");
		else expect(result.attached).toEqual([name === "main.ts" ? "src/main.ts" : name]);
	});

	it.each(["header", "other entry", "keyboard", "wheel", "right click"])(
		"requires a new first click after %s",
		(interruption) => {
			const { browser, result } = project();
			const lines = browser.render(40);
			const row = lines.findIndex((line) => line.includes("b.txt"));
			const click = clickAt(row);
			browser.handleMouse(click);
			if (interruption === "keyboard") browser.handleInput(DOWN);
			else if (interruption === "wheel") browser.handleMouse({ ...click, type: "wheel", wheelDelta: 0 });
			else if (interruption === "right click") browser.handleMouse({ ...clickAt(0), button: "right" });
			else browser.handleMouse(clickAt(interruption === "header" ? 0 : row - 1));
			browser.render(40);
			browser.handleMouse(click);
			expect(result.attached).toBeUndefined();
			browser.handleMouse(click);
			expect(result.attached).toEqual(["b.txt"]);
		},
	);

	it("replaces controls in file names and the directory heading, but attaches the real path", () => {
		const folder = "src\x1b]52;c;ZGF0YQ==\x07\x9c";
		const name = "bad\x01\t\n\x7f\x80\x9f.txt";
		const { browser, result } = project(name, folder);
		expect(browser.render(100).join("\n")).toContain("src�]52;c;ZGF0YQ==��/");
		expect(browser.render(100).join("\n")).not.toContain("\x1b]52;");
		browser.handleInput(ENTER);
		const rendered = browser.render(100).join("\n");
		expect(rendered).toContain("src�]52;c;ZGF0YQ==��");
		expect(rendered).toContain("bad������.txt");
		expect(rendered).not.toContain("\x1b]52;");
		browser.handleInput(ENTER);
		expect(result.attached).toEqual([`${folder}/${name}`]);
	});

	it("quotes shell arguments literally, including command substitutions and apostrophes", () => {
		const paths = ["$(id).txt", "a'b.txt", "`id`.txt", "a file.md", "$HOME;echo injected", "a\nb"];
		expect(appendReferences("!cat", paths.slice(0, 2))).toBe("!cat '$(id).txt' 'a'\\''b.txt' ");
		expect(appendReferences("!cat", paths)).toBe(
			"!cat '$(id).txt' 'a'\\''b.txt' '`id`.txt' 'a file.md' '$HOME;echo injected' 'a\nb' ",
		);
		expect(appendReferences("look at", ["$(id).txt"])).toBe("look at @$(id).txt ");
	});

	it("appends references to the message, quoting paths with spaces", () => {
		expect(appendReferences("", ["a.ts"])).toBe("@a.ts ");
		expect(appendReferences("look at", ["a.ts", "a file.md"])).toBe('look at @a.ts @"a file.md" ');
		expect(appendReferences("x ", [])).toBe("x ");
	});

	it("changes the open overlay from a sidebar to full width and back on resize", async () => {
		const harness = await createHarness({ extensionFactories: [fileBrowser] });
		root = harness.tempDir;
		const terminal = new VirtualTerminal(100, 20);
		const tui = new TuiAltScreen(terminal);
		let handle: OverlayHandle | undefined;
		let component: Component | undefined;
		let command: Promise<void> | undefined;
		try {
			tui.start();
			await harness.session.bindExtensions({
				uiContext: createTestUiContext({
					custom: async <T>(
						factory: (
							tui: TUI,
							theme: Theme,
							keys: KeybindingsManager,
							done: (result: T) => void,
						) => Component | Promise<Component>,
						options?: Parameters<ExtensionUIContext["custom"]>[1],
					) =>
						new Promise<T>((resolve, reject) => {
							Promise.resolve(factory(tui, theme, new KeybindingsManager({}), resolve)).then((browser) => {
								component = browser;
								// The interactive UI resolves the factory only once, then retains the options object.
								const overlay =
									typeof options?.overlayOptions === "function"
										? options.overlayOptions()
										: options?.overlayOptions;
								handle = tui.showOverlay(browser, overlay);
							}, reject);
						}),
				}),
			});
			command = harness.session.prompt("/files");
			await vi.waitFor(() => expect(handle?.getBounds()?.width).toBe(35));
			terminal.resize(60, 20);
			await terminal.waitForRender();
			expect(handle?.getBounds()).toMatchObject({ col: 0, width: 60 });
			terminal.resize(120, 20);
			await terminal.waitForRender();
			expect(handle?.getBounds()).toMatchObject({ col: 78, width: 42 });
		} finally {
			component?.handleInput?.(ESC);
			await command;
			tui.stop();
			harness.cleanup();
		}
	});
});
