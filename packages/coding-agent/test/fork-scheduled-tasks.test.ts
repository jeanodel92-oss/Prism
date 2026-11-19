// fork.9 (CAP-01): scheduled tasks against a fake systemd; real timers run only in a throwaway VM (planification.md).
import { spawnSync } from "node:child_process";
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
import { dirname, join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { EventBus } from "../src/core/event-bus.ts";
import { setLanguage } from "../src/fork/i18n/index.ts";
import permissionsExtension, { decidePermission } from "../src/fork/permissions.ts";
import { addProjectHost } from "../src/fork/project-permissions.ts";
import { TOOL_NETWORK_EVENT, type ToolNetworkRequest, toolNetworkGate } from "../src/fork/sandbox/tool-network.ts";
import { scheduleCommand, unseenRunsReport } from "../src/fork/schedule-command.ts";
import {
	beginScheduledRun,
	endScheduledRun,
	installTask,
	lastRuns,
	nextElapse,
	type PrismLauncher,
	prepareScheduledRun,
	readScheduledTask,
	realSystemd,
	recordRun,
	removeTask,
	type ScheduledTask,
	type SystemdUser,
	scheduledUnits,
	setTaskPaused,
	unitName,
	unsafeLauncher,
	writeScheduledTask,
} from "../src/fork/scheduled-tasks.ts";
import { createHarness, createTestUiContext, getToolResult, type Harness } from "./suite/harness.ts";

const hasSystemdAnalyze = spawnSync("systemd-analyze", ["--version"]).status === 0;

describe("fork: scheduled tasks", () => {
	let root: string;
	let agentDir: string;
	let project: string;
	let systemd: SystemdUser & { calls: string[][] };
	const saved = process.env[ENV_AGENT_DIR];
	const harnesses: Harness[] = [];

	/** An installed Prism, outside any project: what the timer may start. */
	const installed: PrismLauncher = {
		invocation: (id) => ({ command: "/usr/bin/node", args: ["/opt/prism/dist/cli.js", "--scheduled", id] }),
		packageDir: () => "/opt/prism",
	};

	const task = (overrides: Partial<ScheduledTask> = {}): ScheduledTask => ({
		version: 1,
		id: "nightly",
		prompt: "Run the tests and fix what fails",
		cwd: project,
		onCalendar: "*-*-* 03:00",
		operations: [{ what: "Change the project's files", commands: [], writes: ["**"], hosts: [] }],
		budget: { minutes: 20, tools: 50 },
		catchUp: "report",
		createdAt: "2026-10-28T00:00:00.000Z",
		...overrides,
	});

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "prism-schedule-"));
		agentDir = join(root, "agent");
		project = join(root, "my project");
		mkdirSync(agentDir);
		mkdirSync(project);
		process.env[ENV_AGENT_DIR] = agentDir;
		const calls: string[][] = [];
		systemd = {
			calls,
			unitDir: () => join(root, "units"),
			systemctl: (args) => {
				calls.push(args);
				return { ok: true, output: args[0] === "is-enabled" ? "enabled" : "" };
			},
			// The calendar is systemd's own: the real systemd-analyze, which installs nothing.
			analyze: (args) => realSystemd.analyze(args),
		};
		setLanguage("en");
	});
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		if (saved === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = saved;
		rmSync(root, { recursive: true, force: true });
	});

	describe("the units", () => {
		it("start Prism with --scheduled only, once, without restart, and catch up through Persistent", () => {
			const { service, timer } = scheduledUnits(task({ cwd: "/home/u/50% $HOME" }), {
				command: "/usr/bin/node",
				args: ["/opt/prism/cli.js", "--scheduled", "nightly"],
			});
			expect(service).toContain('ExecStart="/usr/bin/node" "/opt/prism/cli.js" "--scheduled" "nightly"');
			expect(service).toContain("WorkingDirectory=/home/u/50%% $HOME");
			expect(service).toMatch(/^Type=oneshot$/m);
			expect(service).toMatch(/^Restart=no$/m);
			expect(service).toMatch(/^TimeoutStartSec=25min$/m);
			// The model's answer stays out of the user's journal.
			expect(service).toMatch(/^StandardOutput=null$/m);
			expect(service).toMatch(/^StandardError=journal$/m);
			expect(timer).toMatch(/^OnCalendar=\*-\*-\* 03:00$/m);
			expect(timer).toMatch(/^Persistent=true$/m);
			expect(timer).toContain(`Unit=${unitName("nightly", "service")}`);
			expect(() =>
				scheduledUnits(task({ cwd: "/tmp/a\nExecStartPre=/bin/evil" }), { command: "/usr/bin/node", args: [] }),
			).toThrow("line break");
		});
		it.skipIf(!hasSystemdAnalyze)("pass systemd-analyze verify, without being installed", () => {
			const dir = join(root, "verify");
			mkdirSync(dir);
			const { service, timer } = scheduledUnits(task(), { command: process.execPath, args: ["--version"] });
			writeFileSync(join(dir, unitName("nightly", "service")), service);
			writeFileSync(join(dir, unitName("nightly", "timer")), timer);
			const result = spawnSync(
				"systemd-analyze",
				[
					"verify",
					"--user",
					"--man=no",
					join(dir, unitName("nightly", "timer")),
					join(dir, unitName("nightly", "service")),
				],
				{ encoding: "utf8", env: { ...process.env, HOME: root, XDG_CONFIG_HOME: root, XDG_RUNTIME_DIR: root } },
			);
			expect(`${result.stdout}${result.stderr}`.trim()).toBe("");
			expect(result.status).toBe(0);
		});
		it.skipIf(!hasSystemdAnalyze)("read the calendar with systemd's own parser", () => {
			const next = nextElapse("*-*-* 03:00", systemd, new Date(2026, 9, 28, 2, 0));
			expect(next).toMatchObject({ normalized: "*-*-* 03:00:00" });
			if ("at" in next) expect(next.at.getTime()).toBe(new Date(2026, 9, 28, 3, 0).getTime());
			expect(nextElapse("every tuesday-ish", systemd)).toHaveProperty("error");
		});
		it("read the next elapse in a UTC zone, where systemd prints no separate UTC line", () => {
			const output = [
				"  Original form: *-*-* 15:40",
				"Normalized form: *-*-* 15:40:00",
				"    Next elapse: Wed 2026-10-28 15:40:00 UTC",
				"       From now: 14min left",
			].join("\n");
			const utcZone: SystemdUser = { ...systemd, analyze: () => ({ ok: true, output }) };
			const next = nextElapse("*-*-* 15:40", utcZone);
			expect(next).toMatchObject({ normalized: "*-*-* 15:40:00" });
			if ("at" in next) expect(next.at.toISOString()).toBe("2026-10-28T15:40:00.000Z");
		});
	});

	describe("what the timer starts", () => {
		it("refuses a Prism an agent could change: its sources, a Git working tree, the task's folder", () => {
			expect(unsafeLauncher(installed, project)).toBeUndefined();
			const checkout = join(root, "pi");
			mkdirSync(join(checkout, "packages", "coding-agent", "src"), { recursive: true });
			const cli = join(checkout, "packages", "coding-agent", "src", "cli.ts");
			writeFileSync(cli, "");
			const fromSources: PrismLauncher = {
				invocation: (id) => ({
					command: process.execPath,
					args: ["--import", `file://${cli}`, cli, "--scheduled", id],
				}),
				packageDir: () => join(checkout, "packages", "coding-agent"),
			};
			expect(unsafeLauncher(fromSources, project)).toContain("TypeScript sources");
			const built = join(checkout, "packages", "coding-agent", "dist", "cli.js");
			mkdirSync(dirname(built), { recursive: true });
			writeFileSync(built, "");
			const fromCheckout: PrismLauncher = {
				invocation: (id) => ({ command: process.execPath, args: [built, "--scheduled", id] }),
				packageDir: () => join(checkout, "packages", "coding-agent"),
			};
			expect(unsafeLauncher(fromCheckout, project)).toBeUndefined();
			spawnSync("git", ["init", "-q", checkout]);
			expect(unsafeLauncher(fromCheckout, project)).toContain("Git working tree");
			rmSync(join(checkout, ".git"), { recursive: true });
			expect(unsafeLauncher(fromCheckout, checkout)).toContain("in the task's folder");
			expect(() => installTask(task({ cwd: checkout }), systemd, undefined, fromCheckout)).toThrow("task's folder");
			expect(systemd.calls).toEqual([]);
		});
		// Hardening review, point 2: anything sandboxed commands may write, not only the task's folder.
		describe("a Prism in a folder sandboxed commands can write", () => {
			let home: string;
			const prismAt = (dir: string): PrismLauncher => {
				mkdirSync(join(dir, "dist"), { recursive: true });
				writeFileSync(join(dir, "dist", "cli.js"), "");
				return {
					invocation: (id) => ({
						command: process.execPath,
						args: [join(dir, "dist", "cli.js"), "--scheduled", id],
					}),
					packageDir: () => dir,
				};
			};
			beforeEach(() => {
				home = join(root, "home");
				mkdirSync(home);
			});
			it("refuses one run by npx from npm's cache", () => {
				const launcher = prismAt(join(home, ".npm", "_npx", "0a1b", "node_modules", "prism"));
				expect(unsafeLauncher(launcher, project, home)).toContain("sandboxed commands can change");
			});
			it("refuses one reached through a link, whatever the link's own folder", () => {
				const real = prismAt(join(home, ".npm", "prism"));
				mkdirSync(join(root, "opt"));
				symlinkSync(join(home, ".npm", "prism"), join(root, "opt", "prism"));
				const linked: PrismLauncher = {
					invocation: (id) => ({
						command: process.execPath,
						args: [join(root, "opt", "prism", "dist", "cli.js"), "--scheduled", id],
					}),
					packageDir: () => join(root, "opt", "prism"),
				};
				expect(unsafeLauncher(real, project, home)).toContain("sandboxed commands can change");
				expect(unsafeLauncher(linked, project, home)).toContain("sandboxed commands can change");
			});
			it("refuses one in a folder the settings let commands write", () => {
				const launcher = prismAt(join(root, "tools", "prism"));
				expect(unsafeLauncher(launcher, project, home)).toBeUndefined();
				writeFileSync(
					join(agentDir, "settings.json"),
					JSON.stringify({ sandbox: { allowWrite: [join(root, "tools")] } }),
				);
				expect(unsafeLauncher(launcher, project, home)).toContain("sandboxed commands can change");
			});
			it("refuses a Node.js the commands can change", () => {
				const node = join(home, ".npm", "node", "bin", "node");
				mkdirSync(dirname(node), { recursive: true });
				writeFileSync(node, "");
				const safe = prismAt(join(home, ".local", "lib", "node_modules", "prism"));
				expect(unsafeLauncher(safe, project, home)).toBeUndefined();
				const launcher: PrismLauncher = {
					...safe,
					invocation: (id) => ({ ...safe.invocation(id), command: node }),
				};
				expect(unsafeLauncher(launcher, project, home)).toContain("sandboxed commands can change");
			});
		});
		it("keeps task definitions out of the agent's reach, in every mode", () => {
			const file = join(agentDir, "scheduled", "nightly.json");
			for (const mode of ["ask", "broad", "unrestricted"] as const) {
				expect(decidePermission("write", { path: file, content: "{}" }, project, { mode })).toMatchObject({
					effect: "block",
					reason: "Only the user can change Prism's security settings.",
				});
				expect(decidePermission("bash", { command: `echo {} > ${file}` }, project, { mode }).effect).toBe("block");
			}
		});
	});

	describe("installing", () => {
		it("writes both units and enables the timer; pause, resume and removal go through systemctl --user", () => {
			installTask(task(), systemd, undefined, installed);
			const units = join(root, "units");
			expect(readFileSync(join(units, unitName("nightly", "timer")), "utf8")).toContain("OnCalendar=*-*-* 03:00");
			expect(existsSync(join(units, unitName("nightly", "service")))).toBe(true);
			expect(readScheduledTask("nightly")).toMatchObject({ prompt: "Run the tests and fix what fails" });
			setTaskPaused("nightly", true, systemd);
			setTaskPaused("nightly", false, systemd);
			removeTask("nightly", systemd);
			expect(systemd.calls).toEqual([
				["daemon-reload"],
				["enable", "--now", "prism-task-nightly.timer"],
				["disable", "--now", "prism-task-nightly.timer"],
				["enable", "--now", "prism-task-nightly.timer"],
				["disable", "--now", "prism-task-nightly.timer"],
				["daemon-reload"],
			]);
			expect(existsSync(join(units, unitName("nightly", "timer")))).toBe(false);
			expect(readScheduledTask("nightly")).toBeUndefined();
			// Never lingering, never a system unit.
			expect(JSON.stringify(systemd.calls)).not.toMatch(/linger|--system/);
		});

		// Hardening review, point 5: a failed step leaves no task behind, and a removal never reports a false success.
		const failing = (step: string): SystemdUser & { calls: string[][] } => ({
			...systemd,
			systemctl: (args) => {
				systemd.calls.push(args);
				return args.join(" ").startsWith(step) ? { ok: false, output: `${step} failed` } : { ok: true, output: "" };
			},
		});
		const units = () => join(root, "units");
		const nothingLeft = () => {
			expect(readScheduledTask("nightly")).toBeUndefined();
			expect(existsSync(join(units(), unitName("nightly", "timer")))).toBe(false);
			expect(existsSync(join(units(), unitName("nightly", "service")))).toBe(false);
		};
		it.each(["daemon-reload", "enable"])("undoes the creation when systemctl %s fails, and can try again", (step) => {
			expect(() => installTask(task(), failing(step), undefined, installed)).toThrow(`${step} failed`);
			nothingLeft();
			if (step === "enable")
				expect(systemd.calls).toContainEqual(["disable", "--now", unitName("nightly", "timer")]);
			systemd.calls.length = 0;
			installTask(task(), systemd, undefined, installed);
			expect(readScheduledTask("nightly")).toBeDefined();
		});
		it("keeps the task and says it may still run when the timer cannot be disabled after a failed enable", () => {
			const both: SystemdUser & { calls: string[][] } = {
				...systemd,
				systemctl: (args) => {
					systemd.calls.push(args);
					return args[0] === "enable" || args[0] === "disable"
						? { ok: false, output: `${args[0]} failed` }
						: { ok: true, output: "" };
				},
			};
			let message = "";
			try {
				installTask(task(), both, undefined, installed);
			} catch (error) {
				message = (error as Error).message;
			}
			expect(message).toContain("enable failed");
			expect(message).toContain("disable failed");
			expect(message).toMatch(/may still run/);
			// Enough is left to see the task in /schedule and remove it once systemd works.
			expect(readScheduledTask("nightly")).toBeDefined();
			expect(existsSync(join(units(), unitName("nightly", "timer")))).toBe(true);
			expect(existsSync(join(units(), unitName("nightly", "service")))).toBe(true);
			removeTask("nightly", systemd);
			nothingLeft();
		});
		it("undoes the creation when a unit cannot be written", () => {
			mkdirSync(join(units(), unitName("nightly", "timer")), { recursive: true });
			expect(() => installTask(task(), systemd, undefined, installed)).toThrow();
			expect(readScheduledTask("nightly")).toBeUndefined();
			expect(existsSync(join(units(), unitName("nightly", "service")))).toBe(false);
			// What the installation did not write is not its to remove.
			expect(existsSync(join(units(), unitName("nightly", "timer")))).toBe(true);
			expect(systemd.calls).toEqual([]);
		});
		// two dialogs opened before the first creation. The second
		// replaced the first task, and when its installation failed, its undoing removed the first task's files.
		it("refuses a name another task took since the question, and leaves that task whole", () => {
			installTask(task({ prompt: "First" }), systemd, undefined, installed);
			recordRun("nightly", { at: "2026-10-28T03:00:00.000Z", outcome: "finished" });
			const timer = readFileSync(join(units(), unitName("nightly", "timer")), "utf8");
			systemd.calls.length = 0;
			for (const systemctl of [systemd, failing("daemon-reload")])
				expect(() =>
					installTask(task({ prompt: "Second", onCalendar: "daily" }), systemctl, undefined, installed),
				).toThrow("A task named nightly already exists.");
			expect(readScheduledTask("nightly")?.prompt).toBe("First");
			expect(lastRuns("nightly")).toHaveLength(1);
			expect(readFileSync(join(units(), unitName("nightly", "timer")), "utf8")).toBe(timer);
			expect(systemd.calls).toEqual([]);
			expect(readdirSync(join(agentDir, "scheduled")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
		});
		it("reports a failed removal and keeps the task, then removes it once systemctl works", () => {
			installTask(task(), systemd, undefined, installed);
			expect(() => removeTask("nightly", failing("disable"))).toThrow("disable failed");
			expect(readScheduledTask("nightly")).toBeDefined();
			expect(existsSync(join(units(), unitName("nightly", "timer")))).toBe(true);
			expect(() => removeTask("nightly", failing("daemon-reload"))).toThrow("daemon-reload failed");
			expect(readScheduledTask("nightly")).toBeDefined();
			removeTask("nightly", systemd);
			nothingLeft();
			// Removing again, with its units already gone, is not an error.
			removeTask("nightly", failing("disable"));
		});
	});

	describe("the run", () => {
		const chdir = () => {};
		it("refuses an unknown task, other arguments and a sandbox turned off", () => {
			expect(prepareScheduledRun(["--scheduled", "nope"], { agentDir, chdir })).toMatchObject({ exit: 2 });
			writeScheduledTask(task());
			expect(
				prepareScheduledRun(["--scheduled", "nightly", "--perm-mode", "unrestricted"], { agentDir, chdir }),
			).toMatchObject({ exit: 1 });
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sandbox: { modes: { ask: false } } }));
			expect(prepareScheduledRun(["--scheduled", "nightly"], { agentDir, chdir })).toMatchObject({
				exit: 1,
				message: expect.stringContaining("sandbox is off"),
			});
			expect(lastRuns("nightly").map((run) => run.outcome)).toEqual(["refused", "refused"]);
		});
		it.skipIf(!hasSystemdAnalyze)(
			"runs on time in ask mode with its budgets, and reports a late run without running it",
			() => {
				writeScheduledTask(task({ model: "faux/model" }));
				const onTime = prepareScheduledRun(["--scheduled", "nightly"], {
					agentDir,
					chdir,
					systemd,
					now: new Date(2026, 9, 28, 3, 1),
				});
				expect(onTime).toEqual({
					args: [
						"--scheduled",
						"nightly",
						"--perm-mode",
						"ask",
						"--budget-time",
						"20",
						"--budget-tools",
						"50",
						"--model",
						"faux/model",
						"-p",
						"--",
						"Run the tests and fix what fails",
					],
				});
				// The run above still holds the lock in this process: the next one is skipped.
				expect(
					prepareScheduledRun(["--scheduled", "nightly"], {
						agentDir,
						chdir,
						systemd,
						now: new Date(2026, 9, 28, 3, 2),
					}),
				).toMatchObject({ exit: 0, message: expect.stringContaining("still going") });
				rmSync(join(agentDir, "scheduled", "nightly.lock"));
				// Started at boot, five hours after 03:00.
				expect(
					prepareScheduledRun(["--scheduled", "nightly"], {
						agentDir,
						chdir,
						systemd,
						now: new Date(2026, 9, 28, 8, 0),
					}),
				).toMatchObject({ exit: 0, message: expect.stringContaining("not run") });
				expect(lastRuns("nightly").map((run) => run.outcome)).toEqual(["started", "skipped-running", "missed"]);
			},
		);
		it.skipIf(!hasSystemdAnalyze)("takes over the lock of a run that died", () => {
			writeScheduledTask(task({ catchUp: "run" }));
			mkdirSync(join(agentDir, "scheduled"), { recursive: true });
			writeFileSync(join(agentDir, "scheduled", "nightly.lock"), "999999999");
			expect(prepareScheduledRun(["--scheduled", "nightly"], { agentDir, chdir, systemd })).toHaveProperty("args");
			rmSync(join(agentDir, "scheduled", "nightly.lock"));
		});
	});

	describe("unattended", () => {
		let bus: EventBus;
		async function start() {
			const harness = await createHarness({
				extensionFactories: [
					{ name: "permissions", factory: permissionsExtension },
					{
						name: "probe",
						factory: (pi) => {
							bus = pi.events;
							// A stand-in for the real web_fetch: the same declaration and gate, no request sent.
							pi.registerTool({
								name: "web_fetch",
								label: "Web Fetch",
								permissions: ["network"],
								description: "Fetch a URL",
								parameters: Type.Object({ urls: Type.String() }),
								async execute(id, params) {
									const gate = toolNetworkGate(pi.events, id, `web_fetch ${params.urls}`);
									const refused = await gate?.destination(new URL(params.urls), async () => [
										{ address: "93.184.216.34", family: 4 },
									]);
									gate?.close();
									if (refused) throw new Error(refused);
									return { content: [{ type: "text", text: `fetched ${params.urls}` }], details: {} };
								},
							});
						},
					},
				],
			});
			harnesses.push(harness);
			await harness.session.bindExtensions({ mode: "print" });
			harness.session.extensionRunner.setFlagValue("scheduled", "nightly");
			await harness.session.extensionRunner.emit({ type: "session_start", reason: "startup" });
			return harness;
		}
		it("does what the scope covers, refuses the rest without asking, even with an allow rule, and logs it", async () => {
			writeScheduledTask(task({ cwd: "/" }));
			writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ allow: ["bash(rm *)"] }));
			beginScheduledRun("nightly", undefined, false);
			const harness = await start();
			// One agent run, as the scheduled prompt: its end ends the scope.
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("write", { path: join(harness.tempDir, "notes.md"), content: "x" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(fauxToolCall("bash", { command: "rm notes.md" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("go");
			expect(getToolResult(harness, "write").isError).not.toBe(true);
			const removal = getToolResult(harness, "bash");
			expect(removal.isError).toBe(true);
			expect(JSON.stringify(removal.content)).toContain("the user is away");
			expect(existsSync(join(harness.tempDir, "notes.md"))).toBe(true);
			const notices: string[] = [];
			endScheduledRun(0, (title) => notices.push(title));
			const finished = lastRuns("nightly").filter((run) => run.outcome === "finished");
			expect(finished).toHaveLength(1);
			expect(finished[0]?.detail).toContain("rm");
			expect(finished[0]?.session).toBe(harness.session.sessionManager.getSessionFile());
			expect(notices).toEqual(["Scheduled task nightly: actions refused"]);
		});
		it("cannot write the extensions, hooks or settings its next run would load outside the sandbox", async () => {
			writeScheduledTask(task({ cwd: "/" }));
			const harness = await start();
			const targets = [
				// The control: an ordinary project file, which the scope covers.
				join(harness.tempDir, "notes.md"),
				join(harness.tempDir, ".pi", "extensions", "evil.ts"),
				join(harness.tempDir, ".pi", "settings.json"),
				join(agentDir, "extensions", "evil.ts"),
				join(agentDir, "settings.json"),
			];
			harness.setResponses([
				...targets.map((path) =>
					fauxAssistantMessage(fauxToolCall("write", { path, content: "export default () => {}" }), {
						stopReason: "toolUse",
					}),
				),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("go");
			const results = harness.events.filter((event) => event.type === "tool_execution_end");
			expect(results.map((event) => (event as { isError?: boolean }).isError)).toEqual([
				false,
				true,
				true,
				true,
				true,
			]);
			for (const path of targets.slice(1)) expect(existsSync(path), path).toBe(false);
		});
		it("reaches only the hosts of its scope, whatever the network settings and earlier grants allow", async () => {
			writeScheduledTask(
				task({
					operations: [
						{
							what: "Run commands in the sandbox, except dangerous ones",
							commands: ["*"],
							writes: [],
							hosts: [],
						},
						{ what: "Connect to these hosts", commands: [], writes: [], hosts: ["api.example.com"] },
					],
				}),
			);
			// Everything that would let another host through without the task: no questions, a global allow list,
			// a host kept for this project, and a provider of web_search.
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ sandbox: { network: { askNewHosts: false, allow: ["allowed.example.com"] } } }),
			);
			const harness = await start();
			await addProjectHost(harness.tempDir, { host: "granted.example.com", rule: "bash(curl*)" });
			const resolve = async () => [{ address: "93.184.216.34", family: 4 }];
			const check = async (command: string, url: string) => {
				const request: ToolNetworkRequest = { toolCallId: `call-${url}`, command };
				bus.emit(TOOL_NETWORK_EVENT, request);
				const gate = request.gate;
				if (!gate) throw new Error("no gate");
				const refusal = await gate.destination(new URL(url), resolve);
				gate.close();
				return refusal;
			};
			expect(await check("curl https://api.example.com/", "https://api.example.com/")).toBeUndefined();
			expect(await check("web_fetch https://api.example.com/x", "https://api.example.com/x")).toBeUndefined();
			for (const url of [
				"https://new.example.org/",
				"https://allowed.example.com/",
				"https://granted.example.com/",
			]) {
				expect(await check(`curl ${url}`, url), url).toBeDefined();
				expect(await check(`web_fetch ${url}`, url), url).toBeDefined();
			}
			const request: ToolNetworkRequest = { toolCallId: "search", command: "web_search q" };
			bus.emit(TOOL_NETWORK_EVENT, request);
			expect(request.gate?.provider(new URL("https://api.exa.ai/search"))).toBeDefined();
			expect(request.gate?.provider(new URL("https://api.example.com/search"))).toBeUndefined();
		});
		it("lets the web tools reach its hosts only, and refuses them to a task given no host", async () => {
			const scoped = task({
				operations: [{ what: "Connect to these hosts", commands: [], writes: [], hosts: ["api.example.com"] }],
			});
			writeScheduledTask(scoped);
			const harness = await start();
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("web_fetch", { urls: "https://api.example.com/status" }),
						fauxToolCall("web_fetch", { urls: "https://evil.example.org/leak" }),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("go");
			const results = harness
				.eventsOfType("tool_execution_end")
				.map((event) => `${event.isError ? "error" : "ok"} ${JSON.stringify(event.result.content)}`);
			expect(results[0]).toMatch(/^ok .*fetched https:\/\/api\.example\.com/);
			expect(results[1]).toMatch(/^error .*evil\.example\.org/);

			// A task's file is created once: the same name with no host is a new task.
			rmSync(join(agentDir, "scheduled", "nightly.json"));
			writeScheduledTask(task());
			const offline = await start();
			offline.setResponses([
				fauxAssistantMessage(fauxToolCall("web_fetch", { urls: "https://api.example.com/status" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			]);
			await offline.session.prompt("go");
			expect(JSON.stringify(getToolResult(offline, "web_fetch").content)).toContain("the user is away");
		});
	});

	describe("run reports", () => {
		it("records a failed run by its exit code and notifies only failures and refusals", () => {
			writeScheduledTask(task());
			const notices: string[] = [];
			const notify = (title: string) => notices.push(title);
			beginScheduledRun("nightly", undefined, false);
			endScheduledRun(1, notify);
			beginScheduledRun("nightly", undefined, false);
			endScheduledRun(0, notify);
			// No run in this process: nothing is recorded.
			endScheduledRun(0, notify);
			expect(lastRuns("nightly")).toEqual([
				expect.objectContaining({ outcome: "failed", detail: expect.stringContaining("exit code 1") }),
				expect.objectContaining({ outcome: "finished", detail: "nothing refused" }),
			]);
			expect(notices).toEqual(["Scheduled task nightly failed"]);
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ desktopNotifications: { enabled: false } }));
			beginScheduledRun("nightly", undefined, false);
			endScheduledRun(2, notify);
			expect(notices).toHaveLength(1);
		});
		it("sums up the unseen runs once, in Prism's language, with a warning when one went wrong", () => {
			writeScheduledTask(task());
			writeScheduledTask(task({ id: "weekly" }));
			recordRun("nightly", { at: "2026-10-27T12:00:00.000Z", outcome: "started" });
			recordRun("nightly", { at: "2026-10-27T12:05:00.000Z", outcome: "finished", detail: "nothing refused" });
			recordRun("weekly", {
				at: "2026-10-27T13:00:00.000Z",
				outcome: "missed",
				detail: "started late (computer off or asleep); not run",
			});
			recordRun("weekly", {
				at: "2026-10-27T14:00:00.000Z",
				outcome: "failed",
				detail: "exit code 2; journalctl --user -u prism-task-weekly.service shows the error",
			});
			setLanguage("fr");
			const report = unseenRunsReport();
			expect(report?.message).toContain(
				"échec: code de sortie 2 ; journalctl --user -u prism-task-weekly.service montre l'erreur",
			);
			expect(report?.level).toBe("warning");
			expect(report?.message).toContain("Passages planifiés depuis votre dernière visite");
			expect(report?.message).toContain("nightly · 27 oct. 2026");
			expect(report?.message).toContain("terminé: rien refusé");
			expect(report?.message).toContain("manqué: démarré en retard (ordinateur éteint ou en veille) ; non exécuté");
			// A start whose run ended is not listed apart.
			expect(report?.message).not.toContain("démarré,");
			expect(unseenRunsReport()).toBeUndefined();
			recordRun("nightly", {
				at: new Date(Date.now() + 60_000).toISOString(),
				outcome: "finished",
				detail: "nothing refused",
			});
			setLanguage("en");
			expect(unseenRunsReport()).toMatchObject({
				level: "info",
				message: expect.stringContaining("finished: nothing refused"),
			});
		});
	});

	describe("proposed by the model", () => {
		const proposal = {
			prompt: "Run the tests",
			name: "nightly-tests",
			when: "*-*-* 02:00",
			change_files: false,
			run_commands: true,
			hosts: ["registry.npmjs.org"],
			minutes: 10,
			tool_calls: 30,
		};
		async function start(mode: "tui" | "print", answer?: string) {
			const harness = await createHarness({
				extensionFactories: [
					{ name: "permissions", factory: permissionsExtension },
					{ name: "schedule", factory: scheduleCommand(systemd, installed) },
				],
			});
			harnesses.push(harness);
			const titles: string[] = [];
			await harness.session.bindExtensions({
				mode,
				uiContext: createTestUiContext({
					select: async (title, choices) => {
						titles.push(title);
						return choices.find((choice) => choice === answer);
					},
				}),
			});
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("propose_scheduled_task", proposal), { stopReason: "toolUse" }),
				fauxAssistantMessage("ok"),
			]);
			await harness.session.prompt("run the tests every night");
			return { result: getToolResult(harness, "propose_scheduled_task"), titles };
		}
		it.skipIf(!hasSystemdAnalyze)(
			"creates nothing unless the user confirms the same summary as /schedule",
			async () => {
				const declined = await start("tui", "Cancel");
				expect(declined.result.isError).toBe(true);
				expect(JSON.stringify(declined.result.content)).toContain("did not create");
				expect(declined.titles[0]).toContain("The agent proposes a scheduled task.");
				expect(declined.titles[0]).toContain("registry.npmjs.org");
				expect(readScheduledTask("nightly-tests")).toBeUndefined();
				expect(systemd.calls).toEqual([]);
				const accepted = await start("tui", "Create the task");
				expect(accepted.result.isError).not.toBe(true);
				expect(readScheduledTask("nightly-tests")).toMatchObject({
					cwd: expect.any(String),
					budget: { minutes: 10, tools: 30 },
					catchUp: "report",
					operations: [
						expect.objectContaining({ commands: ["*"] }),
						expect.objectContaining({ hosts: ["registry.npmjs.org"] }),
					],
				});
				expect(systemd.calls).toContainEqual(["enable", "--now", "prism-task-nightly-tests.timer"]);
			},
		);
		// a client answering after the turn was cancelled installed the task.
		it("installs nothing when the user confirms after the turn was cancelled", async () => {
			const harness = await createHarness({
				extensionFactories: [
					{ name: "permissions", factory: permissionsExtension },
					{ name: "schedule", factory: scheduleCommand(systemd, installed) },
				],
			});
			harnesses.push(harness);
			let asked: (answer: string) => void = () => {};
			const opened = new Promise<void>((resolveOpened) => {
				harness.session
					.bindExtensions({
						mode: "tui",
						uiContext: createTestUiContext({
							// A client that keeps the question and answers it late, whatever the signal says.
							select: (_title, _choices) =>
								new Promise<string | undefined>((resolveAnswer) => {
									asked = resolveAnswer;
									resolveOpened();
								}),
						}),
					})
					.catch(() => {});
			});
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("propose_scheduled_task", proposal), { stopReason: "toolUse" }),
				fauxAssistantMessage("ok"),
			]);
			const turn = harness.session.prompt("run the tests every night").catch(() => {});
			await opened;
			await harness.session.abort();
			asked("Create the task");
			await turn;
			await new Promise((resolveWait) => setTimeout(resolveWait, 50));
			expect(readScheduledTask("nightly-tests")).toBeUndefined();
			expect(systemd.calls).toEqual([]);
		});
		it("is refused without the interactive terminal", async () => {
			const { result, titles } = await start("print", "Create the task");
			expect(result.isError).toBe(true);
			expect(titles).toEqual([]);
			expect(readScheduledTask("nightly-tests")).toBeUndefined();
		});
	});

	describe("/schedule", () => {
		async function start(answers: { inputs: string[]; selects: (string | undefined)[] }) {
			const harness = await createHarness({
				extensionFactories: [{ name: "schedule", factory: scheduleCommand(systemd, installed) }],
			});
			harnesses.push(harness);
			const titles: string[] = [];
			const notices: string[] = [];
			await harness.session.bindExtensions({
				mode: "tui",
				uiContext: createTestUiContext({
					notify: (message) => notices.push(message),
					input: async () => answers.inputs.shift(),
					select: async (title, choices) => {
						titles.push(title);
						const answer = answers.selects.shift();
						return answer === undefined ? undefined : choices.find((choice) => choice.startsWith(answer));
					},
				}),
			});
			return { harness, titles, notices };
		}
		const inputs = (hosts = "") => ["Check the build", "build-check", "09:00", hosts, "15", "40"];

		it.skipIf(!hasSystemdAnalyze)(
			"creates a task only after the user read what it may do and confirmed",
			async () => {
				const { harness, titles } = await start({
					inputs: inputs(),
					selects: ["New scheduled task", "Monday to Friday", "Yes", "No", "Report it only", "Create the task"],
				});
				await harness.session.prompt("/schedule");
				const summary = titles.at(-1) ?? "";
				expect(summary).toContain("Change the project's files");
				expect(summary).not.toContain("Run commands in the sandbox");
				expect(summary).toContain("no sudo, no unrestricted mode");
				expect(summary).toContain("Prism does not enable lingering");
				expect(summary).toContain("prism-task-build-check.timer");
				expect(readScheduledTask("build-check")).toMatchObject({
					budget: { minutes: 15, tools: 40 },
					catchUp: "report",
					operations: [{ what: "Change the project's files" }],
				});
				expect(systemd.calls).toContainEqual(["enable", "--now", "prism-task-build-check.timer"]);
			},
		);
		it.skipIf(!hasSystemdAnalyze)(
			"names the hosts a task may reach, and refuses anything but host names",
			async () => {
				const { harness, titles } = await start({
					inputs: inputs("api.github.com, *.example.com"),
					selects: ["New scheduled task", "Monday to Friday", "No", "No", "Report it only", "Create the task"],
				});
				await harness.session.prompt("/schedule");
				expect(titles.at(-1)).toContain(
					"Connect to these hosts (commands it may run, web_fetch, web_search): api.github.com, *.example.com",
				);
				expect(readScheduledTask("build-check")?.operations).toEqual([
					expect.objectContaining({ commands: [], writes: [], hosts: ["api.github.com", "*.example.com"] }),
				]);
				for (const bad of ["localhost:8080", "https://x.com", "10.0.0.1"]) {
					removeTask("build-check", systemd);
					const refused = await start({
						inputs: inputs(bad),
						selects: ["New scheduled task", "Monday to Friday", "No", "No"],
					});
					await refused.harness.session.prompt("/schedule");
					expect(readScheduledTask("build-check"), bad).toBeUndefined();
				}
			},
		);
		it.skipIf(!hasSystemdAnalyze)("writes nothing when the user cancels or the schedule is invalid", async () => {
			const cancelled = await start({
				inputs: inputs(),
				selects: ["New scheduled task", "Monday to Friday", "Yes", "Yes", "Report it only", "Cancel"],
			});
			await cancelled.harness.session.prompt("/schedule");
			const invalid = await start({
				inputs: ["Check the build", "build-check", "sometimes"],
				selects: ["New scheduled task", "Other"],
			});
			await invalid.harness.session.prompt("/schedule");
			expect(readScheduledTask("build-check")).toBeUndefined();
			expect(existsSync(join(root, "units"))).toBe(false);
			expect(systemd.calls).toEqual([]);
		});
		it("says so when an empty name cancels the creation, and stays quiet on Escape", async () => {
			const empty = await start({ inputs: ["Check the build", ""], selects: ["New scheduled task"] });
			await empty.harness.session.prompt("/schedule");
			expect(empty.notices).toEqual(["No name given: the task was not created."]);
			const escaped = await start({ inputs: ["Check the build"], selects: ["New scheduled task"] });
			await escaped.harness.session.prompt("/schedule");
			expect(escaped.notices).toEqual([]);
			expect(existsSync(join(agentDir, "scheduled"))).toBe(false);
			expect(existsSync(join(root, "units"))).toBe(false);
			expect(systemd.calls).toEqual([]);
		});
	});
});
