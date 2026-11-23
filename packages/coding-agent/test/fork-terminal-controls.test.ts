// fork: no control
// byte from external content reaches the terminal; only the sequences Prism builds itself do. One hostile string goes
// through every output that shows external text, and the bytes produced are checked. Nothing is sent to a terminal.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	CURSOR_MARKER,
	encodeKitty,
	hyperlink,
	Image,
	Input,
	ProcessTerminal,
	resetCapabilitiesCache,
	sanitizeTerminalLabel,
	setCapabilities,
	setKeybindings,
	type TUI,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TRUSTED_LINK_ID } from "../../tui/src/utils.ts";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SessionEntry, SessionInfo, SessionTreeNode } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createFindToolDefinition } from "../src/core/tools/find.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import { shortenPath } from "../src/core/tools/render-utils.ts";
import { formatDoctorReport, renderDoctorLines } from "../src/fork/doctor.ts";
import { NoticeText } from "../src/fork/notice-text.ts";
import notify from "../src/fork/notify.ts";
import { createEditorFactory } from "../src/fork/prism/editor.ts";
import { createFooterFactory } from "../src/fork/prism/footer.ts";
import { createHeaderFactory } from "../src/fork/prism/header.ts";
import { createState } from "../src/fork/prism/lib/state.ts";
import { noticeHooks } from "../src/fork/prism/notices.ts";
import { transcriptHooks } from "../src/fork/prism/transcript.ts";
import { setRenderHooks } from "../src/fork/render-hooks.ts";
import { reportGitCopies } from "../src/fork/sandbox/git-orphans.ts";
import { formatSessionState } from "../src/fork/session-state.ts";
import { ConfigSelectorComponent } from "../src/modes/interactive/components/config-selector.ts";
import { FooterComponent } from "../src/modes/interactive/components/footer.ts";
import { LoginDialogComponent } from "../src/modes/interactive/components/login-dialog.ts";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { TreeSelectorComponent } from "../src/modes/interactive/components/tree-selector.ts";
import { UserMessageSelectorComponent } from "../src/modes/interactive/components/user-message-selector.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { runPrintMode } from "../src/modes/print-mode.ts";
import { loadVendored } from "./fork-vendored-module.ts";

const OSC52 = "\x1b]52;c;Y2xpcA==\x07";
/** Visible letters between the attacks: clipboard write, clear screen, title, DCS, 8-bit CSI, BEL, CR and BS. */
const HOSTILE = `A${OSC52}B\x1b[2J\x1b]0;pwned\x07C\x1bP1$r\x1b\\D\x9b31mE\x07\r\bF`;

/** The sequences an output may emit itself: SGR styling, the links this process creates, the cursor marker. */
function leftovers(out: string): string {
	return out
		.replaceAll(CURSOR_MARKER, "")
		.replaceAll(new RegExp(`\\x1b\\]8;id=${TRUSTED_LINK_ID};[^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)`, "g"), "")
		.replaceAll(/\x1b\]8;;(?:\x07|\x1b\\)/g, "")
		.replaceAll(/\x1b\[[0-9;:]*m/g, "");
}

/**
 * `"marked"`: the output shows each control as a `<U+XXXX>` token instead of dropping the
 * sequence, so its inert payload stays readable.
 */
function expectClean(out: string, visible: boolean | "marked" = true): void {
	const rest = leftovers(out);
	expect(rest).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
	if (visible === "marked") {
		expect(rest).toContain("A<U+001B>]52;c;");
		expect(rest).toContain("<U+001B>]0;pwned<U+0007>");
		return;
	}
	expect(rest).not.toContain("pwned");
	expect(rest).not.toContain("Y2xpcA");
	if (visible) expect(rest).toContain("A");
}

/** The payloads of an OSC writer's envelopes; anything outside them fails. */
function payloads(writes: string[], envelope: RegExp): string {
	return writes
		.map((write) => {
			const match = envelope.exec(write);
			expect(match, JSON.stringify(write)).not.toBeNull();
			expect(match![1]).not.toContain("\x1b");
			return match![1]!;
		})
		.join("\n");
}

