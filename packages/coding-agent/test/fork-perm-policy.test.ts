// fork: permissions by capability, time-limited permissions and the /perm window
//.
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { ExtensionUIContext, InlineExtension, ToolDefinition } from "../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import { PermView } from "../src/fork/perm-view.ts";
import permissionsExtension, {
	decidePermission,
	type Mode,
	modePolicy,
	POLICY_ROWS,
	type PolicyRow,
} from "../src/fork/permissions.ts";
import { realPath } from "../src/fork/real-path.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, createTestUiContext, getToolResult, type Harness } from "./suite/harness.ts";

// These tests run a real `npm test` in the sandbox, whose private /tmp hides test.sh's npm cache: npm would then
// look for its own update on the network and the sandbox would ask about registry.npmjs.org.
process.env.NPM_CONFIG_UPDATE_NOTIFIER = "false";

const MODES: Mode[] = ["safe", "ask", "broad", "unrestricted"];

/** The table of the mockup the maintainer approved on 2026-10-20: ✓ allow, ? ask, ?! danger, ✗ block. */
const APPROVED: Record<PolicyRow, string> = {
	read: "✓ ✓ ✓ ✓",
	// fork: only while reading is limited to the project.
	"read-outside": "? ? ? ✓",
	"write-project": "✗ ? ✓ ✓",
	"write-outside": "✗ ?! ?! ✓",
	"process-safe": "✓ ✓ ✓ ✓",
	"process-other": "✗ ? ✓ ✓",
	network: "? ? ✓ ✓",
	// a browser or a desktop is asked about even in broad mode, once per grant.
	computer: "? ? ? ✓",
	privilege: "✗ ?! ?! ✓",
	"security-config": "✗ ✗ ✗ ✗",
	undeclared: "✗ ✗ ✓ ✓",
};
const MARK = { allow: "✓", ask: "?", danger: "?!", block: "✗" } as const;

