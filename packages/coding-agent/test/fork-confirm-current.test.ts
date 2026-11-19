/**
 * fork: a confirmation applies only to the state it showed. For each confirmation,
 * the state changes during the question: the question is asked again, and the state applied is the one the last
 * question showed.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME, ENV_AGENT_DIR, getAgentDir } from "../src/config.ts";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionUIContext,
} from "../src/core/extensions/types.ts";
import checkpoints from "../src/fork/checkpoints.ts";
import { CONFIRM_CURRENT_ROUNDS, confirmCurrent, StateChangedError } from "../src/fork/confirm-current.ts";
import { askMcpServer } from "../src/fork/mcp-add.ts";
import memoryExtension from "../src/fork/memory.ts";
import { PERMISSION_MODE_EVENT, type PermissionModeRequest } from "../src/fork/onboarding.ts";
import { sealPermState } from "../src/fork/perm-seal.ts";
import type { PermView } from "../src/fork/perm-view.ts";
import permissionsExtension from "../src/fork/permissions.ts";
import { ListEditor, type ListEntry } from "../src/fork/settings-list-editor.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

describe("fork: confirmCurrent", () => {
	it("asks again while the state changes, and gives up after three changes in a row", async () => {
		let state = { value: "a", version: "1" };
		const shown: string[] = [];
		const result = await confirmCurrent(
			(value) => {
				shown.push(value);
				if (shown.length === 1) state = { value: "b", version: "2" };
				return "yes";
			},
			() => state,
		);
		expect(shown).toEqual(["a", "b"]);
		expect(result).toEqual({ value: "b", answer: "yes" });

		let version = 0;
		const asked: number[] = [];
		await expect(
			confirmCurrent(
				(value: number) => {
					asked.push(value);
					return true;
				},
				() => ({ value: version, version: String(version++) }),
			),
		).rejects.toThrow(StateChangedError);
		expect(asked).toHaveLength(CONFIRM_CURRENT_ROUNDS);

		let reads = 0;
		const declined = await confirmCurrent(
			() => false,
			() => ({ value: reads, version: String(reads++) }),
		);
		expect(declined).toBeUndefined();
		expect(reads).toBe(1);
	});
});

describe("fork: /undo and /checkpoints apply the turns they showed", () => {
	let home: string;
	const saved = {
		agent: process.env[ENV_AGENT_DIR],
		home: process.env.HOME,
		keyring: process.env.PRISM_SECRET_SERVICE,
	};
	const harnesses: Harness[] = [];
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "prism-confirm-current-"));
		process.env.HOME = home;
		process.env[ENV_AGENT_DIR] = home;
		process.env.PRISM_SECRET_SERVICE = "off";
	});
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) {
			await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			harness.cleanup();
		}
		for (const [name, value] of [
			[ENV_AGENT_DIR, saved.agent],
			["HOME", saved.home],
			["PRISM_SECRET_SERVICE", saved.keyring],
		] as const) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		rmSync(home, { recursive: true, force: true });
	});

	async function engine(ui: Partial<ExtensionUIContext>) {
		const harness = await createHarness({ extensionFactories: [checkpoints] });
		harnesses.push(harness);
		const notices: string[] = [];
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({ notify: (message) => notices.push(message), ...ui }),
		});
		const write = async (path: string, content: string) => {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("write", { path, content }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("write the fixture");
		};
		const run = async (name: string, context?: (ctx: ExtensionCommandContext) => void) => {
			const runner = harness.session.extensionRunner;
			const ctx = runner.createCommandContext();
			context?.(ctx);
			await runner.getCommand(name)!.handler("", ctx);
		};
		return { harness, notices, write, run };
	}

	it("/undo asks again for a turn added during its question, and undoes only that turn", async () => {
		const questions: string[] = [];
		let during: (() => Promise<void>) | undefined;
		const { harness, write, run } = await engine({
			confirm: async (title) => {
				questions.push(title);
				const action = during;
				during = undefined;
				await action?.();
				return true;
			},
		});
		const old = join(harness.tempDir, "old.txt");
		const added = join(harness.tempDir, "added.txt");
		writeFileSync(old, "original");
		await write(old, "first");
		during = () => write(added, "added during the question");
		await run("undo");
		// Each prompt is two model turns: the write is in the first one.
		expect(questions).toEqual(["Undo turn 1?", "Undo turn 3?"]);
		expect(existsSync(added)).toBe(false);
		expect(readFileSync(old, "utf8")).toBe("first");
	});

	it("/undo refuses while a turn runs, and after three changes in a row", async () => {
		let confirms = 0;
		let grow: (() => Promise<void>) | undefined;
		const { harness, notices, write, run } = await engine({
			confirm: async () => {
				confirms++;
				await grow?.();
				return true;
			},
		});
		const file = join(harness.tempDir, "file.txt");
		writeFileSync(file, "original");
		await write(file, "first");
		await run("undo", (ctx) => Object.defineProperty(ctx, "isIdle", { value: () => false }));
		expect(confirms).toBe(0);
		expect(notices).toContain("Stop the current turn before restoring files.");
		expect(readFileSync(file, "utf8")).toBe("first");

		let count = 0;
		grow = () => write(join(harness.tempDir, `grow-${count++}.txt`), "x");
		await run("undo");
		expect(confirms).toBe(3);
		expect(notices.at(-1)).toMatch(/three times in a row/);
		expect(readFileSync(file, "utf8")).toBe("first");
		expect(existsSync(join(harness.tempDir, "grow-0.txt"))).toBe(true);
	});

	it("/checkpoints asks again when a turn is added during its question", async () => {
		const asked: string[][] = [];
		let during: (() => Promise<void>) | undefined;
		const { harness, write, run } = await engine({
			select: async (_title, options) => {
				asked.push(options);
				const action = during;
				during = undefined;
				await action?.();
				return options.find((option) => option.startsWith("turn 1 "));
			},
		});
		const old = join(harness.tempDir, "old.txt");
		const added = join(harness.tempDir, "added.txt");
		writeFileSync(old, "original");
		await write(old, "first");
		during = () => write(added, "added during the question");
		await run("checkpoints");
		expect(asked).toHaveLength(2);
		expect(asked[1]!.some((option) => option.startsWith("turn 3 "))).toBe(true);
		expect(readFileSync(old, "utf8")).toBe("original");
		expect(existsSync(added)).toBe(false);
	});
});

describe("fork: /mcp add replaces only what it asked about", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "prism-confirm-mcp-"));
		mkdirSync(join(root, "project", CONFIG_DIR_NAME), { recursive: true });
		mkdirSync(join(root, "agent"));
		vi.stubEnv(ENV_AGENT_DIR, join(root, "agent"));
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	const global = () => join(root, "agent", "mcp.json");
	const local = () => join(root, "project", CONFIG_DIR_NAME, "mcp.json");
	const docs = (url: string) => JSON.stringify({ mcpServers: { docs: { url } } });
	const globalUrl = () => JSON.parse(readFileSync(global(), "utf8")).mcpServers.docs.url as string;

	function add(confirm: (title: string) => Promise<boolean>) {
		const notes: string[] = [];
		const answers = [
			"A web address (URL)",
			"docs",
			"https://new.example/mcp",
			"No key: sign in in the browser if the server asks",
			"Every project",
		];
		const ctx = {
			cwd: join(root, "project"),
			isProjectTrusted: () => true,
			ui: {
				select: async () => answers.shift(),
				input: async () => answers.shift(),
				confirm,
				notify: (message: string) => void notes.push(message),
			},
		} as unknown as ExtensionContext;
		return { run: () => askMcpServer(ctx), notes };
	}

	it("asks before replacing a global server that a project server of the same name hides", async () => {
		writeFileSync(global(), docs("https://global.example/mcp"));
		writeFileSync(local(), docs("https://project.example/mcp"));
		const asked: string[] = [];
		const { run } = add(async (title) => {
			asked.push(title);
			return false;
		});
		expect(await run()).toBe(false);
		expect(asked).toEqual(["Replace this server?"]);
		expect(globalUrl()).toBe("https://global.example/mcp");
	});

	it("asks again when the entry changes during the question, and says the project's one is used here", async () => {
		writeFileSync(global(), docs("https://global.example/mcp"));
		writeFileSync(local(), docs("https://project.example/mcp"));
		let asked = 0;
		const { run, notes } = add(async () => {
			if (++asked === 1) writeFileSync(global(), docs("https://changed.example/mcp"));
			return true;
		});
		expect(await run()).toBe(true);
		expect(asked).toBe(2);
		expect(globalUrl()).toBe("https://new.example/mcp");
		expect(notes.at(-1)).toMatch(/also defines "docs"/);
	});
});

describe("fork: a list in /settings removes the entry its question showed", () => {
	const press = async (list: ListEditor, data: string) => {
		await list.handleInput(data);
		await new Promise<void>((resolve) => setImmediate(resolve));
	};
	const ENTER = "\r";
	const DOWN = "\x1b[B";
	function editor(entries: ListEntry[]) {
		const removed: ListEntry[] = [];
		const list = new ListEditor({
			title: "Rules",
			description: "",
			addPrompt: "Rule",
			entries: () => entries,
			onAdd: () => {},
			onRemove: (entry) => {
				removed.push(entry);
				entries.splice(entries.indexOf(entry), 1);
			},
			done: () => {},
			requestRender: () => {},
		});
		return { list, removed };
	}

	it("asks again where the entry moved to, and removes it, not the one now in its place", async () => {
		const entries: ListEntry[] = [
			{ text: "read", tag: "allow", key: "global" },
			{ text: "bash", tag: "deny", key: "global" },
		];
		const { list, removed } = editor(entries);
		await press(list, DOWN);
		await press(list, ENTER);
		entries.unshift({ text: "write", tag: "allow", key: "project" });
		await press(list, ENTER);
		expect(removed).toEqual([]);
		await press(list, ENTER);
		expect(removed.map((entry) => entry.text)).toEqual(["read"]);
	});

	it("removes nothing when the entry it showed changed", async () => {
		const entries: ListEntry[] = [{ text: "read", tag: "allow", key: "global" }];
		const { list, removed } = editor(entries);
		await press(list, DOWN);
		await press(list, ENTER);
		entries[0] = { text: "read", tag: "deny", key: "global" };
		await press(list, ENTER);
		await press(list, ENTER);
		expect(removed).toEqual([]);
	});
});

describe("fork: /perm revokes the permission it showed", () => {
	let root: string;
	const saved = { home: process.env.HOME, agent: process.env[ENV_AGENT_DIR] };
	const harnesses: Harness[] = [];
	beforeEach(() => {
		initTheme("dark");
		root = mkdtempSync(join(tmpdir(), "prism-confirm-perm-"));
		mkdirSync(join(root, "agent"));
		process.env.HOME = root;
		process.env[ENV_AGENT_DIR] = join(root, "agent");
	});
	afterEach(() => {
		vi.restoreAllMocks();
		for (const harness of harnesses.splice(0)) harness.cleanup();
		process.env.HOME = saved.home;
		if (saved.agent === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = saved.agent;
		rmSync(root, { recursive: true, force: true });
	});

	it("keeps the next permission when the selected one expired before Enter", async () => {
		const harness = await createHarness({
			extensionFactories: [{ name: "permissions", factory: permissionsExtension }],
		});
		harnesses.push(harness);
		const until = Date.now() + 60_000;
		// fork: sealed, as the state this Prism saved is.
		const kept = {
			mode: "ask",
			allow: ["read(kept.txt)"],
			deny: [],
			timed: [{ rule: "read(expiring.txt)", effect: "allow", until }],
		};
		harness.session.sessionManager.appendCustomEntry("perm-state", {
			...kept,
			seal: sealPermState(getAgentDir(), kept),
		});
		let view: PermView | undefined;
		let close!: () => void;
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				custom: (async (factory: (...args: unknown[]) => PermView) =>
					await new Promise<unknown>((resolve) => {
						close = () => resolve(undefined);
						view = factory(
							{ terminal: { rows: 60, columns: 100 }, requestRender: () => {} },
							undefined,
							undefined,
							(result: unknown) => resolve(result),
						);
					})) as ExtensionUIContext["custom"],
			}),
		});
		const runner = harness.session.extensionRunner;
		const opened = runner.getCommand("perm")!.handler("", runner.createCommandContext());
		await vi.waitFor(() => expect(view).toBeDefined());
		const shown = () =>
			view!
				.render(100)
				.join("\n")
				.replace(/\x1b\[[0-9;:]*m/g, "");
		expect(shown()).toMatch(/expiring\.txt[\s\S]*kept\.txt/);
		view!.handleInput("\x1b[B"); // the first permission in effect: expiring.txt
		vi.spyOn(Date, "now").mockReturnValue(until + 1);
		view!.handleInput("\r");
		expect(shown()).toContain("kept.txt");
		close();
		await opened;
	});
});

describe("fork: saved permission states", () => {
	let root: string;
	const saved = { home: process.env.HOME, agent: process.env[ENV_AGENT_DIR] };
	const harnesses: Harness[] = [];
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "prism-perm-state-"));
		mkdirSync(join(root, "agent"));
		process.env.HOME = root;
		process.env[ENV_AGENT_DIR] = join(root, "agent");
	});
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		process.env.HOME = saved.home;
		if (saved.agent === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = saved.agent;
		rmSync(root, { recursive: true, force: true });
	});

	it("keeps an earlier saved mode when the session changes mode afterwards", async () => {
		let events: ExtensionAPI["events"] | undefined;
		const harness = await createHarness({
			extensionFactories: [
				{ name: "permissions", factory: permissionsExtension },
				{
					name: "events",
					factory: (pi: ExtensionAPI) => {
						events = pi.events;
					},
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });
		const ctx = harness.session.extensionRunner.createContext();
		const change = async (mode: PermissionModeRequest["mode"]) => {
			const request: PermissionModeRequest = { mode, ctx };
			events?.emit(PERMISSION_MODE_EVENT, request);
			expect(await request.applied).toBe(true);
		};
		const modes = () =>
			harness.session.sessionManager
				.getBranch()
				.flatMap((entry) =>
					entry.type === "custom" && entry.customType === "perm-state"
						? [(entry.data as { mode: string }).mode]
						: [],
				);
		await change("broad");
		await change("ask");
		expect(modes().slice(-2)).toEqual(["broad", "ask"]);
	});
});

describe("fork: /memory-edit saves over the text it opened only", () => {
	let agentDir: string;
	const harnesses: Harness[] = [];
	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-confirm-memory-"));
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
	});
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		vi.unstubAllEnvs();
		rmSync(agentDir, { recursive: true, force: true });
	});
	const memory = () => join(agentDir, "MEMORY.md");

	async function edit(editor: (title: string, text: string | undefined) => Promise<string | undefined>) {
		const harness = await createHarness({ extensionFactories: [{ name: "memory", factory: memoryExtension }] });
		harnesses.push(harness);
		const notices: string[] = [];
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({ editor, notify: (message) => void notices.push(message) }),
		});
		await harness.session.prompt("/memory-edit");
		return notices;
	}

	it("opens the editor again with the user's text and what was saved meanwhile", async () => {
		writeFileSync(memory(), "# Memory\n");
		const prefills: Array<string | undefined> = [];
		const notices = await edit(async (_title, text) => {
			prefills.push(text);
			if (prefills.length === 1) {
				// Another editor saves first.
				writeFileSync(memory(), "# Memory\n\n- added by the other editor\n");
				return "# Memory\n\n- mine";
			}
			return "# Memory\n\n- mine\n- added by the other editor";
		});
		expect(prefills).toHaveLength(2);
		expect(prefills[1]).toMatch(
			/^# Memory\n\n- mine\n\n-+ Saved meanwhile[^\n]*\n# Memory\n\n- added by the other editor\n$/,
		);
		expect(readFileSync(memory(), "utf8")).toBe("# Memory\n\n- mine\n- added by the other editor\n");
		expect(notices.at(-1)).toBe("Global memory saved.");
	});

	it("writes nothing for a save without a change, and keeps the text aside after three changes", async () => {
		writeFileSync(memory(), "# Memory\n");
		let notices = await edit(async (_title, text) => {
			writeFileSync(memory(), "# Memory\n\n- newer\n");
			return text;
		});
		expect(readFileSync(memory(), "utf8")).toBe("# Memory\n\n- newer\n");
		expect(notices.at(-1)).toBe("Global memory unchanged.");

		let round = 0;
		notices = await edit(async () => {
			writeFileSync(memory(), `# Memory\n\n- other ${++round}\n`);
			return "# Memory\n\n- mine";
		});
		expect(round).toBe(3);
		expect(readFileSync(memory(), "utf8")).toBe("# Memory\n\n- other 3\n");
		const kept = readdirSync(agentDir).filter((name) => name.startsWith("MEMORY.md.edited-"));
		expect(kept).toHaveLength(1);
		expect(readFileSync(join(agentDir, kept[0]!), "utf8")).toBe("# Memory\n\n- mine\n");
		expect(notices.at(-1)).toMatch(/three times in a row.*Your text is in/);
	});
});