function captureStdout(): { writes: string[]; restore: () => void } {
	const writes: string[] = [];
	const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
		writes.push(String(chunk));
		const done = rest.find((arg) => typeof arg === "function") as (() => void) | undefined;
		done?.();
		return true;
	}) as typeof process.stdout.write);
	return { writes, restore: () => spy.mockRestore() };
}

async function withTty<T>(tty: boolean, run: () => Promise<T>): Promise<T> {
	const saved = process.stdout.isTTY;
	process.stdout.isTTY = tty;
	try {
		return await run();
	} finally {
		process.stdout.isTTY = saved;
	}
}

let root: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "prism-terminal-controls-"));
	vi.stubEnv(ENV_AGENT_DIR, join(root, "agent"));
	initTheme("prism");
	setKeybindings(new KeybindingsManager());
});

afterEach(() => {
	setRenderHooks({});
	resetCapabilitiesCache();
	vi.useRealTimers();
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

async function notifyFallback(kitty: boolean, commands = [HOSTILE]): Promise<string> {
	const handlers = new Map<string, (event: unknown) => unknown>();
	notify({ on: (name: string, handler: (event: unknown) => unknown) => handlers.set(name, handler) } as never);
	const empty = mkdtempSync(join(root, "path-"));
	vi.stubEnv("PATH", empty);
	if (kitty) vi.stubEnv("KITTY_WINDOW_ID", "1");
	else vi.stubEnv("KITTY_WINDOW_ID", undefined as unknown as string);
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	const { writes, restore } = captureStdout();
	try {
		return await withTty(true, async () => {
			for (const [i, command] of commands.entries())
				await handlers.get("tool_call")!({ toolName: "bash", toolCallId: `c${i}`, input: { command } });
			vi.advanceTimersByTime(15_000);
			for (let i = 0; i < 500 && !writes.some((write) => write.startsWith("\x1b]")); i++)
				await new Promise((resolve) => setImmediate(resolve));
			const sent = writes.filter((write) => write.startsWith("\x1b]"));
			expect(sent.length).toBeGreaterThan(0);
			return payloads(
				sent,
				kitty ? /^\x1b\]99;i=1:(?:d=0|p=body);([\s\S]*)\x1b\\$/ : /^\x1b\]777;notify;([\s\S]*)\x07$/,
			);
		});
	} finally {
		restore();
		vi.unstubAllEnvs();
		vi.stubEnv(ENV_AGENT_DIR, join(root, "agent"));
	}
}

function prismState(mode: "simple" | "advanced" = "simple") {
	const state = createState();
	state.theme = theme;
	state.interfaceMode = () => mode;
	state.animates = () => false;
	const assistant = {
		role: "assistant",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
	};
	state.ctx = {
		cwd: `/w/${HOSTILE}`,
		isProjectTrusted: () => true,
		model: { id: HOSTILE, provider: HOSTILE, reasoning: false, contextWindow: 100_000 },
		modelRegistry: { isUsingOAuth: () => false },
		getContextUsage: () => ({ tokens: 10, contextWindow: 100_000, percent: 0 }),
		sessionManager: {
			getEntries: () => [{ type: "message", message: assistant }],
			getSessionId: () => "s",
			getLeafId: () => "l",
			getCwd: () => `/w/${HOSTILE}`,
			getSessionName: () => HOSTILE,
		},
	} as never;
	return state;
}

function toolLines(mode: "vanilla" | "simple" | "advanced"): string {
	const state = prismState(mode === "advanced" ? "advanced" : "simple");
	if (mode !== "vanilla") setRenderHooks(transcriptHooks(state));
	const tui = new TuiMainScreen(new VirtualTerminal());
	const calls: Array<[string, Record<string, unknown>, ConstructorParameters<typeof ToolExecutionComponent>[4]]> = [
		["read", { path: HOSTILE }, createReadToolDefinition("/w")],
		["find", { pattern: HOSTILE, path: HOSTILE }, createFindToolDefinition("/w")],
		["bash", { command: HOSTILE }, createBashToolDefinition("/w")],
	];
	const out: string[] = [];
	for (const [name, args, definition] of calls) {
		const component = new ToolExecutionComponent(name, "id", args, {}, definition, tui, "/w");
		out.push(...component.render(100));
		component.updateResult({ content: [{ type: "text", text: HOSTILE }], isError: true }, false);
		out.push(...component.render(100));
	}
	return out.join("\n");
}