describe("fork: permissions by capability", () => {
	let root: string;
	let agentDir: string;
	let project: string;
	const saved = { home: process.env.HOME, agentDir: process.env[ENV_AGENT_DIR] };

	beforeEach(() => {
		root = realPath(mkdtempSync(join(tmpdir(), "prism-perm-policy-")));
		agentDir = join(root, "home", ".pi", "agent");
		project = join(root, "home", "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(project, ".git"), { recursive: true });
		process.env.HOME = join(root, "home");
		process.env[ENV_AGENT_DIR] = agentDir;
	});

	afterEach(() => {
		vi.useRealTimers();
		process.env.HOME = saved.home;
		if (saved.agentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = saved.agentDir;
		rmSync(root, { recursive: true, force: true });
	});

	it("draws the approved table", () => {
		for (const row of POLICY_ROWS) {
			expect([row, MODES.map((mode) => MARK[modePolicy(mode, row)]).join(" ")]).toEqual([row, APPROVED[row]]);
		}
	});

	describe("the gate decides as the table says", () => {
		const declared = (permissions: ToolDefinition["permissions"]) => ({ declaration: { permissions } });
		const calls: Record<PolicyRow, () => [string, Record<string, unknown>, ReturnType<typeof declared>?]> = {
			read: () => ["read", { path: "notes.txt" }],
			"read-outside": () => {
				writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sandbox: { read: { limit: "project" } } }));
				return ["read", { path: join(root, "home", "Documents", "x.txt") }];
			},
			"write-project": () => ["write", { path: "notes.txt", content: "x" }],
			// Not /tmp itself, which broad mode writes freely: the home folder, under it here.
			"write-outside": () => ["write", { path: join(root, "home", "elsewhere.txt"), content: "x" }],
			"process-safe": () => ["bash", { command: "git status" }],
			"process-other": () => ["bash", { command: "npm test" }],
			network: () => ["web_fetch", { url: "https://example.com" }, declared(["network"])],
			computer: () => ["tool", {}, declared(["computer"])],
			privilege: () => ["tool", {}, declared(["privilege"])],
			"security-config": () => ["edit", { path: join(agentDir, "settings.json"), edits: [] }],
			undeclared: () => ["mystery", {}],
		};
		const effect = { allow: "allow", ask: "prompt", danger: "prompt", block: "block" } as const;

		for (const row of POLICY_ROWS) {
			it.each(MODES)(`${row} in %s mode`, (mode) => {
				const [tool, input, options] = calls[row]();
				const verdict = modePolicy(mode, row);
				const decision = decidePermission(tool, input, project, { mode }, options);
				expect(decision.effect).toBe(effect[verdict]);
				if (verdict === "danger") expect(decision.tier).toBe("danger");
				if (verdict === "ask") expect(decision.tier).toBe("ask");
			});
		}

		it("takes the strictest verdict of a tool's effects", () => {
			const both = declared(["fs.read", "network", "process"]);
			expect(decidePermission("tool", {}, project, { mode: "safe" }, both).effect).toBe("block");
			expect(decidePermission("tool", {}, project, { mode: "ask" }, both).reason).toContain("network access");
			expect(decidePermission("tool", {}, project, { mode: "broad" }, both).effect).toBe("allow");
		});

		it("judges a declared write by its path, and a computed declaration by the call's input", () => {
			const writes = declared((input) => [{ capability: "fs.write", path: String(input.path) }]);
			expect(decidePermission("tool", { path: "notes.txt" }, project, { mode: "broad" }, writes).effect).toBe(
				"allow",
			);
			expect(
				decidePermission("tool", { path: join(root, "elsewhere.txt") }, project, { mode: "broad" }, writes).tier,
			).toBe("danger");
		});

		it("lets an MCP tool's hints decide, and a rule allow an undeclared tool", () => {
			const mcp = (annotations: Record<string, boolean>) => ({
				declaration: { namespace: { name: "mcp__docs", description: "" }, annotations },
			});
			expect(
				decidePermission("lookup", {}, project, { mode: "safe" }, mcp({ readOnlyHint: true, openWorldHint: false }))
					.effect,
			).toBe("allow");
			expect(decidePermission("lookup", {}, project, { mode: "safe" }, mcp({ readOnlyHint: true })).effect).toBe(
				"prompt",
			);
			expect(decidePermission("mystery", {}, project, { mode: "ask", allow: ["mystery"] }).effect).toBe("allow");
		});

		// fork (SEC-03): the outbound channels other than web_fetch and bash. Their destination is one the user configured
		// (an MCP server): a question in ask mode, none in broad mode.
		it("asks before a message leaves through an open-world MCP tool, except in broad mode", () => {
			const mcp = { declaration: { namespace: { name: "mcp__docs", description: "" }, annotations: {} } };
			const calls: [string, Record<string, unknown>, typeof mcp | undefined][] = [
				["lookup", { query: "sk-canary" }, mcp],
			];
			for (const [tool, input, declaration] of calls) {
				expect(decidePermission(tool, input, project, { mode: "ask" }, declaration).effect).toBe("prompt");
				// Safe mode refuses an MCP tool that may act (no read-only hint), and asks for a message.
				expect(decidePermission(tool, input, project, { mode: "safe" }, declaration).effect).toBe(
					declaration ? "block" : "prompt",
				);
				expect(decidePermission(tool, input, project, { mode: "broad" }, declaration).effect).toBe("allow");
				expect(decidePermission(tool, input, project, { mode: "broad", deny: [tool] }, declaration).effect).toBe(
					"block",
				);
			}
		});

		it("asks for the MCP resource tools rather than refusing them as undeclared", () => {
			for (const tool of ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]) {
				expect(decidePermission(tool, {}, project, { mode: "ask" }).effect).toBe("prompt");
			}
		});

		it("an ask rule makes a call ask in ask mode; broad mode skips ask rules", () => {
			writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ ask: ["read(notes.txt)"] }));
			expect(decidePermission("read", { path: "notes.txt" }, project, { mode: "ask" }).effect).toBe("prompt");
			expect(decidePermission("read", { path: "notes.txt" }, project, { mode: "broad" }).effect).toBe("allow");
		});

		it("judges a write through a symlink to a security setting as a security setting", () => {
			writeFileSync(join(agentDir, "trust.json"), "{}");
			symlinkSync(join(agentDir, "trust.json"), join(project, "innocent.json"));
			const decision = decidePermission("write", { path: "innocent.json", content: "{}" }, project, {
				mode: "broad",
			});
			expect(decision).toMatchObject({ effect: "block", tier: "danger" });
		});
	});

	describe("time-limited permissions", () => {
		const start = Date.UTC(2026, 9, 20, 14, 0, 0);
		const timed = [{ rule: "bash(npm test*)", effect: "allow" as const, until: start + 15 * 60_000 }];
		const at = (ms: number) =>
			decidePermission("bash", { command: "npm test" }, project, { mode: "ask", timed }, { now: start + ms }).effect;

		it("are valid at 14 min 59 s and expired at 15 min", () => {
			expect(at(14 * 60_000 + 59_000)).toBe("allow");
			expect(at(15 * 60_000)).toBe("prompt");
		});

		it("a time-limited block applies until its date", () => {
			const block = [{ rule: "bash(npm test*)", effect: "deny" as const, until: start + 60_000 }];
			const decide = (now: number) =>
				decidePermission("bash", { command: "npm test" }, project, { mode: "broad", timed: block }, { now }).effect;
			expect(decide(start)).toBe("block");
			expect(decide(start + 60_000)).toBe("allow");
		});
	});
});

