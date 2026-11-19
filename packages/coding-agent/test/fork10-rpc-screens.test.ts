// the operations behind the window's own screens for /perm, /bg and /files. The engine
// keeps the decisions and refuses what it must; the window only draws the answers (rpc-builtins.ts).
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import backgroundExtension from "../src/fork/background.ts";
import budgetsExtension, { type BudgetSnapshot } from "../src/fork/budgets.ts";
import { getPrismChangelogPath } from "../src/fork/changelog.ts";
import fileBrowserExtension, { noteExported } from "../src/fork/file-browser.ts";
import { translateKitChoices } from "../src/fork/menu-i18n.ts";
import permissionsExtension, { type PermissionsSnapshot } from "../src/fork/permissions.ts";
import prismExtension from "../src/fork/prism/index.ts";
import { handleBuiltinCommand, MAX_READ_BYTES, MAX_READ_CHUNK } from "../src/fork/rpc-builtins.ts";
import type { SandboxField, SandboxPanelState } from "../src/fork/sandbox-panel.ts";
import { type ScheduleSnapshot, scheduleCommand } from "../src/fork/schedule-command.ts";
import { type PrismLauncher, realSystemd, type SystemdUser } from "../src/fork/scheduled-tasks.ts";
import type { TutorialPanelState } from "../src/fork/tutorial.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

interface PermAnswer {
	state: PermissionsSnapshot;
	error?: string;
}
interface SandboxAnswer {
	state: SandboxPanelState;
	error?: string;
}
interface BgTask {
	id: string;
	status: string;
	exitCode?: number;
}
interface BgAnswer {
	tasks: BgTask[];
	error?: string;
}

