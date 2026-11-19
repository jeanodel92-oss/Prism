import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { importExtensionFactory } from "../src/core/extensions/loader.ts";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "../src/core/extensions/types.ts";
import { RpcViews } from "../src/fork/rpc-views.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { runMenu } from "../vendor/forks/pi-tui-kit/index.js";

interface NativeComponent {
	nativeMenu: { kind: string; title: string };
	handleNativeMenuInput(input: unknown): boolean;
}
type Factory = (tui: undefined, theme: undefined, keys: undefined, done: (input: unknown) => void) => NativeComponent;

const host = globalThis as Record<symbol, unknown>;
const symbol = Symbol.for("prism.hasNativeMenus");
const previous = host[symbol];
let testAgentDir: string;
let previousAgentDir: string | undefined;
beforeEach(() => {
	previousAgentDir = process.env[ENV_AGENT_DIR];
	testAgentDir = mkdtempSync(join(tmpdir(), "prism-menu-test-"));
	process.env[ENV_AGENT_DIR] = testAgentDir;
});
afterEach(() => {
	host[symbol] = previous;
	if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = previousAgentDir;
	rmSync(testAgentDir, { recursive: true, force: true });
});

describe("graphical pi-tui-kit adapter", () => {
	it("closes a parent menu when its nested panel is closed", async () => {
		host[symbol] = () => true;
		let shown = 0;
		const ctx = {
			mode: "rpc" as const,
			hasUI: true,
			ui: {
				custom: (factory: Factory) =>
					new Promise((done) => {
						shown++;
						const view = factory(undefined, undefined, undefined, done);
						if (shown === 1) view.handleNativeMenuInput({ kind: "activate", itemId: "settings" });
						else if (shown === 2) done(undefined);
						else view.handleNativeMenuInput({ kind: "activate", itemId: "close" });
					}),
			},
		};
		const result = await runMenu(
			ctx,
			{
				start: "main",
				screens: {
					main: () => ({
						kind: "actions",
						title: "Main",
						items: [
							{ id: "settings", label: "Settings", action: "settings" },
							{ id: "close", label: "Close", close: true },
						],
					}),
				},
				actions: {
					settings: async () => {
						await runMenu(
							ctx,
							{
								start: "settings",
								screens: { settings: () => ({ kind: "detail", title: "Settings", lines: [] }) },
								actions: {},
							},
							{ getState: () => undefined },
						);
					},
				},
			},
			{ getState: () => undefined },
		);
		expect(result).toEqual({ kind: "closed", reason: "close" });
		expect(shown).toBe(2);
	});

	it("carries structured screens and rejects actions for an expired view", async () => {
		initTheme("dark");
		const records: Array<Record<string, unknown>> = [];
		const views = new RpcViews((record) => records.push(record as Record<string, unknown>));
		views.handleCommand({ type: "set_views", columns: 80, rows: 24, nativeMenus: true });
		const options = { overlay: true, nativeMenu: true };
		const result = views.custom(
			(_tui, _theme, _keys, done) => ({
				nativeMenu: { kind: "actions", title: "Native", items: [] },
				render: () => [],
				invalidate() {},
				handleNativeMenuInput(input: unknown) {
					if (input !== "valid") return false;
					done(input);
					return true;
				},
			}),
			options,
		);
		await Promise.resolve();
		expect(records.find((record) => record.type === "view_open")?.nativeMenu).toBe(true);
		const frame = records.find((record) => record.type === "view_frame");
		expect(frame?.menu).toMatchObject({ title: "Native" });
		const viewId = frame!.id;
		expect(views.handleCommand({ type: "view_action", viewId, action: "invalid" })).toMatchObject({ success: false });
		expect(views.handleCommand({ type: "view_action", viewId, action: "valid" })).toMatchObject({ success: true });
		expect(await result).toBe("valid");
		expect(views.handleCommand({ type: "view_action", viewId, action: "valid" })).toMatchObject({ success: false });
		views.handleCommand({ type: "set_views", columns: 80, rows: 24 });
	});

	it("applies the built-in loader alias rather than silently loading the original kit", async () => {
		const dir = mkdtempSync(join(tmpdir(), "prism-native-menu-"));
		const agentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = dir;
		try {
			const entry = join(dir, "extension.ts");
			writeFileSync(
				entry,
				`import { runMenu } from "@narumitw/pi-tui-kit";
export default (pi) => pi.registerCommand("probe", { handler: (_args, ctx) => runMenu(ctx, {
start: "main", screens: { main: () => ({ kind: "actions", title: "Aliased", items: [{ id: "close", label: "Close", close: true }] }) }, actions: {}
}, { getState: () => undefined }) });`,
			);
			const factory = await importExtensionFactory(entry, {
				"@narumitw/pi-tui-kit": fileURLToPath(new URL("../vendor/forks/pi-tui-kit/index.js", import.meta.url)),
			});
			let command: Omit<RegisteredCommand, "name" | "sourceInfo"> | undefined;
			await factory!({
				registerCommand: (_name, options) => {
					command = options;
				},
			} as ExtensionAPI);
			host[symbol] = () => true;
			let shown = false;
			await command!.handler("", {
				mode: "rpc",
				hasUI: true,
				ui: {
					custom: (factory: Factory) =>
						new Promise((done) => {
							const view = factory(undefined, undefined, undefined, done);
							shown = view.nativeMenu.title === "Aliased";
							view.handleNativeMenuInput({ kind: "activate", itemId: "close" });
						}),
				},
			} as unknown as ExtensionCommandContext);
			expect(shown).toBe(true);
		} finally {
			if (agentDir === undefined) delete process.env[ENV_AGENT_DIR];
			else process.env[ENV_AGENT_DIR] = agentDir;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps checkbox changes and text submission in the original action handlers", async () => {
		host[symbol] = () => true;
		let selected = false;
		let text = "";
		const inputs = [
			{ kind: "multiSelect", itemId: "one", selected: true },
			{ kind: "activate", itemId: "next" },
			{ kind: "input", value: "user text" },
		];
		const ctx = {
			mode: "rpc" as const,
			hasUI: true,
			ui: {
				custom: (factory: Factory) =>
					new Promise((done) => {
						const view = factory(undefined, undefined, undefined, done);
						for (const input of [
							{ kind: "multiSelect", itemId: "one", selected: "yes" },
							{ kind: "activate", itemId: "locked" },
							{ kind: "input", value: 1 },
						])
							expect(view.handleNativeMenuInput(input)).toBe(false);
						expect(view.handleNativeMenuInput(inputs.shift())).toBe(true);
					}),
			},
		};
		const result = await runMenu(
			ctx,
			{
				start: "pick",
				screens: {
					pick: () => ({
						kind: "multiSelect",
						title: "Pick",
						items: [
							{ id: "one", label: "One", selected },
							{ id: "locked", label: "Locked", selected: false, disabled: true },
						],
						action: "toggle",
						actions: [{ id: "next", label: "Next", to: "text" }],
					}),
					text: () => ({ kind: "input", title: "Text", action: "submit" }),
				},
				actions: {
					toggle: (context) => {
						selected = context.selected!;
					},
					submit: (context) => {
						text = context.value!;
						return { kind: "close" };
					},
				},
			},
			{ getState: () => undefined },
		);
		expect(result).toEqual({ kind: "closed", reason: "close" });
		expect(selected).toBe(true);
		expect(text).toBe("user text");
	});

	it("keeps the original actions, supports direct setting values and rejects invalid input", async () => {
		host[symbol] = () => true;
		let value = "low";
		const inputs = [
			{ kind: "activate", itemId: "settings" },
			{ kind: "setting", itemId: "limit", value: "high" },
			{ kind: "back" },
			{ kind: "activate", itemId: "close" },
		];
		const seen: string[] = [];
		const ctx = {
			mode: "rpc" as const,
			hasUI: true,
			ui: {
				custom: (factory: Factory) =>
					new Promise((done) => {
						const view = factory(undefined, undefined, undefined, done);
						seen.push(view.nativeMenu.title);
						for (const invalid of [
							null,
							{},
							{ kind: "activate", itemId: "missing" },
							{ kind: "setting", itemId: "limit", value: "invalid" },
						]) {
							expect(view.handleNativeMenuInput(invalid)).toBe(false);
						}
						expect(view.handleNativeMenuInput(inputs.shift())).toBe(true);
					}),
			},
		};
		const result = await runMenu(
			ctx,
			{
				start: "main",
				screens: {
					main: () => ({
						kind: "actions",
						title: "Main",
						items: [
							{ id: "settings", label: "Settings", to: "settings" },
							{ id: "close", label: "Close", close: true },
						],
					}),
					settings: () => ({
						kind: "settings",
						title: "Settings",
						items: [
							{
								id: "limit",
								label: "Limit",
								currentValue: value,
								values: ["low", "medium", "high"],
								action: "set",
							},
						],
					}),
				},
				actions: {
					set: (context) => {
						expect(context.ctx).toBe(ctx);
						value = context.value!;
					},
				},
			},
			{ getState: () => undefined },
		);
		expect(result).toEqual({ kind: "closed", reason: "close" });
		expect(value).toBe("high");
		expect(seen).toEqual(["Main", "Settings", "Settings", "Main"]);
		expect(inputs).toHaveLength(0);
	});

	it("shows a full review while retaining the original confirmation and cancellation", async () => {
		host[symbol] = () => true;
		let applied = false;
		for (const cancel of [true, false]) {
			const ctx = {
				mode: "rpc" as const,
				hasUI: true,
				ui: {
					custom: (factory: Factory) =>
						new Promise((done) => {
							const view = factory(undefined, undefined, undefined, done);
							expect(view.nativeMenu.kind).toBe("review");
							if (cancel) done(undefined);
							else expect(view.handleNativeMenuInput({ kind: "activate", itemId: "apply" })).toBe(true);
						}),
				},
			};
			expect(
				await runMenu(
					ctx,
					{
						start: "review",
						screens: {
							review: () => ({
								kind: "review",
								title: "Review",
								content: "long review\n".repeat(100),
								confirm: { id: "apply", label: "Apply", action: "apply" },
							}),
						},
						actions: {
							apply: () => {
								applied = true;
								return { kind: "close" };
							},
						},
					},
					{ getState: () => undefined },
				),
			).toEqual({ kind: "closed", reason: "close" });
			expect(applied).toBe(!cancel);
		}
	});

	it("keeps the dialog runtime when a client has not advertised native menus", async () => {
		host[symbol] = () => false;
		let selected = false;
		const ctx = {
			mode: "rpc" as const,
			hasUI: true,
			ui: {
				select: async () => {
					selected = true;
					return "Close";
				},
			},
		};
		const result = await runMenu(
			ctx,
			{
				start: "main",
				screens: {
					main: () => ({ kind: "actions", title: "Main", items: [{ id: "close", label: "Close", close: true }] }),
				},
				actions: {},
			},
			{ getState: () => undefined },
		);
		expect(selected).toBe(true);
		expect(result).toEqual({ kind: "closed", reason: "close" });
	});
});
