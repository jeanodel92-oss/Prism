// fork: budgets are session-local and stop work at the harness boundary.

import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { emitSessionShutdownEvent } from "../src/core/extensions/runner.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import budgetsExtension, { budgetPanel } from "../src/fork/budgets.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fakeProvider = resolve(packageDir, "../../fork/tools/fake-provider.ts");
const sourceResolver = pathToFileURL(join(packageDir, "src/experimental/source-resolver.ts")).href;

async function runCli(
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	const child = spawn(
		process.execPath,
		["--import", sourceResolver, join(env.PI_PACKAGE_DIR!, "bin/prism"), ...args],
		{
			cwd,
			env,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});
	try {
		return await new Promise((resolveResult, reject) => {
			const timeout = setTimeout(() => {
				if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
				reject(new Error("Budget CLI did not exit before timeout"));
			}, 60_000);
			child.once("error", (error) => {
				clearTimeout(timeout);
				reject(error);
			});
			child.once("close", (code) => {
				clearTimeout(timeout);
				resolveResult({ code, stdout, stderr });
			});
		});
	} finally {
		if (child.exitCode === null && child.signalCode === null) {
			if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
			else child.kill("SIGKILL");
		}
	}
}

function cliFixture(): { root: string; cwd: string; agentDir: string; env: NodeJS.ProcessEnv } {
	const root = mkdtempSync(join(tmpdir(), "prism-budget-cli-"));
	const cwd = join(root, "work");
	const agentDir = join(root, "agent");
	const packageRoot = join(root, "package");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(packageRoot, "bin"), { recursive: true });
	writeFileSync(
		join(packageRoot, "package.json"),
		JSON.stringify({ type: "module", piConfig: { name: "prism", configDir: ".prism" } }),
	);
	for (const name of ["src", "docs", "examples", "vendor"])
		symlinkSync(join(packageDir, name), join(packageRoot, name), "dir");
	writeFileSync(
		join(packageRoot, "bin/prism"),
		`import ${JSON.stringify(pathToFileURL(join(packageDir, "src/cli.ts")).href)};\n`,
	);
	writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode: "broad" }));
	return {
		root,
		cwd,
		agentDir,
		env: {
			...process.env,
			PI_PACKAGE_DIR: packageRoot,
			PI_CODING_AGENT_DIR: agentDir,
			PRISM_CODING_AGENT_DIR: agentDir,
			[ENV_AGENT_DIR]: agentDir,
			PI_OFFLINE: "1",
		},
	};
}

const savedAgentDir = process.env[ENV_AGENT_DIR];
const harnesses: Harness[] = [];
const tempDirs: string[] = [];

/** The pids of the live processes started with exactly `argv` (a zombie has no command line). */
function processesRunning(argv: string[]): number[] {
	const wanted = `${argv.join("\0")}\0`;
	return readdirSync("/proc")
		.filter((name) => /^\d+$/.test(name))
		.filter((pid) => {
			try {
				return readFileSync(`/proc/${pid}/cmdline`, "utf8") === wanted;
			} catch {
				return false;
			}
		})
		.map(Number);
}