describe("fork: the gate in a session", () => {
	let agentDir: string;
	const savedAgentDir = process.env[ENV_AGENT_DIR];
	const harnesses: Harness[] = [];

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-perm-session-"));
		process.env[ENV_AGENT_DIR] = agentDir;
		// These sessions start in ask mode; without a configured mode Prism starts in broad.
		writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode: "ask" }));
	});

	afterEach(() => {
		vi.useRealTimers();
		for (const harness of harnesses.splice(0)) harness.cleanup();
		if (savedAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = savedAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	});

	const tool = (name: string, permissions?: ToolDefinition["permissions"]): InlineExtension => ({
		name,
		factory: (pi) =>
			pi.registerTool({
				name,
				label: name,
				description: name,
				parameters: Type.Object({}),
				...(permissions ? { permissions } : {}),
				execute: async () => ({ content: [{ type: "text", text: `${name} ran` }], details: {} }),
			}),
	});

	async function start(options: {
		answer?: (title: string, options: string[]) => string | undefined;
		extensions?: InlineExtension[];
		sessionManager?: SessionManager;
		ui?: Partial<ExtensionUIContext>;
	}) {
		const harness = await createHarness({
			extensionFactories: [{ name: "permissions", factory: permissionsExtension }, ...(options.extensions ?? [])],
			sessionManager: options.sessionManager,
		});
		harnesses.push(harness);
		const titles: string[] = [];
		const notes: string[] = [];
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				select: async (title, selectOptions) => {
					titles.push(title.split("\n")[0]!);
					return options.answer?.(title, selectOptions);
				},
				notify: (message) => void notes.push(message),
				...options.ui,
			}),
		});
		return { harness, titles, notes };
	}

	async function call(harness: Harness, name: string, input: Parameters<typeof fauxToolCall>[1]) {
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall(name, input), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
	}

	async function command(harness: Harness, text: string) {
		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt(text);
	}

	const resultText = (harness: Harness, name: string) => JSON.stringify(getToolResult(harness, name).content);

	it("refuses an undeclared tool in ask and safe, tells the user once, and runs it in broad", async () => {
		const { harness, titles, notes } = await start({ extensions: [tool("mystery")] });
		await call(harness, "mystery", {});
		await call(harness, "mystery", {});
		expect(titles).toEqual([]);
		expect(resultText(harness, "mystery")).toContain("declares no permissions");
		expect(notes.filter((note) => note.includes("/perm allow mystery"))).toHaveLength(1);
		await command(harness, "/perm mode broad");
		await call(harness, "mystery", {});
		expect(resultText(harness, "mystery")).toContain("mystery ran");
	});

	it("asks for a declared network tool in ask and safe, not in broad", async () => {
		const { harness, titles } = await start({
			extensions: [tool("fetcher", ["network"])],
			answer: () => "Block this action once",
		});
		await call(harness, "fetcher", {});
		await command(harness, "/perm mode safe");
		await call(harness, "fetcher", {});
		await command(harness, "/perm mode broad");
		await call(harness, "fetcher", {});
		expect(titles).toEqual(["Allow this action? fetcher", "Allow this action? fetcher"]);
		expect(resultText(harness, "fetcher")).toContain("fetcher ran");
	});

	it("asks once in broad mode for a browser or a desktop, then the answer covers the session", async () => {
		const { harness, titles } = await start({
			extensions: [tool("pilot", ["network", "computer"])],
			answer: (_title, options) => options.find((option) => option.endsWith("in this session")),
		});
		await command(harness, "/perm mode broad");
		await call(harness, "pilot", {});
		await call(harness, "pilot", {});
		await call(harness, "pilot", {});
		expect(titles).toEqual(["Allow this action? pilot"]);
		expect(resultText(harness, "pilot")).toContain("pilot ran");
	});

	it("refuses a nested call the mode refuses: codemode-style tools cannot go around the gate", async () => {
		const nested: InlineExtension = {
			name: "runner",
			factory: (pi) =>
				pi.registerTool({
					name: "run_tools",
					label: "run_tools",
					description: "Runs tools.",
					parameters: Type.Object({}),
					permissions: ["none"],
					execute: async (_id, _params, _signal, _onUpdate, ctx) => {
						const outcomes = [
							await ctx.executeTool("write", { path: "nested.txt", content: "x" }),
							await ctx.executeTool("bash", { command: "touch nested-bash" }),
							await ctx.executeTool("fetcher", {}),
							await ctx.executeTool("mystery", {}),
						];
						const text = outcomes.map((o) => (o.result.content[0] as { text: string }).text).join(" | ");
						return { content: [{ type: "text", text }], details: {} };
					},
				}),
		};
		const { harness } = await start({ extensions: [nested, tool("fetcher", ["network"]), tool("mystery")] });
		await command(harness, "/perm mode safe");
		await call(harness, "run_tools", {});
		const text = resultText(harness, "run_tools");
		expect(text).not.toContain("fetcher ran");
		expect(text).not.toContain("mystery ran");
		expect(existsSync(join(harness.tempDir, "nested.txt"))).toBe(false);
		expect(existsSync(join(harness.tempDir, "nested-bash"))).toBe(false);
	});

	it("judges the final input: an extension that rewrites a call is checked on what will run", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "prism-perm-final-"));
		try {
			const rewriter = join(cwd, "rewrite.ts");
			writeFileSync(
				rewriter,
				`export default function (pi) {
  pi.on("tool_call", (event) => {
    if (event.toolName === "bash") event.input.command = "touch rewritten";
  });
}`,
			);
			const gate = builtInExtensions.find(
				(extension) => typeof extension !== "function" && extension.name === "permissions",
			)!;
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				extensionFactories: [gate],
				additionalExtensionPaths: [rewriter],
			});
			await loader.reload();
			const harness = await createHarness({ resourceLoader: loader });
			harnesses.push(harness);
			await harness.session.bindExtensions({});
			await command(harness, "/perm mode safe");
			await call(harness, "bash", { command: "ls" });
			expect(resultText(harness, "bash")).toContain("Blocked by safe mode");
			expect(existsSync(join(harness.tempDir, "rewritten"))).toBe(false);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("offers 15 minutes; the permission expires at its date, also after the session is reopened", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const t0 = Date.UTC(2026, 9, 20, 14, 0, 0);
		vi.setSystemTime(t0);
		const sessionDir = join(agentDir, "sessions");
		const cwd = join(agentDir, "ws");
		mkdirSync(sessionDir);
		mkdirSync(cwd);
		const minutes = (options: string[]) => options.find((option) => option.endsWith("for 15 minutes"));
		const first = await start({
			sessionManager: SessionManager.create(cwd, sessionDir),
			answer: (_title, options) => minutes(options),
		});
		await call(first.harness, "bash", { command: "npm test" });
		expect(first.titles).toHaveLength(1);
		vi.setSystemTime(t0 + 14 * 60_000 + 59_000);
		await call(first.harness, "bash", { command: "npm test" });
		expect(first.titles).toHaveLength(1);

		const reopen = () =>
			start({
				sessionManager: SessionManager.open(first.harness.session.sessionFile!, sessionDir),
				answer: () => "Block this action once",
			});
		const before = await reopen();
		await call(before.harness, "bash", { command: "npm test" });
		expect(before.titles).toEqual([]);
		vi.setSystemTime(t0 + 15 * 60_000);
		const after = await reopen();
		await call(after.harness, "bash", { command: "npm test" });
		expect(after.titles).toEqual(["Allow this action? bash"]);
	});

	it("/perm lists the permissions in effect, and a revocation applies to the next call", async () => {
		initTheme("dark");
		let rendered: string[] = [];
		const custom = (async (factory: Parameters<ExtensionUIContext["custom"]>[0]) =>
			new Promise<unknown>((resolve) => {
				const tui = { terminal: { rows: 40, columns: 120 }, requestRender: () => {} };
				const view = factory(tui as never, {} as never, {} as never, resolve) as Component;
				rendered = view.render(100);
				view.handleInput?.("\x1b[B");
				view.handleInput?.("\r");
				view.handleInput?.("\x1b");
			})) as ExtensionUIContext["custom"];
		const { harness, titles } = await start({
			answer: (_title, options) =>
				options.find((option) => option.includes("in this session")) ?? "Block this action once",
			ui: { custom },
		});
		await call(harness, "bash", { command: "npm test" });
		await call(harness, "bash", { command: "npm test" });
		expect(titles).toHaveLength(1);
		await command(harness, "/perm");
		expect(rendered.join("\n")).toContain("this session");
		await call(harness, "bash", { command: "npm test" });
		expect(titles).toEqual(["Allow this action? bash", "Allow this action? bash"]);
	});
});