function assistantEntry(id: string, parentId: string | null, content: AssistantMessage["content"]): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message: {
			role: "assistant",
			content,
			api: "anthropic-messages",
			provider: "p",
			model: "m",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		},
	};
}

function treeLines(): string {
	const entries: SessionEntry[] = [
		{
			type: "message",
			id: "u1",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: { role: "user", content: HOSTILE, timestamp: Date.now() },
		},
		assistantEntry("a1", "u1", [{ type: "text", text: HOSTILE }]),
		assistantEntry("a2", "a1", [{ type: "toolCall", id: "tc", name: "read", arguments: { path: HOSTILE } }]),
		{
			type: "message",
			id: "r1",
			parentId: "a2",
			timestamp: new Date().toISOString(),
			message: {
				role: "toolResult",
				toolCallId: "tc",
				toolName: HOSTILE,
				content: [{ type: "text", text: HOSTILE }],
				isError: false,
				timestamp: Date.now(),
			},
		},
		{
			type: "branch_summary",
			id: "b1",
			parentId: "r1",
			timestamp: new Date().toISOString(),
			fromId: "u1",
			summary: HOSTILE,
		} as SessionEntry,
		{
			type: "custom_message",
			id: "c1",
			parentId: "b1",
			timestamp: new Date().toISOString(),
			customType: HOSTILE,
			content: HOSTILE,
			display: true,
		} as SessionEntry,
	];
	const nodes = new Map<string, SessionTreeNode>(entries.map((entry) => [entry.id, { entry, children: [] }]));
	for (const entry of entries) if (entry.parentId) nodes.get(entry.parentId)!.children.push(nodes.get(entry.id)!);
	nodes.get("a1")!.label = HOSTILE;
	const selector = new TreeSelectorComponent(
		[nodes.get("u1")!],
		"c1",
		40,
		() => {},
		() => {},
	);
	const list = selector.getTreeList() as unknown as { filterMode: string; render(width: number): string[] };
	list.filterMode = "all";
	return list.render(200).join("\n");
}

async function sessionListLines(): Promise<string> {
	const session: SessionInfo = {
		path: `/s/${HOSTILE}.jsonl`,
		id: "a",
		cwd: `/p/${HOSTILE}`,
		name: HOSTILE,
		created: new Date(0),
		modified: new Date(0),
		messageCount: 1,
		firstMessage: HOSTILE,
		allMessagesText: HOSTILE,
	};
	const selector = new SessionSelectorComponent(
		async () => [session],
		async () => [session],
		() => {},
		() => {},
		() => {},
		() => {},
		{ keybindings: new KeybindingsManager() },
	);
	await new Promise((resolve) => setImmediate(resolve));
	const list = selector.getSessionList();
	list.setSessions([session], true);
	(list as unknown as { showPath: boolean }).showPath = true;
	return list.render(400).join("\n");
}

async function printMode(tty: boolean): Promise<string> {
	const message = {
		role: "assistant",
		content: [{ type: "text", text: HOSTILE }],
		stopReason: "stop",
	} as unknown as AssistantMessage;
	const session = {
		sessionManager: { getHeader: () => undefined },
		agent: { waitForIdle: async () => {}, subscribe: vi.fn(() => () => {}) },
		state: { messages: [message] },
		extensionRunner: { hasHandlers: () => false, emit: vi.fn(async () => {}) },
		bindExtensions: vi.fn(async () => {}),
		subscribe: vi.fn(() => () => {}),
		prompt: vi.fn(async () => {}),
		reload: vi.fn(async () => {}),
	};
	const host = {
		session,
		newSession: vi.fn(),
		fork: vi.fn(),
		switchSession: vi.fn(),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	};
	const { writes, restore } = captureStdout();
	try {
		await withTty(tty, () => runPrintMode(host as unknown as Parameters<typeof runPrintMode>[0], { mode: "text" }));
	} finally {
		restore();
	}
	return writes.join("");
}

