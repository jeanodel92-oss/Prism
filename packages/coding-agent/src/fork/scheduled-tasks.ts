/**
 * scheduled tasks. A task is a prompt, a folder, a
 * systemd calendar expression and a permission scope fixed when the user created it. A systemd user timer starts
 * `prism --scheduled <id>`; there is no Prism daemon. The run has nobody to ask: what the scope covers passes,
 * everything else is refused and reported (permissions.ts). Only `/schedule`, after the user's confirmation,
 * writes the units; never a model's tool call, and never `loginctl enable-linger`.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { ENV_AGENT_DIR, getAgentDir, getPackageDir } from "../config.ts";
import { APP_DISPLAY_NAME } from "./brand.ts";
import { getPiInvocation } from "./child-invocation.ts";
import { readGlobalSetting } from "./global-settings.ts";
import { hostCommand, hostProgram } from "./host-program.ts";
import { fill, t } from "./i18n/index.ts";
import { within } from "./path-within.ts";
import { takeProcessLock } from "./process-lock.ts";
import { realPath } from "./real-path.ts";
import { buildLayout, readSandboxSettings, sandboxSettingsProblem } from "./sandbox/layout.ts";
import type { ScopeOperation } from "./task-scope.ts";

export const SCHEDULED_FLAG = "scheduled";

const operationSchema = Type.Object(
	{
		what: Type.String({ minLength: 1 }),
		commands: Type.Array(Type.String()),
		writes: Type.Array(Type.String()),
		hosts: Type.Array(Type.String()),
	},
	{ additionalProperties: false },
);

const taskSchema = Type.Object(
	{
		version: Type.Literal(1),
		id: Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,39}$" }),
		prompt: Type.String({ minLength: 1 }),
		cwd: Type.String({ minLength: 1 }),
		onCalendar: Type.String({ minLength: 1 }),
		operations: Type.Array(operationSchema),
		budget: Type.Object(
			{
				minutes: Type.Integer({ minimum: 1, maximum: 24 * 60 }),
				tools: Type.Integer({ minimum: 1, maximum: 10_000 }),
			},
			{ additionalProperties: false },
		),
		model: Type.Optional(Type.String()),
		catchUp: Type.Union([Type.Literal("report"), Type.Literal("run")]),
		createdAt: Type.String(),
	},
	{ additionalProperties: false },
);

export interface ScheduledTask {
	version: 1;
	/** Lower case letters, digits and dashes: it names the systemd units. */
	id: string;
	prompt: string;
	/** The project folder the run starts in. */
	cwd: string;
	/** A systemd calendar expression (`systemd.time(7)`), checked by `systemd-analyze calendar`. */
	onCalendar: string;
	/** The fixed scope: what runs without a question. Nothing else runs. */
	operations: ScopeOperation[];
	/** Mandatory limits of each run. */
	budget: { minutes: number; tools: number };
	/** `provider/id`; the default model when absent. */
	model?: string;
	/** A run that systemd starts late (missed while the computer was off): only reported, or run. */
	catchUp: "report" | "run";
	createdAt: string;
}

/** What a run left, for /schedule and the next interactive start. */
export interface RunRecord {
	at: string;
	outcome: "started" | "finished" | "failed" | "missed" | "skipped-running" | "refused";
	/** In English; translated when shown. */
	detail?: string;
	/** The run's session file: its conversation stays there, out of the system journal. */
	session?: string;
}

export const validTaskId = (id: string): boolean => /^[a-z0-9][a-z0-9-]{0,39}$/.test(id);

export function scheduledDir(agentDir = getAgentDir()): string {
	return join(agentDir, "scheduled");
}

const taskFile = (id: string, agentDir?: string) => join(scheduledDir(agentDir), `${id}.json`);
const logFile = (id: string, agentDir?: string) => join(scheduledDir(agentDir), `${id}.log.jsonl`);
const lockFile = (id: string, agentDir?: string) => join(scheduledDir(agentDir), `${id}.lock`);
/** When the user last saw the runs, at an interactive start. */
const seenFile = (agentDir?: string) => join(scheduledDir(agentDir), ".seen");

export function parseScheduledTask(value: unknown): ScheduledTask | undefined {
	return Check(taskSchema, value) && isAbsolute(value.cwd) ? (value as ScheduledTask) : undefined;
}

