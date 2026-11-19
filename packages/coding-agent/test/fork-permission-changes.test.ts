/**
 * fork: a permission change made while the gate waits applies to the call it
 * holds.
 * - a mode chosen while an earlier mode's sandbox was starting is the one kept.
 * - an answer given to a question still open when safe mode, or a blocking rule, came in allows nothing.
 * - a task scope ended during the npm check covers nothing: the call is asked about.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";
import { setLanguage } from "../src/fork/i18n/index.ts";
import permissionsExtension, { configurationMode, permissionsPanel } from "../src/fork/permissions.ts";
import { sessionSandbox } from "../src/fork/sandbox/runtime.ts";
import type { ScopeApproval, ScopeView } from "../src/fork/task-scope.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, createTestUiContext, getToolResult, type Harness } from "./suite/harness.ts";

type Starter = (...args: unknown[]) => unknown;

const holds = vi.hoisted(() => ({
	sandbox: undefined as (() => Promise<unknown>) | undefined,
	npm: undefined as (() => Promise<string | undefined>) | undefined,
}));

vi.mock("../src/fork/sandbox/runtime.ts", async (original) => {
	const actual = await original<Record<string, unknown>>();
	return {
		...actual,
		startSandbox: (...args: unknown[]) => holds.sandbox?.() ?? (actual.startSandbox as Starter)(...args),
	};
});
vi.mock("../src/fork/npm-guard.ts", async (original) => {
	const actual = await original<Record<string, unknown>>();
	return {
		...actual,
		npmInstallRefusal: (...args: unknown[]) => holds.npm?.() ?? (actual.npmInstallRefusal as Starter)(...args),
	};
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("fork: a permission change while the gate waits", () => {
	let agentDir: string;
	const harnesses: Harness[] = [];

	beforeAll(() => initTheme("dark"));
	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-permission-changes-"));
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		// These tests expect ask mode; without a configured mode Prism starts in broad.
		writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode: "ask" }));
		setLanguage("en");
	});
	afterEach(() => {
		holds.sandbox = undefined;
		holds.npm = undefined;
		for (const harness of harnesses.splice(0)) harness.cleanup();
		vi.unstubAllEnvs();
		rmSync(agentDir, { recursive: true, force: true });
	});

	/** A session in ask mode; `select` answers the gate's questions, `keys` are typed on a scope's approval. */
	async function start(
		options: { select?: (title: string, options: string[]) => Promise<string | undefined>; keys?: string[] } = {},
	) {
		const harness = await createHarness({
			extensionFactories: [{ name: "permissions", factory: permissionsExtension }],
		});
		harnesses.push(harness);
		const selects: string[] = [];
		const custom = (async (factory: (...args: unknown[]) => ScopeView) => {
			let result: ScopeApproval | undefined;
			const view = factory(
				{ terminal: { rows: 40, columns: 100 }, requestRender: () => {} },
				undefined,
				undefined,
				(value: ScopeApproval | undefined) => {
					result = value;
				},
			);
			for (const key of options.keys ?? []) view.handleInput(key);
			return result;
		}) as unknown as ExtensionUIContext["custom"];
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				custom,
				select: async (title, choices) => {
					selects.push(title);
					return await options.select?.(title, choices);
				},
			}),
		});
		const context = () => harness.session.extensionRunner.createContext();
		return { harness, selects, panel: () => permissionsPanel(context())!, context };
	}

	async function calls(harness: Harness, ...list: [string, Parameters<typeof fauxToolCall>[1]][]) {
		harness.setResponses([
			...list.map(([tool, input]) => fauxAssistantMessage(fauxToolCall(tool, input), { stopReason: "toolUse" })),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
	}

	const text = (harness: Harness, tool: string) => JSON.stringify(getToolResult(harness, tool).content);

	it("keeps the mode chosen while the previous one's sandbox was starting", async () => {
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ sandbox: { modes: { ask: false, safe: false, broad: true, unrestricted: false } } }),
		);
		const { panel, context } = await start();
		const started = deferred<unknown>();
		let starting = false;
		holds.sandbox = () => {
			starting = true;
			return started.promise;
		};
		const broad = panel().setMode("broad", false);
		await vi.waitFor(() => expect(starting).toBe(true));
		expect(await panel().setMode("safe", false)).toBe(true);
		// The broad sandbox is ready only now.
		started.resolve({ bwrap: "/unused", tmp: "/unused" });
		expect(await broad).toBe(false);
		expect(configurationMode(context())).toBe("safe");
		expect(sessionSandbox(context().sessionManager)).toBeUndefined();
	});

	it("refuses a call allowed in a question left open while safe mode was chosen", async () => {
		const run = await start({
			select: async () => {
				expect(await run.panel().setMode("safe", false)).toBe(true);
				return "Allow once";
			},
		});
		await calls(run.harness, ["write", { path: "note.txt", content: "x" }]);
		expect(run.selects).toHaveLength(1);
		expect(existsSync(join(run.harness.tempDir, "note.txt"))).toBe(false);
		expect(text(run.harness, "write")).toContain("the permission mode changed to safe while the question was open");
	});

	it("refuses a call allowed in a question left open while a rule blocking it was added", async () => {
		const run = await start({
			select: async () => {
				expect(
					await run.panel().rule({ action: "add", effect: "deny", rule: "write", where: "session" }),
				).toBeUndefined();
				return "Allow once";
			},
		});
		await calls(run.harness, ["write", { path: "note.txt", content: "x" }]);
		expect(existsSync(join(run.harness.tempDir, "note.txt"))).toBe(false);
		expect(getToolResult(run.harness, "write").isError).toBe(true);
	});

	it("asks about a command whose task scope ended during the npm check", async () => {
		const run = await start({
			keys: ["\x1b[B", "\x1b[B", "\x1b[B", "\r"],
			select: async () => "Block this action once",
		});
		const checked = deferred<string | undefined>();
		let checking = false;
		const command = "touch made.txt";
		holds.npm = () => {
			checking = true;
			return checked.promise;
		};
		// The scope covers the task it was proposed in.
		const task = calls(
			run.harness,
			["propose_scope", { operations: [{ what: "Make the file", commands: [command] }], minutes: 30 }],
			["bash", { command }],
		);
		await vi.waitFor(() => expect(checking).toBe(true));
		expect(text(run.harness, "propose_scope")).toContain("The user approved this scope");
		run.panel().endScope();
		checked.resolve(undefined);
		await task;
		expect(run.selects).toHaveLength(1);
		expect(existsSync(join(run.harness.tempDir, "made.txt"))).toBe(false);
	});
});
