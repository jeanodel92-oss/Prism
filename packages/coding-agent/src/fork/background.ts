/**
 * Background shell tasks.
 *
 * Lets the model start a long command (build, test suite, indexer) without
 * blocking the turn; its end comes back to the model by itself. One tool with four actions rather than
 * one tool per verb — the whole feature costs a single tool definition.
 *
 *   /bg          list tasks in this session
 *   /bg-clear    forget finished tasks
 *
 * Output is streamed to <agent dir>/bg/<id>.log so it survives even if the
 * model never reads it back. Completion fires a desktop notification through
 * the same channel notify.ts uses.
 *
 * fork: copy of fork/reference/extensions/background.ts, shipped as the built-in
 * extension `builtin:background`. Change from the reference: the log dir comes from
 * `getAgentDir()` instead of `~/.pi/agent`.
 */

import { execFile } from "node:child_process";
import {
	closeSync,
	createWriteStream,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import { StringEnum } from "@earendil-works/pi-ai";
import type { TUI } from "@earendil-works/pi-tui";
import {
	type Component,
	Container,
	getKeybindings,
	Text,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { getAgentDir } from "../config.ts";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "../core/extensions/types.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import type { Theme } from "../modes/interactive/theme/theme.ts";
import { getShellConfig, getShellEnv } from "../utils/shell.ts";
import { APP_DISPLAY_NAME } from "./brand.ts";
import { type GroupEnd, type Launched, launch, stopProcessGroup } from "./child-process.ts";
import { withDesktopEnv } from "./desktop/env.ts";
import { hostCommand } from "./host-program.ts";
import { fill, t } from "./i18n/index.ts";
import { hasInteractiveClient } from "./interactive-client.ts";
import { isExcludedCommand } from "./sandbox/layout.ts";
import {
	holdSessionTmp,
	openSandboxNetwork,
	requireSandbox,
	type SandboxRuntime,
	sandboxTask,
	sessionSandbox,
} from "./sandbox/runtime.ts";
import { commandEnv, knownSecrets } from "./secrets/env.ts";
import { maskingTransform } from "./secrets/mask.ts";
import { revealSecrets } from "./secrets/reveal.ts";

const TAIL_BYTES = 4000;
/** the output a task's end report carries, at most; the rest stays in its log. */
const REPORT_BYTES = 2000;
const MAX_TASKS = 50;
const LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type BackgroundTask = {
	id: string;
	command: string;
	cwd: string;
	pid?: number;
	status: "running" | "stopping" | "done" | "failed" | "stopped" | "timed_out";
	exitCode?: number;
	startedAt: number;
	endedAt?: number;
	logPath: string;
	/** the model stopped it itself, so its end is not reported to it. */
	stoppedByModel?: boolean;
	/** its optional time limit, in seconds; none by default. */
	timeoutSeconds?: number;
	/** the limit was reached and the task was stopped for it. */
	timedOut?: boolean;
	/** fork: why its log stopped being written, when it did. */
	logError?: string;
};
type Task = BackgroundTask;

export function shellInvocation(
	config: ReturnType<typeof getShellConfig>,
	command: string,
): { args: string[]; stdin: boolean } {
	const stdin = config.commandTransport === "stdin";
	return { args: stdin ? config.args : [...config.args, command], stdin };
}

/** A task's state for the interface: "timed out" reads better than the model-facing `timed_out`. */
const statusLabel = (status: Task["status"]) => t(status === "timed_out" ? "timed out" : status);

/** fork: the stop of a task, which its end waits for. */
const taskStops = new WeakMap<Task, Promise<GroupEnd>>();

export function requestTaskStop(task: Task, updateStatus: () => void): string | undefined {
	if (task.status !== "running") return `${task.id} already ${task.status}.`;
	// fork: SIGTERM to the group, SIGKILL after the grace unless the group was seen
	// empty first, and never a signal once it was: its number may then be another group's.
	if (task.pid) taskStops.set(task, stopProcessGroup(task.pid));
	task.status = "stopping";
	updateStatus();
	return undefined;
}

export class BackgroundTasksPanel implements Component {
	private selected = 0;
	private detailId: string | undefined;
	private scrollTop = 0;
	/** The log view stays on its last lines while they grow, until the user scrolls up. */
	private following = true;
	/** Asked inside the panel: a dialog would open behind this overlay. */
	private confirmingStop = false;
	private readonly getTasks: () => BackgroundTask[];
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly close: () => void;
	private readonly stop: (task: BackgroundTask) => void;
	private readonly sessionCwd: string;
	private readonly interval: ReturnType<typeof setInterval>;

	constructor(
		tui: TUI,
		theme: Theme,
		getTasks: () => BackgroundTask[],
		sessionCwd: string,
		stop: (task: BackgroundTask) => void,
		close: () => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.getTasks = getTasks;
		this.sessionCwd = sessionCwd;
		this.stop = stop;
		this.close = close;
		this.interval = setInterval(() => this.tui.requestRender(), 500);
	}

	dispose(): void {
		clearInterval(this.interval);
	}

	invalidate(): void {}

	handleInput(data: string): void {
		const keys = getKeybindings();
		if (keys.matches(data, "tui.select.cancel")) {
			if (this.confirmingStop) this.confirmingStop = false;
			else if (this.detailId) this.detailId = undefined;
			else this.close();
			this.tui.requestRender();
			return;
		}
		const tasks = this.sortedTasks();
		if (this.detailId) {
			const task = tasks.find((entry) => entry.id === this.detailId);
			if (this.confirmingStop) {
				if (keys.matches(data, "tui.select.confirm")) {
					this.confirmingStop = false;
					if (task?.status === "running") this.stop(task);
				}
			} else if (keys.matches(data, "tui.select.up")) this.scrollBy(-1);
			else if (keys.matches(data, "tui.select.down")) this.scrollBy(1);
			else if (keys.matches(data, "tui.select.pageUp")) this.scrollBy(-10);
			else if (keys.matches(data, "tui.select.pageDown")) this.scrollBy(10);
			else if (keys.matches(data, "tui.select.confirm") && task?.status === "running") this.confirmingStop = true;
			this.tui.requestRender();
			return;
		}
		if (keys.matches(data, "tui.select.up")) this.selected = Math.max(0, this.selected - 1);
		else if (keys.matches(data, "tui.select.down")) this.selected = Math.min(tasks.length - 1, this.selected + 1);
		else if (keys.matches(data, "tui.select.confirm")) {
			this.detailId = tasks[this.selected]?.id;
			this.scrollTop = 0;
			this.following = true;
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const tasks = this.sortedTasks();
		const title = t("Background tasks");
		if (this.detailId) {
			const task = tasks.find((entry) => entry.id === this.detailId);
			if (!task) this.detailId = undefined;
			else return this.renderDetail(task, width);
		}
		const lines = [truncateToWidth(this.theme.bold(this.theme.fg("accent", title)), width)];
		if (tasks.length === 0) lines.push(t("No background tasks."));
		for (const [index, task] of tasks.entries()) {
			const duration = Math.round(((task.endedAt ?? Date.now()) - task.startedAt) / 1000);
			const status =
				task.status === "done" ? fill("finished (code {0})", String(task.exitCode ?? 0)) : statusLabel(task.status);
			const marker = index === this.selected ? "› " : "  ";
			lines.push(truncateToWidth(`${marker}${task.id} ${status} ${duration}s`, width));
			const cwd = task.cwd === this.sessionCwd ? "" : `  ${t("cwd")}: ${task.cwd}`;
			for (const part of wrapTextWithAnsi(`${task.command}${cwd}`, Math.max(1, width - 2)))
				lines.push(truncateToWidth(`  ${part}`, width));
		}
		lines.push(truncateToWidth(t("↑↓ select · Enter view · Esc close"), width));
		return lines;
	}

	private scrollBy(lines: number): void {
		this.scrollTop = Math.max(0, this.scrollTop + lines);
		// render() turns following back on when the bottom is reached again.
		this.following = false;
	}

	/** Newest first, the order shown, so the selected index points at the task on screen. */
	private sortedTasks(): BackgroundTask[] {
		return [...this.getTasks()].sort((a, b) => b.startedAt - a.startedAt);
	}

	private renderDetail(task: BackgroundTask, width: number): string[] {
		const duration = Math.round(((task.endedAt ?? Date.now()) - task.startedAt) / 1000);
		const status =
			task.status === "done" ? fill("finished (code {0})", String(task.exitCode ?? 0)) : statusLabel(task.status);
		const lines = [
			truncateToWidth(this.theme.bold(this.theme.fg("accent", `${task.id} · ${status} · ${duration}s`)), width),
			...wrapTextWithAnsi(task.command, width),
			...wrapTextWithAnsi(`${t("cwd")}: ${task.cwd}`, width),
			"",
			...wrapTextWithAnsi(tail(task.logPath, TAIL_BYTES, t("(no output yet)")), width),
		];
		const page = Math.max(1, (this.tui.terminal?.rows ?? 24) - 5);
		const maxTop = Math.max(0, lines.length - page);
		this.scrollTop = this.following ? maxTop : Math.min(this.scrollTop, maxTop);
		if (this.scrollTop === maxTop) this.following = true;
		return [
			...lines.slice(this.scrollTop, this.scrollTop + page).map((line) => truncateToWidth(line, width)),
			truncateToWidth(
				this.confirmingStop && task.status === "running"
					? t("Stop this task? Enter: stop · Esc: keep it running")
					: task.status === "running"
						? t("↑↓ scroll · Enter stop · Esc back")
						: t("↑↓ scroll · Esc back"),
				width,
			),
		];
	}
}

function notify(title: string, body: string) {
	// fork: never a `notify-send` the sandbox could write.
	execFile(
		hostCommand("notify-send"),
		[`--app-name=${APP_DISPLAY_NAME}`, "--urgency=normal", "--icon=utilities-terminal", title, body],
		() => {
			/* best-effort */
		},
	);
}

export function tail(path: string, bytes = TAIL_BYTES, empty = "(no output yet)"): string {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const size = statSync(path).size;
		const length = Math.min(size, bytes);
		const content = Buffer.alloc(length);
		readSync(fd, content, 0, length, size - length);
		let start = 0;
		if (size > bytes) while (start < content.length && (content[start]! & 0xc0) === 0x80) start += 1;
		const text = content.subarray(start).toString("utf8");
		return text.trim() || empty;
	} catch {
		return empty;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

export function pruneLogs(logDir: string, active: Set<string> = new Set()): void {
	const cutoff = Date.now() - LOG_RETENTION_MS;
	for (const name of readdirSync(logDir)) {
		if (!name.endsWith(".log")) continue;
		const path = join(logDir, name);
		try {
			if (active.has(path) || statSync(path).mtimeMs >= cutoff) continue;
			const pidPath = `${path}.pid`;
			// A log without its .pid file (written before the files existed) is kept: its task may still run.
			if (!existsSync(pidPath)) continue;
			const pid = Number(readFileSync(pidPath, "utf8"));
			if (Number.isInteger(pid) && pid > 0) {
				try {
					process.kill(-pid, 0);
					continue;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue;
				}
			}
			rmSync(pidPath, { force: true });
			rmSync(path, { force: true });
		} catch {
			// A log may disappear while another session is pruning it.
		}
	}
}

function sessionIdOf(ctx: ExtensionContext): string | undefined {
	try {
		return ctx.sessionManager.getSessionId();
	} catch {
		return undefined;
	}
}

function describe(task: Task): string {
	const seconds = Math.round(((task.endedAt ?? Date.now()) - task.startedAt) / 1000);
	// For the model: stays in English whatever the interface language.
	const code = task.exitCode === undefined ? "" : ` exit=${task.exitCode}`;
	return `${task.id} [${task.status}${code}] ${seconds}s · ${task.command}`;
}

/** a task's end, for the model: its state, its last output, bounded, and its log's path. */
export function endReport(task: Task): string {
	return [
		`Background task ended: ${describe(task)}`,
		...(task.logError ? [`Its log was lost from that point on: ${task.logError}`] : []),
		`Last output (at most ${REPORT_BYTES} bytes):`,
		tail(task.logPath, REPORT_BYTES),
		`Full log: ${task.logPath}`,
	].join("\n");
}

/** the custom type of a task's end report. */
export const END_MESSAGE = "background-task-ended";

type EndDetails = Pick<Task, "id" | "status" | "exitCode" | "logPath">;

/** fork: the loaded extension's tasks, for /state; undefined while the extension is off. */
let loadedTasks: Map<string, Task> | undefined;

export function backgroundTasks(): BackgroundTask[] | undefined {
	return loadedTasks && [...loadedTasks.values()];
}

/**
 * the tasks of one session, by its id, whichever extension was
 * loaded last in the process: the browser opens a task's server only for the session that started it.
 */
const tasksBySession = new Map<string, Map<string, Task>>();
export function sessionBackgroundTasks(sessionId: string): BackgroundTask[] {
	return [...(tasksBySession.get(sessionId)?.values() ?? [])];
}

/** what a client's own task screen can do (rpc-builtins.ts, bg_*); undefined while the extension is off. */
export interface BackgroundControl {
	/** Asks the task to stop, as /bg does; why it could not, otherwise. */
	stop(id: string): string | undefined;
	/** Forgets the tasks that ended, as /bg-clear; how many. */
	clear(): number;
}
let loadedControl: BackgroundControl | undefined;
export function backgroundControl(): BackgroundControl | undefined {
	return loadedControl;
}
/** A task's state as /bg names it, in the interface's language. */
export const backgroundStatusLabel = (status: BackgroundTask["status"]) => statusLabel(status);

/** fork: where a task's end goes; a /reload points it to the reloaded extension. */
interface TaskSink {
	deliver(task: Task): void;
	status(): void;
}
/** What a /reload hands to the reloaded extension of the same session: its tasks and their ends meanwhile. */
let reloadHandover:
	| { sessionId: string | undefined; tasks: Task[]; counter: number; owner: { current: TaskSink }; held: Task[] }
	| undefined;

export default function (pi: ExtensionAPI) {
	const tasks = new Map<string, Task>();
	loadedTasks = tasks;
	let counter = 0;
	let ui: ExtensionUIContext | undefined;
	// once the session closes, a task's end calls no model.
	let closed = false;
	// fork: ends held while a /reload replaces this extension; the reloaded one reports them.
	let held: Task[] | undefined;
	const sink: TaskSink = {
		deliver: (task) => {
			if (held) held.push(task);
			else if (!closed) reportEnd(task);
		},
		status: () => updateStatus(),
	};
	// Shared by the tasks of every instance this one took over, so a later /reload moves them all.
	let owner = { current: sink };
	pi.on("session_shutdown", (event, ctx) => {
		closed = true;
		const id = sessionIdOf(ctx);
		if (id !== undefined && tasksBySession.get(id) === tasks) tasksBySession.delete(id);
		// fork: the same session goes on after a /reload; its running tasks stay its own.
		if (event.reason !== "reload") return;
		held = [];
		reloadHandover = { sessionId: sessionIdOf(ctx), tasks: [...tasks.values()], counter, owner, held };
	});
	pi.on("session_start", (event, ctx) => {
		const id = sessionIdOf(ctx);
		if (id !== undefined) tasksBySession.set(id, tasks);
		const handover = reloadHandover;
		reloadHandover = undefined;
		if (!handover || event.reason !== "reload" || handover.sessionId !== sessionIdOf(ctx)) return;
		for (const task of handover.tasks) if (!tasks.has(task.id)) tasks.set(task.id, task);
		counter = Math.max(counter, handover.counter);
		owner = handover.owner;
		owner.current = sink;
		ui = ctx.ui;
		for (const task of handover.held.splice(0)) sink.deliver(task);
		updateStatus();
	});

	/** tells the model a task ended, without polling. */
	function reportEnd(task: Task): void {
		try {
			pi.sendMessage(
				{
					customType: END_MESSAGE,
					content: endReport(task),
					display: true,
					details: {
						id: task.id,
						status: task.status,
						exitCode: task.exitCode,
						logPath: task.logPath,
					} satisfies EndDetails,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} catch {
			// The session was disposed or replaced without closing (its pi is stale): nobody to tell.
		}
	}
	// The report is in English, for the model: the transcript shows its gist in the interface language, and the
	// report itself when expanded.
	pi.registerMessageRenderer<EndDetails>(END_MESSAGE, (message, { expanded, outputPad }, theme) => {
		const details = message.details;
		if (!details) return undefined;
		const status =
			details.status === "done"
				? fill("finished (code {0})", String(details.exitCode ?? 0))
				: statusLabel(details.status);
		const box = new Container();
		box.addChild(
			new Text(theme.fg("accent", theme.bold(fill("Background task {0}: {1}", details.id, status))), outputPad, 0),
		);
		box.addChild(new Text(theme.fg("muted", fill("Log: {0}", details.logPath)), outputPad, 0));
		if (expanded && typeof message.content === "string")
			box.addChild(new Text(theme.fg("dim", message.content), outputPad, 0));
		return box;
	});

	const LOG_DIR = join(getAgentDir(), "bg");
	// fork: what the tasks print is private to the user.
	mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
	pruneLogs(LOG_DIR, new Set());

	function updateStatus() {
		// fork: a task that outlives its session must not set the next session's status.
		if (closed) return;
		const running = [...tasks.values()].filter(
			(task) => task.status === "running" || task.status === "stopping",
		).length;
		ui?.setStatus("background", running ? fill("bg: {0} running", String(running)) : undefined);
	}

	function killTask(task: Task): string | undefined {
		return requestTaskStop(task, updateStatus);
	}

	loadedControl = {
		stop: (id) => {
			const task = tasks.get(id);
			const error = task ? killTask(task) : undefined;
			return task ? (error ? t(error) : undefined) : fill("No such task: {0}", id);
		},
		clear: () => {
			let removed = 0;
			for (const [id, task] of tasks) {
				if (task.status === "running" || task.status === "stopping") continue;
				tasks.delete(id);
				removed += 1;
			}
			updateStatus();
			return removed;
		},
	};

	async function openPanel(ctx: ExtensionContext): Promise<void> {
		ui = ctx.ui;
		if (!hasInteractiveClient(ctx)) {
			ctx.ui.notify(t("The background tasks panel is available in the interactive terminal."), "info");
			return;
		}
		let panel: BackgroundTasksPanel;
		await ctx.ui.custom<void>(
			(tui, theme, _keys, done) => {
				panel = new BackgroundTasksPanel(
					tui,
					theme,
					() => [...tasks.values()],
					ctx.cwd,
					(task) => {
						const status = task.status;
						const error = killTask(task);
						// The model gets the English text; the panel shows it in the interface language.
						if (error && status !== "running")
							ctx.ui.notify(fill("{0} already {1}.", task.id, statusLabel(status)), "error");
						else if (error) ctx.ui.notify(t(error), "error");
						tui.requestRender();
					},
					() => {
						panel.dispose();
						done(undefined);
					},
				);
				return panel;
			},
			{ overlay: true, overlayOptions: { anchor: "bottom-center", width: "100%", maxHeight: "100%" } },
		);
	}

	function start(
		command: string,
		cwd: string,
		shellPath?: string,
		sandbox?: SandboxRuntime,
		toolCallId?: string,
		timeoutSeconds?: number,
	): Task {
		// fork: a missing shell fails before anything is acquired.
		const shell = getShellConfig(shellPath);
		// the shell gets the keys the user let this call use; the task, its log and its records keep the labels.
		const run = revealSecrets(toolCallId, command);
		const invocation = shellInvocation(shell, run);
		counter += 1;
		const id = `bg${counter}`;
		// fork: sessions share LOG_DIR and each counts from bg1. The process id tells live
		// Prisms apart; the exclusive create, retried under another name, two sessions of one process.
		let logPath = "";
		let logFd: number | undefined;
		for (let attempt = 0; logFd === undefined; attempt++) {
			logPath = join(LOG_DIR, `${Date.now()}-${process.pid}-${id}${attempt ? `-${attempt}` : ""}.log`);
			try {
				logFd = openSync(logPath, "wx", 0o600);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 100) throw error;
			}
		}
		pruneLogs(
			LOG_DIR,
			new Set(
				[...tasks.values()]
					.filter((task) => task.status === "running" || task.status === "stopping")
					.map((task) => task.logPath),
			),
		);
		const log = createWriteStream(logPath, { fd: logFd });
		// fork: a log that fails (ENOSPC, I/O error) is detached from the task's
		// output, which is still drained so the task never blocks on a full pipe; its end report says the log was lost.
		// fork: handled from its creation, before the task exists.
		const outputs: NodeJS.ReadableStream[] = [];
		let logError: string | undefined;
		let current: Task | undefined;
		log.on("error", (error) => {
			if (logError) return;
			logError = error.message;
			if (current) current.logError = logError;
			for (const output of outputs) {
				output.unpipe(log);
				output.resume();
			}
		});
		// fork: a failure before the task is published releases what was acquired.
		let channel: ReturnType<typeof openSandboxNetwork> | undefined;
		let sandboxed: ReturnType<typeof sandboxTask> | undefined;
		let launched: Launched | undefined;
		let releaseTmp: (() => void) | undefined;
		let boxed: SandboxRuntime | undefined;
		try {
			// fork: in the sandbox when the session has one. bubblewrap dies with its parent, and the task
			// must outlive Prism, so a shell that waits for it stands in between. Its network ends with Prism.
			// Commands the user excluded run outside it (sandbox.excludedCommands).
			boxed = sandbox && !isExcludedCommand(command, sandbox.settings.excludedCommands) ? sandbox : undefined;
			// the task's network answers last as long as the task does.
			channel = boxed ? openSandboxNetwork(boxed, { toolCallId, command }) : undefined;
			const env = commandEnv(getShellEnv(), "background", command).env;
			// its repositories work in private copies of their Git metadata, published when it ends.
			sandboxed =
				boxed && channel
					? sandboxTask(boxed, cwd, channel, [shell.shell, ...invocation.args], command, env)
					: undefined;
			const [program, ...args] = sandboxed
				? ["/bin/sh", "-c", '"$@"; exit $?', "sh", ...sandboxed.argv]
				: [shell.shell, ...invocation.args];
			// fork: in its own process group, as every child Prism starts. It outlives Prism: no time limit here.
			launched = launch(program!, args, {
				cwd,
				outlivesPrism: true,
				// fork: without the secrets of the environment, as the bash tool. outside the sandbox,
				// graphical programs open on the agent's desktop while it runs.
				env: sandboxed ? env : withDesktopEnv(env),
				stdio: [invocation.stdin ? "pipe" : "ignore", "pipe", "pipe"],
			});
			const pid = launched.child.pid;
			if (invocation.stdin) launched.child.stdin?.end(run);
			writeFileSync(`${logPath}.pid`, String(pid ?? 0));
			// a later Prism sees the task still works in its Git copies, if this one ends first.
			if (pid) sandboxed?.started(pid);
			// fork: the session's private /tmp stays while the task runs, even after the session.
			releaseTmp = boxed && pid ? holdSessionTmp(boxed.tmp, pid) : undefined;
		} catch (error) {
			if (launched) void launched.stop();
			channel?.close();
			void sandboxed?.finish().catch(() => {});
			releaseTmp?.();
			log.destroy();
			throw error;
		}
		const child = launched.child;
		// fork: the log, which the end report and the panels read, holds no known secret,
		// even one the user passed to this task. stdout and stderr are masked apart, as they arrive apart.
		const secrets = knownSecrets();
		for (const stream of [child.stdout, child.stderr])
			if (stream) outputs.push(stream.pipe(maskingTransform(secrets)));
		for (const output of outputs) {
			if (logError) output.resume();
			else output.pipe(log, { end: false });
		}

		const task: Task = {
			id,
			command,
			cwd,
			pid: child.pid,
			status: "running",
			startedAt: Date.now(),
			logPath,
			timeoutSeconds,
			logError,
		};
		current = task;
		// an optional limit stops the task as kill does (SIGTERM, then SIGKILL after the grace).
		const limit =
			timeoutSeconds === undefined
				? undefined
				: setTimeout(() => {
						if (task.status !== "running") return;
						task.timedOut = true;
						requestTaskStop(task, updateStatus);
					}, timeoutSeconds * 1000);
		limit?.unref();

		// The task ends once, on `close`: after its exit and the end of its output, which can come later (a process
		// it left running still writes). Its Git changes are published and its log written to the file before
		// it shows as ended and is notified. A failed spawn reports an error, then `close`.
		let spawnError: Error | undefined;
		let ended = false;
		const end = async (code: number | null, signal: NodeJS.Signals | null) => {
			if (ended) return;
			ended = true;
			if (limit) clearTimeout(limit);
			channel?.close();
			// The masked output's last bytes, held while a secret could still be completed, reach the log first.
			await Promise.all(outputs.map((output) => finished(output).catch(() => {})));
			// fork: a stopped task ends once its group is seen empty, or says the stop was not confirmed.
			const stop = taskStops.get(task);
			if (stop && !(await stop).confirmed)
				log.write("\n[stop] Processes of this task still ran after SIGKILL; their end is not confirmed.\n");
			for (const note of sandboxed ? await sandboxed.finish() : []) log.write(`\n${note}\n`);
			releaseTmp?.();
			if (spawnError) log.write(`\n[spawn error] ${spawnError.message}\n`);
			log.end();
			try {
				await finished(log);
			} catch {}
			task.endedAt = Date.now();
			task.exitCode = code ?? undefined;
			if (spawnError) task.status = "failed";
			else if (task.timedOut) task.status = "timed_out";
			else if (task.status === "stopping" || signal) task.status = "stopped";
			else task.status = code === 0 ? "done" : "failed";
			if (!spawnError)
				notify(
					fill("{0} — background {1}", APP_DISPLAY_NAME, statusLabel(task.status)),
					`${task.id}: ${task.command.slice(0, 80)}`,
				);
			// fork: to the extension that holds the task now, the reloaded one after a /reload.
			owner.current.status();
			// the model learns of the end without polling, once the task's Git changes are published
			// and its log is complete: after its current work, or in a new turn when it is waiting.
			if (!task.stoppedByModel) owner.current.deliver(task);
		};

		child.on("error", (error) => {
			// Also emitted when a running task could not be signalled: only a failed spawn ends it.
			if (child.pid !== undefined) return;
			spawnError = error;
		});
		child.on("close", (code, signal) => void end(code, signal));

		child.unref();
		tasks.set(id, task);
		updateStatus();

		// Keep the map bounded; drop the oldest settled tasks first.
		if (tasks.size > MAX_TASKS) {
			const settled = [...tasks.values()]
				.filter((entry) => entry.status !== "running" && entry.status !== "stopping")
				.sort((a, b) => a.startedAt - b.startedAt);
			for (const stale of settled.slice(0, tasks.size - MAX_TASKS)) tasks.delete(stale.id);
		}
		return task;
	}

	pi.registerTool({
		name: "background",
		label: "Background Task",
		// fork: `run` is judged like a bash command by the gate; status and logs only read.
		permissions: (input) => (input.action === "status" || input.action === "logs" ? ["none"] : ["process"]),
		description:
			"Run a shell command in the background. When it ends (done, failed, stopped or timed_out) you receive a message with its state, its last output and its log path, also after your final answer, so do not poll it. Actions: run (start, returns an id), status (list tasks), logs (output of one task), kill (terminate one). Use for long jobs like builds or test suites instead of blocking on bash.",
		promptSnippet: "Run long shell commands in the background",
		promptGuidelines: [
			"Use background with action=run for commands expected to take over a minute; use bash for quick ones.",
		],
		parameters: Type.Object({
			action: StringEnum(["run", "status", "logs", "kill"] as const),
			command: Type.Optional(Type.String({ description: "Shell command (action=run)" })),
			timeout: Type.Optional(
				Type.Number({
					description:
						"Maximum run time in seconds (action=run). Omit it for no limit, the default: a task may run for hours.",
					exclusiveMinimum: 0,
					// Node's timers hold at most 2^31-1 ms (about 24 days).
					maximum: 2_000_000,
				}),
			),
			id: Type.Optional(Type.String({ description: "Task id (action=logs|kill)" })),
		}),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			ui = ctx.ui;
			const fail = (message: string) => ({
				content: [{ type: "text" as const, text: message }],
				details: {},
				isError: true,
			});

			if (params.action === "run") {
				if (!params.command?.trim()) return fail("action=run requires `command`.");
				let sandbox: SandboxRuntime | undefined;
				try {
					sandbox = requireSandbox(sessionSandbox(ctx.sessionManager));
				} catch (error) {
					return fail((error as Error).message);
				}
				const task = start(
					params.command.trim(),
					ctx.cwd,
					SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() }).getShellPath(),
					sandbox,
					toolCallId,
					params.timeout,
				);
				return {
					content: [
						{
							type: "text",
							text: `Started ${task.id} (pid ${task.pid ?? "?"}).\nYou will receive its result when it ends; do not poll it.`,
						},
					],
					details: { id: task.id, pid: task.pid },
				};
			}

			if (params.action === "status") {
				if (tasks.size === 0) {
					return { content: [{ type: "text", text: "No background tasks." }], details: {} };
				}
				const text = [...tasks.values()].map(describe).join("\n");
				return { content: [{ type: "text", text }], details: { count: tasks.size } };
			}

			if (!params.id) return fail(`action=${params.action} requires \`id\`.`);
			const task = tasks.get(params.id);
			if (!task) return fail(`No such task: ${params.id}`);

			if (params.action === "logs") {
				return {
					content: [{ type: "text", text: `${describe(task)}\n\n${tail(task.logPath)}` }],
					details: { id: task.id, status: task.status, exitCode: task.exitCode },
				};
			}

			const error = killTask(task);
			if (error) return fail(error);
			task.stoppedByModel = true;
			return { content: [{ type: "text", text: `Stopping ${task.id}.` }], details: { id: task.id } };
		},
	});

	pi.registerCommand("bg", {
		description: "Show and manage background tasks",
		handler: async (_args, ctx) => openPanel(ctx),
	});

	pi.registerCommand("bg-clear", {
		description: "Forget finished background tasks",
		handler: async (_args, ctx) => {
			let removed = 0;
			for (const [id, task] of tasks) {
				if (task.status !== "running") {
					tasks.delete(id);
					removed += 1;
				}
			}
			ctx.ui.setWidget("background", []);
			ctx.ui.notify(fill("Cleared {0} task(s).", String(removed)), "info");
		},
	});

	// Tasks are spawned detached on purpose: they outlive the session, so there
	// is deliberately no session_shutdown cleanup here.
}