function footerLines(): string {
	const session = {
		state: {
			model: { id: HOSTILE, provider: HOSTILE, contextWindow: 200_000, reasoning: false },
			thinkingLevel: "off",
		},
		sessionManager: {
			getEntries: () => [],
			getEntryCount: () => 0,
			getSessionId: () => "s",
			getLeafId: () => null,
			getSessionName: () => HOSTILE,
			getCwd: () => `/p/${HOSTILE}`,
		},
		getContextUsage: () => ({ contextWindow: 200_000, percent: 1 }),
		routedModel: { model: { id: HOSTILE } },
		modelRuntime: { isUsingSubscription: () => false },
	} as unknown as AgentSession;
	const data: ReadonlyFooterDataProvider = {
		getGitBranch: () => HOSTILE,
		getExtensionStatuses: () => new Map([["x", HOSTILE]]),
		getAvailableProviderCount: () => 2,
		onBranchChange: () => () => {},
	};
	return new FooterComponent(session, data).render(400).join("\n");
}

function prismFooterLines(width = 400, cwd?: string): string {
	const state = prismState();
	if (cwd) (state.ctx as unknown as { sessionManager: { getCwd: () => string } }).sessionManager.getCwd = () => cwd;
	const data = {
		getGitBranch: () => HOSTILE,
		getExtensionStatuses: () => new Map([["x", HOSTILE]]),
		onBranchChange: () => () => {},
	};
	return createFooterFactory(state)({ requestRender() {} }, theme, data)
		.render(width)
		.join("\n");
}

function configLines(): string {
	const resource = (path: string) => ({
		path,
		enabled: false,
		metadata: { source: HOSTILE, scope: "user" as const, origin: "package" as const },
	});
	const empty = { extensions: [], skills: [], prompts: [], themes: [] };
	const selector = new ConfigSelectorComponent(
		{ global: { ...empty, extensions: [resource(`/x/${HOSTILE}/${HOSTILE}.ts`)] }, project: empty },
		SettingsManager.inMemory(),
		"/w",
		join(root, "agent"),
		() => {},
		() => {},
		() => {},
		40,
	);
	return selector.render(400).join("\n");
}

type Row = [name: string, output: () => string | Promise<string>, visible?: boolean | "marked"];

