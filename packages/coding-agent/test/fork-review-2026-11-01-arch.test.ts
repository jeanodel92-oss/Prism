// fork: architecture/performance findings of the 2026-11-01 review; synthetic data only.
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os, { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { TuiMainScreen } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { holdsCredentials } from "../src/fork/credential-paths.ts";
import { cacheFile, RACY_MS } from "../src/fork/file-cache.ts";
import { checkInstalls, lockedNames } from "../src/fork/npm-guard.ts";
import { within } from "../src/fork/path-within.ts";
import permissionsExtension, { decidePermission } from "../src/fork/permissions.ts";
import { fileExclusion } from "../src/fork/portable-export.ts";
import { createEditorFactory } from "../src/fork/prism/editor.ts";
import { editorState } from "../src/fork/prism/editor-state.ts";
import { createState } from "../src/fork/prism/lib/state.ts";
import { projectGrantsProblem, projectRoot, readProjectGrants } from "../src/fork/project-permissions.ts";
import { hooksQuestion } from "../src/fork/sandbox/git-hooks.ts";
import { opensWholeHome } from "../src/fork/sandbox/home-start.ts";
import {
	buildLayout,
	parseSandboxSettings,
	readEverythingThisRun,
	readSandboxSettings,
	SandboxSettingsError,
} from "../src/fork/sandbox/layout.ts";
import { checkNewRepositories, findRepositories } from "../src/fork/sandbox/nested-git.ts";
import type { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { WorkingStatusIndicator } from "../src/modes/interactive/components/status-indicator.ts";
import { getEditorTheme, initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, getToolResult, type Harness } from "./suite/harness.ts";

let root: string;
let agent: string;
const harnesses: Harness[] = [];
beforeEach(() => {
	root = fs.mkdtempSync(join(tmpdir(), "prism-arch-review-"));
	agent = join(root, ".pi", "agent");
	fs.mkdirSync(agent, { recursive: true });
	vi.stubEnv("HOME", root);
	vi.stubEnv(ENV_AGENT_DIR, agent);
	vi.stubEnv("GIT_CONFIG_GLOBAL", join(root, "gitconfig"));
	vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
	vi.stubEnv("XDG_CONFIG_HOME", join(root, ".config"));
	vi.spyOn(os, "networkInterfaces").mockReturnValue({});
	syncBuiltinESMExports();
});
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	vi.restoreAllMocks();
	syncBuiltinESMExports();
	readEverythingThisRun(false);
	vi.unstubAllEnvs();
	fs.rmSync(root, { recursive: true, force: true });
});