export function readScheduledTask(id: string, agentDir?: string): ScheduledTask | undefined {
	if (!validTaskId(id)) return undefined;
	try {
		return parseScheduledTask(JSON.parse(readFileSync(taskFile(id, agentDir), "utf8")));
	} catch {
		return undefined;
	}
}

export function listScheduledTasks(agentDir?: string): ScheduledTask[] {
	const dir = scheduledDir(agentDir);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".json"))
		.map((name) => readScheduledTask(name.slice(0, -".json".length), agentDir))
		.filter((task): task is ScheduledTask => task !== undefined)
		.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Writes a new task. fork: the name is taken exclusively, whole (a link
 * from a temporary file of this attempt's own), and a task of that name already there, created by another dialog or
 * process since the question, is refused rather than replaced.
 */
export function writeScheduledTask(task: ScheduledTask, agentDir?: string): void {
	if (!parseScheduledTask(task)) throw new Error("Invalid scheduled task.");
	mkdirSync(scheduledDir(agentDir), { recursive: true, mode: 0o700 });
	const file = taskFile(task.id, agentDir);
	const temporary = `${file}.${process.pid}-${randomUUID()}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(task, null, 2)}\n`, { mode: 0o600, flag: "wx" });
	try {
		linkSync(temporary, file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST")
			throw new Error(fill("A task named {0} already exists.", task.id));
		throw error;
	} finally {
		rmSync(temporary, { force: true });
	}
}

export function removeScheduledTaskFiles(id: string, agentDir?: string): void {
	for (const file of [taskFile(id, agentDir), logFile(id, agentDir), lockFile(id, agentDir)])
		rmSync(file, { force: true });
}

export function recordRun(id: string, record: RunRecord, agentDir?: string): void {
	mkdirSync(scheduledDir(agentDir), { recursive: true, mode: 0o700 });
	writeFileSync(logFile(id, agentDir), `${JSON.stringify(record)}\n`, { flag: "a", mode: 0o600 });
}

export function lastRuns(id: string, count = 5, agentDir?: string): RunRecord[] {
	try {
		return readFileSync(logFile(id, agentDir), "utf8")
			.split("\n")
			.filter(Boolean)
			.slice(-count)
			.map((line) => JSON.parse(line) as RunRecord);
	} catch {
		return [];
	}
}

/** The runs the user has not seen yet, oldest first, and marks them seen. A start whose run ended is left out. */
export function unseenRuns(agentDir?: string, now = new Date()): Array<RunRecord & { id: string }> {
	let seen = "";
	try {
		seen = readFileSync(seenFile(agentDir), "utf8").trim();
	} catch {}
	const runs: Array<RunRecord & { id: string }> = [];
	for (const task of listScheduledTasks(agentDir)) {
		const records = lastRuns(task.id, 50, agentDir).filter((run) => run.at > seen);
		records.forEach((run, index) => {
			if (run.outcome !== "started" || index === records.length - 1) runs.push({ ...run, id: task.id });
		});
	}
	if (existsSync(scheduledDir(agentDir))) writeFileSync(seenFile(agentDir), now.toISOString(), { mode: 0o600 });
	return runs.sort((a, b) => a.at.localeCompare(b.at));
}

// ---------------------------------------------------------------------------
// systemd units
// ---------------------------------------------------------------------------

export const unitName = (id: string, kind: "service" | "timer") => `prism-task-${id}.${kind}`;

/** One ExecStart word: quoted, with systemd's specifiers (`%`) and variables (`$`) kept literal. */
function execWord(word: string): string {
	return `"${word.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;
}

/**
 * One quoted `Environment=` assignment. fork: systemd expands no variable there,
 * so `$` stays single; a doubled one reached the service as `$$`.
 */
function environmentWord(word: string): string {
	return `"${word.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
}

/** A value on the right of `Key=`, which systemd takes literally but for `%` specifiers. */
const unitValue = (value: string) => value.replace(/%/g, "%%");

/** The service and timer of a task. `command` is how this Prism starts itself (child-invocation.ts). */
export function scheduledUnits(
	task: ScheduledTask,
	command: { command: string; args: string[] } = getPiInvocation([`--${SCHEDULED_FLAG}`, task.id]),
	agentDirEnv: string | undefined = process.env[ENV_AGENT_DIR],
): { service: string; timer: string } {
	if (/\p{Cc}|\p{Zl}|\p{Zp}/u.test(task.onCalendar))
		throw new Error("The calendar contains a line break or control character.");
	for (const value of [task.cwd, command.command, ...command.args, agentDirEnv ?? ""])
		if (/[\n\r\0]/.test(value)) throw new Error("A path contains a line break.");
	const service = [
		"[Unit]",
		`Description=Prism scheduled task ${task.id}`,
		"",
		"[Service]",
		"Type=oneshot",
		`WorkingDirectory=${unitValue(task.cwd)}`,
		...(agentDirEnv ? [`Environment=${environmentWord(`${ENV_AGENT_DIR}=${agentDirEnv}`)}`] : []),
		`ExecStart=${[command.command, ...command.args].map(execWord).join(" ")}`,
		// The model's answer stays in the run's session file, not in the user's journal; errors go there.
		"StandardOutput=null",
		"StandardError=journal",
		// The run's own time budget stops it first; this is the backstop.
		`TimeoutStartSec=${task.budget.minutes + 5}min`,
		"Restart=no",
		"",
	].join("\n");
	const timer = [
		"[Unit]",
		`Description=Prism scheduled task ${task.id}`,
		"",
		"[Timer]",
		`OnCalendar=${unitValue(task.onCalendar)}`,
		// A run missed while the computer was off starts at the next boot; the run decides to report or run it.
		"Persistent=true",
		`Unit=${unitName(task.id, "service")}`,
		"",
		"[Install]",
		"WantedBy=timers.target",
		"",
	].join("\n");
	return { service, timer };
}

/** systemd, as Prism uses it; tests replace it. Real timers are tested only in a throwaway VM. */
export interface SystemdUser {
	/** The user's unit folder (`~/.config/systemd/user`). */
	unitDir(): string;
	/** `systemctl --user <args>`. */
	systemctl(args: string[]): { ok: boolean; output: string };
	/** `systemd-analyze <args>`. */
	analyze(args: string[]): { ok: boolean; output: string };
}

/** fork: `command` is found by the host-program rule, as `notify-send` here. */
function run(command: string, args: string[]): { ok: boolean; output: string } {
	const result = spawnSync(hostCommand(command), args, {
		encoding: "utf8",
		timeout: 30_000,
		env: { ...process.env, LC_ALL: "C", SYSTEMD_PAGER: "", SYSTEMD_COLORS: "0" },
	});
	return {
		ok: result.status === 0,
		output: `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? String(result.error) : ""}`.trim(),
	};
}

export const realSystemd: SystemdUser = {
	unitDir: () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user"),
	systemctl: (args) => run("systemctl", ["--user", ...args]),
	analyze: (args) => run("systemd-analyze", args),
};

/** The next time `expression` elapses after `after`, or why systemd rejects it. */
export function nextElapse(
	expression: string,
	systemd: SystemdUser,
	after = new Date(),
): { at: Date; normalized: string } | { error: string } {
	const result = systemd.analyze([
		"calendar",
		`--base-time=@${Math.floor(after.getTime() / 1000)}`,
		"--iterations=1",
		"--",
		expression,
	]);
	const normalized = /Normalized form: (.+)/.exec(result.output)?.[1]?.trim();
	// In a UTC zone systemd prints "Next elapse: ... UTC" alone, without the "(in UTC)" line.
	const utc = /(?:\(in UTC\)|Next elapse): \w+ (\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) UTC$/m.exec(result.output)?.[1];
	if (!result.ok || !normalized) return { error: result.output.split("\n").at(-1) || "Invalid calendar expression." };
	if (!utc) return { error: "This calendar expression never elapses again." };
	return { at: new Date(`${utc.replace(" ", "T")}Z`), normalized };
}

/** How this Prism starts itself, as the timer will start it; tests replace it. */
export interface PrismLauncher {
	invocation(id: string): { command: string; args: string[] };
	/** The folder of Prism's package (its code and assets). */
	packageDir(): string;
}

export const realLauncher: PrismLauncher = {
	invocation: (id) => getPiInvocation([`--${SCHEDULED_FLAG}`, id]),
	packageDir: getPackageDir,
};

/**
 * Why the timer must not start this Prism, if it must not. The timer runs Prism outside the sandbox, later and with
 * nobody watching: its code must not be something an agent can change in the meantime. Sources (TypeScript run
 * through a loader), a Git working tree (a project agents work in) and the task's own folder are all such code.
 */
export function unsafeLauncher(launcher: PrismLauncher, cwd: string, home = homedir()): string | undefined {
	const { command, args } = launcher.invocation("check");
	// fork: the code Node loads before Prism, `--import=<module>` included. A module named
	// relative to the folder, or by a package name, comes from where the timer starts: the task's project.
	const words = [command, ...args].flatMap((arg, index, all) => {
		const option = /^(--import|--require|-r|--loader|--experimental-loader)(?:=(.*))?$/.exec(arg);
		if (!option) return [arg];
		const value = option[2] ?? all[index + 1] ?? "";
		return [value.startsWith("file://") || isAbsolute(value) ? value : `\0${value}`];
	});
	const unresolved = words.find((word) => word.startsWith("\0"));
	if (unresolved !== undefined)
		return `Prism starts here with a Node module named ${JSON.stringify(unresolved.slice(1))}, which the timer would look for from the task's folder. Schedule tasks from a Prism started without it.`;
	const paths = [...words, launcher.packageDir()]
		.map((arg) => (arg.startsWith("file://") ? fileURLToPath(arg) : arg))
		.filter((arg) => isAbsolute(arg));
	const files = paths.filter((path) => existsSync(path));
	if (files.some((file) => /\.[cm]?ts$/.test(file)))
		return "Prism runs here from its TypeScript sources, which an agent could change before the timer runs them outside the sandbox. Schedule tasks from an installed Prism (release or npm).";
	const folder = realPath(cwd);
	const inFolder = files.find((file) => within(realPath(file), folder));
	if (inFolder)
		return `Prism's own files are in the task's folder (${inFolder}): the task could change the code its next run starts outside the sandbox.`;
	// any folder sandboxed commands may write (npm's cache, where npx keeps what it
	// runs; the tools' caches; sandbox.allowWrite), by the path given or by the one its links lead to. An absent
	// path is checked too: a command could create it.
	const writable = buildLayout({ cwd, agentDir: getAgentDir(), settings: readSandboxSettings(), home }).writable;
	const exposed = paths.find((path) =>
		[path, ...(existsSync(path) ? [realPath(path)] : [])].some((each) => writable.some((root) => within(each, root))),
	);
	if (exposed)
		return `Prism's files are in a folder sandboxed commands can change (${exposed}): the timer would run them later outside the sandbox. Schedule tasks from a Prism installed where commands cannot write (release or npm global install).`;
	// fork: Git from PATH, never from where the sandbox writes.
	const program = hostProgram("git");
	const git = program
		? spawnSync(program, ["-C", dirname(realPath(launcher.packageDir())), "rev-parse", "--show-toplevel"], {
				encoding: "utf8",
				timeout: 5_000,
				stdio: ["ignore", "pipe", "ignore"],
			})
		: undefined;
	if (git?.status === 0 && git.stdout.trim())
		return `Prism runs from a Git working tree (${git.stdout.trim()}), a project agents can change before the timer runs it outside the sandbox. Schedule tasks from an installed Prism (release or npm).`;
	return undefined;
}

/** Writes the units, then enables and starts the timer. Called only from /schedule, after the user confirmed. */
export function installTask(
	task: ScheduledTask,
	systemd: SystemdUser,
	agentDir?: string,
	launcher: PrismLauncher = realLauncher,
): void {
	const unsafe = unsafeLauncher(launcher, task.cwd);
	if (unsafe) throw new Error(unsafe);
	const dir = systemd.unitDir();
	const { service, timer } = scheduledUnits(task, launcher.invocation(task.id));
	mkdirSync(dir, { recursive: true });
	const written: string[] = [];
	let enabling = false;
	// Taken before anything else: a name another task holds is refused with nothing written or removed, and once
	// taken, the name's units and files are this attempt's to undo.
	writeScheduledTask(task, agentDir);
	try {
		for (const [kind, text] of [
			["service", service],
			["timer", timer],
		] as const) {
			writeFileSync(join(dir, unitName(task.id, kind)), text, { mode: 0o644 });
			written.push(join(dir, unitName(task.id, kind)));
		}
		systemctlOrThrow(systemd, ["daemon-reload"]);
		enabling = true;
		systemctlOrThrow(systemd, ["enable", "--now", unitName(task.id, "timer")]);
	} catch (error) {
		// Hardening review, point 5: a task that failed to install leaves nothing behind that could still run.
		if (enabling) {
			const undo = systemd.systemctl(["disable", "--now", unitName(task.id, "timer")]);
			// Its timer's state is unknown: the task and its units stay, so /schedule shows it and can remove it.
			if (!undo.ok) {
				throw new Error(
					`${(error as Error).message}; systemctl --user disable --now ${unitName(task.id, "timer")}: ${undo.output}. The task may still run: it is kept, remove it from /schedule once systemd works.`,
				);
			}
		}
		for (const path of written) rmSync(path, { force: true });
		if (enabling) systemd.systemctl(["daemon-reload"]);
		removeScheduledTaskFiles(task.id, agentDir);
		throw error;
	}
}

function systemctlOrThrow(systemd: SystemdUser, args: string[]): void {
	const result = systemd.systemctl(args);
	if (!result.ok) throw new Error(`systemctl --user ${args.join(" ")}: ${result.output}`);
}

export function setTaskPaused(id: string, paused: boolean, systemd: SystemdUser): void {
	systemctlOrThrow(systemd, [paused ? "disable" : "enable", "--now", unitName(id, "timer")]);
}

/** Whether the timer is enabled; undefined when systemd cannot tell. */
export function taskEnabled(id: string, systemd: SystemdUser): boolean | undefined {
	const result = systemd.systemctl(["is-enabled", unitName(id, "timer")]);
	const state = result.output.split("\n")[0]?.trim();
	return state === "enabled" ? true : state === "disabled" ? false : undefined;
}

/**
 * Stops and disables the timer, removes both units and the task. Throws, keeping the task, when systemd could not
 * stop the timer, so a removal is never reported while the task can still run. Removing again finishes the job.
 */
export function removeTask(id: string, systemd: SystemdUser, agentDir?: string): void {
	const dir = systemd.unitDir();
	if (existsSync(join(dir, unitName(id, "timer"))))
		systemctlOrThrow(systemd, ["disable", "--now", unitName(id, "timer")]);
	rmSync(join(dir, unitName(id, "timer")), { force: true });
	rmSync(join(dir, unitName(id, "service")), { force: true });
	systemctlOrThrow(systemd, ["daemon-reload"]);
	removeScheduledTaskFiles(id, agentDir);
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/** The scheduled run this process carries out, once prepareScheduledRun let it start. */
let current: { id: string; agentDir?: string; refused?: string; session?: string } | undefined;

/** The id of the scheduled run this process carries out: notifications and proposals stay quiet in it. */
export const scheduledRun = (): string | undefined => current?.id;

/** permissions.ts: where the run's session is, and what its scope refused. */
export function noteScheduledRun(note: { refused?: string; session?: string }): void {
	if (!current) return;
	if (note.refused) current.refused = note.refused;
	if (note.session) current.session = note.session;
}

/** Records the end of the run at process exit; `exitHook: false` leaves the call to the caller (tests). */
export function beginScheduledRun(id: string, agentDir?: string, exitHook = true): void {
	current = { id, agentDir };
	if (exitHook) process.once("exit", (code) => endScheduledRun(code));
}

/**
 * The run's end: finished or failed by its exit code, with what its scope refused. A failure or a refusal also
 * sends a desktop notification, unless the user turned them off; nothing else does, since nobody was waiting.
 */
export function endScheduledRun(code: number, notify: (title: string, body: string) => void = desktopNotice): void {
	const run = current;
	current = undefined;
	if (!run) return;
	const failed = code !== 0;
	const detail = [
		failed ? `exit code ${code}; journalctl --user -u ${unitName(run.id, "service")} shows the error` : undefined,
		run.refused,
	]
		.filter(Boolean)
		.join("\n");
	recordRun(
		run.id,
		{
			at: new Date().toISOString(),
			outcome: failed ? "failed" : "finished",
			detail: detail || "nothing refused",
			...(run.session ? { session: run.session } : {}),
		},
		run.agentDir,
	);
	if (!failed && !run.refused) return;
	const setting = readGlobalSetting("desktopNotifications");
	if (typeof setting === "object" && setting !== null && (setting as { enabled?: unknown }).enabled === false) return;
	notify(
		fill(failed ? "Scheduled task {0} failed" : "Scheduled task {0}: actions refused", run.id),
		t("/schedule shows what happened."),
	);
}

/** Synchronous: the process is exiting. */
function desktopNotice(title: string, body: string): void {
	spawnSync(
		hostCommand("notify-send"),
		[`--app-name=${APP_DISPLAY_NAME}`, "--urgency=normal", "--icon=utilities-terminal", title, body],
		{
			stdio: "ignore",
			timeout: 3_000,
		},
	);
}

/** How late a run may start and still count as on time (systemd adds up to a minute of accuracy). */
export const ON_TIME_MS = 10 * 60_000;

/** One run at a time: a run still going makes the next one skip. The lock names its process. */
function takeLock(id: string, agentDir?: string): boolean {
	// fork: never read empty, taken over only from a process that is gone, and released
	// only while it is still this run's.
	const release = takeProcessLock(lockFile(id, agentDir));
	if (release) process.once("exit", release);
	return release !== undefined;
}

/**
 * `prism --scheduled <id>`: the arguments of the unattended run, or the exit code when it must not run (unknown
 * task, sandbox off, a run still going, a late run only reported). Runs before the session starts; main.ts calls it.
 */
export function prepareScheduledRun(
	args: string[],
	options: { systemd?: SystemdUser; agentDir?: string; now?: Date; chdir?: (dir: string) => void } = {},
): { args: string[] } | { exit: number; message: string } | undefined {
	const index = args.indexOf(`--${SCHEDULED_FLAG}`);
	if (index === -1) return undefined;
	const id = args[index + 1] ?? "";
	const task = readScheduledTask(id, options.agentDir);
	if (!task) return { exit: 2, message: `No scheduled task "${id}".` };
	const refuse = (detail: string) => {
		recordRun(id, { at: new Date().toISOString(), outcome: "refused", detail }, options.agentDir);
		return { exit: 1, message: `Scheduled task ${id} refused: ${detail}` };
	};
	if (index !== 0 || args.length !== 2) return refuse("--scheduled takes no other argument.");
	const settingsProblem = sandboxSettingsProblem(options.agentDir);
	if (settingsProblem) return refuse(settingsProblem);
	if (!readSandboxSettings(options.agentDir).modes.ask)
		return refuse("the sandbox is off in ask mode, and a scheduled run needs it.");
	if (!existsSync(task.cwd)) return refuse(`the folder ${task.cwd} does not exist.`);
	const now = options.now ?? new Date();
	if (task.catchUp === "report") {
		const scheduled = nextElapse(
			task.onCalendar,
			options.systemd ?? realSystemd,
			new Date(now.getTime() - ON_TIME_MS),
		);
		if ("error" in scheduled) return refuse(scheduled.error);
		if (scheduled.at.getTime() > now.getTime()) {
			recordRun(
				id,
				{ at: now.toISOString(), outcome: "missed", detail: "started late (computer off or asleep); not run" },
				options.agentDir,
			);
			return { exit: 0, message: `Scheduled task ${id}: missed run reported, not run (catch-up: report only).` };
		}
	}
	if (!takeLock(id, options.agentDir)) {
		recordRun(id, { at: now.toISOString(), outcome: "skipped-running" }, options.agentDir);
		return { exit: 0, message: `Scheduled task ${id}: the previous run is still going; this one is skipped.` };
	}
	recordRun(id, { at: now.toISOString(), outcome: "started" }, options.agentDir);
	beginScheduledRun(id, options.agentDir);
	(options.chdir ?? process.chdir)(task.cwd);
	return {
		args: [
			`--${SCHEDULED_FLAG}`,
			id,
			"--perm-mode",
			"ask",
			"--budget-time",
			String(task.budget.minutes),
			"--budget-tools",
			String(task.budget.tools),
			...(task.model ? ["--model", task.model] : []),
			// fork: after `--`, the prompt is a message even when it starts with `-`.
			"-p",
			"--",
			task.prompt,
		],
	};
}