describe("fork: the /perm window", () => {
	const view = (overrides: Partial<ConstructorParameters<typeof PermView>[0]> = {}) => {
		const calls: string[] = [];
		let mode: Mode = "ask";
		const permView = new PermView({
			mode: () => mode,
			defaultMode: () => "ask",
			verdict: modePolicy,
			rows: POLICY_ROWS,
			grants: () => [{ effect: "allow", what: "Run npm test", scope: "15 minutes", left: "12 min left" }],
			savedRules: () => 2,
			height: () => 40,
			onMode: (next) => {
				mode = next;
				calls.push(`mode ${next}`);
			},
			onRevoke: (index) => void calls.push(`revoke ${index}`),
			onAction: (action) => void calls.push(action),
			onClose: () => void calls.push("close"),
			...overrides,
		});
		return { permView, calls };
	};
	const plain = (lines: string[]) => lines.map((line) => line.replace(/\x1b\[[0-9;:]*m/g, ""));

	beforeEach(() => initTheme("dark"));

	it("shows the modes, the table, the summary and the permissions in effect", () => {
		const text = plain(view().permView.render(100)).join("\n");
		for (const part of [
			"Permissions",
			"Safe",
			"Unrestricted",
			"Internet",
			"Run npm test",
			"Revoke",
			"Saved rules (2)",
		]) {
			expect(text).toContain(part);
		}
		expect(text).toContain("Reads freely. Asks before changing a file");
	});

	it("changes the mode with the arrows, revokes with Enter and opens the buttons", () => {
		const { permView, calls } = view();
		permView.handleInput("\x1b[C");
		permView.handleInput("\x1b[B");
		permView.handleInput("\r");
		permView.handleInput("\x1b[B");
		permView.handleInput("\x1b[C");
		permView.handleInput("\r");
		permView.handleInput("\x1b");
		expect(calls).toEqual(["mode broad", "revoke 0", "rules", "close"]);
	});

	it("picks a mode and revokes on click", () => {
		const { permView, calls } = view();
		const lines = plain(permView.render(100));
		const row = lines.findIndex((line) => line.includes("Internet"));
		const column = lines[row]!.indexOf("✓");
		permView.handleMouse({ type: "click", button: "left", x: column, y: row } as never);
		const grant = lines.findIndex((line) => line.includes("Revoke"));
		permView.handleMouse({
			type: "click",
			button: "left",
			x: lines[grant]!.indexOf("Revoke"),
			y: grant,
		} as never);
		expect(calls).toEqual(["mode broad", "revoke 0"]);
	});

	it("in a narrow window, shows the modes as tabs and the chosen mode's column; a tab picks its mode", () => {
		const { permView, calls } = view();
		const lines = plain(permView.render(64));
		const tabs = lines.findIndex((line) => line.includes("● Ask"));
		expect(lines[tabs]).toContain("○ Unrestricted");
		const internet = lines.find((line) => line.includes("Internet"))!;
		expect(internet.match(/[✓✗?]/g)).toEqual(["?"]);
		permView.handleMouse({
			type: "click",
			button: "left",
			x: lines[tabs]!.indexOf("Broad"),
			y: tabs,
		} as never);
		expect(calls).toEqual(["mode broad"]);
	});

	it.each([40, 64])("fits %i columns and a 24-row terminal without a line too wide", (width) => {
		const lines = view({ height: () => 24 }).permView.render(width);
		expect(lines.length).toBeLessThanOrEqual(24);
		for (const line of plain(lines)) expect([...line].length).toBeLessThanOrEqual(width);
	});
});
