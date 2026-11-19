// fork: the "Produced" tab of /files lists the files a session wrote, edited or created by a
// command, with their state, and acts on them without running them.
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { previewDocument } from "../src/fork/document-preview.ts";
import fileBrowser, { exportFile, FileBrowser, openRefusal, type ProducedAction } from "../src/fork/file-browser.ts";
import { setLanguage } from "../src/fork/i18n/index.ts";
import {
	changedBetween,
	PRODUCED_ENTRY,
	type ProducedFile,
	producedFiles,
	producedState,
} from "../src/fork/produced-files.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ENTER = "\r";
const ESC = "\x1b";
const ALT_E = "\x1be";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

describe("fork: produced files", () => {
	const dirs: string[] = [];
	const harnesses: Harness[] = [];
	beforeAll(() => {
		initTheme("prism");
		setKeybindings(new KeybindingsManager({}));
	});
	afterEach(() => {
		setLanguage("en");
		for (const harness of harnesses.splice(0)) harness.cleanup();
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});
	const temp = () => {
		const dir = mkdtempSync(join(tmpdir(), "prism-produced-"));
		dirs.push(dir);
		return dir;
	};

	async function session(options: { repo?: boolean } = {}) {
		const harness = await createHarness({ extensionFactories: [fileBrowser] });
		harnesses.push(harness);
		if (options.repo) {
			git(harness.tempDir, "init", "-q");
			git(
				harness.tempDir,
				"-c",
				"user.email=t@t",
				"-c",
				"user.name=t",
				"commit",
				"-q",
				"--allow-empty",
				"-m",
				"init",
			);
		}
		// The tracker looks for the repository when the session starts, here.
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });
		return harness;
	}

	const recorded = (harness: Harness) => producedFiles(harness.sessionManager.getBranch());

	it("records files written and edited by the model, newest first, and leaves failed calls out", async () => {
		const harness = await session();
		const cwd = harness.tempDir;
		writeFileSync(join(cwd, "untouched.md"), "a");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "notes.md", content: "# Notes\n" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				[fauxToolCall("edit", { path: "notes.md", edits: [{ oldText: "Notes", newText: "Todo" }] })],
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage(
				[fauxToolCall("edit", { path: "untouched.md", edits: [{ oldText: "not there", newText: "b" }] })],
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage([fauxToolCall("write", { path: "report.txt", content: "done" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		const files = recorded(harness);
		expect(files.map((file) => [file.path, file.source])).toEqual([
			[join(cwd, "report.txt"), "write"],
			[join(cwd, "notes.md"), "edit"],
		]);
		// Stored as custom entries: the model never sees them.
		expect(
			harness.sessionManager
				.getBranch()
				.some((entry) => entry.type === "custom" && entry.customType === PRODUCED_ENTRY),
		).toBe(true);
		expect(JSON.stringify(harness.session.messages)).not.toContain(PRODUCED_ENTRY);
	});

	it("records the file an edit wrote through a final link, by its real path", async () => {
		const harness = await session();
		const cwd = harness.tempDir;
		writeFileSync(join(cwd, "real.md"), "one");
		symlinkSync(join(cwd, "real.md"), join(cwd, "notes.md"));
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("edit", { path: "notes.md", edits: [{ oldText: "one", newText: "two" }] })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		const files = recorded(harness);
		expect(files.map((file) => file.path)).toEqual([realpathSync(join(cwd, "real.md"))]);
		expect(producedState(files[0]!)).toBe("present");
	});

	it("says when a produced file changed since or is gone", () => {
		const dir = temp();
		const path = join(dir, "out.txt");
		writeFileSync(path, "one");
		const { size, mtimeMs } = statSync(path);
		const file: ProducedFile = { path, source: "write", at: 1, size, mtimeMs };
		expect(producedState(file)).toBe("present");
		writeFileSync(path, "three");
		expect(producedState(file)).toBe("changed");
		unlinkSync(path);
		expect(producedState(file)).toBe("absent");
	});

	it("finds the files a command created or changed in a git repository", async () => {
		const harness = await session({ repo: true });
		const cwd = harness.tempDir;
		writeFileSync(join(cwd, "draft.txt"), "before");
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("bash", {
						command: "mkdir -p out && echo hi > out/made.txt && echo after, longer > draft.txt",
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo unrelated" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		const files = recorded(harness);
		expect(
			files
				.filter((file) => file.source === "bash")
				.map((file) => file.path)
				.sort(),
		).toEqual([join(cwd, "draft.txt"), join(cwd, "out", "made.txt")].sort());
	});

	it("knows the state before a command even when git answers after the command ended", async () => {
		const harness = await session({ repo: true });
		const cwd = harness.tempDir;
		writeFileSync(join(cwd, "draft.txt"), "before");
		// A git that answers slower than the command runs, as under load.
		const bin = temp();
		const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
		writeFileSync(join(bin, "git"), `#!/bin/sh\nsleep 0.5\nexec '${realGit}' "$@"\n`);
		chmodSync(join(bin, "git"), 0o755);
		const path = process.env.PATH;
		process.env.PATH = `${bin}:${path}`;
		try {
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("bash", { command: "echo after > draft.txt" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("go");
		} finally {
			process.env.PATH = path;
		}
		expect(recorded(harness).map((file) => file.path)).toEqual([join(cwd, "draft.txt")]);
	});

	it("lists the full output of a truncated command, readable in the viewer", async () => {
		const harness = await session();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "seq 1 6000" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		const output = recorded(harness).find((file) => file.source === "output");
		expect(output).toBeDefined();
		const preview = await previewDocument(output!.path);
		expect(preview.kind).toBe("text");
		expect(preview.text?.trim().split("\n")).toHaveLength(6000);
	});

	it("never runs the repository's fsmonitor program when it looks for changes", async () => {
		const harness = await session({ repo: true });
		const cwd = harness.tempDir;
		const marker = join(temp(), "fsmonitor-ran");
		git(cwd, "config", "core.fsmonitor", `touch ${marker}; false`);
		// The same git without the override does run it: the check below is meaningful.
		execFileSync("git", ["status", "--porcelain"], { cwd, stdio: "ignore" });
		expect(existsSync(marker)).toBe(true);
		rmSync(marker);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo x > made.txt" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		expect(recorded(harness).map((file) => file.path)).toEqual([join(cwd, "made.txt")]);
		expect(existsSync(marker)).toBe(false);
	});

	it("compares snapshots by state, size and time, and skips deleted files", () => {
		const before = new Map([
			["/r/a", " M 3 1"],
			["/r/b", "?? 1 1"],
		]);
		const after = new Map([
			["/r/a", " M 4 2"],
			["/r/b", "?? 1 1"],
			["/r/c", "?? 2 3"],
			["/r/d", " D -"],
		]);
		expect(changedBetween(before, after)).toEqual(["/r/a", "/r/c"]);
	});

	function browserWith(files: ProducedFile[], root: string) {
		const actions: [ProducedAction, string][] = [];
		const browser = new FileBrowser({
			root,
			height: () => 16,
			onAttach: () => {},
			onAction: (action, file) => actions.push([action, file.path]),
			onClose: () => {},
			requestRender: () => {},
			produced: () => files,
		});
		return { browser, actions };
	}

	it("shows the Produced tab with each file's state, at narrow and wide widths", () => {
		const root = temp();
		writeFileSync(join(root, "kept.md"), "x");
		const files: ProducedFile[] = [
			{ path: join(root, "gone.csv"), source: "bash", at: 3 },
			{ path: join(root, "kept.md"), source: "write", at: 2 },
		];
		const { browser } = browserWith(files, root);
		browser.handleInput(ALT_E);
		for (const width of [40, 64, 100]) {
			const lines = browser.render(width);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			const text = stripAnsi(lines.join("\n"));
			expect(text).toContain("gone.csv");
			expect(text).toContain("no longer there");
			expect(text).toContain("kept.md");
		}
		// Back to the project with the same key.
		browser.handleInput(ALT_E);
		expect(stripAnsi(browser.render(64).join("\n"))).toContain("kept.md");
		expect(stripAnsi(browser.render(64).join("\n"))).not.toContain("no longer there");
	});

	it("offers actions on a produced file; a missing file only lets you copy its path", () => {
		const root = temp();
		writeFileSync(join(root, "kept.md"), "x");
		const files: ProducedFile[] = [
			{ path: join(root, "gone.csv"), source: "bash", at: 3 },
			{ path: join(root, "kept.md"), source: "write", at: 2 },
		];
		const { browser, actions } = browserWith(files, root);
		browser.handleInput(ALT_E);
		browser.handleInput(ENTER); // gone.csv: the menu opens on "Copy the path"
		browser.handleInput(ENTER);
		expect(actions).toEqual([["copy", join(root, "gone.csv")]]);
		browser.handleInput(UP); // up to "Add to message", unavailable
		browser.handleInput(ENTER);
		expect(actions).toHaveLength(1);
		browser.handleInput(ESC); // back to the list, not closed
		browser.handleInput(DOWN);
		browser.handleInput(ENTER); // kept.md, menu on "Read in Prism"
		expect(stripAnsi(browser.render(64).join("\n"))).toContain("Read in Prism");
		browser.handleInput(ENTER);
		expect(actions[1]).toEqual(["view", join(root, "kept.md")]);
	});

	it("translates the tab and states in French", () => {
		setLanguage("fr");
		const root = temp();
		const { browser } = browserWith([{ path: join(root, "gone.csv"), source: "output", at: 1 }], root);
		browser.handleInput(ALT_E);
		const text = stripAnsi(browser.render(64).join("\n"));
		expect(text).toContain("Produits");
		expect(text).toContain("absent");
		expect(text).toContain("sortie de commande");
	});

	it("refuses to open programs, scripts and launchers with the system's application", () => {
		const dir = temp();
		const at = (name: string, content: string, mode = 0o644) => {
			const path = join(dir, name);
			writeFileSync(path, content);
			chmodSync(path, mode);
			return path;
		};
		expect(openRefusal(at("report.pdf", "%PDF-1.4"))).toBeUndefined();
		expect(openRefusal(at("notes.txt", "plain"))).toBeUndefined();
		expect(openRefusal(at("tool", "binary", 0o755))).toContain("Executable");
		expect(openRefusal(at("app.desktop", "[Desktop Entry]"))).toContain("Scripts");
		expect(openRefusal(at("setup.sh", "echo"))).toContain("Scripts");
		expect(openRefusal(at("readme", "#!/bin/sh\necho"))).toContain("Scripts");
		// Review L9, owner's decision 2026-11-05: by content when the name says nothing; web pages show as code.
		expect(openRefusal(at("launcher", "\n[Desktop Entry]\nExec=sh -c x"))).toContain("Scripts");
		expect(openRefusal(at("page.html", "<p>hi</p>"))).toContain("Prism shows their code");
		expect(openRefusal(at("Page.SVG", "<svg/>"))).toContain("Prism shows their code");
		expect(openRefusal(at("index", "\uFEFF  <!DOCTYPE html><script>x()</script>"))).toContain(
			"Prism shows their code",
		);
		expect(openRefusal(at("data.xml", "<?xml version='1.0'?><a/>"))).toBeUndefined();
		expect(openRefusal(at("notes.md", "<html> is a tag"))).toBeUndefined();
		expect(openRefusal(join(dir, "nothing"))).toContain("no longer");
		expect(openRefusal(dir)).toContain("regular");
		try {
			execFileSync("mkfifo", [join(dir, "pipe")]);
		} catch {
			return;
		}
		expect(openRefusal(join(dir, "pipe"))).toContain("regular");
	});

	it("copies a file to a folder without replacing what is there", () => {
		const dir = temp();
		const target = temp();
		const path = join(dir, "result.csv");
		writeFileSync(path, "a,b");
		expect(exportFile(path, target)).toEqual({ copy: join(target, "result.csv") });
		expect(readFileSync(join(target, "result.csv"), "utf8")).toBe("a,b");
		writeFileSync(path, "changed");
		expect(exportFile(path, target)).toEqual({ problem: "A file with this name is already there." });
		expect(readFileSync(join(target, "result.csv"), "utf8")).toBe("a,b");
		expect(exportFile(path, join(target, "missing"))).toEqual({ problem: "This folder does not exist." });
	});
});