describe("L7", () => {
	it("does not treat manifest dependencies as locked", () => {
		fs.writeFileSync(join(root, "package.json"), '{"dependencies":{"recat":"*"}}');
		expect(lockedNames(root).has("recat")).toBe(false);
	});
	it.each(["npm install recat", "npm install"])("checks an unlocked manifest name with %s", async (command) => {
		fs.writeFileSync(join(root, "package.json"), '{"dependencies":{"recat":"*"}}');
		const fetch = vi.fn(async () => new Response("{}", { status: 404 }));
		const checked = await checkInstalls(command, { cwd: root, home: root, fetch, now: Date.now });
		expect(checked).toEqual([
			expect.objectContaining({ name: "recat", reasons: expect.arrayContaining([expect.stringContaining("404")]) }),
		]);
		expect(fetch).toHaveBeenCalledTimes(1);
	});
	it("fails closed on an invalid manifest and accepts legacy shrinkwrap dependency entries", async () => {
		fs.writeFileSync(join(root, "package.json"), "invalid");
		const fetch = vi.fn(async () => new Response("{}", { status: 404 }));
		const checked = await checkInstalls("npm install", { cwd: root, home: root, fetch, now: Date.now });
		expect(checked[0]?.reasons.join(" ")).toContain("could not be verified");
		expect(fetch).not.toHaveBeenCalled();
		fs.writeFileSync(join(root, "npm-shrinkwrap.json"), '{"dependencies":{"recat":{"version":"1.0.0"}}}');
		expect(lockedNames(root)).toEqual(new Set(["recat"]));
	});
	it.each(["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"])(
		"skips names locked in %s, but checks new aliases and all dependency fields",
		async (lock) => {
			fs.writeFileSync(
				join(root, "package.json"),
				JSON.stringify({
					dependencies: {
						react: "*",
						local: "file:../local",
						git: "github:org/repo",
						url: "https://example.test/a.tgz",
					},
					devDependencies: { recat: "*" },
					optionalDependencies: { alias: "npm:recat@1" },
					peerDependencies: { another: "*" },
				}),
			);
			fs.writeFileSync(
				join(root, lock),
				lock.endsWith(".json") ? '{"packages":{"node_modules/react":{}}}' : '"react@1":\n',
			);
			const fetch = vi.fn(async () => new Response("{}", { status: 404 }));
			const result = await checkInstalls("npm install", { cwd: root, home: root, fetch, now: Date.now });
			expect(result.map(({ name }) => name).sort()).toEqual(["another", "recat"]);
			expect(fetch).toHaveBeenCalledTimes(2);
		},
	);
	it("refuses a manifest-only install in a faux broad session without contacting the network", async () => {
		fs.writeFileSync(join(agent, "permissions.json"), '{"mode":"broad"}');
		fs.writeFileSync(
			join(agent, "settings.json"),
			JSON.stringify({ sandbox: { modes: { broad: false }, network: { deny: ["registry.npmjs.org"] } } }),
		);
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "fake install" }], details: {} }));
		const harness = await createHarness({
			extensionFactories: [
				{ name: "permissions", factory: permissionsExtension },
				{
					name: "fake-shell",
					factory: (pi) =>
						pi.registerTool({
							name: "bash",
							label: "bash",
							description: "Synthetic shell, never installs anything",
							parameters: Type.Object({ command: Type.String() }),
							execute,
						}),
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		fs.writeFileSync(join(harness.tempDir, "package.json"), "{}");
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("write", { path: "package.json", content: '{"dependencies":{"recat":"*"}}' }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("bash", { command: "npm install" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		expect(fs.readFileSync(join(harness.tempDir, "package.json"), "utf8")).toContain("recat");
		expect(JSON.stringify(getToolResult(harness, "bash"))).toContain("npm install blocked");
		expect(execute).not.toHaveBeenCalled();
	});
});

describe("A5", () => {
	it("keeps home-start root/equality handling and its legacy dot-dot name exclusion", () => {
		const home = join(root, "..home");
		fs.mkdirSync(home);
		vi.stubEnv("HOME", home);
		expect(opensWholeHome("/")).toBe(true);
		expect(opensWholeHome(home)).toBe(true);
		expect(opensWholeHome(root)).toBe(false);
	});
	it("keeps C1's root search protection and equal credential paths", () => {
		const secret = join(root, ".ssh");
		expect(holdsCredentials("/", [secret])).toBe(true);
		expect(holdsCredentials(secret, [secret])).toBe(true);
	});
	it.each([
		["/", "/", true],
		["/tmp", "/", true],
		["/a", "/a", true],
		["/a/b", "/a", true],
		["/ab", "/a", false],
		["/a", "/a/b", false],
		["/a/b", "/a/", true],
	])("contains %s in %s: %s", (path, folder, expected) => expect(within(path, folder)).toBe(expected));
	it("keeps legacy root semantics at export and hooks call sites, with equal paths unchanged", () => {
		vi.spyOn(fs, "readdirSync").mockImplementationOnce((path) => {
			expect(String(path)).toBe("/");
			return [];
		});
		syncBuiltinESMExports();
		expect(fileExclusion("tmp/file", "/")).toBe("outside the project folder");
		expect(fileExclusion(".", root)).toBe("outside the project folder");
		expect(hooksQuestion(join(root, ".git"), { before: undefined, after: "/" }, [root], false)).toMatchObject({
			folder: "/",
		});
		expect(hooksQuestion(join(root, ".git"), { before: undefined, after: root }, [root], false)).toContain(
			"holds folders",
		);
	});
});

describe("A9", () => {
	it("checks real upstream editor fields, render and mouse mapping at narrow and wide widths", () => {
		initTheme("prism");
		const state = createState();
		state.theme = theme;
		const tui = new TuiMainScreen(new VirtualTerminal());
		const editor = createEditorFactory(state)(tui, getEditorTheme(), new KeybindingsManager({}));
		editor.setText("one\ntwo\nthree");
		for (const width of [40, 120]) {
			expect(editor.render(width).length).toBeGreaterThan(3);
			expect(editorState(editor).renderedVisibleLineCount).toBe(3);
		}
		expect(
			editor.handleMouse?.({
				type: "click",
				button: "left",
				shift: false,
				alt: false,
				ctrl: false,
				x: 5,
				y: 0,
				screenX: 5,
				screenY: 0,
				width: 40,
				height: 8,
			}),
		).toMatchObject({ handled: true, focus: true });
		const indicator = new WorkingStatusIndicator(tui, "Working");
		try {
			(editor as CustomEditor).setWorkingStatusIndicator(indicator);
			expect(editorState(editor).workingStatusIndicator?.message).toBe("Working");
			expect(editor.render(40).join("\n")).toContain("Working");
		} finally {
			indicator.dispose();
			(editor as CustomEditor).setWorkingStatusIndicator(undefined);
		}
		for (const key of ["renderedVisibleLineCount", "scrollOffset", "workingStatusIndicator"]) {
			const fields = { ...editor };
			Reflect.deleteProperty(fields, key);
			expect(() => editorState(fields)).toThrow(new RegExp(key));
		}
	});
	it("rejects NaN and an indicator whose private message disappeared", () => {
		const fields = { renderedVisibleLineCount: 1, scrollOffset: 0, workingStatusIndicator: undefined };
		expect(editorState(fields)).toBe(fields);
		expect(() => editorState({ ...fields, scrollOffset: Number.NaN })).toThrow(/scrollOffset/);
		expect(() =>
			editorState({ ...fields, workingStatusIndicator: { kind: "working", renderInBorder: () => "" } }),
		).toThrow(/workingStatusIndicator/);
	});
});

describe("O1", () => {
	// fork: a file changed in the last RACY_MS is read again, never served from
	// the cache; this moves the clock past that, for the reads of an unchanged file. Edits come after the real
	// time is back, so they are read again whatever the kernel's timestamp precision.
	const ageFiles = () => vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + RACY_MS + 1_000 });
	afterEach(() => {
		vi.useRealTimers();
	});
	it("keeps last-valid settings scoped to the original agent-directory spelling", () => {
		const file = join(agent, "settings.json");
		fs.writeFileSync(file, '{"sandbox":{"network":{"deny":["blocked.test"]}}}');
		readSandboxSettings(agent);
		fs.writeFileSync(file, "invalid");
		expect(() => readSandboxSettings(`${agent}/`)).toThrow(SandboxSettingsError);
		expect(readSandboxSettings(agent).network.deny).toEqual(["blocked.test"]);
		fs.writeFileSync(file, "{}");
		readSandboxSettings(agent);
		readSandboxSettings(`${agent}/`);
		fs.writeFileSync(file, "invalid");
		expect(readSandboxSettings(`${agent}/`).network.deny).toEqual([]);
	});
	it("does not cache an unsuccessful inspection with unchanged metadata", () => {
		const file = join(root, "data");
		fs.writeFileSync(file, "unchanged");
		ageFiles();
		const read = vi.fn(() => ({ problem: "temporarily unreadable" as string | undefined }));
		const cached = cacheFile(read, (value) => value.problem === undefined);
		expect(cached(file).problem).toBeDefined();
		read.mockReturnValue({ problem: undefined });
		expect(cached(file).problem).toBeUndefined();
		cached(file);
		expect(read).toHaveBeenCalledTimes(2);
	});
	it("caches unchanged files, sees edits and replacements, and never shares mutable JSON", () => {
		const file = join(root, "data.json");
		const read = vi.fn((path: string): { value: string } => JSON.parse(fs.readFileSync(path, "utf8")));
		const cached = cacheFile(read);
		fs.writeFileSync(file, '{"value":"a"}');
		const timestamp = new Date(1_700_000_000_000);
		fs.utimesSync(file, timestamp, timestamp);
		ageFiles();
		cached(file).value = "caller change";
		expect(cached(file)).toEqual({ value: "a" });
		expect(read).toHaveBeenCalledTimes(1);
		vi.useRealTimers();
		fs.writeFileSync(file, '{"value":"b"}');
		expect(cached(file)).toEqual({ value: "b" });
		fs.writeFileSync(`${file}.next`, '{"value":"c"}');
		fs.utimesSync(`${file}.next`, timestamp, timestamp);
		fs.renameSync(`${file}.next`, file);
		expect(cached(file)).toEqual({ value: "c" });
		fs.writeFileSync(file, "invalid");
		expect(() => cached(file)).toThrow();
		expect(() => cached(file)).toThrow();
		fs.rmSync(file);
		expect(() => cached(file)).toThrow();
		fs.writeFileSync(file, '{"value":"d"}');
		expect(cached(file)).toEqual({ value: "d" });
	});
	it("reads each unchanged permissions/settings/grants file once and sees the next edit", () => {
		const permissions = join(agent, "permissions.json");
		const settings = join(agent, "settings.json");
		const grants = join(agent, "project-permissions.json");
		fs.writeFileSync(permissions, "{}");
		fs.writeFileSync(settings, "{}");
		fs.writeFileSync(grants, "{}");
		ageFiles();
		const read = vi.spyOn(fs, "readFileSync");
		syncBuiltinESMExports();
		const decision = () => decidePermission("bash", { command: "echo hello" }, root, { mode: "broad" });
		expect(decision().effect).toBe("allow");
		expect(decision().effect).toBe("allow");
		readSandboxSettings();
		readSandboxSettings();
		for (const file of [permissions, settings, grants])
			expect(read.mock.calls.filter(([path]) => path === file)).toHaveLength(1);
		vi.useRealTimers();
		fs.writeFileSync(permissions, '{"deny":["bash(echo *)"]}');
		expect(decision().effect).toBe("block");
		fs.writeFileSync(permissions, "invalid");
		expect(decision().reason).toContain("Denied by rule");
		fs.writeFileSync(permissions, "{}");
		fs.writeFileSync(grants, JSON.stringify({ projects: { [projectRoot(root)]: { deny: ["bash(echo *)"] } } }));
		expect(decision().reason).toContain("Denied by rule");
		fs.writeFileSync(grants, "invalid");
		expect(decision().reason).toContain("Denied by rule");
		expect(readProjectGrants(root).deny).toEqual(["bash(echo *)"]);
		fs.writeFileSync(settings, '{"sandbox":{"network":{"deny":["blocked.test"]}}}');
		expect(readSandboxSettings().network.deny).toEqual(["blocked.test"]);
		fs.writeFileSync(settings, "invalid");
		expect(readSandboxSettings().network.deny).toEqual(["blocked.test"]);
		readEverythingThisRun();
		expect(readSandboxSettings().read.limit).toBe("all");
	});
	it("still fails closed and reports invalid files with no last valid version", () => {
		fs.writeFileSync(join(agent, "permissions.json"), '{"deny":[42]}');
		const decision = () => decidePermission("bash", { command: "echo hello" }, root, { mode: "broad" });
		expect(decision()).toEqual(
			expect.objectContaining({ effect: "block", reason: expect.stringContaining("not a valid permissions file") }),
		);
		expect(decision().effect).toBe("block");
		fs.writeFileSync(join(agent, "project-permissions.json"), "invalid");
		expect(projectGrantsProblem()).toContain("not a valid project permissions file");
		fs.writeFileSync(join(agent, "settings.json"), "invalid");
		expect(() => readSandboxSettings()).toThrow(SandboxSettingsError);
		expect(() => readSandboxSettings()).toThrow(SandboxSettingsError);
		fs.rmSync(join(agent, "permissions.json"));
		fs.rmSync(join(agent, "project-permissions.json"));
		fs.rmSync(join(agent, "settings.json"));
		expect(decision().effect).toBe("allow");
		expect(readSandboxSettings().network.deny).toEqual([]);
	});
});

describe("O5", () => {
	it("must protect existing node_modules repositories and report newly planted hooks", () => {
		// Only Git's read-only config parser is stubbed; the repository walk and mounts use the real fixture.
		const exec = childProcess.execFileSync;
		vi.spyOn(childProcess, "execFileSync").mockImplementation(((file, args, options) => {
			if (file === "git" && args?.includes("config")) return "";
			return exec(file, args, options);
		}) as typeof childProcess.execFileSync);
		syncBuiltinESMExports();
		const dependency = join(root, "node_modules", "dependency");
		const git = join(dependency, ".git");
		fs.mkdirSync(join(git, "hooks"), { recursive: true });
		fs.mkdirSync(join(git, "objects"));
		fs.mkdirSync(join(git, "refs"));
		fs.writeFileSync(join(git, "HEAD"), "ref: refs/heads/main\n");
		fs.writeFileSync(join(git, "config"), "[core]\nrepositoryformatversion = 0\nbare = false\n");
		const layout = buildLayout({
			cwd: root,
			home: root,
			agentDir: agent,
			settings: parseSandboxSettings({ read: { limit: "all" } }),
			env: {},
			prism: [],
		});
		expect(layout.blocked).toBeUndefined();
		expect(layout.readOnly).toContain(join(git, "hooks"));
		expect(findRepositories([root]).repositories).toContain(dependency);
		const planted = join(root, "node_modules", "planted");
		fs.mkdirSync(join(planted, ".git", "hooks"), { recursive: true });
		fs.writeFileSync(join(planted, ".git", "hooks", "pre-commit"), "synthetic hook");
		expect(checkNewRepositories(layout.repositories!)?.note).toContain(join(planted, ".git", "hooks", "pre-commit"));
	});
});