describe("fork.10: the window's screens", () => {
	let agentDir: string;
	const saved = process.env[ENV_AGENT_DIR];
	const harnesses: Harness[] = [];

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-rpc-screens-"));
		process.env[ENV_AGENT_DIR] = agentDir;
		// No sandbox: nothing here may depend on bubblewrap.
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ sandbox: { modes: { safe: false, ask: false, broad: false } } }),
		);
	});
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		if (saved === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = saved;
		rmSync(agentDir, { recursive: true, force: true });
	});

	/** systemd's answers, as the tests of scheduled tasks give them: nothing here reaches the real one. */
	const systemd = (): SystemdUser & { calls: string[][] } => {
		const calls: string[][] = [];
		return {
			calls,
			unitDir: () => join(agentDir, "units"),
			systemctl: (args) => {
				calls.push(args);
				return { ok: true, output: args[0] === "is-enabled" ? "enabled" : "" };
			},
			// The calendar is systemd's own: the real systemd-analyze, which installs nothing.
			analyze: (args) => realSystemd.analyze(args),
		};
	};
	const installed: PrismLauncher = {
		invocation: (id) => ({ command: "/usr/bin/node", args: ["/opt/prism/dist/cli.js", "--scheduled", id] }),
		packageDir: () => "/opt/prism",
	};

	async function engine(
		answer: (title: string, options: string[]) => string | undefined = () => undefined,
		units: SystemdUser = systemd(),
	) {
		const harness = await createHarness({
			extensionFactories: [
				{ name: "permissions", factory: permissionsExtension },
				{ name: "background", factory: backgroundExtension },
				{ name: "files", factory: fileBrowserExtension },
				{ name: "budgets", factory: budgetsExtension },
				{ name: "schedule", factory: scheduleCommand(units, installed) },
				{ name: "prism", factory: prismExtension },
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({ select: async (title, options) => answer(title, options) }),
		});
		const call = async <T>(command: Record<string, unknown>): Promise<T> => {
			const reply = (await handleBuiltinCommand(
				{ ...command, id: "request-id" } as Parameters<typeof handleBuiltinCommand>[0],
				harness.session,
				{} as never,
				{} as never,
				async () => {},
			)) as { data: T };
			return reply.data;
		};
		const toolCall = async (name: string, args: Parameters<typeof fauxToolCall>[1]) => {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("go");
		};
		return { harness, call, toolCall };
	}

	describe("perm_*", () => {
		it("describes the modes, their sandbox and the policy", async () => {
			const { call } = await engine();
			const { state } = await call<PermAnswer>({ type: "perm_get" });
			// with no mode configured, Prism starts in broad.
			expect(state.mode).toBe("broad");
			expect(state.defaultMode).toBe("broad");
			expect(state.modes.map((entry) => entry.mode)).toEqual(["safe", "ask", "broad", "unrestricted"]);
			expect(state.modes.at(-1)?.sandbox).toBe("off");
			expect(state.modes[1]?.sandbox).toBe("off");
			expect(state.rows.length).toBeGreaterThan(5);
			expect(state.rows[0]?.verdicts.unrestricted).toBeDefined();
			expect(state.help).toContain("/perm");
		});

		it("changes the mode, and saves it only when asked", async () => {
			const { call } = await engine();
			const once = await call<PermAnswer>({ type: "perm_mode", mode: "ask" });
			expect(once.state.mode).toBe("ask");
			expect(once.state.defaultMode).toBe("broad");
			expect(existsSync(join(agentDir, "permissions.json"))).toBe(false);
			const kept = await call<PermAnswer>({ type: "perm_mode", mode: "ask", asDefault: true });
			expect(kept.state.defaultMode).toBe("ask");
			expect(JSON.parse(readFileSync(join(agentDir, "permissions.json"), "utf8")).mode).toBe("ask");
		});

		it("unrestricted needs the warning accepted; refused, nothing changes", async () => {
			let accept = false;
			const { call } = await engine((_title, options) => (accept ? options[0] : "Cancel"));
			const refused = await call<PermAnswer>({ type: "perm_mode", mode: "unrestricted" });
			expect(refused.error).toBeTruthy();
			expect(refused.state.mode).toBe("broad");
			expect(refused.state.unrestrictedAccepted).toBe(false);
			accept = true;
			const accepted = await call<PermAnswer>({ type: "perm_mode", mode: "unrestricted" });
			expect(accepted.error).toBeUndefined();
			expect(accepted.state.mode).toBe("unrestricted");
			expect(accepted.state.unrestrictedAccepted).toBe(true);
			await expect(call({ type: "perm_mode", mode: "root" })).rejects.toThrow(/Unknown mode/);
		});

		it("a session rule added here decides for real, and taking it back ends it", async () => {
			const asked: string[] = [];
			const { harness, call, toolCall } = await engine((title, options) => {
				asked.push(title);
				return options.find((option) => option.startsWith("Block"));
			});
			const witness = join(harness.tempDir, "w");
			// In ask mode, where touch needs a permission; broad, the default since 2026-11-18, needs none.
			await call<PermAnswer>({ type: "perm_mode", mode: "ask" });
			const added = await call<PermAnswer>({
				type: "perm_rule",
				action: "add",
				effect: "allow",
				rule: "bash(touch *)",
				where: "session",
			});
			expect(added.state.sessionRules.allow).toEqual(["bash(touch *)"]);
			await toolCall("bash", { command: `touch ${witness}` });
			expect(existsSync(witness)).toBe(true);
			expect(asked).toEqual([]);

			const grant = added.state.grants.find((entry) => entry.scope !== "");
			expect(grant).toBeDefined();
			const stale = await call<PermAnswer>({ type: "perm_revoke", index: grant?.index, what: "something else" });
			expect(stale.error).toBeTruthy();
			expect(stale.state.sessionRules.allow).toHaveLength(1);
			const revoked = await call<PermAnswer>({ type: "perm_revoke", index: grant?.index, what: grant?.what });
			expect(revoked.state.sessionRules.allow).toEqual([]);
			rmSync(witness);
			await toolCall("bash", { command: `touch ${witness}` });
			expect(asked).toHaveLength(1);
			expect(existsSync(witness)).toBe(false);
		});

		it("a session rule added here blocks for real", async () => {
			const { harness, call, toolCall } = await engine((_title, options) => options.find((o) => o === "Allow once"));
			const witness = join(harness.tempDir, "w");
			await call({ type: "perm_rule", action: "add", effect: "deny", rule: "bash(touch *)", where: "session" });
			await toolCall("bash", { command: `touch ${witness}` });
			expect(existsSync(witness)).toBe(false);
		});

		it("refuses a bad rule, an 'ask' for the session, and an untrusted project", async () => {
			const { harness, call } = await engine();
			const rule = { type: "perm_rule", action: "add" };
			const bad = await call<PermAnswer>({ ...rule, effect: "allow", rule: "not a rule(", where: "session" });
			expect(bad.error).toMatch(/Invalid rule/);
			const ask = await call<PermAnswer>({ ...rule, effect: "ask", rule: "bash(ls*)", where: "session" });
			expect(ask.error).toMatch(/cannot ask/);
			expect(ask.state.sessionRules).toEqual({ allow: [], deny: [] });
			harness.settingsManager.setProjectTrusted(false);
			const untrusted = await call<PermAnswer>({ ...rule, effect: "allow", rule: "bash(ls*)", where: "project" });
			expect(untrusted.error).toMatch(/not trusted/);
			expect(untrusted.state.saved.find((source) => source.where === "project")?.read).toBe(false);
			expect(existsSync(untrusted.state.saved.find((source) => source.where === "project")?.file ?? "")).toBe(false);
		});

		it("saves a global rule in the file and takes it out", async () => {
			const { call } = await engine();
			const rule = { type: "perm_rule", effect: "deny", rule: "bash(rm *)", where: "global" };
			const added = await call<PermAnswer>({ ...rule, action: "add" });
			expect(added.error).toBeUndefined();
			expect(added.state.saved.find((source) => source.where === "global")?.deny).toEqual(["bash(rm *)"]);
			expect(JSON.parse(readFileSync(join(agentDir, "permissions.json"), "utf8")).deny).toEqual(["bash(rm *)"]);
			const removed = await call<PermAnswer>({ ...rule, action: "remove" });
			expect(removed.state.saved.find((source) => source.where === "global")?.deny).toEqual([]);
		});

		it("turns a mode's sandbox on in the settings, unrestricted included", async () => {
			const { call } = await engine();
			const answer = await call<PermAnswer>({ type: "perm_sandbox", mode: "safe", on: true });
			expect(answer.error).toBeUndefined();
			expect(answer.state.modes[0]?.sandbox).toBe("on");
			expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).sandbox.modes.safe).toBe(true);
			const yolo = await call<PermAnswer>({ type: "perm_sandbox", mode: "unrestricted", on: true });
			expect(yolo.state.modes.at(-1)?.sandbox).toBe("on");
			await expect(call({ type: "perm_sandbox", mode: "nope", on: true })).rejects.toThrow(/Unknown mode/);
		});
	});

	describe("sandbox_*", () => {
		const field = (state: SandboxPanelState, id: string): SandboxField | undefined =>
			state.sections.flatMap((section) => section.fields).find((entry) => entry.id === id);
		const saved = () => JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).sandbox;

		it("draws the settings of /settings as sections with the current values", async () => {
			const { call } = await engine();
			const { state } = await call<SandboxAnswer>({ type: "sandbox_get" });
			expect(state.problem).toBeUndefined();
			expect(state.sections.map((section) => section.id)).toEqual(["modes", "network", "commands", "files"]);
			expect(field(state, "modes.safe")).toMatchObject({ kind: "switch", on: false });
			expect(field(state, "network.allow")).toMatchObject({ kind: "list", items: [] });
			expect(field(state, "read.limit")).toMatchObject({ kind: "choice", options: ["project", "all"] });
		});

		it("saves a switch and a choice in the settings", async () => {
			const { call } = await engine();
			const on = await call<SandboxAnswer>({ type: "sandbox_set", setting: "network.askNewHosts", value: false });
			expect(on.error).toBeUndefined();
			expect(field(on.state, "network.askNewHosts")).toMatchObject({ on: false });
			expect(saved().network.askNewHosts).toBe(false);
			const limit = await call<SandboxAnswer>({ type: "sandbox_set", setting: "read.limit", value: "all" });
			expect(limit.error).toBeUndefined();
			expect(saved().read.limit).toBe("all");
			// Limited to nothing, the tools and the extra paths are not offered any more.
			expect(field(limit.state, "read.allow")).toBeUndefined();
		});

		it("refuses what the screen does not offer, and writes nothing", async () => {
			const { call } = await engine();
			const before = readFileSync(join(agentDir, "settings.json"), "utf8");
			for (const command of [
				{ type: "sandbox_set", setting: "network.proxy", value: "http://elsewhere" },
				{ type: "sandbox_set", setting: "__proto__", value: true },
				{ type: "sandbox_set", setting: "modes.safe", value: "yes" },
				{ type: "sandbox_set", setting: "read.limit", value: "nothing" },
				{ type: "sandbox_set", setting: "network.allow", value: true },
				{ type: "sandbox_list", setting: "modes.safe", action: "add", text: "x" },
				{ type: "sandbox_list", setting: "network.allow", action: "remove", text: "not-there" },
				{ type: "sandbox_list", setting: "network.allow", action: "replace", text: "x" },
			])
				expect((await call<SandboxAnswer>(command)).error).toBeTruthy();
			expect(readFileSync(join(agentDir, "settings.json"), "utf8")).toBe(before);
		});

		it("adds to a list and takes back from it, without duplicates", async () => {
			const { call } = await engine();
			const add = { type: "sandbox_list", setting: "network.allow", action: "add", text: "  example.com " };
			await call<SandboxAnswer>(add);
			const twice = await call<SandboxAnswer>(add);
			expect(twice.error).toBeUndefined();
			expect(saved().network.allow).toEqual(["example.com"]);
			expect(field(twice.state, "network.allow")).toMatchObject({ items: [{ text: "example.com" }] });
			const removed = await call<SandboxAnswer>({ ...add, action: "remove" });
			expect(removed.error).toBeUndefined();
			expect(saved().network.allow).toEqual([]);
		});

		it("adds a readable path for this project or for all, and says why one is refused", async () => {
			const { call, harness } = await engine();
			const add = { type: "sandbox_list", setting: "read.allow", action: "add" };
			const global = await call<SandboxAnswer>({ ...add, text: harness.tempDir, where: "global" });
			expect(global.error).toBeUndefined();
			expect(saved().read.allow).toEqual([harness.tempDir]);
			const project = await call<SandboxAnswer>({ ...add, text: harness.tempDir, where: "project" });
			expect(project.error).toBeUndefined();
			const items = field(project.state, "read.allow");
			expect(items?.kind === "list" ? items.items.map((item) => item.key === "global") : []).toEqual([true, false]);
			const refused = await call<SandboxAnswer>({ ...add, text: join(agentDir, "no-such-file"), where: "global" });
			expect(refused.error).toBeTruthy();
			expect(saved().read.allow).toEqual([harness.tempDir]);
			const grant = items?.kind === "list" ? items.items[1] : undefined;
			const back = await call<SandboxAnswer>({
				type: "sandbox_list",
				setting: "read.allow",
				action: "remove",
				text: grant?.text,
				key: grant?.key,
			});
			expect(back.error).toBeUndefined();
			const left = field(back.state, "read.allow");
			expect(left?.kind === "list" ? left.items.length : -1).toBe(1);
		});

		it("offers nothing to change when the settings file was never valid", async () => {
			const broken = '{ "sandbox": { "modes": ';
			writeFileSync(join(agentDir, "settings.json"), broken);
			const { call } = await engine();
			const { state } = await call<SandboxAnswer>({ type: "sandbox_get" });
			expect(state.problem).toContain("settings.json");
			expect(state.sections).toEqual([]);
			const refused = await call<SandboxAnswer>({ type: "sandbox_set", setting: "modes.safe", value: true });
			expect(refused.error).toBeTruthy();
			expect(readFileSync(join(agentDir, "settings.json"), "utf8")).toBe(broken);
		});

		it("does not overwrite a settings file that became invalid", async () => {
			const { call } = await engine();
			await call<SandboxAnswer>({ type: "sandbox_get" });
			const broken = '{ "sandbox": { "modes": ';
			writeFileSync(join(agentDir, "settings.json"), broken);
			const refused = await call<SandboxAnswer>({ type: "sandbox_set", setting: "modes.safe", value: true });
			expect(refused.error).toBeTruthy();
			expect(readFileSync(join(agentDir, "settings.json"), "utf8")).toBe(broken);
		});
	});

	describe("budget_*", () => {
		interface BudgetAnswer {
			state: BudgetSnapshot;
			error?: string;
		}
		const row = (state: BudgetSnapshot, kind: string) => state.rows.find((entry) => entry.kind === kind);

		it("shows every limit, sets one and takes it back", async () => {
			const { call } = await engine();
			const { state } = await call<BudgetAnswer>({ type: "budget_get" });
			expect(state.rows.map((entry) => entry.kind)).toEqual(["time", "tools", "tokens", "cost"]);
			expect(row(state, "tools")?.limit).toBeNull();
			const set = await call<BudgetAnswer>({ type: "budget_set", kind: "tools", value: 50 });
			expect(set.error).toBeUndefined();
			expect(row(set.state, "tools")?.limit).toBe(50);
			const off = await call<BudgetAnswer>({ type: "budget_set", kind: "tools", value: null });
			expect(row(off.state, "tools")?.limit).toBeNull();
		});

		it("refuses what /budget refuses", async () => {
			const { call } = await engine();
			expect((await call<BudgetAnswer>({ type: "budget_set", kind: "tools", value: -3 })).error).toBeTruthy();
			await expect(call({ type: "budget_set", kind: "patience", value: 3 })).rejects.toThrow(/Unknown budget/);
			await expect(call({ type: "budget_set", kind: "tools", value: "3" })).rejects.toThrow(/Invalid budget/);
		});

		it("/budget by its words still answers as before", async () => {
			const notices: string[] = [];
			const { harness } = await engine();
			await harness.session.bindExtensions({
				uiContext: createTestUiContext({ notify: (message) => notices.push(message) }),
			});
			await harness.session.prompt("/budget tools 7");
			expect(notices.at(-1)).toMatch(/\/ 7/);
			await harness.session.prompt("/budget tools nope");
			expect(notices.at(-1)).toMatch(/Usage: \/budget/);
		});
	});

	describe("schedule_*", () => {
		interface ScheduleAnswer {
			state: ScheduleSnapshot;
			summary?: string;
			fingerprint?: string;
			error?: string;
		}
		const form = {
			prompt: "Run the tests",
			name: "nightly",
			when: "daily",
			files: true,
			commands: false,
			hosts: "",
			minutes: "20",
			tools: "50",
			catchUp: "report",
		};

		it("checks a draft as /schedule does, and writes nothing before the creation", async () => {
			const units = systemd();
			const { call } = await engine(undefined, units);
			for (const wrong of [
				{ prompt: " " },
				{ name: "Not Valid" },
				{ when: "not a calendar" },
				{ hosts: "not a host/" },
				{ minutes: "0" },
				{ tools: "many" },
			]) {
				const answer = await call<ScheduleAnswer>({ type: "schedule_preview", form: { ...form, ...wrong } });
				expect(answer.error).toBeTruthy();
				expect(answer.summary).toBeUndefined();
			}
			const preview = await call<ScheduleAnswer>({ type: "schedule_preview", form });
			expect(preview.error).toBeUndefined();
			expect(preview.summary).toContain("Run the tests");
			expect(preview.state.tasks).toEqual([]);
			expect(existsSync(join(agentDir, "units"))).toBe(false);
		});

		it("creates, pauses and removes a task, through systemd only", async () => {
			const units = systemd();
			const { call } = await engine(undefined, units);
			const { fingerprint } = await call<ScheduleAnswer>({ type: "schedule_preview", form });
			const created = await call<ScheduleAnswer>({ type: "schedule_create", form, fingerprint });
			expect(created.error).toBeUndefined();
			expect(created.state.tasks.map((task) => task.id)).toEqual(["nightly"]);
			expect(existsSync(join(agentDir, "units"))).toBe(true);
			const again = await call<ScheduleAnswer>({ type: "schedule_create", form, fingerprint });
			expect(again.error).toMatch(/already exists/);
			const paused = await call<ScheduleAnswer>({ type: "schedule_pause", task: "nightly", paused: true });
			expect(paused.error).toBeUndefined();
			expect(units.calls.some((args) => args.includes("disable") || args.includes("stop"))).toBe(true);
			const removed = await call<ScheduleAnswer>({ type: "schedule_remove", task: "nightly" });
			expect(removed.error).toBeUndefined();
			expect(removed.state.tasks).toEqual([]);
		});

		// the window's form stayed editable while its summary was prepared,
		// and "Create" sent the form as it was then, not the one the summary showed.
		it("creates only the task its summary showed", async () => {
			const { call } = await engine(undefined, systemd());
			const preview = await call<ScheduleAnswer>({ type: "schedule_preview", form });
			expect(preview.fingerprint).toMatch(/^[0-9a-f]{64}$/);
			const changed = { ...form, prompt: "Delete the build folder", commands: true };
			const refused = await call<ScheduleAnswer>({
				type: "schedule_create",
				form: changed,
				fingerprint: preview.fingerprint,
			});
			expect(refused.error).toMatch(/Review it again/);
			expect(refused.state.tasks).toEqual([]);
			expect((await call<ScheduleAnswer>({ type: "schedule_create", form: changed })).error).toMatch(
				/Review it again/,
			);
			const created = await call<ScheduleAnswer>({
				type: "schedule_create",
				form,
				fingerprint: preview.fingerprint,
			});
			expect(created.error).toBeUndefined();
			expect(created.state.tasks.map((task) => task.prompt)).toEqual(["Run the tests"]);
		});

		it("refuses a task that does not exist", async () => {
			const { call } = await engine();
			for (const task of ["ghost", "../../etc", ""]) {
				expect((await call<ScheduleAnswer>({ type: "schedule_pause", task, paused: true })).error).toBeTruthy();
				expect((await call<ScheduleAnswer>({ type: "schedule_remove", task })).error).toBeTruthy();
			}
		});
	});

	describe("tutorial_*", () => {
		it("gives the nine modules as data, with the keys and no function", async () => {
			const { call } = await engine();
			const { state } = await call<{ state: TutorialPanelState }>({ type: "tutorial_get" });
			expect(state.modules).toHaveLength(9);
			expect(JSON.parse(JSON.stringify(state))).toEqual(state);
			expect(state.interrupt.ids.length).toBeGreaterThan(0);
			const permissions = state.modules.find((module) => module.id === "permissions");
			expect(permissions?.exercise?.command).toBe("/perm");
			expect(permissions?.exercise?.items?.length).toBeGreaterThan(0);
			expect(permissions?.exercise?.notes.picked).toContain("{0}");
			const following = state.modules.find((module) => module.id === "following");
			expect(following?.exercise?.key?.ids.length).toBeGreaterThan(0);
		});

		it("keeps the progress as the terminal does, dropping unknown modules", async () => {
			const { call } = await engine();
			const { progress } = await call<{ progress: unknown }>({
				type: "tutorial_progress",
				done: ["first-steps", "first-steps", "no-such-module", 3],
				skipped: "nope",
			});
			expect(progress).toEqual({ done: ["first-steps"], skipped: [] });
			const { state } = await call<{ state: TutorialPanelState }>({ type: "tutorial_get" });
			expect(state.progress.done).toEqual(["first-steps"]);
			expect(JSON.parse(readFileSync(join(agentDir, "tutorial.json"), "utf8")).done).toEqual(["first-steps"]);
		});
	});

	describe("sessions_*", () => {
		interface SessionsAnswer {
			current: string | null;
			sessions: Array<{ path: string; name?: string }>;
		}
		/** A saved session in the same folder as the engine's. */
		const saved = (harness: Harness) => {
			const manager = harness.session.sessionManager;
			const other = SessionManager.create(manager.getCwd(), manager.getSessionDir());
			other.appendMessage({ role: "user", content: "older work", timestamp: Date.now() });
			other.appendMessage(fauxAssistantMessage("done"));
			return other.getSessionFile() as string;
		};

		it("lists, renames and deletes a saved session", async () => {
			const { call, harness } = await engine();
			const path = saved(harness);
			const { sessions } = await call<SessionsAnswer>({ type: "sessions_list" });
			expect(sessions.map((session) => session.path)).toContain(path);
			expect(await call({ type: "sessions_rename", path, name: "  kept " })).toEqual({});
			const after = await call<SessionsAnswer>({ type: "sessions_list", all: true });
			expect(after.sessions.find((session) => session.path === path)?.name).toBe("kept");
			expect(await call<{ error?: string }>({ type: "sessions_delete", path })).not.toHaveProperty("error");
			expect(existsSync(path)).toBe(false);
		});

		it("finds a saved session by its text", async () => {
			const { call, harness } = await engine();
			const path = saved(harness);
			const { hits } = await call<{ hits: Array<{ path: string; text: string }> }>({
				type: "sessions_search",
				query: "done",
				all: true,
			});
			expect(hits.find((hit) => hit.path === path)?.text).toContain("done");
		});

		it("refuses a file it does not list, and the session in use", async () => {
			const { call, harness } = await engine();
			const outside = join(agentDir, "not-a-session.jsonl");
			writeFileSync(outside, "keep me");
			for (const command of [
				{ type: "sessions_delete", path: outside },
				{ type: "sessions_rename", path: outside, name: "x" },
				{ type: "sessions_delete", path: "" },
			])
				expect((await call<{ error?: string }>(command)).error).toBeTruthy();
			expect(readFileSync(outside, "utf8")).toBe("keep me");
			const path = saved(harness);
			expect((await call<{ error?: string }>({ type: "sessions_rename", path, name: " " })).error).toBeTruthy();
		});

		// the window shows a saved session this way while its own engine starts.
		it("previews a saved session without opening or changing it, and only from the sessions folder", async () => {
			const { call, harness } = await engine();
			const path = saved(harness);
			const before = readFileSync(path, "utf8");
			const { messages } = await call<{ messages?: Array<{ role: string }> }>({ type: "session_preview", path });
			expect(messages?.map((message) => message.role)).toEqual(["user", "assistant"]);
			expect(readFileSync(path, "utf8")).toBe(before);
			expect(harness.session.sessionManager.getSessionFile()).not.toBe(path);
			const outside = join(agentDir, "copy.jsonl");
			writeFileSync(outside, before);
			const older = path.replace(/\.jsonl$/, "-v2.jsonl");
			writeFileSync(older, before.replace('"version":3', '"version":2'));
			for (const target of [outside, older, "", 3])
				expect(await call({ type: "session_preview", path: target })).toEqual({});
			expect(readFileSync(older, "utf8")).toBe(before.replace('"version":3', '"version":2'));
		});
	});

	describe("get_changelog", () => {
		it("uses the fork's source notes and prefers a packaged copy when present", () => {
			const packageDir = join(agentDir, "packages", "coding-agent");
			mkdirSync(packageDir, { recursive: true });
			mkdirSync(join(agentDir, "fork"));
			const source = join(agentDir, "fork", "CHANGELOG.md");
			writeFileSync(source, "fork notes");
			expect(getPrismChangelogPath(packageDir)).toBe(source);
			const bundled = join(packageDir, "PRISM-CHANGELOG.md");
			writeFileSync(bundled, "packaged notes");
			expect(getPrismChangelogPath(packageDir)).toBe(bundled);
		});
		it("gives one item per version, its heading apart", async () => {
			const { call } = await engine();
			const { versions } = await call<{ versions: Array<{ title: string; markdown: string }> }>({
				type: "get_changelog",
			});
			expect(versions.length).toBeGreaterThan(0);
			expect(versions[0]?.title).toMatch(/^\d+\.\d+\.\d+/);
			expect(versions[0]?.title).toContain("fork.");
			expect(versions[0]?.markdown.startsWith("## ")).toBe(false);
		});
	});

	describe("get_docs", () => {
		it("lists and searches shipped pages and reads only a catalogued path", async () => {
			const { call } = await engine();
			const { topics } = await call<{ topics: Array<{ label: string; path: string }> }>({ type: "get_docs" });
			expect(topics.length).toBeGreaterThan(10);
			const topic = topics[0]!;
			const page = await call<{ path: string; markdown: string }>({ type: "get_docs", path: topic.path });
			expect(page.path).toBe(topic.path);
			expect(page.markdown.length).toBeGreaterThan(100);
			const { topics: found } = await call<{ topics: typeof topics }>({ type: "get_docs", query: topic.label });
			expect(found.map((entry) => entry.path)).toContain(topic.path);
			expect(await call({ type: "get_docs", query: topic.path })).toMatchObject({ topics: [{ path: topic.path }] });
			for (const path of ["../../settings.json", "/etc/passwd", "", null]) {
				await expect(call({ type: "get_docs", path })).rejects.toThrow("Unknown documentation page.");
			}
		});

		it("gives each result its own match count and first matching line", async () => {
			const { call } = await engine();
			type Found = { topics: Array<{ path: string; matches?: number; excerpt?: string }> };
			const { topics } = await call<Found>({ type: "get_docs", query: "linux" });
			expect(topics.length).toBeGreaterThan(1);
			for (const topic of topics.filter((entry) => entry.matches)) {
				expect(topic.matches).toBeGreaterThan(0);
				expect(topic.excerpt?.toLowerCase()).toContain("linux");
				expect(topic.excerpt).not.toMatch(/^\d+×/);
			}
			expect(new Set(topics.map((topic) => topic.excerpt)).size).toBeGreaterThan(1);
		});
	});

	describe("bg_*", () => {
		it("lists a task, reads its output, stops it and forgets it once ended", async () => {
			const { call, toolCall } = await engine((_title, options) => options.find((o) => o === "Allow once"));
			await toolCall("background", { action: "run", command: "echo from-the-task; sleep 30" });
			const { tasks } = await call<BgAnswer>({ type: "bg_list" });
			const task = tasks[0];
			expect(task?.status).toBe("running");
			const id = task?.id;
			await expect
				.poll(async () => (await call<{ log: string }>({ type: "bg_log", task: id })).log)
				.toContain("from-the-task");

			// A running task is not forgotten.
			expect((await call<BgAnswer>({ type: "bg_clear" })).tasks).toHaveLength(1);
			expect((await call<BgAnswer>({ type: "bg_stop", task: "nope" })).error).toMatch(/nope/);
			await call({ type: "bg_stop", task: id });
			await expect
				.poll(async () => (await call<BgAnswer>({ type: "bg_list" })).tasks[0]?.status, { timeout: 15_000 })
				.toBe("stopped");
			expect((await call<BgAnswer>({ type: "bg_clear" })).tasks).toEqual([]);
			await expect(call({ type: "bg_log", task: id })).rejects.toThrow(id ?? "");
		});
	});

	// the window's live view; the frames themselves are tested in fork-desktop-e2e.test.ts.
	describe("desktop_*", () => {
		it("says the agent's desktop is off while its module is", async () => {
			const { call } = await engine();
			await expect(call({ type: "desktop_frame" })).rejects.toThrow(/desktop is off/);
			await expect(call({ type: "desktop_stop" })).rejects.toThrow(/desktop is off/);
		});
	});

	describe("files_*", () => {
		function project(harness: Harness) {
			mkdirSync(join(harness.tempDir, "docs"));
			mkdirSync(join(harness.tempDir, ".git"));
			writeFileSync(join(harness.tempDir, "docs", "note.md"), "# Note\n\nbody of the note\n");
			writeFileSync(join(harness.tempDir, "run.sh"), "#!/bin/sh\n");
			chmodSync(join(harness.tempDir, "run.sh"), 0o755);
		}

		it("lists the project's folders with their figures, without .git", async () => {
			const { harness, call } = await engine();
			project(harness);
			const root = await call<{ dir: string; entries: Array<{ name: string; dir: boolean; size?: number }> }>({
				type: "files_list",
			});
			expect(root.dir).toBe("");
			expect(root.entries.map((entry) => entry.name)).toContain("docs");
			expect(root.entries.map((entry) => entry.name)).not.toContain(".git");
			const docs = await call<typeof root>({ type: "files_list", dir: "docs" });
			expect(docs.dir).toBe("docs");
			expect(docs.entries).toMatchObject([{ name: "note.md", dir: false, size: 25 }]);
		});

		it("previews the project's files and refuses what is outside, also through a link", async () => {
			const { harness, call } = await engine();
			project(harness);
			const outside = mkdtempSync(join(tmpdir(), "prism-outside-"));
			try {
				writeFileSync(join(outside, "secret"), "outside text");
				symlinkSync(outside, join(harness.tempDir, "away"));
				symlinkSync(join(outside, "secret"), join(harness.tempDir, "link.md"));
				const { preview } = await call<{ preview: { text?: string } }>({
					type: "files_preview",
					path: "docs/note.md",
				});
				expect(preview.text).toContain("body of the note");
				const refused = /Only the project's files/;
				await expect(call({ type: "files_preview", path: "../x" })).rejects.toThrow(refused);
				await expect(call({ type: "files_preview", path: join(outside, "secret") })).rejects.toThrow(refused);
				await expect(call({ type: "files_preview", path: "link.md" })).rejects.toThrow(refused);
				await expect(call({ type: "files_list", dir: "away" })).rejects.toThrow(refused);
				await expect(call({ type: "files_export", path: "link.md", folder: outside })).rejects.toThrow(refused);
			} finally {
				rmSync(outside, { recursive: true, force: true });
			}
		});

		describe("files_read (the phone downloads files with it)", () => {
			type Piece = { name: string; size: number; offset: number; length: number; data: string; eof: boolean };

			it("sends a project file in pieces, whatever length is asked, until its end", async () => {
				const { harness, call } = await engine();
				project(harness);
				const bytes = Buffer.alloc(MAX_READ_CHUNK + 100, 7);
				writeFileSync(join(harness.tempDir, "docs", "big.bin"), bytes);
				const first = await call<Piece>({ type: "files_read", path: "docs/big.bin", length: 50 * 1024 * 1024 });
				expect(first).toMatchObject({
					name: "big.bin",
					size: bytes.length,
					offset: 0,
					length: MAX_READ_CHUNK,
					eof: false,
				});
				const rest = await call<Piece>({ type: "files_read", path: "docs/big.bin", offset: first.length });
				expect(rest).toMatchObject({ offset: MAX_READ_CHUNK, length: 100, eof: true });
				expect(
					Buffer.concat([Buffer.from(first.data, "base64"), Buffer.from(rest.data, "base64")]).equals(bytes),
				).toBe(true);
				const end = await call<Piece>({ type: "files_read", path: "docs/big.bin", offset: bytes.length });
				expect(end).toMatchObject({ length: 0, data: "", eof: true });
				const middle = await call<Piece>({ type: "files_read", path: "docs/note.md", offset: 2, length: 4 });
				expect(Buffer.from(middle.data, "base64").toString()).toBe("Note");
			});

			it("refuses what the explorer refuses, a link out of the project included, and what is not a file to send", async () => {
				const { harness, call } = await engine();
				project(harness);
				const outside = mkdtempSync(join(tmpdir(), "prism-outside-"));
				try {
					writeFileSync(join(outside, "secret"), "outside text");
					symlinkSync(outside, join(harness.tempDir, "away"));
					symlinkSync(join(outside, "secret"), join(harness.tempDir, "link.md"));
					const refused = /Only the project's files/;
					await expect(call({ type: "files_read", path: "../x" })).rejects.toThrow(refused);
					await expect(call({ type: "files_read", path: join(outside, "secret") })).rejects.toThrow(refused);
					await expect(call({ type: "files_read", path: "link.md" })).rejects.toThrow(refused);
					await expect(call({ type: "files_read", path: "away/secret" })).rejects.toThrow(refused);
					await expect(call({ type: "files_read", path: "docs/../../x" })).rejects.toThrow(refused);
					await expect(call({ type: "files_read", path: "/etc/hostname" })).rejects.toThrow(refused);
					await expect(call({ type: "files_read" })).rejects.toThrow(/No path/);
					await expect(call({ type: "files_read", path: 12 })).rejects.toThrow(/No path/);
					await expect(call({ type: "files_read", path: "docs" })).rejects.toThrow(/directory/);
					await expect(call({ type: "files_read", path: "missing.txt" })).rejects.toThrow(/ENOENT/);
					execFileSync("mkfifo", [join(harness.tempDir, "pipe")]);
					await expect(call({ type: "files_read", path: "pipe" })).rejects.toThrow(/named pipe/);
					for (const offset of [-1, 1.5, "0", 1000]) {
						await expect(call({ type: "files_read", path: "docs/note.md", offset })).rejects.toThrow(/offset/);
					}
					for (const length of [0, -5, 2.5, "9", null]) {
						await expect(call({ type: "files_read", path: "docs/note.md", length })).rejects.toThrow(/length/);
					}
				} finally {
					rmSync(outside, { recursive: true, force: true });
				}
			});

			it("refuses a file above the bound, however it is asked", async () => {
				const { harness, call } = await engine();
				project(harness);
				writeFileSync(join(harness.tempDir, "huge.bin"), "");
				truncateSync(join(harness.tempDir, "huge.bin"), MAX_READ_BYTES + 1);
				await expect(call({ type: "files_read", path: "huge.bin", length: 10 })).rejects.toThrow(
					/larger than 100 MiB/,
				);
			});

			it("sends the files an export wrote, wherever the user put them, and only through files_read", async () => {
				const { harness, call } = await engine();
				project(harness);
				const outside = mkdtempSync(join(tmpdir(), "prism-exported-"));
				try {
					const report = join(outside, "report.json");
					writeFileSync(report, "{}");
					await expect(call({ type: "files_read", path: report })).rejects.toThrow(/Only the project's files/);
					noteExported(harness.session.extensionRunner.createContext(), report);
					expect((await call<Piece>({ type: "files_read", path: report })).data).toBe(
						Buffer.from("{}").toString("base64"),
					);
					// Not a licence for the explorer's other commands, nor for the folder around the export.
					await expect(call({ type: "files_preview", path: report })).rejects.toThrow(/Only the project's files/);
					await expect(call({ type: "files_read", path: join(outside, "other") })).rejects.toThrow(
						/Only the project's files/,
					);
				} finally {
					rmSync(outside, { recursive: true, force: true });
				}
			});
		});

		it("never opens a program", async () => {
			const { harness, call } = await engine();
			project(harness);
			const answer = await call<{ error?: string }>({ type: "files_open", path: "run.sh" });
			expect(answer.error).toMatch(/not opened/);
		});

		it("colours code without changing its text and bounds the highlighting work", async () => {
			initTheme("dark");
			const { harness, call } = await engine();
			const source = 'const markup = "<script>alert(1)</script>";\n';
			writeFileSync(join(harness.tempDir, "code.ts"), source);
			const answer = await call<{ preview: { text: string }; highlighted?: string[] }>({
				type: "files_preview",
				path: "code.ts",
			});
			expect(answer.preview.text).toBe(source);
			expect(answer.highlighted).toBeDefined();
			expect(stripTerminalSequences(answer.highlighted!.join("\n"))).toBe(source);
			expect(answer.highlighted!.join("\n")).toContain("\u001b[");
			writeFileSync(join(harness.tempDir, "large.ts"), source.repeat(2000));
			expect(await call({ type: "files_preview", path: "large.ts" })).not.toHaveProperty(
				"highlighted",
				expect.any(Array),
			);
		});

		it("copies to a folder without overwriting", async () => {
			const { harness, call } = await engine();
			project(harness);
			const target = join(harness.tempDir, "out");
			mkdirSync(target);
			const first = await call<{ copy?: string; error?: string }>({
				type: "files_export",
				path: "docs/note.md",
				folder: "out",
			});
			expect(first.copy).toBe(join(target, "note.md"));
			expect(readFileSync(join(target, "note.md"), "utf8")).toContain("body");
			const again = await call<{ error?: string }>({ type: "files_export", path: "docs/note.md", folder: "out" });
			expect(again.error).toMatch(/already there/);
			const missing = await call<{ error?: string }>({ type: "files_export", path: "docs/note.md", folder: "none" });
			expect(missing.error).toMatch(/does not exist/);
		});

		it("lists what Prism wrote in this conversation", async () => {
			const { call, toolCall } = await engine((_title, options) => options.find((o) => o === "Allow once"));
			await toolCall("write", { path: "made.txt", content: "made here\n" });
			const { files } = await call<{ files: Array<{ relative?: string; state: string }> }>({
				type: "files_produced",
			});
			expect(files).toMatchObject([{ relative: "made.txt", state: "present" }]);
		});
	});

	it("pi-tui-kit's navigation choices are shown translated and answered as the kit wrote them", () => {
		const { shown, original } = translateKitChoices(["Backup", "← Back"]);
		expect(shown[0]).toBe("Backup");
		expect(original(shown[1] ?? "")).toBe("← Back");
		expect(original("Backup")).toBe("Backup");
	});
});
