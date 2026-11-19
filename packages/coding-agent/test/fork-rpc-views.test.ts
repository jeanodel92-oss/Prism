import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { Component, TuiMouseEvent } from "@earendil-works/pi-tui";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { setLanguage, t } from "../src/fork/i18n/index.ts";
import { hasInteractiveClient, setViewsClient } from "../src/fork/interactive-client.ts";
import onboarding, { setOnboardingHost } from "../src/fork/onboarding.ts";
import permissionsExtension from "../src/fork/permissions.ts";
import { createState } from "../src/fork/prism/lib/state.ts";
import { installTurnSummary } from "../src/fork/prism/turn-summary.ts";
import sessionStateExtension, { setSessionStateHost } from "../src/fork/session-state.ts";
import { installTutorial } from "../src/fork/tutorial.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

// fork: extension views (`ctx.ui.custom`, widget components) reach an RPC client that shows them,
// rendered by the engine with the same components as the terminal, and driven by the client's keys.

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
	clipboardImage: vi.fn<() => Promise<{ bytes: Uint8Array; mimeType: string } | null>>(async () => null),
	clipboardFiles: vi.fn<() => Promise<string[] | null>>(async () => null),
}));

vi.mock("../src/utils/clipboard.ts", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	readClipboardFilePaths: rpcIo.clipboardFiles,
}));

vi.mock("../src/utils/clipboard-image.ts", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	readClipboardImage: rpcIo.clipboardImage,
}));

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {
			rpcIo.lineHandler = undefined;
		};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

type NodeListener = Parameters<typeof process.on>[1];

function takeListenerSnapshot(): { stdinEnd: NodeListener[]; signals: Map<NodeJS.Signals, NodeListener[]> } {
	const signals: NodeJS.Signals[] = ["SIGTERM", "SIGHUP"];
	return {
		stdinEnd: process.stdin.listeners("end") as NodeListener[],
		signals: new Map(signals.map((signal) => [signal, process.listeners(signal) as NodeListener[]])),
	};
}

function restoreListeners(snapshot: ReturnType<typeof takeListenerSnapshot>): void {
	for (const listener of process.stdin.listeners("end") as NodeListener[]) {
		if (!snapshot.stdinEnd.includes(listener)) process.stdin.off("end", listener);
	}
	for (const [signal, previous] of snapshot.signals) {
		for (const listener of process.listeners(signal) as NodeListener[]) {
			if (!previous.includes(listener)) process.off(signal, listener);
		}
	}
}

