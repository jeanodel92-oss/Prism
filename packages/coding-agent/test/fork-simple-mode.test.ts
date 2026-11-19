// fork: the simple interface shows one line per action, in plain words; ctrl+o or a click
// shows the call and its output. Owner's QA report on 1.0.0-fork.6: every command and every output showed in
// full in the simple interface.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TuiMainScreen } from "../../tui/src/tui-main-screen.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import { setLanguage } from "../src/fork/i18n/index.ts";
import { createState } from "../src/fork/prism/lib/state.ts";
import { commandPrograms, plainAction } from "../src/fork/prism/plain-action.ts";
import { transcriptHooks } from "../src/fork/prism/transcript.ts";
import { setRenderHooks, type ToolExecutionView } from "../src/fork/render-hooks.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const plain = (line: string) => stripAnsi(line);

function bashView(overrides: Partial<ToolExecutionView> = {}): ToolExecutionView {
	return {
		toolName: "bash",
		isPartial: false,
		isError: false,
		expanded: false,
		args: { command: "CI=1 npm test" },
		shell: "renderer",
		renderSelf: () => [],
		renderParts: () => ["$ CI=1 npm test", "", "ok 12 tests", "", "Took 1.2s"],
		renderText: () => [],
		imageCount: 0,
		renderImages: () => [],
		...overrides,
	};
}

describe("fork: a real simple interface", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "prism-simple-mode-"));
	beforeAll(() => initTheme("prism"));
	afterEach(() => {
		setRenderHooks({});
		setLanguage("en");
	});
	afterAll(() => rmSync(agentDir, { recursive: true, force: true }));

	const render = (view: ToolExecutionView, mode: "simple" | "advanced", width = 60) => {
		const state = createState();
		state.theme = theme;
		state.animates = () => false;
		state.interfaceMode = () => mode;
		return transcriptHooks(state).toolExecution!(view, width)!.map(plain);
	};

	it("describes the built-in actions in plain words", () => {
		expect(plainAction("read", { path: "src/a.ts" })).toBe("Read file src/a.ts");
		expect(plainAction("edit", { path: "a.ts", edits: [] })).toBe("Edit file a.ts");
		expect(plainAction("write", { path: "notes.md", content: "x" })).toBe("Write file notes.md");
		expect(plainAction("bash", { command: "CI=1 /usr/bin/npm test" })).toBe("Run a command (npm)");
		expect(plainAction("grep", { pattern: "TODO" })).toBe("Search for “TODO” in .");
		expect(plainAction("find", { pattern: "*.ts", path: "src" })).toBe("Find files *.ts in src");
		expect(plainAction("ls", {})).toBe("List folder .");
		// Arguments still streaming in: no path yet.
		expect(plainAction("read", {})).toBe("Read a file");
		expect(plainAction("bash", { command: "" })).toBe("Run a command");
		// Other tools keep their own header line.
		expect(plainAction("web_search", { query: "x" })).toBeUndefined();
		expect(commandPrograms("FOO=1 BAR=2 ./build.sh --fast")).toEqual(["build.sh"]);
	});

	it("says them in French", () => {
		setLanguage("fr");
		expect(plainAction("read", { path: "a.ts" })).toBe("Lecture de a.ts");
		expect(plainAction("bash", { command: "ls -la" })).toBe("Commande lancée (ls)");
		expect(plainAction("grep", { pattern: "TODO", path: "src" })).toBe("Recherche de « TODO » dans src");
		expect(plainAction("ls", {})).toBe("Contenu du dossier .");
	});

	it("folds each action to one plain line in simple, successes and failures alike", () => {
		const simple = render(bashView(), "simple");
		expect(simple).toHaveLength(2);
		expect(simple[1]).toMatch(/^● \S Run a command \(npm\) +1\.2s$/);
		expect(simple.join("\n")).not.toContain("ok 12 tests");

		const failed = bashView({
			isError: true,
			renderParts: () => ["$ CI=1 npm test", "", "boom", "", "Command exited with code 2", "", "Took 1.2s"],
		});
		const folded = render(failed, "simple");
		expect(folded).toHaveLength(2);
		expect(folded[1]).toMatch(/^● \S Run a command \(npm\) failed \(code 2\) +1\.2s$/);

		// An add-on's tool keeps its own header, folded too.
		const other = render(
			bashView({ toolName: "web_search", args: {}, renderParts: () => ["search x", "", "r"] }),
			"simple",
		);
		expect(other).toHaveLength(2);
		expect(other[1]).toContain("search x");
	});

	// a successful action has no state or duration to make room for, so
	// its plain line was never cut; a long path overflowed the terminal and the renderer stopped.
	it("keeps a folded action with a long path or pattern within the width", () => {
		const deep = `src/${"very-long-folder-name/".repeat(6)}file.ts`;
		const views = [
			bashView({ toolName: "read", args: { path: deep }, renderParts: () => [`read ${deep}`] }),
			bashView({ toolName: "grep", args: { pattern: "x".repeat(80) }, renderParts: () => ["grep"] }),
			bashView({ toolName: "find", args: { pattern: "*.ts", path: deep }, renderParts: () => ["find"] }),
		];
		for (const width of [60, 40, 20]) {
			for (const view of views) {
				const lines = render(view, "simple", width);
				expect(lines).toHaveLength(2);
				for (const line of lines) expect(line.length).toBeLessThanOrEqual(width);
				expect(lines[1]).toMatch(/…$/);
			}
		}
	});

	it("shows the command and the output when expanded, and always in advanced", () => {
		const expanded = render(bashView({ expanded: true }), "simple");
		expect(expanded[1]).toMatch(/^● \S \$ CI=1 npm test +1\.2s$/);
		expect(expanded.join("\n")).toContain("ok 12 tests");
		const advanced = render(bashView(), "advanced");
		expect(advanced[1]).toMatch(/^● \S \$ CI=1 npm test +1\.2s$/);
		expect(advanced.join("\n")).toContain("ok 12 tests");
	});

	it("shows or hides the details of one action on a click, through the render hook", () => {
		const state = createState();
		state.theme = theme;
		state.animates = () => false;
		setRenderHooks(transcriptHooks(state));
		const ui = new TuiMainScreen(new VirtualTerminal(80, 24));
		const component = new ToolExecutionComponent(
			"bash",
			"call-1",
			{ command: "echo hello" },
			{ showImages: false },
			createBashToolDefinition(agentDir),
			ui,
			agentDir,
		);
		component.updateResult({ content: [{ type: "text", text: "hello from the shell" }], isError: false });
		const text = () => component.render(80).map(plain).join("\n");
		expect(text()).toContain("Run a command (echo)");
		expect(text()).not.toContain("hello from the shell");

		const lines = component.render(80);
		const click: TuiMouseEvent = {
			type: "click",
			button: "left",
			x: 4,
			y: 1,
			screenX: 4,
			screenY: 11,
			width: 80,
			height: lines.length,
			shift: false,
			alt: false,
			ctrl: false,
			clickCount: 1,
		};
		expect(component.handleMouse(click)?.handled).toBe(true);
		expect(text()).toContain("hello from the shell");
		expect(text()).toContain("echo hello");
		component.handleMouse({ ...click, height: component.render(80).length });
		expect(text()).not.toContain("hello from the shell");
		// Below the block: not ours.
		expect(component.handleMouse({ ...click, y: 40 })).toBeUndefined();
	});
});
