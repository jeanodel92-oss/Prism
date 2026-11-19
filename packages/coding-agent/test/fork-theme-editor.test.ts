// fork: /settings > Appearance > Customize theme edits a copy of the active theme, previews each
// colour as it is typed and saves the copy as JSON in the agent's themes/ folder.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { colorToHex } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { type EditableTheme, settingWith, ThemeEditor, themeCopy, themeFromJson } from "../src/fork/theme-editor.ts";
import { initTheme, type Theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const ENTER = "\r";
const ESC = "\x1b";
const DOWN = "\x1b[B";
const BACKSPACE = "\x7f";

let agentDir: string;
const saved = process.env[ENV_AGENT_DIR];

function host(setting = "prism-light/prism") {
	const calls = {
		previews: [] as Theme[],
		applied: [] as string[],
		restored: 0,
		setting,
	};
	return {
		calls,
		host: {
			setting: () => calls.setting,
			preview: (theme: Theme) => calls.previews.push(theme),
			apply: (next: string) => {
				calls.applied.push(next);
				calls.setting = next;
			},
			restore: () => {
				calls.restored++;
			},
		},
	};
}

function type(editor: ThemeEditor, text: string): void {
	for (const char of text) editor.handleInput(char);
}

/** Clears the field (it opens on the current value). */
function clear(editor: ThemeEditor): void {
	for (let i = 0; i < 40; i++) editor.handleInput(BACKSPACE);
}

/** The full token editor remains available behind the tenth, closed-by-default row. */
function advanced(editor: ThemeEditor): void {
	for (let i = 0; i < 9; i++) editor.handleInput(DOWN);
	editor.handleInput(ENTER);
}

describe("fork: theme editor", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-theme-editor-"));
		process.env[ENV_AGENT_DIR] = agentDir;
	});
	afterEach(() => {
		if (saved === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = saved;
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("copies a built-in theme under a free name in themes/, without writing it yet", () => {
		const copy = themeCopy("prism");
		expect(copy.name).toBe("prism-custom");
		expect(copy.path).toBe(join(agentDir, "themes", "prism-custom.json"));
		expect(copy.saved).toBe(false);
		expect(copy.json.vars?.ink).toBeDefined();
		expect(copy.json.colors.text).toBe("ink");
		expect(existsSync(copy.path)).toBe(false);

		mkdirSync(join(agentDir, "themes"));
		writeFileSync(copy.path, JSON.stringify({ ...copy.json, name: "prism-custom" }));
		expect(themeCopy("prism").name).toBe("prism-custom-2");
	});

	it("edits a theme of themes/ in place", () => {
		mkdirSync(join(agentDir, "themes"));
		const file = join(agentDir, "themes", "mine.json");
		writeFileSync(file, JSON.stringify({ ...themeCopy("prism").json, name: "mine" }));
		const copy = themeCopy("mine");
		expect(copy).toMatchObject({ name: "mine", path: file, saved: true });
	});

	it("copies the system theme, which has no file, as its current colours", () => {
		const copy = themeCopy("system");
		expect(copy.name).toBe("system-custom");
		expect(copy.json.vars).toBeUndefined();
		expect(copy.json.colors.text).toMatch(/^#[0-9a-f]{6}$/);
		expect(() => themeFromJson(copy.json)).not.toThrow();
	});

	it("keeps an automatic setting following the terminal, with the copy on the active side", () => {
		expect(settingWith("prism-light/prism", "prism", "prism-custom")).toBe("prism-light/prism-custom");
		expect(settingWith("prism-light/prism", "prism-light", "prism-light-custom")).toBe("prism-light-custom/prism");
		expect(settingWith("dark", "dark", "dark-custom")).toBe("dark-custom");
	});

	it("refuses a value that is not a colour or names no palette entry", () => {
		const json = themeCopy("prism").json;
		expect(() => themeFromJson({ ...json, vars: { ...json.vars, ink: "#zzzzzz" } })).toThrow();
		expect(() => themeFromJson({ ...json, colors: { ...json.colors, text: "nowhere" } })).toThrow();
		expect(colorToHex(themeFromJson({ ...json, vars: { ...json.vars, ink: "#ff0000" } }).colors.text)).toBe(
			"#ff0000",
		);
	});

	it("keeps the copy another session saved under the same name first", () => {
		const { calls, host: editorHost } = host();
		const editor = new ThemeEditor({ host: editorHost, active: "prism", requestRender: () => {}, done: () => {} });
		// Another session opened the editor at the same time and saved first.
		const other = join(agentDir, "themes", "prism-custom.json");
		mkdirSync(join(agentDir, "themes"), { recursive: true });
		writeFileSync(other, "the other session's copy\n");
		advanced(editor);
		editor.handleInput(ENTER);
		clear(editor);
		type(editor, "#ff0000");
		editor.handleInput(ENTER);
		expect(readFileSync(other, "utf8")).toBe("the other session's copy\n");
		const written = JSON.parse(
			readFileSync(join(agentDir, "themes", "prism-custom-2.json"), "utf8"),
		) as EditableTheme;
		expect(written.name).toBe("prism-custom-2");
		expect(calls.applied).toEqual(["prism-light/prism-custom-2"]);
	});

	it("previews as it is typed, saves on Enter, and makes the copy the theme in use", () => {
		const { calls, host: editorHost } = host();
		const done = vi.fn();
		const editor = new ThemeEditor({ host: editorHost, active: "prism", requestRender: () => {}, done });
		advanced(editor);
		const text = editor
			.render(60)
			.map((line) => stripAnsi(line).trim())
			.join(" ");
		expect(text).toContain("A copy of prism, saved as themes/prism-custom.json at the first change.");
		expect(text).toContain("ink");

		// The first row is the palette's "ink": every colour that names it follows.
		editor.handleInput(ENTER);
		clear(editor);
		type(editor, "#ff0");
		expect(colorToHex(calls.previews.at(-1)!.colors.text)).toBe("#ffff00");
		const shown = calls.previews.length;
		type(editor, "0");
		// "#ff00" is not a colour: nothing new is shown, and the field says so.
		expect(calls.previews).toHaveLength(shown);
		expect(stripAnsi(editor.render(60).join("\n"))).toContain("Not a colour yet.");
		type(editor, "00");
		const preview = calls.previews.at(-1)!;
		expect(colorToHex(preview.colors.text)).toBe("#ff0000");
		expect(existsSync(join(agentDir, "themes", "prism-custom.json"))).toBe(false);

		editor.handleInput(ENTER);
		const file = join(agentDir, "themes", "prism-custom.json");
		const written = JSON.parse(readFileSync(file, "utf8")) as EditableTheme;
		expect(written.name).toBe("prism-custom");
		expect(written.vars?.ink).toBe("#ff0000");
		expect(calls.applied).toEqual(["prism-light/prism-custom"]);
		expect(stripAnsi(editor.render(60).join("\n"))).toContain("Saved with low contrast: 2.85:1");

		// A second change saves in place and reloads the saved theme instead of changing the setting.
		editor.handleInput(DOWN);
		editor.handleInput(ENTER);
		clear(editor);
		type(editor, "#00ff00");
		editor.handleInput(ENTER);
		expect((JSON.parse(readFileSync(file, "utf8")) as EditableTheme).vars?.ink2).toBe("#00ff00");
		expect(calls.applied).toHaveLength(1);
		expect(calls.restored).toBe(1);

		editor.handleInput(ESC);
		editor.handleInput(ESC); // Advanced returns to the core list first.
		expect(calls.restored).toBe(2);
		expect(done).toHaveBeenCalled();
	});

	it("goes back to the saved colours with Esc, and saves nothing", () => {
		const { calls, host: editorHost } = host();
		const editor = new ThemeEditor({ host: editorHost, active: "prism", requestRender: () => {}, done: () => {} });
		advanced(editor);
		editor.handleInput(ENTER);
		clear(editor);
		type(editor, "#123456");
		editor.handleInput(ESC);
		expect(colorToHex(calls.previews.at(-1)!.colors.text)).not.toBe("#123456");
		expect(existsSync(join(agentDir, "themes"))).toBe(false);
		expect(calls.applied).toEqual([]);
		// Still open: Esc closed the field only.
		expect(stripAnsi(editor.render(60).join("\n"))).toContain("Customize theme");
	});

	it("saves nothing on Enter while the value is not a colour, and keeps the field open", () => {
		const { calls, host: editorHost } = host();
		const editor = new ThemeEditor({ host: editorHost, active: "prism", requestRender: () => {}, done: () => {} });
		advanced(editor);
		editor.handleInput(ENTER);
		clear(editor);
		type(editor, "#ff00");
		editor.handleInput(ENTER);
		expect(existsSync(join(agentDir, "themes"))).toBe(false);
		expect(calls.applied).toEqual([]);
		expect(stripAnsi(editor.render(60).join("\n"))).toContain("> #ff00");
	});

	it("names a palette entry, a 256-colour index, or the terminal's own colour", () => {
		const { host: editorHost } = host();
		const editor = new ThemeEditor({ host: editorHost, active: "prism", requestRender: () => {}, done: () => {} });
		advanced(editor);
		const rows = themeCopy("prism").json;
		const firstColour = Object.keys(rows.vars ?? {}).length; // the rows: the palette, then the colours
		for (let i = 0; i < firstColour; i++) editor.handleInput(DOWN);
		editor.handleInput(ENTER); // accent
		clear(editor);
		type(editor, "ink2");
		editor.handleInput(ENTER);
		const file = join(agentDir, "themes", "prism-custom.json");
		expect((JSON.parse(readFileSync(file, "utf8")) as EditableTheme).colors.accent).toBe("ink2");
		editor.handleInput(ENTER);
		clear(editor);
		type(editor, "196");
		editor.handleInput(ENTER);
		expect((JSON.parse(readFileSync(file, "utf8")) as EditableTheme).colors.accent).toBe(196);
		editor.handleInput(ENTER);
		clear(editor);
		editor.handleInput(ENTER);
		expect((JSON.parse(readFileSync(file, "utf8")) as EditableTheme).colors.accent).toBe("");
		expect(stripAnsi(editor.render(60).join("\n"))).toContain("terminal's own");
	});

	it("fits a narrow window", () => {
		const { host: editorHost } = host();
		const editor = new ThemeEditor({ host: editorHost, active: "prism", requestRender: () => {}, done: () => {} });
		for (const width of [30, 48, 64]) {
			for (const line of editor.render(width)) expect(stripAnsi(line).length).toBeLessThanOrEqual(width);
		}
	});
});