const rows: Row[] = [
	["CR-022 notification fallback (OSC 777)", () => notifyFallback(false)],
	["CR-022 notification fallback (OSC 99, kitty)", () => notifyFallback(true)],
	[
		"CR-025 orphan Git copy report",
		() => {
			const folder = mkdtempSync(join(root, "copies-"));
			const copy = join(folder, "c1");
			mkdirSync(join(copy, "metadata"), { recursive: true });
			const origin = {
				gitDir: `/r/${HOSTILE}`,
				cwd: "/r",
				command: HOSTILE,
				task: false,
				created: new Date().toISOString(),
				prism: { pid: process.pid, start: "not-this-process" },
			};
			writeFileSync(join(copy, "origin.json"), JSON.stringify(origin));
			const lines = reportGitCopies(folder);
			expect(lines.length).toBeGreaterThan(0);
			return lines.join("\n");
		},
	],
	[
		"CR-037 terminal title (setTitle)",
		() => {
			const { writes, restore } = captureStdout();
			try {
				new ProcessTerminal().setTitle(`Prism - ${HOSTILE}`);
			} finally {
				restore();
			}
			return payloads(writes, /^\x1b\]0;([\s\S]*)\x07$/);
		},
	],
	[
		"CR-038 Input after a paste",
		() => {
			const input = new Input();
			input.handleInput(`\x1b[200~${HOSTILE}\x1b[201~`);
			return input.render(200).join("\n");
		},
	],
	[
		"CR-038 Input given a value",
		() => {
			const input = new Input();
			input.focused = true;
			input.setValue(HOSTILE);
			return input.render(200).join("\n");
		},
	],
	[
		"CR-079 Prism composer info row (model id)",
		() =>
			(
				createEditorFactory(prismState())(
					new TuiMainScreen(new VirtualTerminal()),
					defaultEditorTheme,
					new KeybindingsManager({}),
				) as unknown as { render(width: number): string[] }
			)
				.render(200)
				.join("\n"),
	],
	[
		"CR-079 Prism header (model id, cwd)",
		() =>
			createHeaderFactory(
				prismState(),
				false,
			)({ requestRender: () => {} })
				.render(200)
				.join("\n"),
	],
	["CR-098 tool call and error, original interface", () => toolLines("vanilla")],
	["CR-098 tool call and error, Prism simple (folded action)", () => toolLines("simple"), "marked"],
	["CR-098 tool call and error, Prism advanced", () => toolLines("advanced")],
	[
		"CR-098 notice, original interface",
		() => new NoticeText("error", HOSTILE, () => `Error: ${HOSTILE}`).render(80).join("\n"),
	],
	[
		"CR-098 notice, Prism",
		() => {
			setRenderHooks(noticeHooks(prismState()));
			return new NoticeText("error", HOSTILE, () => `Error: ${HOSTILE}`).render(80).join("\n");
		},
	],
	["CR-156 print mode to a terminal", () => printMode(true)],
	["CR-160 session list (cwd, path, name)", () => sessionListLines()],
	[
		"CR-162 encodeKitty with data that is not base64",
		() => encodeKitty(HOSTILE).replaceAll(/\x1b_G[^;\x1b]*;[A-Za-z0-9+/=]*\x1b\\/g, ""),
		false,
	],
	[
		"CR-162 Image with data that is not base64",
		() => {
			setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
			return new Image(HOSTILE, "image/png", { fallbackColor: (text) => text }, {}, { widthPx: 10, heightPx: 10 })
				.render(80)
				.join("\n")
				.replaceAll(/\x1b_G[^;\x1b]*;[A-Za-z0-9+/=]*\x1b\\/g, "");
		},
		false,
	],
	["CR-163 /tree", () => treeLines()],
	[
		"CR-163 /fork message list",
		() =>
			new UserMessageSelectorComponent(
				[{ id: "u", text: HOSTILE }],
				() => {},
				() => {},
			)
				.render(200)
				.join("\n"),
	],
	[
		"CR-163 /context numbered lines (vendored)",
		async () => {
			const { buildNumberedLines } = await loadVendored<{
				buildNumberedLines: (text: string, th: typeof theme) => string[];
			}>(new URL("../vendor/forks/pi-context-inspector/src/index.ts", import.meta.url).pathname);
			return buildNumberedLines(`x\n${HOSTILE}`, theme).join("\n");
		},
	],
	[
		"CR-163 questionnaire options (vendored)",
		async () => {
			const { normalizeQuestionParams } = await loadVendored<{
				normalizeQuestionParams: (params: unknown) => { questions: Array<Record<string, unknown>> };
			}>(new URL("../vendor/forks/rpiv-ask-user-question/tool/normalize-params.ts", import.meta.url).pathname);
			const option = { label: HOSTILE, description: HOSTILE };
			const [question] = normalizeQuestionParams({
				questions: [{ question: HOSTILE, header: HOSTILE, options: [option, option] }],
			}).questions;
			return JSON.stringify(question, null, 1)
				.replaceAll("\\u001b", "\x1b")
				.replace(/\\u00([0-9a-f]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
		},
	],
	[
		"CR-163 /doctor details",
		() =>
			renderDoctorLines(
				formatDoctorReport(
					{
						createdAt: "now",
						checks: [
							{
								component: HOSTILE,
								status: "problem",
								observed: HOSTILE,
								cause: HOSTILE,
								action: HOSTILE,
								detail: HOSTILE,
							},
						],
					},
					true,
				),
				400,
			).join("\n"),
	],
	[
		"CR-163 session state (interrupted call name)",
		() =>
			formatSessionState(
				[assistantEntry("a", null, [{ type: "toolCall", id: "t", name: HOSTILE, arguments: {} }])],
				[],
				400,
			).join("\n"),
	],
	["CR-163 prism config resource list", () => configLines()],
	["CR-163 footer, original interface", () => footerLines()],
	["CR-163 footer, Prism", () => prismFooterLines()],
	["hyperlink() with a hostile address", () => hyperlink("A", `https://x/${HOSTILE}`)],
];

describe("fork: external content written to the terminal", () => {
	it.each(rows)("%s", async (_name, output, visible = true) => {
		expectClean(await output(), visible);
	});

	it("leaves print mode output to a pipe byte for byte", async () => {
		expect(await printMode(false)).toBe(`${HOSTILE}\n`);
	});
});

describe("fork: isolated defects of the same files", () => {
	it("counts every other approval still waiting", async () => {
		expect(await notifyFallback(false, ["rm a", "rm b"])).toContain("(+1 more waiting)");
		expect(await notifyFallback(false, ["rm a", "rm b", "rm c"])).toContain("(+2 more waiting)");
	});

	it("keeps the cursor on a character boundary when the value is replaced", () => {
		for (const [next, expected] of [
			["\u{1F600}x", "X\u{1F600}x"],
			["e\u0301x", "Xe\u0301x"],
			["bc", "bXc"],
		]) {
			const input = new Input();
			input.handleInput("a");
			input.setValue(next!);
			input.handleInput("X");
			expect(input.getValue()).toBe(expected);
		}
	});

	it("places the cursor where the click lands, whatever the prompt", () => {
		for (const prompt of ["", "> ", "search: "]) {
			const input = new Input({ prompt });
			input.setValue("abc");
			input.render(40);
			input.handleMouse({ type: "press", button: "left", x: prompt.length + 1, y: 0 } as never);
			input.handleInput("X");
			expect(input.getValue(), JSON.stringify(prompt)).toBe("aXbc");
		}
	});

	it("does not bring a secret back in the next login step", async () => {
		const dialog = new LoginDialogComponent({ requestRender: vi.fn() } as unknown as TUI, "p", () => {}, "P");
		const secret = dialog.showPrompt("Enter API key", undefined, true);
		for (const char of "sk-123") dialog.handleInput(char);
		dialog.handleInput("\x17"); // ctrl+w: the kill ring holds part of the secret
		for (const char of "123") dialog.handleInput(char);
		dialog.handleInput("\x7f"); // backspace: the undo stack holds the secret
		dialog.handleInput("3");
		dialog.handleInput("\r");
		await expect(secret).resolves.toBe("sk-123");
		const name = dialog.showPrompt("Name");
		dialog.handleInput("\x1b[45;5u"); // ctrl+- (undo)
		dialog.handleInput("\x19"); // ctrl+y (yank)
		dialog.handleInput("\r");
		await expect(name).resolves.toBe("");
	});

	it("shortens the Prism footer's folder from its cleaned name", () => {
		// Cut first and cleaned after, the tail of a sequence stays on screen ("…nedYZ" for proj-X<OSC 0 pwned>YZ).
		const cwd = `/tmp/a-long-parent-folder/another-one/proj-X\x1b]0;pwned\x07Y\x1b]52;c;Y2xpcA==\x07Z\x1b[2J`;
		const line = leftovers(prismFooterLines(60, cwd).split("\n")[0]!);
		const folder = /\uf07b (\S+)/.exec(line)?.[1] ?? "";
		expect(folder.startsWith("…"), line).toBe(true);
		expect(sanitizeTerminalLabel(cwd).endsWith(folder.slice(1)), line).toBe(true);
	});

	it("shortens only the home folder and what is inside it", () => {
		vi.stubEnv("HOME", "/home/alice");
		try {
			expect(shortenPath("/home/alice")).toBe("~");
			expect(shortenPath("/home/alice/project")).toBe("~/project");
			expect(shortenPath("/home/alice-backup/project")).toBe("/home/alice-backup/project");
		} finally {
			vi.unstubAllEnvs();
			vi.stubEnv(ENV_AGENT_DIR, join(root, "agent"));
		}
	});
});
