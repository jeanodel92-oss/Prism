/**
 * fork: what /context and the footer say of the context.
 * - the parts of /context counted the raw branch, so a tool result a compaction or a context edit had taken
 *   out of the context still filled the "tools" part, in the window (rpc-inspect) and in the terminal (vendored).
 * - the buffer and "free" figures used the default reserve, not where the engine starts auto-compaction.
 * - the footer's "auto" kept the value read when its folder was first drawn.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { ContextUsage, ExtensionAPI } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createFooterFactory } from "../src/fork/prism/footer.ts";
import type { ContextInfo } from "../src/fork/prism/footer-actions.ts";
import { createState } from "../src/fork/prism/lib/state.ts";
import { handleInspectCommand } from "../src/fork/rpc-inspect.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { loadVendored } from "./fork-vendored-module.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

type Parts = { tools: number; messages: number; total: number; reserveTokens: number; safeAvailable: number };
const usage: ContextUsage = { tokens: 1000, contextWindow: 100_000, percent: 1 };

/** A big read result summarised by a compaction, then another one removed by a context edit. */
function fillSession(manager: SessionManager): void {
	const read = (id: string) =>
		manager.appendMessage({
			...fauxAssistantMessage(""),
			content: [{ type: "toolCall", id, name: "read", arguments: { path: "log.txt" } }],
		});
	const result = (id: string) =>
		manager.appendMessage({
			role: "toolResult",
			toolCallId: id,
			toolName: "read",
			content: [{ type: "text", text: "L".repeat(200_000) }],
			isError: false,
			timestamp: 1,
		});
	manager.appendMessage({ role: "user", content: "read the log", timestamp: 1 });
	read("c1");
	result("c1");
	const kept = manager.appendMessage({ role: "user", content: "and now?", timestamp: 1 });
	manager.appendCompaction("The log was read.", kept, 50_000);
	read("c2");
	const second = result("c2");
	manager.appendContextEdit(second, { content: "[removed]" });
}

describe("fork: /context's parts and buffer, the footer's auto", () => {
	const harnesses: Harness[] = [];
	const dirs: string[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
		delete (globalThis as Record<symbol, unknown>)[Symbol.for("prism.context")];
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	async function windowContext(settings: object = {}): Promise<{ breakdown: Parts; compaction: { auto: string } }> {
		const harness = await createHarness({ settings });
		harnesses.push(harness);
		fillSession(harness.sessionManager);
		harness.session.getContextUsage = () => usage;
		return (await handleInspectCommand({ type: "get_context" }, harness.session)) as never;
	}

	it("leaves out of the window's parts what compaction and context edits took out", async () => {
		const { breakdown } = await windowContext();
		// Two 50k-token results are out of the context: the tool calls left weigh a few tokens of the 1000.
		expect(breakdown.tools).toBeLessThan(50);
		expect(breakdown.total).toBe(1000);
	});

	it("gives the window's buffer from where auto-compaction starts, and none when it is off", async () => {
		const half = await windowContext({ compaction: { thresholdPercent: 50 } });
		expect(half.compaction.auto).toContain("50%");
		expect(half.breakdown.reserveTokens).toBe(50_000);
		expect(half.breakdown.safeAvailable).toBe(49_000);
		const off = await windowContext({ compaction: { enabled: false } });
		expect(off.breakdown.reserveTokens).toBe(0);
		expect(off.breakdown.safeAvailable).toBe(99_000);
	});

	it("does the same in the terminal's /context", async () => {
		const path = new URL("../vendor/forks/pi-context-inspector/src/index.ts", import.meta.url).pathname;
		const { default: extension } = await loadVendored<{ default: (pi: ExtensionAPI) => void }>(path);
		let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
		extension({
			registerCommand: (_name: string, command: { handler: typeof handler }) => {
				handler = command.handler;
			},
			getAllTools: () => [],
			getActiveTools: () => [],
		} as never);
		const manager = SessionManager.inMemory();
		fillSession(manager);
		const breakdownWith = async (threshold: number | null): Promise<Parts> => {
			(globalThis as Record<symbol, unknown>)[Symbol.for("prism.context")] = {
				compaction: () => "line",
				threshold: () => threshold,
				compact() {},
				settings() {},
			};
			let parts: Parts | undefined;
			await handler!("", {
				hasUI: true,
				getSystemPrompt: () => "S".repeat(40_000),
				getContextUsage: () => usage,
				sessionManager: manager,
				model: { id: "m", contextWindow: 100_000 },
				ui: {
					notify() {},
					custom: async (factory: (...args: unknown[]) => { opts: { tabs: Array<{ breakdown: Parts }> } }) => {
						parts = factory({ requestRender() {} }, theme, {}, () => {}).opts.tabs[0]!.breakdown;
					},
				},
			});
			return parts!;
		};
		initTheme("prism");
		const half = await breakdownWith(50_000);
		expect(half.tools).toBeLessThan(50);
		expect(half.reserveTokens).toBe(50_000);
		expect(half.safeAvailable).toBe(49_000);
		expect((await breakdownWith(null)).reserveTokens).toBe(0);
	});

	it("updates the footer's auto when auto-compaction is turned off in the same folder", () => {
		initTheme("prism");
		const root = mkdtempSync(join(tmpdir(), "prism-footer-auto-"));
		dirs.push(root);
		const writeEnabled = (enabled: boolean) =>
			writeFileSync(join(root, "settings.json"), JSON.stringify({ compaction: { enabled } }));
		vi.stubEnv(ENV_AGENT_DIR, root);
		writeEnabled(true);
		const state = createState();
		state.theme = theme;
		let seen: ContextInfo | undefined;
		state.contextSeen = (info) => {
			seen = info;
		};
		state.ctx = {
			cwd: root,
			isProjectTrusted: () => true,
			model: { provider: "p", id: "m", contextWindow: 100_000 },
			modelRegistry: { isUsingOAuth: () => false },
			getContextUsage: () => usage,
			sessionManager: {
				getEntries: () => [],
				getSessionId: () => "s",
				getLeafId: () => "l",
				getCwd: () => root,
				getSessionName: () => undefined,
			},
		} as never;
		const footer = createFooterFactory(state)({ requestRender() {} }, theme, {
			getGitBranch: () => undefined,
			getExtensionStatuses: () => new Map(),
			onBranchChange: () => () => {},
		});
		const plain = () => footer.render(120)[0]!.replace(/\x1b\[[0-9;:]*m/g, "");
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);
		expect(plain()).toContain(" auto");
		expect(seen?.auto).toBe(true);
		writeEnabled(false);
		// The footer reads the settings again at most every 2 s.
		now += 3000;
		expect(plain()).not.toContain(" auto");
		expect(seen).toMatchObject({ auto: false, mark: undefined });
	});
});