function records(): Array<Record<string, unknown>> {
	return rpcIo.outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

const ofType = (type: string) => records().filter((r) => r.type === type);
const send = (record: unknown) => rpcIo.lineHandler?.(JSON.stringify(record));
const notified = (message: string) => records().some((r) => r.method === "notify" && r.message === message);

let beforeSessionInvalidate: (() => void) | undefined;
let onSessionLost: ((error: unknown) => void) | undefined;

const importFromJsonl = vi.fn(async (_path: string, _cwd?: string) => ({ cancelled: false }));

function runtimeHost(harness: Harness): AgentSessionRuntime {
	return {
		importFromJsonl,
		session: harness.session,
		services: { agentDir: process.env[ENV_AGENT_DIR] },
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
		setBeforeSessionInvalidate: vi.fn((callback: () => void) => {
			beforeSessionInvalidate = callback;
		}),
		setOnSessionLost: vi.fn((callback: (error: unknown) => void) => {
			onSessionLost = callback;
		}),
	} as unknown as AgentSessionRuntime;
}

/** A small terminal view: types into a field, Enter returns it, Escape cancels; a click picks a row. */
class Picker implements Component {
	text = "";
	clicked: number | undefined;
	readonly done: (value: string | undefined) => void;
	readonly requestRender: () => void;
	disposed = false;

	constructor(done: (value: string | undefined) => void, requestRender: () => void) {
		this.done = done;
		this.requestRender = requestRender;
	}

	render(width: number): string[] {
		return [`width ${width}`, `> ${this.text}`, `clicked ${this.clicked ?? "-"}`];
	}

	handleInput(data: string): void {
		if (data === "\r") this.done(this.text);
		else if (data === "\x1b") this.done(undefined);
		else this.text += data;
	}

	handleMouse(event: TuiMouseEvent): undefined {
		if (event.type === "press") this.clicked = event.y;
		return undefined;
	}

	invalidate(): void {}

	dispose(): void {
		this.disposed = true;
	}
}

describe("fork: extension views over RPC", () => {
	const cleanups: Array<() => void> = [];
	let agentDir: string;
	let previousAgentDir: string | undefined;
	let lastPicker: Picker | undefined;

	beforeAll(() => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-rpc-views-"));
		previousAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
		initTheme("dark");
	});

	afterAll(() => {
		if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	});

	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) cleanup();
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	const openPicker = (ctx: ExtensionContext, options?: Parameters<ExtensionContext["ui"]["custom"]>[1]) =>
		ctx.ui.custom<string | undefined>((tui, _theme, _keybindings, done) => {
			lastPicker = new Picker(done, () => tui.requestRender());
			return lastPicker;
		}, options);

	async function start(harness: Harness): Promise<void> {
		const snapshot = takeListenerSnapshot();
		cleanups.push(() => {
			harness.cleanup();
			restoreListeners(snapshot);
		});
		void runRpcMode(runtimeHost(harness));
		await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
	}

	const pickCommand = (pi: ExtensionAPI) => {
		pi.registerCommand("pick", {
			description: "pick",
			handler: async (_args, ctx) => {
				const value = await openPicker(ctx);
				ctx.ui.notify(`picked:${value ?? "none"}`);
			},
		});
		pi.registerCommand("panel", {
			description: "panel",
			handler: async (_args, ctx) => {
				const value = await openPicker(ctx, { overlay: true, overlayOptions: { width: "50%", maxHeight: 2 } });
				ctx.ui.notify(`panel:${value ?? "none"}`);
			},
		});
		pi.registerCommand("secret", {
			description: "secret",
			handler: async (_args, ctx) => {
				const value = await ctx.ui.input("Password", "", { secret: true });
				ctx.ui.notify(`secret:${value === undefined ? "none" : "given"}`);
			},
		});
		pi.registerCommand("widget", {
			description: "widget",
			handler: async (_args, ctx) => {
				ctx.ui.setWidget("w", (_tui, theme) => ({
					render: (width: number) => [theme.fg("accent", `widget ${width}`)],
					invalidate() {},
				}));
				// What the vendored plug-ins (pi-goal) read, without importing Prism.
				const vendored = (globalThis as Record<symbol, ((c: ExtensionContext) => boolean) | undefined>)[
					Symbol.for("prism.hasInteractiveClient")
				]?.(ctx);
				ctx.ui.notify(`client:${hasInteractiveClient(ctx)}/${vendored}`);
			},
		});
	};

	// Must run first: whether the client shows views is process-wide, and set_views is not undone.
	test("a client that did not opt in keeps the previous behaviour: no view, undefined result", async () => {
		const harness = await createHarness({ extensionFactories: [pickCommand] });
		await start(harness);
		send({ id: "p", type: "prompt", message: "/pick" });
		send({ id: "w", type: "prompt", message: "/widget" });

		await vi.waitFor(() => expect(notified("picked:none")).toBe(true));
		await vi.waitFor(() => expect(notified("client:false/false")).toBe(true));
		expect(ofType("view_open")).toHaveLength(0);
		expect(records().some((r) => r.method === "setWidget")).toBe(false);
	});

	test("opens the view, renders it at the client's width and returns what the keys chose", async () => {
		const harness = await createHarness({ extensionFactories: [pickCommand] });
		await start(harness);
		send({ id: "v", type: "set_views", columns: 60, rows: 20 });
		await vi.waitFor(() => expect(records().some((r) => r.id === "v" && r.success === true)).toBe(true));

		send({ id: "p", type: "prompt", message: "/pick" });
		await vi.waitFor(() => expect(ofType("view_frame")).toHaveLength(1));
		const [open] = ofType("view_open");
		expect(open).toMatchObject({ overlay: false });
		expect(ofType("view_frame")[0]).toEqual({
			type: "view_frame",
			id: open.id,
			columns: 60,
			lines: ["width 60", "> ", "clicked -"],
		});

		send({ id: "i1", type: "view_input", viewId: open.id, data: "a" });
		send({ id: "i2", type: "view_input", viewId: open.id, data: "b" });
		send({ id: "m", type: "view_mouse", viewId: open.id, event: { type: "press", button: "left", x: 3, y: 2 } });
		expect(ofType("view_frame").at(-1)?.lines).toEqual(["width 60", "> ab", "clicked 2"]);

		send({ id: "i3", type: "view_input", viewId: open.id, data: "\r" });
		await vi.waitFor(() => expect(notified("picked:ab")).toBe(true));
		expect(ofType("view_closed")).toEqual([{ type: "view_closed", id: open.id, reason: "done" }]);
		expect(lastPicker?.disposed).toBe(true);
		// Input for a closed view is refused, not delivered.
		send({ id: "late", type: "view_input", viewId: open.id, data: "x" });
		expect(records().find((r) => r.id === "late")).toMatchObject({ success: false });
	});

	// fork: a view of the old session must not stay usable once the session is replaced.
	test("replacing the session closes its open views as cancelled and refuses their input", async () => {
		const harness = await createHarness({ extensionFactories: [pickCommand] });
		await start(harness);
		send({ id: "v", type: "set_views", columns: 60, rows: 20 });
		await vi.waitFor(() => expect(records().some((r) => r.id === "v" && r.success === true)).toBe(true));
		send({ id: "p", type: "prompt", message: "/pick" });
		await vi.waitFor(() => expect(ofType("view_open")).toHaveLength(1));
		const [open] = ofType("view_open");

		beforeSessionInvalidate?.();
		await vi.waitFor(() => expect(notified("picked:none")).toBe(true));
		expect(ofType("view_closed")).toEqual([{ type: "view_closed", id: open.id, reason: "aborted" }]);
		expect(lastPicker?.disposed).toBe(true);
		send({ id: "late", type: "view_input", viewId: open.id, data: "x" });
		expect(records().find((r) => r.id === "late")).toMatchObject({ success: false });
	});

	test("an overlay takes its size from the overlay options, as in the terminal", async () => {
		const harness = await createHarness({ extensionFactories: [pickCommand] });
		await start(harness);
		send({ id: "v", type: "set_views", columns: 80, rows: 20 });
		send({ id: "p", type: "prompt", message: "/panel" });
		await vi.waitFor(() => expect(ofType("view_frame")).toHaveLength(1));
		expect(ofType("view_open")[0]).toMatchObject({ overlay: true });
		expect(ofType("view_frame")[0]).toMatchObject({ columns: 40, lines: ["width 40", "> "] });

		// A new client size re-renders open views.
		send({ id: "v2", type: "set_views", columns: 100, rows: 20 });
		expect(ofType("view_frame").at(-1)).toMatchObject({ columns: 50, lines: ["width 50", "> "] });

		send({ id: "c", type: "view_close", viewId: ofType("view_open")[0].id });
		await vi.waitFor(() => expect(notified("panel:none")).toBe(true));
		expect(ofType("view_closed").at(-1)).toMatchObject({ reason: "client" });
	});

	test("aborting the turn closes a view opened for a tool call", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", async (_event, ctx) => {
						const value = await openPicker(ctx, { signal: ctx.signal });
						return value === "ok" ? undefined : { block: true, reason: "blocked" };
					});
				},
			],
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "x.txt" }, { id: "call-1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await start(harness);
		send({ id: "v", type: "set_views", columns: 60, rows: 20 });
		send({ id: "p", type: "prompt", message: "read it" });
		await vi.waitFor(() => expect(ofType("view_frame")).toHaveLength(1));

		send({ id: "a", type: "abort" });
		await vi.waitFor(() => expect(records().some((r) => r.id === "a")).toBe(true));
		expect(ofType("view_closed")).toEqual([
			{ type: "view_closed", id: ofType("view_open")[0].id, reason: "aborted" },
		]);
		expect(lastPicker?.disposed).toBe(true);
	});

	test("a widget component reaches the client as lines, and the client counts as interactive", async () => {
		const harness = await createHarness({ extensionFactories: [pickCommand] });
		await start(harness);
		send({ id: "v", type: "set_views", columns: 30, rows: 10 });
		send({ id: "w", type: "prompt", message: "/widget" });
		await vi.waitFor(() => expect(notified("client:true/true")).toBe(true));
		const widget = records().find((r) => r.method === "setWidget" && r.widgetKey === "w");
		expect(widget?.widgetLines).toHaveLength(1);
		expect(String((widget?.widgetLines as string[])[0])).toContain("widget 30");
	});

	test("a masked question is announced as secret, so the client masks it too", async () => {
		const harness = await createHarness({ extensionFactories: [pickCommand] });
		await start(harness);
		send({ id: "p", type: "prompt", message: "/secret" });
		await vi.waitFor(() => expect(records().some((r) => r.method === "input")).toBe(true));
		const request = records().find((r) => r.method === "input")!;
		expect(request.secret).toBe(true);
		send({ type: "extension_ui_response", id: request.id, value: "hunter2" });
		await vi.waitFor(() => expect(notified("secret:given")).toBe(true));
	});
	test("keys: the client gets the resolved keybindings and runs extension shortcuts through the session", async () => {
		writeFileSync(join(agentDir, "keybindings.json"), JSON.stringify({ "app.message.followUp": "ctrl+j" }));
		cleanups.push(() => rmSync(join(agentDir, "keybindings.json"), { force: true }));
		const shortcuts = (pi: ExtensionAPI) => {
			pi.registerShortcut("alt+k", {
				description: "Ask something",
				handler: async (ctx) => {
					const ok = await ctx.ui.confirm("Really?", "");
					ctx.ui.notify(`shortcut:${ok}`);
				},
			});
			pi.registerShortcut("alt+x", {
				description: "Fails",
				handler: () => {
					throw new Error("broken shortcut");
				},
			});
		};
		const harness = await createHarness({ extensionFactories: [shortcuts] });
		await start(harness);

		send({ id: "k", type: "get_keys" });
		await vi.waitFor(() => expect(records().some((r) => r.id === "k")).toBe(true));
		const keys = records().find((r) => r.id === "k")?.data as {
			bindings: Record<string, { keys: string[]; description: string }>;
			shortcuts: Array<{ key: string; description: string }>;
		};
		// keybindings.json applies, as in the terminal; of the terminal-only bindings (tui.*), only the transcript's.
		expect(keys.bindings["app.message.followUp"].keys).toEqual(["ctrl+j"]);
		expect(keys.bindings["app.thinking.cycle"]).toMatchObject({ keys: ["shift+tab"] });
		expect(keys.bindings["app.goal.menu"]).toMatchObject({ keys: ["alt+g"], command: "goal" });
		expect(
			Object.keys(keys.bindings)
				.filter((id) => !id.startsWith("app."))
				.sort(),
		).toEqual([
			"tui.altScreen.nextPrompt",
			"tui.altScreen.previousPrompt",
			"tui.altScreen.search",
			"tui.altScreen.searchClose",
			"tui.altScreen.searchNext",
			"tui.altScreen.searchPrevious",
		]);
		expect(keys.bindings["tui.altScreen.search"].keys).toEqual(["ctrl+f", "ctrl+shift+f"]);
		expect(keys).toMatchObject({ doubleEscapeAction: "tree" });
		expect(keys.shortcuts).toEqual(
			expect.arrayContaining([
				{ key: "alt+k", description: "Ask something" },
				{ key: "alt+x", description: "Fails" },
			]),
		);

		// The handler answers through the session's dialogs; the response does not wait for it.
		send({ id: "r", type: "run_shortcut", key: "alt+k" });
		await vi.waitFor(() => expect(records().find((r) => r.id === "r")).toMatchObject({ success: true }));
		await vi.waitFor(() => expect(records().some((r) => r.method === "confirm")).toBe(true));
		const question = records().find((r) => r.method === "confirm") as { id: string };
		send({ type: "extension_ui_response", id: question.id, confirmed: false });
		await vi.waitFor(() => expect(notified("shortcut:false")).toBe(true));

		// A failing handler is reported as an extension error; an unknown key is refused.
		send({ id: "x", type: "run_shortcut", key: "alt+x" });
		await vi.waitFor(() => expect(ofType("extension_error")).toHaveLength(1));
		expect(ofType("extension_error")[0]).toMatchObject({ event: "shortcut", error: "broken shortcut" });
		send({ id: "u", type: "run_shortcut", key: "alt+q" });
		await vi.waitFor(() => expect(records().find((r) => r.id === "u")).toMatchObject({ success: false }));
	});
	test("toggle_plan runs the plan module's own toggle, as the terminal's Plan switch does", async () => {
		const bridge = Symbol.for("prism.plan-mode");
		const globals = globalThis as Record<symbol, unknown>;
		const before = globals[bridge];
		cleanups.push(() => {
			globals[bridge] = before;
		});
		globals[bridge] = undefined;
		const harness = await createHarness();
		await start(harness);
		// No plan module: the client runs /plan instead, as the terminal does.
		send({ id: "none", type: "toggle_plan" });
		await vi.waitFor(() =>
			expect(records().find((r) => r.id === "none")).toMatchObject({ success: true, data: { toggled: false } }),
		);
		globals[bridge] = { toggle: (ctx: ExtensionContext) => ctx.ui.notify("plan:toggled"), shortcut: "alt+p" };
		send({ id: "t", type: "toggle_plan" });
		await vi.waitFor(() =>
			expect(records().find((r) => r.id === "t")).toMatchObject({ success: true, data: { toggled: true } }),
		);
		await vi.waitFor(() => expect(notified("plan:toggled")).toBe(true));
		send({ id: "k", type: "get_keys" });
		await vi.waitFor(() => expect(records().find((r) => r.id === "k")).toMatchObject({ data: { planKey: "alt+p" } }));
		// The words that mean the switch is on, in both languages, as the terminal reads them.
		expect((records().find((r) => r.id === "k")?.data as { planOn: string[] }).planOn).toEqual(
			expect.arrayContaining(["plan active", "plan actif", "plan ready", "plan prêt"]),
		);
		// the words of a finished goal (its switch off), in both languages.
		expect((records().find((r) => r.id === "k")?.data as { goalDone: string[] }).goalDone).toEqual([
			"complete",
			"terminé",
		]);
	});
	test("the footer's more… menu, pinned commands and context menu are the terminal's, asked as dialogs", async () => {
		const harness = await createHarness();
		await start(harness);
		const settingsFile = join(agentDir, "settings.json");
		cleanups.push(() => rmSync(settingsFile, { force: true }));
		const selects = () =>
			records().filter((r) => r.method === "select") as Array<{ id: string; title: string; options: string[] }>;
		const choose = async (count: number, pick: (options: string[]) => string | undefined) => {
			await vi.waitFor(() => expect(selects().length).toBe(count));
			const question = selects()[count - 1]!;
			const value = pick(question.options);
			send({ type: "extension_ui_response", id: question.id, ...(value ? { value } : { cancelled: true }) });
			return question;
		};
		const result = async (id: string) => {
			await vi.waitFor(() => expect(records().some((r) => r.id === id)).toBe(true));
			return records().find((r) => r.id === id) as { success: boolean; data: Record<string, unknown> };
		};
		// A command chosen in more… comes back for the client to run as typed.
		send({ id: "m1", type: "more_menu" });
		const menu = await choose(1, (options) => options.find((o) => o.endsWith("/tree")));
		expect(menu.options.at(-1)).toBe(t("Footer buttons…"));
		expect((await result("m1")).data).toEqual({ line: "/tree" });
		// Footer buttons…: pin /tree, then Esc; saved where the terminal saves it.
		send({ id: "m2", type: "more_menu" });
		await choose(2, (options) => options.at(-1));
		await choose(3, (options) => options.find((o) => o.endsWith("/tree")));
		await choose(4, () => t("Pin to the footer"));
		await choose(5, () => undefined);
		expect((await result("m2")).data).toEqual({ pinned: ["tree"] });
		expect(JSON.parse(readFileSync(settingsFile, "utf8")).footerActions).toEqual(["tree"]);
		send({ id: "f", type: "get_footer" });
		expect((await result("f")).data).toEqual({ pinned: ["tree"] });
	});
	test("get_turns gives the terminal's end-of-turn lines, from the figures the Prism pack keeps", async () => {
		const harness = await createHarness({ extensionFactories: [(pi) => installTurnSummary(pi, createState())] });
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "missing.txt" }, { id: "call-1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("first"),
			fauxAssistantMessage("second"),
		]);
		await start(harness);
		const turns = async (id: string, since?: string) => {
			send({ id, type: "get_turns", ...(since ? { since } : {}) });
			await vi.waitFor(() => expect(records().some((r) => r.id === id)).toBe(true));
			return records().find((r) => r.id === id)?.data as {
				turns: Array<{ id: string; after: number; text: string }>;
				last: string;
			};
		};
		send({ id: "p1", type: "prompt", message: "one" });
		await vi.waitFor(() => expect(ofType("agent_settled")).toHaveLength(1));
		const first = await turns("t1");
		expect(first.turns).toHaveLength(1);
		// The terminal's words: duration, the tool and its failure, tokens.
		expect(first.turns[0].text).toMatch(/^\d+ s · 1 tool · 1 failure · sent \S+ · received \S+/);
		// The line follows the turn's last message.
		const lastReply = harness.session.messages.at(-1);
		expect(first.turns[0]).toMatchObject({ after: lastReply?.timestamp, role: "assistant" });
		expect((await turns("t2", first.last)).turns).toEqual([]);
		send({ id: "p2", type: "prompt", message: "two" });
		await vi.waitFor(() => expect(ofType("agent_settled")).toHaveLength(2));
		const second = await turns("t3", first.last);
		expect(second.turns).toHaveLength(1);
		expect(second.turns[0].text).not.toContain("tool");
		expect((await turns("t4")).turns).toHaveLength(2);
	});
	test("reload is the terminal's /reload: the same session, its extensions started again, refused during a reply", async () => {
		const starts: string[] = [];
		let wrapped = 0;
		const extension = (pi: ExtensionAPI) => {
			pi.on("session_start", (event, ctx) => {
				starts.push(event.reason);
				ctx.ui.addAutocompleteProvider((current) => ({
					getSuggestions: async (lines, line, col, options) => {
						wrapped++;
						return current.getSuggestions(lines, line, col, options);
					},
					applyCompletion: (lines, line, col, item, prefix) =>
						current.applyCompletion(lines, line, col, item, prefix),
				}));
			});
		};
		let finish: () => void = () => {};
		const harness = await createHarness({ extensionFactories: [extension] });
		harness.setResponses([
			async () => {
				await new Promise<void>((resolve) => {
					finish = resolve;
				});
				return fauxAssistantMessage("done");
			},
		]);
		const response = (id: string) => records().find((r) => r.id === id);
		await start(harness);
		// Refused while a reply runs, as in the terminal (the test's model is gone after a reload).
		send({ id: "p", type: "prompt", message: "go" });
		await vi.waitFor(() => expect(ofType("agent_start")).toHaveLength(1));
		send({ id: "busy", type: "reload" });
		await vi.waitFor(() => expect(response("busy")).toBeDefined());
		expect(response("busy")).toMatchObject({
			success: false,
			error: "Wait for the current response to finish before reloading.",
		});
		finish();
		await vi.waitFor(() => expect(ofType("agent_settled")).toHaveLength(1));

		send({ id: "n", type: "set_session_name", name: "Kept" });
		await vi.waitFor(() => expect(response("n")).toBeDefined());
		// A session without a reply is not written yet: reloading keeps it, as in the terminal.
		send({ id: "r", type: "reload" });
		await vi.waitFor(() => expect(response("r")).toBeDefined());
		expect(response("r")).toMatchObject({
			success: true,
			data: { message: "Reloaded keybindings, extensions, skills, prompts, themes, and context files" },
		});
		expect(starts.at(-1)).toBe("reload");
		expect(harness.session.sessionManager.getSessionName()).toBe("Kept");
		// The extension's completion wrapper is there once, not once per start.
		send({ id: "c", type: "complete", text: "/comp", cursor: 5, typed: "p" });
		await vi.waitFor(() => expect(response("c")).toBeDefined());
		expect(wrapped).toBe(1);
	});
	// fork: ctx.reload() from a command is the same reload as the client's.
	test("a command's ctx.reload() does not wrap the extensions' completions twice", async () => {
		let wrapped = 0;
		const extension = (pi: ExtensionAPI) => {
			pi.on("session_start", (_event, ctx) => {
				ctx.ui.addAutocompleteProvider((current) => ({
					getSuggestions: async (lines, line, col, options) => {
						wrapped++;
						return current.getSuggestions(lines, line, col, options);
					},
					applyCompletion: (lines, line, col, item, prefix) =>
						current.applyCompletion(lines, line, col, item, prefix),
				}));
			});
			pi.registerCommand("again", {
				description: "again",
				handler: async (_args, ctx) => {
					await ctx.reload();
				},
			});
		};
		const harness = await createHarness({ extensionFactories: [extension] });
		const response = (id: string) => records().find((r) => r.id === id);
		await start(harness);
		send({ id: "p", type: "prompt", message: "/again" });
		await vi.waitFor(() => expect(response("p")).toBeDefined());
		await new Promise((resolve) => setTimeout(resolve, 50));
		send({ id: "c", type: "complete", text: "/comp", cursor: 5, typed: "p" });
		await vi.waitFor(() => expect(response("c")).toBeDefined());
		expect(wrapped).toBe(1);
	});

	// fork: closing a conversation during a turn must not show extension errors.
	describe("the end of the input during a turn", () => {
		async function closing(
			extension: (pi: ExtensionAPI) => void,
			respond: () => Promise<ReturnType<typeof fauxAssistantMessage>>,
		) {
			const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
			const harness = await createHarness({ extensionFactories: [extension] });
			harness.setResponses([respond, fauxAssistantMessage("after")]);
			const snapshot = takeListenerSnapshot();
			cleanups.push(() => {
				exit.mockRestore();
				harness.cleanup();
				restoreListeners(snapshot);
			});
			const disposed = vi.fn(() => harness.session.dispose());
			void runRpcMode({
				...runtimeHost(harness),
				dispose: async () => disposed(),
			} as unknown as AgentSessionRuntime);
			await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
			send({ id: "p", type: "prompt", message: "go" });
			return { exit, harness };
		}

		test("while a reply streams: no extension error, exit code 0", async () => {
			let turnEnds = 0;
			const extension = (pi: ExtensionAPI) => {
				pi.on("turn_end", (_event, ctx) => {
					turnEnds++;
					ctx.getContextUsage();
				});
			};
			let finish: () => void = () => {};
			const { exit } = await closing(extension, async () => {
				await new Promise<void>((resolve) => {
					finish = resolve;
				});
				return fauxAssistantMessage("late");
			});
			await vi.waitFor(() => expect(ofType("agent_start")).toHaveLength(1));
			process.stdin.emit("end");
			await new Promise((resolve) => setTimeout(resolve, 20));
			finish();
			await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0), { timeout: 5000 });
			expect(turnEnds).toBe(1);
			expect(ofType("extension_error")).toEqual([]);
		});

		test("while a question waits for its answer: it is cancelled, no extension error, exit code 0", async () => {
			let answer: string | undefined = "unset";
			const extension = (pi: ExtensionAPI) => {
				pi.on("turn_start", async (_event, ctx) => {
					answer = await ctx.ui.select("Allow?", ["Yes", "No"]);
				});
				pi.on("turn_end", (_event, ctx) => {
					ctx.getContextUsage();
				});
			};
			const { exit } = await closing(extension, async () => fauxAssistantMessage("done"));
			await vi.waitFor(() => expect(ofType("extension_ui_request").length).toBeGreaterThan(0));
			process.stdin.emit("end");
			await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0), { timeout: 5000 });
			expect(answer).toBeUndefined();
			expect(ofType("extension_error")).toEqual([]);
		});
	});

	// fork: a session change that failed after the old session was torn down left the
	// engine reading commands for a disposed session. It now says so and exits with an error, which the client sees.
	test("a session change lost after the teardown ends the engine with an error", async () => {
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const harness = await createHarness();
		const snapshot = takeListenerSnapshot();
		cleanups.push(() => {
			exit.mockRestore();
			stderr.mockRestore();
			harness.cleanup();
			restoreListeners(snapshot);
		});
		const disposed = vi.fn(async () => {});
		void runRpcMode({
			...runtimeHost(harness),
			dispose: disposed,
			newSession: vi.fn(async () => {
				const lost = new Error("package.json unreadable");
				onSessionLost?.(lost);
				throw lost;
			}),
		} as unknown as AgentSessionRuntime);
		await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
		send({ id: "n", type: "new_session" });
		await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1), { timeout: 5000 });
		expect(records().find((r) => r.id === "n")).toMatchObject({ success: false, error: "package.json unreadable" });
		expect(String(stderr.mock.calls.flat().join(""))).toContain("package.json unreadable");
	});

	test("cycle_model takes the direction of the terminal's backward key", async () => {
		const harness = await createHarness({ models: [{ id: "first" }, { id: "second" }, { id: "third" }] });
		await start(harness);
		send({ id: "b", type: "cycle_model", direction: "backward" });
		await vi.waitFor(() => expect(records().some((r) => r.id === "b")).toBe(true));
		expect(records().find((r) => r.id === "b")).toMatchObject({ success: true, data: { model: { id: "third" } } });
		send({ id: "f", type: "cycle_model" });
		await vi.waitFor(() => expect(records().some((r) => r.id === "f")).toBe(true));
		expect(records().find((r) => r.id === "f")).toMatchObject({ success: true, data: { model: { id: "first" } } });
	});

	// The terminal's built-ins with a view: the same components, run by the engine through the views bridge.
	const response = (id: string) => records().find((r) => r.id === id);
	const viewText = () => (ofType("view_frame").at(-1)?.lines as string[]).join("\n");

	test("show_help opens the terminal's help and gives back the chosen command for the editor", async () => {
		const harness = await createHarness();
		await start(harness);
		send({ id: "v", type: "set_views", columns: 80, rows: 30 });
		send({ id: "h", type: "show_help" });
		await vi.waitFor(() => expect(ofType("view_frame").length).toBeGreaterThan(0));
		expect(viewText()).toContain("Help");
		// Typing filters the list, as in the terminal; Enter on a command hands it back, nothing runs.
		for (const key of "/compact") send({ type: "view_input", viewId: ofType("view_open")[0].id, data: key });
		send({ type: "view_input", viewId: ofType("view_open")[0].id, data: "\r" });
		await vi.waitFor(() => expect(response("h")).toBeDefined());
		expect(response("h")).toMatchObject({ success: true, data: { command: "/compact" } });
		expect(ofType("compaction_start")).toHaveLength(0);
	});

	test("get_help gives the help's entries as data, without opening a view", async () => {
		const harness = await createHarness();
		await start(harness);
		send({ id: "v", type: "set_views", columns: 80, rows: 30 });
		send({ id: "h", type: "get_help" });
		await vi.waitFor(() => expect(response("h")).toBeDefined());
		const data = response("h")?.data as {
			title: string;
			entries: { key: string; action: string; command?: string }[];
		};
		expect(data.title).toBe("Help");
		expect(data.entries.find((entry) => entry.command === "/compact")).toMatchObject({ key: "/compact" });
		expect(data.entries.every((entry) => entry.key && entry.action)).toBe(true);
		expect(ofType("view_open")).toHaveLength(0);
	});

	test("show_changelog opens the reader as an overlay; closing it answers the command", async () => {
		const harness = await createHarness();
		await start(harness);
		send({ id: "v", type: "set_views", columns: 80, rows: 30 });
		send({ id: "c", type: "show_changelog" });
		await vi.waitFor(() => expect(ofType("view_frame").length).toBeGreaterThan(0));
		expect(ofType("view_open")[0]).toMatchObject({ overlay: true });
		expect(response("c")).toBeUndefined();
		send({ type: "view_close", viewId: ofType("view_open")[0].id });
		await vi.waitFor(() => expect(response("c")).toMatchObject({ success: true }));
	});

	test("trust saves the decision through the terminal's selector; Escape saves nothing", async () => {
		const harness = await createHarness();
		await start(harness);
		send({ id: "v", type: "set_views", columns: 80, rows: 30 });
		send({ id: "t1", type: "trust" });
		await vi.waitFor(() => expect(ofType("view_frame").length).toBeGreaterThan(0));
		send({ type: "view_input", viewId: ofType("view_open")[0].id, data: "\x1b" });
		await vi.waitFor(() => expect(response("t1")).toMatchObject({ success: true, data: {} }));
		const trustFile = join(agentDir, "trust.json");
		expect(existsSync(trustFile)).toBe(false);

		send({ id: "t2", type: "trust" });
		await vi.waitFor(() => expect(ofType("view_open")).toHaveLength(2));
		send({ type: "view_input", viewId: ofType("view_open")[1].id, data: "\r" });
		await vi.waitFor(() => expect(response("t2")).toBeDefined());
		expect(String((response("t2")?.data as { message: string }).message)).toMatch(/^Saved trust decision: /);
		expect(readFileSync(trustFile, "utf8")).toContain(JSON.stringify(harness.sessionManager.getCwd()));
		cleanups.push(() => rmSync(trustFile, { force: true }));
	});

	// the same options as a native list in the Prism window, the same store.
	test("trust with native menus: the options, the saved one marked, closing saves nothing", async () => {
		const harness = await createHarness();
		await start(harness);
		send({ id: "v", type: "set_views", columns: 80, rows: 30, nativeMenus: true });
		cleanups.push(() => setViewsClient());
		const cwd = harness.sessionManager.getCwd();
		type Menu = { screenId: string; kind: string; title: string; lines: string[]; hint: string };
		type Item = { id: string; label: string };
		const menu = () => ofType("view_frame").at(-1)?.menu as Menu & { items: Item[]; currentItemId?: string };
		send({ id: "t1", type: "trust" });
		await vi.waitFor(() => expect(menu()?.screenId).toBe("trust"));
		expect(menu()).toMatchObject({ kind: "choice", title: "Project trust", hint: "close" });
		expect(menu().lines).toEqual([cwd, "Saved decision: none", "Current session: trusted"]);
		expect(menu().items.map((item) => item.label)).toEqual([
			"Trust",
			expect.stringMatching(/^Trust parent folder \(/),
			"Do not trust",
		]);
		expect(menu().currentItemId).toBeUndefined();
		const viewId = () => String(ofType("view_open").at(-1)?.id);
		send({ type: "view_close", viewId: viewId() });
		await vi.waitFor(() => expect(response("t1")).toMatchObject({ success: true, data: {} }));
		const trustFile = join(agentDir, "trust.json");
		expect(existsSync(trustFile)).toBe(false);

		send({ id: "t2", type: "trust" });
		await vi.waitFor(() => expect(ofType("view_open")).toHaveLength(2));
		await vi.waitFor(() => expect(menu()?.screenId).toBe("trust"));
		const doNot = menu().items.find((item) => item.label === "Do not trust")!;
		send({ id: "a", type: "view_action", viewId: viewId(), action: { kind: "activate", itemId: doNot.id } });
		await vi.waitFor(() => expect(response("t2")).toBeDefined());
		expect((response("t2")?.data as { message: string }).message).toBe(
			"Saved trust decision: untrusted. Restart pi for this to take effect.",
		);
		cleanups.push(() => rmSync(trustFile, { force: true }));
		expect(JSON.parse(readFileSync(trustFile, "utf8"))).toMatchObject({ [cwd]: false });

		// The saved option is marked and starts selected.
		send({ id: "t3", type: "trust" });
		await vi.waitFor(() => expect(ofType("view_open")).toHaveLength(3));
		await vi.waitFor(() => expect(menu()?.screenId).toBe("trust"));
		expect(menu().lines[1]).toBe(`Saved decision: untrusted (${cwd})`);
		expect(menu().currentItemId).toBe(menu().items.find((item) => item.label === "Do not trust")!.id);
		send({ type: "view_close", viewId: viewId() });
		await vi.waitFor(() => expect(response("t3")).toMatchObject({ success: true, data: {} }));
	});

	// the task scope's approval as a native screen, with the terminal's choices and its start.
	test("perm scope with native menus: lines kept or left out, duration, presence, approve or cancel", async () => {
		const harness = await createHarness({
			extensionFactories: [{ name: "permissions", factory: permissionsExtension }],
		});
		await start(harness);
		send({ id: "v", type: "set_views", columns: 80, rows: 30, nativeMenus: true });
		cleanups.push(() => setViewsClient());
		type Item = { id: string; label: string; description?: string; selected?: boolean; disabled?: boolean };
		type Menu = { screenId: string; kind: string; title: string; lines: string[]; hint: string };
		const menu = () => ofType("view_frame").at(-1)?.menu as Menu & { items: Item[]; actions: Item[] };
		const viewId = () => String(ofType("view_open").at(-1)?.id);
		const act = (action: object) => send({ type: "view_action", viewId: viewId(), action });
		const action = (label: RegExp) => menu().actions.find((item) => label.test(item.label))!;
		const scopeNotice = () =>
			records().find((r) => r.method === "notify" && String(r.message).startsWith("Task scope set")) as
				| { message: string }
				| undefined;

		// Cancel, then closing the panel: no scope.
		for (const end of ["cancel", "close"]) {
			const opened = ofType("view_open").length;
			send({ id: `s-${end}`, type: "prompt", message: "/perm scope" });
			await vi.waitFor(() => expect(ofType("view_open")).toHaveLength(opened + 1));
			await vi.waitFor(() => expect(menu()?.screenId).toBe("scope"));
			if (end === "cancel") act({ kind: "activate", itemId: action(/^Cancel$/).id });
			else send({ type: "view_close", viewId: viewId() });
			await vi.waitFor(() => expect(ofType("view_closed")).toHaveLength(opened + 1));
		}
		expect(scopeNotice()).toBeUndefined();

		send({ id: "s1", type: "prompt", message: "/perm scope" });
		await vi.waitFor(() => expect(ofType("view_open")).toHaveLength(3));
		await vi.waitFor(() => expect(menu()?.screenId).toBe("scope"));
		expect(menu()).toMatchObject({ kind: "multiSelect", title: "Set a task scope", hint: "close" });
		expect(menu().lines[0]).toBe("Within it, the agent works without asking. Untick a line to leave it out.");
		expect(menu().lines[1]).toBe("Anything else is asked about, as now.");
		expect(menu().lines.some((line) => line.startsWith("Limits: "))).toBe(true);
		const files = menu().items.find((item) => item.label === "Change the project's files")!;
		expect(files).toMatchObject({ description: "changes any file in the project", selected: true });
		expect(action(/^Duration: /).label).toBe("Duration: 60 min");
		expect(ofType("view_frame").some((frame) => (frame.lines as string[] | undefined)?.length)).toBe(false);

		// Every line left out: nothing to approve.
		for (const item of menu().items) act({ kind: "multiSelect", itemId: item.id, selected: false });
		await vi.waitFor(() => expect(action(/^Approve$/).disabled).toBe(true));
		act({ kind: "activate", itemId: action(/^Approve$/).id });
		act({ kind: "multiSelect", itemId: menu().items.find((item) => item.label === files.label)!.id, selected: true });
		await vi.waitFor(() => expect(action(/^Approve$/).disabled).toBe(false));
		act({ kind: "activate", itemId: action(/^Duration: /).id });
		await vi.waitFor(() => expect(action(/^Duration: /).label).toBe("Duration: 120 min"));
		act({ kind: "activate", itemId: action(/^While it runs: /).id });
		await vi.waitFor(() => expect(action(/^While it runs: /).label).toBe("While it runs: I'm away"));
		expect(menu().lines[1]).toBe("Anything else is refused at once; you get the list when the task ends.");
		expect(scopeNotice()).toBeUndefined();
		act({ kind: "activate", itemId: action(/^Approve$/).id });
		await vi.waitFor(() =>
			expect(scopeNotice()?.message).toBe("Task scope set for your next task (120 min at most)."),
		);
		await vi.waitFor(() => expect(ofType("view_closed")).toHaveLength(3));
	});

	test("tree: the terminal's selector, the summary question as a dialog, then navigateTree", async () => {
		const harness = await createHarness();
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await start(harness);
		await harness.session.prompt("first");
		await harness.session.prompt("second");
		expect(harness.session.messages.filter((m) => m.role === "user")).toHaveLength(2);
		send({ id: "v", type: "set_views", columns: 80, rows: 30 });
		const firstUser = harness.sessionManager
			.getEntries()
			.find((e) => e.type === "message" && e.message.role === "user")!;

		send({ id: "t", type: "tree", entryId: firstUser.id });
		await vi.waitFor(() => expect(ofType("view_frame").length).toBeGreaterThan(0));
		expect(viewText()).toContain("first");
		send({ type: "view_input", viewId: ofType("view_open")[0].id, data: "\r" });
		await vi.waitFor(() => expect(records().some((r) => r.method === "select")).toBe(true));
		const question = records().find((r) => r.method === "select") as { id: string; title: string; options: string[] };
		expect(question).toMatchObject({
			title: "Summarize branch?",
			options: ["No summary", "Summarize", "Summarize with custom prompt"],
		});
		send({ type: "extension_ui_response", id: question.id, value: "No summary" });
		await vi.waitFor(() => expect(response("t")).toBeDefined());
		// Choosing a user message puts the session before it and its text back in the editor, as in the terminal.
		expect(response("t")).toMatchObject({ success: true, data: { navigated: true, editorText: "first" } });
		expect(harness.session.messages.filter((m) => m.role === "user")).toHaveLength(0);
	});

	test("show_sessions opens the terminal's session selector; Escape chooses nothing", async () => {
		const harness = await createHarness();
		await start(harness);
		send({ id: "v", type: "set_views", columns: 80, rows: 30 });
		send({ id: "s", type: "show_sessions" });
		await vi.waitFor(() => expect(viewText().replace(/\x1b\[[0-9;]*m/g, "")).toContain("Current Folder"));
		send({ type: "view_input", viewId: ofType("view_open")[0].id, data: "\x1b" });
		await vi.waitFor(() => expect(response("s")).toMatchObject({ success: true }));
		expect((response("s") as { data?: object }).data).toEqual({});
	});

	test("import_session asks the terminal's question, then imports through the runtime", async () => {
		const harness = await createHarness();
		await start(harness);
		importFromJsonl.mockClear();
		const answer = async (confirmed: boolean) => {
			await vi.waitFor(() => expect(records().filter((r) => r.method === "confirm").length).toBeGreaterThan(0));
			const question = records()
				.filter((r) => r.method === "confirm")
				.at(-1) as { id: string; message: string };
			rpcIo.outputLines.length = 0;
			send({ type: "extension_ui_response", id: question.id, confirmed });
			return question;
		};
		send({ id: "n", type: "import_session", path: "old.jsonl" });
		expect((await answer(false)).message).toContain("old.jsonl");
		await vi.waitFor(() => expect(response("n")).toBeDefined());
		expect(response("n")).toMatchObject({ success: true, data: { imported: false } });
		expect(importFromJsonl).not.toHaveBeenCalled();

		send({ id: "y", type: "import_session", path: "old.jsonl" });
		await answer(true);
		await vi.waitFor(() => expect(response("y")).toBeDefined());
		expect(response("y")).toMatchObject({ success: true, data: { imported: true } });
		expect(importFromJsonl).toHaveBeenCalledWith("old.jsonl");
	});

	test("share runs the terminal's upload in a view and answers with its status line", async () => {
		// A stand-in `gh`: nothing leaves the machine.
		const bin = mkdtempSync(join(tmpdir(), "pi-share-gh-"));
		writeFileSync(
			join(bin, "gh"),
			'#!/bin/sh\nif [ "$1" = gist ]; then echo https://gist.github.com/someone/abc123; fi\n',
			{ mode: 0o755 },
		);
		const previousPath = process.env.PATH;
		process.env.PATH = `${bin}:${previousPath}`;
		cleanups.push(() => {
			process.env.PATH = previousPath;
			rmSync(bin, { recursive: true, force: true });
		});
		// The terminal shares a saved session (an in-memory one cannot be exported).
		const harness = await createHarness({ sessionManager: SessionManager.create(bin, join(bin, "sessions")) });
		harness.setResponses([fauxAssistantMessage("hello")]);
		await start(harness);
		send({ id: "p", type: "prompt", message: "hi" });
		await vi.waitFor(() => expect(ofType("agent_end")).toHaveLength(1));
		send({ id: "v", type: "set_views", columns: 80, rows: 30 });
		send({ id: "s", type: "share" });
		await vi.waitFor(() => expect(response("s")).toBeDefined(), { timeout: 10_000 });
		const data = (response("s") as { data: { message: string; error?: true } }).data;
		expect(data.error).toBeUndefined();
		expect(data.message).toContain("abc123");
		expect(ofType("view_open")).toHaveLength(1);
		expect(ofType("view_closed")).toHaveLength(1);
	});

	test("share with native menus: the progress in a panel, its stop and its closing cancel the upload", async () => {
		// A stand-in `gh` that takes as long as asked: nothing leaves the machine.
		const bin = mkdtempSync(join(tmpdir(), "pi-share-gh-"));
		writeFileSync(
			join(bin, "gh"),
			'#!/bin/sh\nif [ "$1" = gist ]; then sleep "$SHARE_DELAY"; echo https://gist.github.com/someone/abc123; fi\n',
			{ mode: 0o755 },
		);
		const previousPath = process.env.PATH;
		process.env.PATH = `${bin}:${previousPath}`;
		cleanups.push(() => {
			process.env.PATH = previousPath;
			delete process.env.SHARE_DELAY;
			setViewsClient();
			rmSync(bin, { recursive: true, force: true });
		});
		const harness = await createHarness({ sessionManager: SessionManager.create(bin, join(bin, "sessions")) });
		harness.setResponses([fauxAssistantMessage("hello")]);
		await start(harness);
		send({ id: "p", type: "prompt", message: "hi" });
		await vi.waitFor(() => expect(ofType("agent_end")).toHaveLength(1));
		send({ id: "v", type: "set_views", columns: 80, rows: 30, nativeMenus: true });
		type Menu = { screenId: string; kind: string; title: string; lines: string[]; hint: string };
		const menu = () => ofType("view_frame").at(-1)?.menu as Menu;
		const viewId = () => String(ofType("view_open").at(-1)?.id);
		const data = (id: string) => (response(id) as { data: { message: string; error?: true } }).data;

		process.env.SHARE_DELAY = "0.3";
		send({ id: "s1", type: "share" });
		await vi.waitFor(() => expect(menu()?.screenId).toBe("progress"));
		expect(menu()).toMatchObject({ kind: "detail", title: "Share", lines: ["Creating gist..."], hint: "stop" });
		await vi.waitFor(() => expect(response("s1")).toBeDefined(), { timeout: 10_000 });
		expect(data("s1").error).toBeUndefined();
		expect(data("s1").message).toContain("abc123");
		expect(ofType("view_closed")).toHaveLength(1);

		// Stop, then closing the panel: the upload is cancelled at once, as with the terminal's cancel key.
		process.env.SHARE_DELAY = "5";
		const started = Date.now();
		send({ id: "s2", type: "share" });
		await vi.waitFor(() => expect(ofType("view_open")).toHaveLength(2));
		await vi.waitFor(() => expect(menu()?.screenId).toBe("progress"));
		send({ id: "b", type: "view_action", viewId: viewId(), action: { kind: "back" } });
		await vi.waitFor(() => expect(response("s2")).toBeDefined(), { timeout: 4_000 });
		expect(data("s2")).toEqual({ message: "Share cancelled" });

		send({ id: "s3", type: "share" });
		await vi.waitFor(() => expect(ofType("view_open")).toHaveLength(3));
		await vi.waitFor(() => expect(menu()?.screenId).toBe("progress"));
		send({ type: "view_close", viewId: viewId() });
		await vi.waitFor(() => expect(response("s3")).toBeDefined(), { timeout: 4_000 });
		expect(data("s3")).toEqual({ message: "Share cancelled" });
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(ofType("view_closed")).toHaveLength(3);
	});

	test("set_language: the window's choice, or the language setting as the terminal resolves it", async () => {
		cleanups.push(() => setLanguage("en"));
		await start(await createHarness({ settings: { language: "fr" } }));
		send({ id: "a", type: "set_language" });
		await vi.waitFor(() => expect(response("a")).toBeDefined());
		expect(response("a")).toMatchObject({ data: { language: "fr" } });
		expect(t("Import cancelled")).not.toBe("Import cancelled");
		send({ id: "b", type: "set_language", language: "en" });
		await vi.waitFor(() => expect(response("b")).toBeDefined());
		expect(response("b")).toMatchObject({ data: { language: "en" } });
		expect(t("Import cancelled")).toBe("Import cancelled");
	});

	// the errors the window shows come in its language.
	test("the window's errors in French: unknown model, empty session name", async () => {
		cleanups.push(() => setLanguage("en"));
		await start(await createHarness({ settings: { language: "fr" } }));
		send({ id: "l", type: "set_language" });
		await vi.waitFor(() => expect(response("l")).toBeDefined());
		send({ id: "m", type: "set_model", provider: "nowhere", modelId: "none" });
		send({ id: "n", type: "set_session_name", name: "  " });
		await vi.waitFor(() => expect(response("n")).toBeDefined());
		expect(response("m")).toMatchObject({ success: false, error: "Modèle introuvable : nowhere/none" });
		expect(response("n")).toMatchObject({ success: false, error: "Le nom de session ne peut pas être vide" });
	});

	// the window shows Prism's light or dark theme as Window › Theme chooses, so its
	// onboarding does not ask for the terminal's theme.
	test("onboarding with native menus skips the terminal's theme and leaves it as it was", async () => {
		const harness = await createHarness({ extensionFactories: [{ name: "onboarding", factory: onboarding }] });
		await start(harness);
		cleanups.push(() => {
			setOnboardingHost(undefined);
			setViewsClient();
			for (const file of ["settings.json", "onboarding.json"]) rmSync(join(agentDir, file), { force: true });
		});
		send({ id: "v", type: "set_views", columns: 80, rows: 30, nativeMenus: true });
		type Menu = { screenId: string; lines: string[]; items: Array<{ id: string; label: string }> };
		const menu = () => ofType("view_frame").at(-1)?.menu as Menu;
		const viewId = () => String(ofType("view_open").at(-1)?.id);
		const choose = async (step: string, label: string) => {
			await vi.waitFor(() => expect(menu()?.screenId).toBe(`step:${step}`));
			const item = menu().items.find((entry) => entry.label === label)!;
			send({ type: "view_action", viewId: viewId(), action: { kind: "activate", itemId: item.id } });
		};
		send({ id: "o", type: "prompt", message: "/onboarding" });
		await choose("language", "English");
		await vi.waitFor(() => expect(menu()?.screenId).toBe("step:display"));
		expect(menu().lines[0]).toContain("Step 2 of");
		await choose("display", "Advanced");
		send({ type: "view_close", viewId: viewId() });
		await vi.waitFor(() => expect(response("o")).toBeDefined());
		// The onboarding wrote its other answers, and no theme.
		const saved = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")) as Record<string, unknown>;
		expect(saved.interfaceMode).toBe("advanced");
		expect(saved.theme).toBeUndefined();
	});

	// « Start the tutorial » asks the window for its own tutorial, never the terminal's view.
	test("onboarding with native menus: Start the tutorial asks the client to open its own", async () => {
		const harness = await createHarness({
			extensionFactories: [
				{ name: "onboarding", factory: onboarding },
				{ name: "tutorial", factory: (pi: ExtensionAPI) => installTutorial(pi, createState()) },
			],
		});
		await start(harness);
		cleanups.push(() => {
			setOnboardingHost(undefined);
			setViewsClient();
			for (const file of ["settings.json", "onboarding.json"]) rmSync(join(agentDir, file), { force: true });
		});
		send({ id: "v", type: "set_views", columns: 80, rows: 30, nativeMenus: true });
		type Item = { id: string; label: string };
		type Menu = { screenId: string; kind: string; items: Item[]; actions?: Item[] };
		const menu = () => ofType("view_frame").at(-1)?.menu as Menu | undefined;
		const viewId = () => String(ofType("view_open").at(-1)?.id);
		const activate = (item: Item) =>
			send({ type: "view_action", viewId: viewId(), action: { kind: "activate", itemId: item.id } });
		send({ id: "o", type: "prompt", message: "/onboarding" });
		const seen: string[] = [];
		while (!seen.includes("step:tutorial")) {
			await vi.waitFor(() => expect(menu()?.screenId).toMatch(/^step:/));
			await vi.waitFor(() => expect(menu()!.screenId).not.toBe(seen.at(-1)));
			const screen = menu()!;
			seen.push(screen.screenId);
			if (screen.kind === "multiSelect") activate(screen.actions!.find((item) => item.label === "Continue")!);
			else {
				const wanted = {
					"step:language": "English",
					"step:permissions": "Ask",
					"step:tutorial": "Start the tutorial",
				}[screen.screenId];
				activate(wanted ? screen.items.find((item) => item.label === wanted)! : screen.items[0]!);
			}
		}
		await vi.waitFor(() => expect(response("o")).toBeDefined());
		expect(ofType("open_tutorial")).toHaveLength(1);
		// One view: the onboarding's native panel. The terminal's tutorial never opened.
		expect(ofType("view_open")).toHaveLength(1);
		expect(ofType("view_frame").some((frame) => (frame.lines as string[] | undefined)?.length)).toBe(false);
	});

	test("session state: a resumed, interrupted session's state goes to the client, not as widget lines", async () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: "slow", timestamp: Date.now() });
		sessionManager.appendMessage(fauxAssistantMessage("partial", { stopReason: "aborted" }));
		const harness = await createHarness({
			sessionManager,
			extensionFactories: [{ name: "session-state", factory: sessionStateExtension }],
		});
		harness.setResponses([fauxAssistantMessage("done")]);
		cleanups.push(() => {
			setSessionStateHost(undefined);
			setViewsClient();
		});
		await start(harness);
		// Sent at startup, before the client says it shows views: a resumed session's first session_start.
		await vi.waitFor(() => expect(ofType("session_state")).toHaveLength(1));
		expect(ofType("session_state")[0].state).toMatchObject({ status: "interrupted", calls: [], checkpoints: [] });
		send({ id: "v", type: "set_views", columns: 80, rows: 30, nativeMenus: true });
		// Shown again once the client shows views (a /reload): still the state, never the widget's lines.
		await harness.session.prompt("/state");
		expect(ofType("session_state")).toHaveLength(2);
		expect(records().some((r) => r.method === "setWidget" && r.widgetKey === "session-state" && r.widgetLines)).toBe(
			false,
		);
		await harness.session.prompt("go on");
		expect(ofType("session_state").at(-1)).toEqual({ type: "session_state", state: null });
	});

	test("clipboard_image gives the window the screenshot the system clipboard holds, or nothing", async () => {
		// WebKitGTK's paste event does not always hand a copied screenshot over.
		const harness = await createHarness();
		await start(harness);
		const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
		rpcIo.clipboardImage.mockResolvedValueOnce({ bytes: png, mimeType: "image/png" });
		send({ id: "p", type: "clipboard_image" });
		await vi.waitFor(() => expect(response("p")).toBeDefined());
		expect(response("p")?.data).toEqual({ data: Buffer.from(png).toString("base64"), mimeType: "image/png" });
		send({ id: "none", type: "clipboard_image" });
		await vi.waitFor(() => expect(response("none")).toBeDefined());
		expect(response("none")?.data).toEqual({});
	});

	test("attach_files and clipboard_files: what each file becomes, and only the files the clipboard holds", async () => {
		// files added in the window; a PDF is a copy the agent reads, not the content.
		const harness = await createHarness();
		await start(harness);
		const outside = mkdtempSync(join(tmpdir(), "prism-rpc-attach-"));
		cleanups.push(() => rmSync(outside, { recursive: true, force: true }));
		const pdf = join(outside, "report.pdf");
		writeFileSync(pdf, "%PDF-1.4\n\0binary");
		const notes = join(outside, "notes.txt");
		writeFileSync(notes, "outside line\n");
		const ask = async (id: string, record: Record<string, unknown>) => {
			send({ id, ...record });
			await vi.waitFor(() => expect(response(id)).toBeDefined());
			return response(id) as { success: boolean; data: { attachments: Array<Record<string, unknown>> } };
		};

		const attached = await ask("a", { type: "attach_files", paths: [notes, pdf, join(outside, "gone.pdf")] });
		expect(attached.data.attachments[0]).toEqual({
			kind: "text",
			name: "notes.txt",
			path: notes,
			text: "outside line\n",
		});
		expect(attached.data.attachments[1]).toMatchObject({ kind: "file", name: "report.pdf", copied: true });
		expect(attached.data.attachments[1]?.note).toMatch(
			/^<file name="[^"]+\/attachments\/report\.pdf">\n\[1 KB, a copy/,
		);
		expect(attached.data.attachments[2]).toMatchObject({ kind: "error", name: "gone.pdf" });
		expect((await ask("bad", { type: "attach_files" })).success).toBe(false);

		// A paste the page saw: attached only when the system clipboard holds the same files.
		rpcIo.clipboardFiles.mockResolvedValueOnce([notes]);
		expect((await ask("c1", { type: "clipboard_files", paths: [pdf] })).data.attachments).toEqual([]);
		rpcIo.clipboardFiles.mockResolvedValueOnce(null);
		expect((await ask("c2", { type: "clipboard_files", paths: [pdf] })).data.attachments).toEqual([]);
		rpcIo.clipboardFiles.mockResolvedValueOnce([pdf]);
		expect((await ask("c3", { type: "clipboard_files", paths: [pdf] })).data.attachments).toEqual([
			expect.objectContaining({ kind: "file", name: "report.pdf", copied: true }),
		]);
	});

	// The editor's completion: the terminal's provider (src/fork/autocomplete.ts), its trigger rule and the
	// extensions' wrappers, for a text and a cursor.
	test("complete and apply_completion: the terminal's commands, arguments, files and trigger rule", async () => {
		const harness = await createHarness();
		await start(harness);
		const ask = async (id: string, record: Record<string, unknown>) => {
			send({ id, ...record });
			await vi.waitFor(() => expect(response(id)).toBeDefined());
			return response(id) as {
				success: boolean;
				data: Record<string, unknown> & { items: Array<{ value: string }> };
			};
		};

		const commands = await ask("c1", { type: "complete", text: "/comp", cursor: 5, typed: "p" });
		expect(commands.data.prefix).toBe("/comp");
		expect(commands.data.items.map((item) => item.value)).toContain("compact");
		// An alias finds its command, as in the terminal's "/" list ("exit" finds "quit").
		const alias = await ask("c2", { type: "complete", text: "/exit", cursor: 5, typed: "t" });
		expect(alias.data.items[0]?.value).toBe("quit");
		// Arguments of a built-in command.
		const thinking = await ask("c3", { type: "complete", text: "/thinking of", cursor: 12, typed: "f" });
		expect(thinking.data.items.map((item) => item.value)).toEqual(["off"]);
		// Plain prose, or a space typed after a word, does not open the list; "/" off the first line does not either.
		expect((await ask("c4", { type: "complete", text: "hello", cursor: 5, typed: "o" })).data.items).toEqual([]);
		expect((await ask("c5", { type: "complete", text: "a\n/comp", cursor: 7, typed: "p" })).data.items).toEqual([]);
		// Files after "@", found by fd in the session's folder.
		const files = await ask("c6", { type: "complete", text: "see @fork-rpc-views.te", cursor: 22, typed: "e" });
		expect(files.data.items.some((item) => item.value.includes("fork-rpc-views.test.ts"))).toBe(true);

		// Tab: the command list on the first word of "/", a path elsewhere; a single path is completed at once.
		const tabCommand = await ask("t1", { type: "complete", text: "/comp", cursor: 5, tab: true });
		expect(tabCommand.data).toMatchObject({ mode: "regular", prefix: "/comp" });
		const tabPath = await ask("t2", { type: "complete", text: "read test/fork-rpc-views.te", cursor: 27, tab: true });
		expect(tabPath.data.applied).toEqual({ text: "read test/fork-rpc-views.test.ts", cursor: 32 });

		const applied = await ask("a1", {
			type: "apply_completion",
			text: "/comp tail",
			cursor: 5,
			item: { value: "compact", label: "compact" },
			prefix: "/comp",
		});
		expect(String(applied.data.text).startsWith("/compact ")).toBe(true);
		expect(applied.data.cursor).toBe("/compact ".length);
		expect(harness.session.sessionManager.getEntries().filter((e) => e.type === "message")).toHaveLength(0);
	});

	test("complete applies the extensions' completion wrappers and their trigger characters", async () => {
		const issues = (pi: ExtensionAPI) => {
			pi.on("session_start", (_event, ctx) => {
				ctx.ui.addAutocompleteProvider((current) => ({
					triggerCharacters: ["~"],
					getSuggestions: async (lines, line, col, options) => {
						const before = (lines[line] ?? "").slice(0, col);
						const match = /~(\w*)$/.exec(before);
						if (match) return { items: [{ value: `~issue-${match[1]}`, label: "issue" }], prefix: match[0] };
						return current.getSuggestions(lines, line, col, options);
					},
					applyCompletion: (lines, line, col, item, prefix) =>
						current.applyCompletion(lines, line, col, item, prefix),
				}));
			});
		};
		const harness = await createHarness({ extensionFactories: [issues] });
		await start(harness);
		send({ id: "w", type: "complete", text: "fix ~4", cursor: 6, typed: "4" });
		await vi.waitFor(() => expect(response("w")).toBeDefined());
		expect(response("w")).toMatchObject({ success: true, data: { items: [{ value: "~issue-4" }], prefix: "~4" } });
		// The base provider still answers under the wrapper.
		send({ id: "b", type: "complete", text: "/comp", cursor: 5, typed: "p" });
		await vi.waitFor(() => expect(response("b")).toBeDefined());
		expect((response("b")?.data as { items: Array<{ value: string }> }).items.map((i) => i.value)).toContain(
			"compact",
		);
	});

	// each search had a signal nobody aborted, so the window's quick edits left every older
	// file walk running. A newer search, or complete_cancel (the window closed its list), stops the one under way.
	test("complete stops the search under way when a newer one or complete_cancel arrives", async () => {
		const signals: AbortSignal[] = [];
		const slow = (pi: ExtensionAPI) => {
			pi.on("session_start", (_event, ctx) => {
				ctx.ui.addAutocompleteProvider((current) => ({
					triggerCharacters: ["~"],
					getSuggestions: async (lines, line, col, options) => {
						if (!(lines[line] ?? "").slice(0, col).includes("~"))
							return current.getSuggestions(lines, line, col, options);
						const signal = options.signal;
						signals.push(signal);
						// A walk that ends only when it is stopped.
						await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
						return { items: [{ value: "~late", label: "late" }], prefix: "~" };
					},
					applyCompletion: (lines, line, col, item, prefix) =>
						current.applyCompletion(lines, line, col, item, prefix),
				}));
			});
		};
		const harness = await createHarness({ extensionFactories: [slow] });
		await start(harness);
		send({ id: "s1", type: "complete", text: "~a", cursor: 2, typed: "a" });
		await vi.waitFor(() => expect(signals).toHaveLength(1));
		send({ id: "s2", type: "complete", text: "~ab", cursor: 3, typed: "b" });
		await vi.waitFor(() => expect(signals).toHaveLength(2));
		expect(signals[0]?.aborted).toBe(true);
		// The stopped search answers nothing.
		await vi.waitFor(() => expect(response("s1")).toBeDefined());
		expect(response("s1")).toMatchObject({ success: true, data: { items: [] } });
		expect(signals[1]?.aborted).toBe(false);
		send({ id: "x", type: "complete_cancel" });
		await vi.waitFor(() => expect(response("x")).toMatchObject({ success: true }));
		expect(signals[1]?.aborted).toBe(true);
		await vi.waitFor(() => expect(response("s2")).toBeDefined());
	});

	// the window does not offer /llama; the terminal keeps it.
	test("complete leaves the window's hidden commands out", async () => {
		const commands = (pi: ExtensionAPI) => {
			pi.registerCommand("llama", { description: "llama.cpp models", handler: async () => {} });
			pi.registerCommand("llamas", { description: "another command", handler: async () => {} });
		};
		const harness = await createHarness({ extensionFactories: [commands] });
		await start(harness);
		send({ id: "h", type: "complete", text: "/lla", cursor: 4, typed: "a" });
		await vi.waitFor(() => expect(response("h")).toBeDefined());
		const values = (response("h")?.data as { items: Array<{ value: string }> }).items.map((i) => i.value);
		expect(values).toContain("llamas");
		expect(values).not.toContain("llama");
	});

	// fork: JSON that is not a command gets a refusal, and the engine stays up.
	test("refuses a line that is JSON but not a command, then answers the next one", async () => {
		const harness = await createHarness();
		await start(harness);
		const rejections: unknown[] = [];
		const onRejection = (reason: unknown) => rejections.push(reason);
		process.on("unhandledRejection", onRejection);
		cleanups.push(() => process.off("unhandledRejection", onRejection));
		const lines = ["null", "1", '"x"', "[]", "{}", '{"type":1}', '{"id":"n","type":null}'];
		for (const line of lines) rpcIo.lineHandler?.(line);
		send({ id: "s", type: "get_state" });
		await vi.waitFor(() => expect(response("s")).toMatchObject({ success: true }));
		expect(rejections).toEqual([]);
		expect(records().filter((record) => record.success === false)).toHaveLength(lines.length);
	});

	// fork: a view whose factory fails, at once or later, is closed for the
	// client and takes no more input.
	test("a view factory that throws at once or rejects later closes its view", async () => {
		const failing = (pi: ExtensionAPI) => {
			for (const [name, factory] of [
				[
					"sync",
					() => {
						throw new Error("sync factory");
					},
				],
				[
					"async",
					async () => {
						throw new Error("async factory");
					},
				],
			] as const) {
				pi.registerCommand(name, {
					description: name,
					handler: async (_args, ctx) => {
						try {
							await ctx.ui.custom(factory as never);
						} catch (error) {
							ctx.ui.notify(`failed:${(error as Error).message}`);
						}
					},
				});
			}
		};
		const harness = await createHarness({ extensionFactories: [failing] });
		await start(harness);
		send({ id: "v", type: "set_views", columns: 60, rows: 20 });
		await vi.waitFor(() => expect(response("v")).toMatchObject({ success: true }));
		for (const name of ["sync", "async"]) {
			send({ id: name, type: "prompt", message: `/${name}` });
			await vi.waitFor(() => expect(notified(`failed:${name} factory`)).toBe(true));
		}
		const opened = ofType("view_open").map((record) => record.id);
		expect(opened).toHaveLength(2);
		expect(ofType("view_closed").map((record) => record.id)).toEqual(opened);
		for (const id of opened) {
			send({ id: `late-${id}`, type: "view_input", viewId: id, data: "x" });
			expect(response(`late-${id}`)).toMatchObject({ success: false });
		}
	});
});