describe("fork: execution budgets", () => {
	let agentDir: string;
	const notices: string[] = [];
	const levels: string[] = [];
	const uiContext = createTestUiContext({
		notify: (message, level) => {
			notices.push(message);
			levels.push(level ?? "info");
		},
	});

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-budget-"));
		tempDirs.push(agentDir);
		process.env[ENV_AGENT_DIR] = agentDir;
		notices.length = 0;
		levels.length = 0;
	});
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		if (savedAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = savedAgentDir;
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	async function start(cost = { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }): Promise<Harness> {
		const harness = await createHarness({
			models: [{ id: "budget-test", cost }],
			extensionFactories: [{ name: "budgets", factory: budgetsExtension }],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext });
		return harness;
	}

	it("blocks calls after the tool limit, terminates the loop, and reports a warning at 80 percent", async () => {
		const ran: string[] = [];
		const makeTool = (name: string) => ({
			name,
			label: name,
			description: name,
			parameters: Type.Object({}),
			execute: async () => {
				ran.push(name);
				return { content: [{ type: "text" as const, text: name }], details: {} };
			},
		});
		const withTools = await createHarness({
			models: [{ id: "budget-test", cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } }],
			tools: [makeTool("one"), makeTool("two")],
			initialActiveToolNames: ["one", "two"],
			extensionFactories: [{ name: "budgets", factory: budgetsExtension }],
		});
		harnesses.push(withTools);
		await withTools.session.bindExtensions({ uiContext });
		await withTools.session.prompt("/budget tools 1");
		withTools.setResponses([
			fauxAssistantMessage([fauxToolCall("one", {}), fauxToolCall("two", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("must not run"),
		]);
		await withTools.session.prompt("do work");
		expect(ran).toEqual(["one"]);
		expect(withTools.faux.state.callCount).toBe(1);
		expect(
			notices.some((notice) => notice.includes("1 consumed of 1") && notice.toLowerCase().includes("exhausted")),
		).toBe(true);
		expect(levels).toContain("warning");
		expect(levels).toContain("error");
		await withTools.session.prompt("/budget tools 2");
		withTools.setResponses([fauxAssistantMessage(fauxToolCall("two", {}), { stopReason: "toolUse" })]);
		await withTools.session.prompt("resume work");
		expect(ran).toEqual(["one", "two"]);
	});

	it("counts all four token categories and prevents the next model turn at the cap", async () => {
		const harness = await start();
		await harness.session.prompt("/budget tokens 10");
		harness.setResponses([
			() => ({
				...fauxAssistantMessage("first"),
				usage: {
					input: 3,
					output: 3,
					cacheRead: 2,
					cacheWrite: 2,
					totalTokens: 10,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			}),
			fauxAssistantMessage("must not run"),
		]);
		await harness.session.prompt("go");
		expect(harness.faux.state.callCount).toBe(1);
		expect(notices.some((notice) => notice.includes("consumed of 10"))).toBe(true);
		// A turn that jumps past the cap stops without a late 80% warning.
		expect(notices.some((notice) => notice.includes("Execution budget warning"))).toBe(false);
	});

	// a prompt sent after the budget is exhausted reaches no model.
	it("refuses a new prompt once the budget is exhausted, without a model request, until /budget raises it", async () => {
		const harness = await start();
		await harness.session.prompt("/budget tokens 10");
		const usage = {
			input: 5,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		harness.setResponses([() => ({ ...fauxAssistantMessage("first"), usage }), fauxAssistantMessage("second")]);
		await harness.session.prompt("go");
		expect(harness.faux.state.callCount).toBe(1);

		notices.length = 0;
		await harness.session.prompt("go on");
		expect(harness.faux.state.callCount).toBe(1);
		expect(notices.some((notice) => notice.includes("the message was not sent"))).toBe(true);
		const userTexts = harness.session.messages.filter((message) => message.role === "user");
		expect(userTexts).toHaveLength(1);

		await harness.session.prompt("/budget tokens 100");
		await harness.session.prompt("go on");
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("warns at exactly 80 percent before the tool limit", async () => {
		const ran: string[] = [];
		const tool = {
			name: "count",
			label: "Count",
			description: "Count a call",
			parameters: Type.Object({}),
			execute: async () => {
				ran.push("call");
				return { content: [{ type: "text" as const, text: "ok" }], details: {} };
			},
		};
		const harness = await createHarness({
			tools: [tool],
			extensionFactories: [{ name: "budgets", factory: budgetsExtension }],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext });
		await harness.session.prompt("/budget tools 5");
		harness.setResponses([
			fauxAssistantMessage(
				Array.from({ length: 4 }, () => fauxToolCall("count", {})),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("run four calls");
		expect(ran).toHaveLength(4);
		expect(notices.some((notice) => notice.includes("4 of 5 used"))).toBe(true);
	});

	it("cancels the active tool call at the time limit", async () => {
		let cancelled = false;
		const slow: AgentTool = {
			name: "slow",
			label: "Slow",
			description: "Wait until aborted",
			parameters: Type.Object({}),
			execute: async (_toolCallId, _params, signal) =>
				new Promise<{ content: [{ type: "text"; text: string }]; details: Record<string, never> }>(
					(resolveTool) => {
						const fallback = setTimeout(
							() => resolveTool({ content: [{ type: "text", text: "timeout" }], details: {} }),
							1500,
						);
						const onAbort = () => {
							clearTimeout(fallback);
							cancelled = true;
							resolveTool({ content: [{ type: "text", text: "aborted" }], details: {} });
						};
						if (signal?.aborted) onAbort();
						else signal?.addEventListener("abort", onAbort, { once: true });
					},
				),
		};
		const harness = await createHarness({
			tools: [slow],
			extensionFactories: [{ name: "budgets", factory: budgetsExtension }],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext });
		await harness.session.prompt("/budget time 0.01");
		harness.setResponses([fauxAssistantMessage(fauxToolCall("slow", {}), { stopReason: "toolUse" })]);
		await harness.session.prompt("wait");
		expect(cancelled).toBe(true);
	}, 10_000);

	it("refuses a cost limit for unpriced local models and counts reported cost for priced models", async () => {
		const local = await start({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		await local.session.prompt("/budget cost 2");
		expect(notices.at(-1)).toContain("no non-zero price");
		const priced = await start();
		await priced.session.prompt("/budget cost 0.00001");
		priced.setResponses([
			() => ({
				...fauxAssistantMessage("costed"),
				usage: {
					input: 1,
					output: 1,
					cacheRead: 1,
					cacheWrite: 1,
					totalTokens: 4,
					cost: { input: 0.00001, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.00001 },
				},
			}),
		]);
		await priced.session.prompt("go");
		expect(notices.some((notice) => notice.includes("cost: $0.0000 / $0.00001"))).toBe(true);
	});

	// fork.9 QA: /budget alone is a menu, in the style of /goal.
	it("changes a limit from its menu, and says what a wrong value should be", async () => {
		const notices: string[] = [];
		const titles: string[][] = [];
		const inputs = ["abc", "30", ""];
		const answers = ["time", "time", "tools", "Turn all limits off", "Close"];
		const harness = await createHarness({ extensionFactories: [{ name: "budgets", factory: budgetsExtension }] });
		harnesses.push(harness);
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				notify: (message) => notices.push(message),
				input: async () => inputs.shift(),
				select: async (_title, choices) => {
					titles.push(choices);
					const answer = answers.shift();
					return choices.find((choice) => choice.startsWith(answer ?? ""));
				},
			}),
		});
		await harness.session.prompt("/budget");
		expect(notices).toEqual(["Type a number of minutes, such as 30."]);
		expect(titles[0]).toHaveLength(5);
		expect(titles[2]?.[0]).toContain("/ 30 min");
		expect(titles[2]).toContain("Turn all limits off");
		expect(titles[4]).not.toContain("Turn all limits off");
	});

	it("keeps persisted state separate by session", async () => {
		const first = await start();
		await first.session.prompt("/budget tools 4");
		first.setResponses([fauxAssistantMessage("first session")]);
		await first.session.prompt("count tokens here");
		const second = await start();
		await second.session.prompt("/budget status");
		expect(notices.at(-1)).toContain("tools: off");
		expect(notices.at(-1)).toContain("tokens: off (consumed: 0)");
		expect(
			first.sessionManager
				.getBranch()
				.some(
					(entry) =>
						entry.type === "custom" &&
						entry.customType === "fork-budget-state" &&
						(entry.data as { tokens?: number }).tokens! > 0,
				),
		).toBe(true);
	});

	// a reload keeps the session manager; the module turned off left its panel behind.
	it("takes its RPC panel away when its instance ends, but not the panel of a newer instance", async () => {
		const manager = SessionManager.create(process.cwd(), join(agentDir, "sessions"));
		const ctx = { sessionManager: manager } as unknown as ExtensionContext;
		const open = async () => {
			const harness = await createHarness({
				extensionFactories: [{ name: "budgets", factory: budgetsExtension }],
				sessionManager: manager,
			});
			harnesses.push(harness);
			await harness.session.bindExtensions({ uiContext });
			return harness;
		};
		const shut = (harness: Harness) =>
			emitSessionShutdownEvent(harness.session.extensionRunner, { type: "session_shutdown", reason: "reload" });
		const older = await open();
		const olderPanel = budgetPanel(ctx);
		const newer = await open();
		const newerPanel = budgetPanel(ctx);
		expect(olderPanel).toBeDefined();
		expect(newerPanel).not.toBe(olderPanel);
		await shut(older);
		expect(budgetPanel(ctx)).toBe(newerPanel);
		await shut(newer);
		expect(budgetPanel(ctx)).toBeUndefined();
	});

	it("restores limits and consumption from session entries after reload", async () => {
		const manager = SessionManager.create(process.cwd(), join(agentDir, "sessions"));
		const first = await createHarness({
			extensionFactories: [{ name: "budgets", factory: budgetsExtension }],
			sessionManager: manager,
		});
		harnesses.push(first);
		await first.session.bindExtensions({ uiContext });
		await first.session.prompt("/budget tools 4");
		first.setResponses([fauxAssistantMessage("worked")]);
		await first.session.prompt("do one unit of work");
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		const resumedManager = SessionManager.open(sessionFile);
		expect(
			resumedManager
				.getBranch()
				.filter((entry) => entry.type === "custom" && entry.customType === "fork-budget-state"),
		).toHaveLength(3);
		const resumed = await createHarness({
			extensionFactories: [{ name: "budgets", factory: budgetsExtension }],
			sessionManager: resumedManager,
		});
		harnesses.push(resumed);
		await resumed.session.bindExtensions({ uiContext });
		await resumed.session.prompt("/budget status");
		expect(notices.at(-1)).toContain("tools: 0 / 4");
		const restored = resumedManager
			.getBranch()
			.findLast((entry) => entry.type === "custom" && entry.customType === "fork-budget-state");
		expect(restored?.type === "custom" && restored.data).toMatchObject({
			tools: 0,
			tokens: expect.any(Number),
			limits: { tools: 4 },
		});
	});

	// every saved entry was the live state, so an older one followed later changes.
	it("keeps each saved budget as it was, before and after a resume", async () => {
		const manager = SessionManager.create(process.cwd(), join(agentDir, "sessions"));
		const first = await createHarness({
			extensionFactories: [{ name: "budgets", factory: budgetsExtension }],
			sessionManager: manager,
		});
		harnesses.push(first);
		await first.session.bindExtensions({ uiContext });
		const limits = (entries: ReturnType<SessionManager["getBranch"]>) =>
			entries.flatMap((entry) =>
				entry.type === "custom" && entry.customType === "fork-budget-state"
					? [(entry.data as { limits: { tools?: number } }).limits.tools]
					: [],
			);
		await first.session.prompt("/budget tools 4");
		// The session file is written once it holds a prompt.
		first.setResponses([fauxAssistantMessage("worked")]);
		await first.session.prompt("do one unit of work");
		await first.session.prompt("/budget tools 9");
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		const saved = limits(SessionManager.open(sessionFile).getBranch());
		expect(saved[0]).toBe(4);
		expect(saved.at(-1)).toBe(9);
		expect(limits(manager.getBranch())).toEqual(saved);
		const resumedManager = SessionManager.open(sessionFile);
		const resumed = await createHarness({
			extensionFactories: [{ name: "budgets", factory: budgetsExtension }],
			sessionManager: resumedManager,
		});
		harnesses.push(resumed);
		await resumed.session.bindExtensions({ uiContext });
		await resumed.session.prompt("/budget tools 7");
		const after = limits(resumedManager.getBranch());
		expect(after.slice(0, saved.length)).toEqual(saved);
		expect(after.at(-1)).toBe(7);
		expect(limits(SessionManager.open(sessionFile).getBranch())).toEqual(after);
	});

	it("does not count the time the session was closed after a resume", async () => {
		const manager = SessionManager.create(process.cwd(), join(agentDir, "sessions"));
		const hourAgo = Date.now() - 60 * 60_000;
		manager.appendCustomEntry("fork-budget-state", {
			version: 1,
			limits: { time: 30 },
			tools: 0,
			tokens: 0,
			cost: 0,
			costUnknown: false,
			elapsedMs: 60_000,
			startedAt: hourAgo,
			savedAt: hourAgo + 60_000,
			warned: [],
		});
		const resumed = await createHarness({
			extensionFactories: [{ name: "budgets", factory: budgetsExtension }],
			sessionManager: manager,
		});
		harnesses.push(resumed);
		await resumed.session.bindExtensions({ uiContext });
		await resumed.session.prompt("/budget status");
		expect(notices.at(-1)).toContain("time: 2.00 min / 30 min");
		expect(notices.at(-1)).toContain("State: active");
	});

	it("enforces tool and time limits through the real CLI, cancelling bash children on time cap", async () => {
		const fixture = cliFixture();
		tempDirs.push(fixture.root);
		writeFileSync(join(fixture.cwd, "sample.ts"), "sample contents\n");
		writeFileSync(
			join(fixture.agentDir, "auth.json"),
			JSON.stringify({ fake: { type: "api_key", key: "fake-key" } }),
		);
		const tools = await runCli(
			[
				"--mode",
				"json",
				"-e",
				fakeProvider,
				"--provider",
				"fake",
				"--model",
				"scripted",
				"--no-session",
				"--budget-tools",
				"1",
				"-p",
				'calls [["read", {"path":"sample.ts"}], ["read", {"path":"sample.ts"}]]',
			],
			fixture.cwd,
			fixture.env,
		);
		expect(tools.code, `${tools.stdout}\n${tools.stderr}`).toBe(0);
		expect(`${tools.stdout}\n${tools.stderr}`).toContain("Execution budget exhausted");
		expect(`${tools.stdout}\n${tools.stderr}`).toContain("1 consumed of 1");
		const cost = await runCli(
			[
				"--mode",
				"json",
				"-e",
				fakeProvider,
				"--provider",
				"fake",
				"--model",
				"scripted",
				"--no-session",
				"--budget-cost",
				"0.000001",
				"-p",
				"md",
			],
			fixture.cwd,
			fixture.env,
		);
		expect(`${cost.stdout}\n${cost.stderr}`).toContain("Execution budget exhausted");

		const marker = join(fixture.cwd, "after-sleep");
		const pidFile = join(fixture.cwd, "sleep.pid");
		// fork: the pid the command writes is the one in the sandbox's own PID
		// namespace, not this machine's; the sleep is looked up by its unique argument instead.
		const sleepFor = `30.${process.pid}`;
		const time = await runCli(
			[
				"-e",
				fakeProvider,
				"--provider",
				"fake",
				"--model",
				"scripted",
				"--perm-mode",
				"broad",
				"--no-session",
				// Six seconds: the clock starts with the agent, before the sandbox has started bash, and a shorter
				// cap could stop the run before the command wrote its pid (intermittent under load).
				"--budget-time",
				"0.1",
				"-p",
				`call bash {"command":"sleep ${sleepFor} & child=$!; echo $child > ${pidFile}; wait; touch ${marker}"}`,
			],
			fixture.cwd,
			fixture.env,
		);
		expect(`${time.stdout}\n${time.stderr}`).toContain("Execution budget exhausted");
		expect(existsSync(marker)).toBe(false);
		expect(existsSync(pidFile)).toBe(true);
		expect(processesRunning(["sleep", sleepFor])).toEqual([]);
	}, 130_000);
});
