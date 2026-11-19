/**
 * fork.9 (CAP-01): /schedule, where the user creates, pauses and removes scheduled tasks (scheduled-tasks.ts).
 * Creating  * writes systemd user units, a change to the user's system: only after the user read everything the task may
 * do and confirmed. The model may propose a task (`propose_scheduled_task`); the user confirms it on the same
 * screen, and nothing is written otherwise.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";
import { fill, getLanguage, t } from "./i18n/index.ts";
import { hasInteractiveClient } from "./interactive-client.ts";
import { configurationMode } from "./permissions.ts";
import {
	installTask,
	lastRuns,
	listScheduledTasks,
	nextElapse,
	type PrismLauncher,
	type RunRecord,
	readScheduledTask,
	realLauncher,
	removeTask,
	type ScheduledTask,
	type SystemdUser,
	scheduledRun,
	setTaskPaused,
	taskEnabled,
	unitName,
	unsafeLauncher,
	unseenRuns,
	validTaskId,
} from "./scheduled-tasks.ts";
import type { ScopeOperation } from "./task-scope.ts";
import { textBlock, visibleText } from "./visible-text.ts";

const FILES: ScopeOperation = { what: "Change the project's files", commands: [], writes: ["**"], hosts: [] };
const COMMANDS: ScopeOperation = {
	what: "Run commands in the sandbox, except dangerous ones",
	commands: ["*"],
	writes: [],
	hosts: [],
};

const proposalSchema = Type.Object(
	{
		prompt: Type.String({ minLength: 1, description: "What each run does: the prompt the unattended run gets" }),
		name: Type.String({ description: "Lower case letters, digits and dashes, 40 at most" }),
		when: Type.String({ description: "A systemd calendar expression, e.g. 'Mon..Fri 09:00' or 'daily'" }),
		change_files: Type.Boolean({ description: "Whether it may change the project's files" }),
		run_commands: Type.Boolean({ description: "Whether it may run commands in the sandbox, except dangerous ones" }),
		hosts: Type.Optional(Type.Array(Type.String(), { description: "Host names it may reach; none: no network" })),
		minutes: Type.Integer({ minimum: 1, maximum: 24 * 60, description: "Time limit per run" }),
		tool_calls: Type.Integer({ minimum: 1, maximum: 10_000, description: "Tool call limit per run" }),
		catch_up: Type.Optional(
			Type.Union([Type.Literal("report"), Type.Literal("run")], {
				description: "A run missed while the computer was off: report it only (default) or run it late",
			}),
		),
	},
	{ additionalProperties: false },
);

const NETWORK_WHAT = "Connect to these hosts (commands it may run, web_fetch, web_search)";
/** A host name or a `*.` wildcard: no address, port or path, so the scope reads as what it allows. */
const HOST_RE = /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** A date in Prism's language, not the system's. */
export function formatWhen(date: Date): string {
	return new Intl.DateTimeFormat(getLanguage() === "fr" ? "fr-FR" : "en-GB", {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(date);
}

/** One run, translated: its date, outcome and the first line of each detail. */
export function describeRun(run: RunRecord, last = false): string {
	const outcome = run.outcome === "started" && last ? `${t("started")}, ${t("no end recorded")}` : t(run.outcome);
	const detail = run.detail
		?.split("\n")
		.map((line) => line.replace(/^\s*•\s*/, "").trim())
		.filter(Boolean)
		.map((line) => t(line))
		.join(" · ");
	return `${formatWhen(new Date(run.at))} ${outcome}${detail ? `: ${detail}` : ""}`;
}

/** What scheduled runs did since the user last saw them, for the next interactive start. */
export function unseenRunsReport(agentDir?: string): { message: string; level: "info" | "warning" } | undefined {
	const runs = unseenRuns(agentDir);
	if (runs.length === 0) return undefined;
	const lines = runs.slice(-10).map((run, index, shown) => {
		const last = !shown.slice(index + 1).some((other) => other.id === run.id);
		return `  ${run.id} · ${describeRun(run, last)}`;
	});
	const bad = runs.some((run) => run.outcome !== "finished" || run.detail !== "nothing refused");
	return {
		message: [t("Scheduled runs since you last looked:"), ...lines, t("/schedule shows each task's runs.")].join(
			"\n",
		),
		level: bad ? "warning" : "info",
	};
}

function positiveInteger(text: string | undefined, fallback: number, max: number): number | undefined {
	const value = text?.trim() ? Number(text.trim()) : fallback;
	return Number.isInteger(value) && value >= 1 && value <= max ? value : undefined;
}

/** "Task: <prompt>", the prompt's controls shown; one of several lines under the label, in a block. */
function taskLines(prompt: string): string {
	const shown = visibleText(prompt, { lines: true });
	return shown.includes("\n") ? `${t("Task:")}\n${textBlock(shown)}` : `${t("Task:")} ${shown}`;
}

/** Everything the user reads before the units are written. */
export function scheduleSummary(task: ScheduledTask, next: { at: Date; normalized: string }, unitDir: string): string {
	return [
		t("Create this scheduled task?"),
		// fork.12 security audit (AS-016): the prompt is the model's free text; its controls show, its lines stay.
		// After AS-017: a prompt of several lines shows as a block, which no line of it can leave.
		taskLines(task.prompt),
		`${t("Folder:")} ${task.cwd}`,
		`${t("When:")} ${visibleText(task.onCalendar)} (${next.normalized}) · ${t("next run:")} ${formatWhen(next.at)}`,
		[
			t("What it may do without asking (nobody is there to answer):"),
			...(task.operations.length > 0
				? task.operations.map(
						(operation) =>
							`  • ${t(operation.what)}${operation.hosts.length > 0 ? `: ${operation.hosts.join(", ")}` : ""}`,
					)
				: [`  • ${t("Read the project and run safe commands only")}`]),
			t(
				"Everything else is refused and reported: no sudo, no unrestricted mode, no command outside the sandbox, no new network host, not your allow rules.",
			),
		].join("\n"),
		fill("Limits per run: {0} min, {1} tool calls.", String(task.budget.minutes), String(task.budget.tools)),
		`${t("Model:")} ${task.model ?? t("the default model")}`,
		task.catchUp === "report"
			? t("A run missed while the computer was off is reported, not run late.")
			: t("A run missed while the computer was off runs at the next start."),
		t(
			"Runs only while you are logged in: Prism does not enable lingering. A locked keyring makes the run fail; no key is stored in clear for it.",
		),
		`${t("Files written:")} ${join(unitDir, unitName(task.id, "service"))}, ${unitName(task.id, "timer")}`,
	].join("\n");
}

/** Checks what a draft adds to the answers already checked, and the hosts. */
function parseHosts(text: string): string[] | { error: string } {
	const hosts = text
		.split(/[\s,]+/)
		.map((host) => host.trim().toLowerCase())
		.filter(Boolean);
	const bad = hosts.find((host) => !HOST_RE.test(host));
	return bad ? { error: fill("Invalid host: {0}. Give names such as api.github.com or *.example.com.", bad) } : hosts;
}

/** The task's operations, from the user's or the model's three answers. */
function operationsFor(files: boolean, commands: boolean, hosts: string[]): ScopeOperation[] {
	return [
		...(files ? [FILES] : []),
		...(commands ? [COMMANDS] : []),
		...(hosts.length > 0 ? [{ what: NETWORK_WHAT, commands: [], writes: [], hosts }] : []),
	];
}

/** the window's /schedule screen: the same tasks, checks and installation as data. */
export interface ScheduleForm {
	prompt: string;
	name: string;
	when: string;
	files: boolean;
	commands: boolean;
	hosts: string;
	minutes: string;
	tools: string;
	catchUp: "report" | "run";
}
export interface ScheduleSnapshot {
	/** Why this Prism cannot schedule tasks; nothing can be created then. */
	unsafe?: string;
	tasks: Array<{
		id: string;
		when: string;
		prompt: string;
		cwd: string;
		active: boolean;
		runs: string[];
		limits: string;
	}>;
	labels: Record<string, string>;
}
export interface SchedulePanel {
	snapshot(ctx: ExtensionContext): ScheduleSnapshot;
	/** What creating the task would do, or why it cannot be; `fingerprint` names the task the summary shows. */
	preview(ctx: ExtensionContext, form: ScheduleForm): { summary?: string; error?: string; fingerprint?: string };
	/** Creates the task the preview with this `fingerprint` showed; a form that no longer gives it is refused. */
	create(ctx: ExtensionContext, form: ScheduleForm, fingerprint: string | undefined): string | undefined;
	pause(id: string, paused: boolean): string | undefined;
	remove(id: string): string | undefined;
}
const schedulePanels = new WeakMap<ExtensionContext["sessionManager"], SchedulePanel>();
/** The schedule screen's data and operations for this context; undefined without the extension. */
export function schedulePanel(ctx: ExtensionContext): SchedulePanel | undefined {
	return schedulePanels.get(ctx.sessionManager);
}

function scheduleLabels(): Record<string, string> {
	return {
		title: t("Scheduled tasks"),
		new: t("New scheduled task"),
		prompt: t("What should the task do? (its prompt)"),
		name: t("Name: lower case letters, digits and dashes"),
		when: t("When? A systemd calendar expression"),
		files: t("May the task change the project's files?"),
		commands: t("May the task run commands in the sandbox, except dangerous ones?"),
		hosts: t("Hosts the task may connect to, separated by commas (empty: no network)"),
		minutes: t("Time limit per run, in minutes"),
		tools: t("Tool call limit per run"),
		catchUp: t("A run missed while the computer was off:"),
		report: t("Report it only (recommended)"),
		late: t("Run it late"),
		create: t("Create the task"),
		cancel: t("Cancel"),
		pause: t("Pause"),
		resume: t("Resume"),
		remove: t("Remove"),
		removeSure: t("Remove the task and its units"),
		active: t("active"),
		paused: t("paused"),
		lastRuns: t("Last runs:"),
		noRun: t("No run yet."),
	};
}

/** What a summary shows of a task: all of it but its creation time. */
function taskFingerprint(task: ScheduledTask): string {
	const { createdAt: _createdAt, ...shown } = task;
	return createHash("sha256").update(JSON.stringify(shown)).digest("hex");
}

function schedulePanelFor(systemd: SystemdUser, launcher: PrismLauncher): SchedulePanel {
	const fail = (error: unknown) => (error instanceof Error ? error.message : String(error));
	const known = (id: string): boolean => listScheduledTasks().some((task) => task.id === id);
	/** The checks of `/schedule`'s questions, all at once. */
	const draft = (
		ctx: ExtensionContext,
		form: ScheduleForm,
	): { task: ScheduledTask; next: { at: Date; normalized: string } } | { error: string } => {
		const unsafe = unsafeLauncher(launcher, ctx.cwd);
		if (unsafe) return { error: `${t("This Prism cannot schedule tasks:")} ${t(unsafe)}` };
		const prompt = String(form.prompt ?? "").trim();
		if (!prompt) return { error: t("What should the task do? (its prompt)") };
		const id = String(form.name ?? "").trim();
		if (!validTaskId(id)) return { error: t("Invalid name: lower case letters, digits and dashes, 40 at most.") };
		if (readScheduledTask(id)) return { error: fill("A task named {0} already exists.", id) };
		const onCalendar = String(form.when ?? "").trim();
		if (!onCalendar) return { error: t("When? A systemd calendar expression") };
		const next = nextElapse(onCalendar, systemd);
		if ("error" in next) return { error: `${t("Invalid schedule:")} ${next.error}` };
		const hosts = parseHosts(String(form.hosts ?? ""));
		if ("error" in hosts) return { error: hosts.error };
		const minutes = positiveInteger(String(form.minutes ?? ""), 30, 24 * 60);
		const tools = positiveInteger(String(form.tools ?? ""), 100, 10_000);
		if (minutes === undefined || tools === undefined)
			return { error: t("Invalid limit: a whole number above zero.") };
		return {
			next,
			task: {
				version: 1,
				id,
				prompt,
				cwd: ctx.cwd,
				onCalendar,
				operations: operationsFor(form.files === true, form.commands === true, hosts),
				budget: { minutes, tools },
				...(ctx.model ? { model: `${ctx.model.provider}/${ctx.model.id}` } : {}),
				catchUp: form.catchUp === "run" ? "run" : "report",
				createdAt: new Date().toISOString(),
			},
		};
	};
	return {
		snapshot: (ctx) => {
			const unsafe = unsafeLauncher(launcher, ctx.cwd);
			return {
				...(unsafe ? { unsafe: `${t("This Prism cannot schedule tasks:")} ${t(unsafe)}` } : {}),
				tasks: listScheduledTasks().map((task) => {
					const records = lastRuns(task.id);
					return {
						id: task.id,
						when: task.onCalendar,
						prompt: task.prompt,
						cwd: task.cwd,
						active: taskEnabled(task.id, systemd) !== false,
						runs: records.map((run, index) => describeRun(run, index === records.length - 1)),
						limits: fill(
							"Limits per run: {0} min, {1} tool calls.",
							String(task.budget.minutes),
							String(task.budget.tools),
						),
					};
				}),
				labels: scheduleLabels(),
			};
		},
		preview: (ctx, form) => {
			const made = draft(ctx, form);
			return "error" in made
				? made
				: {
						summary: scheduleSummary(made.task, made.next, systemd.unitDir()),
						fingerprint: taskFingerprint(made.task),
					};
		},
		create: (ctx, form, fingerprint) => {
			const made = draft(ctx, form);
			if ("error" in made) return made.error;
			// fork: the window's form stays editable while its summary is
			// prepared; only the task that summary showed is created.
			if (fingerprint !== taskFingerprint(made.task))
				return t("The task is not the one its summary showed. Review it again before creating it.");
			try {
				installTask(made.task, systemd, undefined, launcher);
				return undefined;
			} catch (error) {
				return fail(error);
			}
		},
		pause: (id, paused) => {
			if (!known(id)) return fill("No scheduled task named {0}.", id);
			try {
				setTaskPaused(id, paused, systemd);
				return undefined;
			} catch (error) {
				return fail(error);
			}
		},
		remove: (id) => {
			if (!known(id)) return fill("No scheduled task named {0}.", id);
			try {
				removeTask(id, systemd);
				return undefined;
			} catch (error) {
				return fail(error);
			}
		},
	};
}

/** fork.9 (CAP-01): `/schedule`, and the model's proposal tool. */
/**
 * fork.9 QA: the usual times offered; a calendar expression only for what they do not cover. A time left empty is
 * 09:00, and a wrong one comes back as an invalid schedule, as a wrong expression does.
 */
async function askWhen(ctx: ExtensionContext): Promise<string | undefined> {
	const days: Array<[string, string]> = [
		[t("Every day"), "*-*-*"],
		[t("Monday to Friday"), "Mon..Fri"],
		[t("Every Monday"), "Mon"],
	];
	const hourly = t("Every hour");
	const other = t("Other: a systemd calendar expression");
	const choice = await ctx.ui.select(t("When should the task run?"), [...days.map(([label]) => label), hourly, other]);
	if (!choice) return undefined;
	if (choice === hourly) return "hourly";
	if (choice === other) {
		return (await ctx.ui.input(t("A systemd calendar expression"), "Mon..Fri 09:00, daily, *-*-* 06:30"))?.trim();
	}
	const time = await ctx.ui.input(t("At what time? (HH:MM)"), "09:00");
	if (time === undefined) return undefined;
	return `${days.find(([label]) => label === choice)?.[1]} ${time.trim() || "09:00"}`;
}

export function scheduleCommand(systemd: SystemdUser, launcher: PrismLauncher = realLauncher) {
	return (pi: ExtensionAPI): void => {
		/** The confirmation screen, then the units. Returns whether the task was created. */
		const confirmAndInstall = async (
			ctx: ExtensionContext,
			task: ScheduledTask,
			next: { at: Date; normalized: string },
			intro?: string,
			proposal?: { signal: AbortSignal | undefined },
		): Promise<boolean> => {
			const confirm = t("Create the task");
			const summary = scheduleSummary(task, next, systemd.unitDir());
			// fork: the agent's proposal is asked with its call's signal, and holds only
			// while that call runs and the mode still lets the agent change the configuration.
			proposal?.signal?.throwIfAborted();
			const answer = await ctx.ui.select(intro ? `${intro}\n\n${summary}` : summary, [confirm, t("Cancel")], {
				signal: proposal?.signal,
			});
			if (answer !== confirm) return false;
			if (proposal) {
				proposal.signal?.throwIfAborted();
				const mode = configurationMode(ctx);
				if (mode === undefined || mode === "safe")
					throw new Error("Scheduled tasks cannot be proposed in safe mode.");
			}
			installTask(task, systemd, undefined, launcher);
			return true;
		};

		const create = async (ctx: ExtensionContext): Promise<void> => {
			const unsafe = unsafeLauncher(launcher, ctx.cwd);
			if (unsafe) {
				ctx.ui.notify(`${t("This Prism cannot schedule tasks:")} ${t(unsafe)}`, "error");
				return;
			}
			const prompt = (await ctx.ui.input(t("What should the task do? (its prompt)"), t("Prompt")))?.trim();
			if (!prompt) return;
			const id = (await ctx.ui.input(t("Name: lower case letters, digits and dashes"), "nightly-tests"))?.trim();
			// Escape cancels quietly; an empty name says that nothing was created.
			if (id === "") ctx.ui.notify(t("No name given: the task was not created."), "info");
			if (!id) return;
			if (!validTaskId(id)) {
				ctx.ui.notify(t("Invalid name: lower case letters, digits and dashes, 40 at most."), "error");
				return;
			}
			if (readScheduledTask(id)) {
				ctx.ui.notify(fill("A task named {0} already exists.", id), "error");
				return;
			}
			const onCalendar = await askWhen(ctx);
			if (!onCalendar) return;
			const next = nextElapse(onCalendar, systemd);
			if ("error" in next) {
				ctx.ui.notify(`${t("Invalid schedule:")} ${next.error}`, "error");
				return;
			}
			const yes = t("Yes");
			const operations: ScopeOperation[] = [];
			if ((await ctx.ui.select(t("May the task change the project's files?"), [yes, t("No")])) === yes)
				operations.push(FILES);
			if (
				(await ctx.ui.select(t("May the task run commands in the sandbox, except dangerous ones?"), [
					yes,
					t("No"),
				])) === yes
			)
				operations.push(COMMANDS);
			const hosts = parseHosts(
				(await ctx.ui.input(
					t("Hosts the task may connect to, separated by commas (empty: no network)"),
					"api.github.com",
				)) ?? "",
			);
			if ("error" in hosts) {
				ctx.ui.notify(hosts.error, "error");
				return;
			}
			if (hosts.length > 0) operations.push(...operationsFor(false, false, hosts));
			const minutes = positiveInteger(await ctx.ui.input(t("Time limit per run, in minutes"), "30"), 30, 24 * 60);
			const tools = positiveInteger(await ctx.ui.input(t("Tool call limit per run"), "100"), 100, 10_000);
			if (minutes === undefined || tools === undefined) {
				ctx.ui.notify(t("Invalid limit: a whole number above zero."), "error");
				return;
			}
			const report = t("Report it only (recommended)");
			const catchUp =
				(await ctx.ui.select(t("A run missed while the computer was off:"), [report, t("Run it late")])) === report
					? "report"
					: "run";
			const task: ScheduledTask = {
				version: 1,
				id,
				prompt,
				cwd: ctx.cwd,
				onCalendar,
				operations,
				budget: { minutes, tools },
				...(ctx.model ? { model: `${ctx.model.provider}/${ctx.model.id}` } : {}),
				catchUp,
				createdAt: new Date().toISOString(),
			};
			try {
				if (await confirmAndInstall(ctx, task, next))
					ctx.ui.notify(fill("Scheduled task {0} created.", id), "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		};

		const manage = async (ctx: ExtensionContext, task: ScheduledTask): Promise<void> => {
			const enabled = taskEnabled(task.id, systemd);
			const records = lastRuns(task.id);
			const runs = records.map((run, index) => `  ${describeRun(run, index === records.length - 1)}`);
			const pause = t("Pause");
			const resume = t("Resume");
			const remove = t("Remove");
			const choice = await ctx.ui.select(
				[
					// fork: the task file's text shows its controls.
					`${task.id} · ${visibleText(task.onCalendar)} · ${enabled === false ? t("paused") : t("active")}`,
					taskLines(task.prompt),
					...(runs.length > 0 ? [t("Last runs:"), ...runs] : [t("No run yet.")]),
				].join("\n"),
				[enabled === false ? resume : pause, remove, t("Back")],
			);
			try {
				if (choice === pause || choice === resume) {
					setTaskPaused(task.id, choice === pause, systemd);
					ctx.ui.notify(
						fill(choice === pause ? "Scheduled task {0} paused." : "Scheduled task {0} resumed.", task.id),
						"info",
					);
				} else if (choice === remove) {
					const sure = t("Remove the task and its units");
					if ((await ctx.ui.select(fill("Remove scheduled task {0}?", task.id), [sure, t("Cancel")])) !== sure)
						return;
					removeTask(task.id, systemd);
					ctx.ui.notify(fill("Scheduled task {0} removed.", task.id), "info");
				}
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		};

		// What the runs did while nobody was there, once, at the next interactive start.
		pi.on("session_start", (event, ctx) => {
			// A scheduled run has nobody at a screen, and may not create tasks.
			if (!scheduledRun()) schedulePanels.set(ctx.sessionManager, schedulePanelFor(systemd, launcher));
			if (event.reason !== "startup" || !hasInteractiveClient(ctx) || scheduledRun()) return;
			const report = unseenRunsReport();
			if (report) ctx.ui.notify(report.message, report.level);
		});

		pi.registerTool({
			name: "propose_scheduled_task",
			label: "Propose a scheduled task",
			permissions: ["none"],
			description:
				"Propose a scheduled task to the user: a prompt run later, unattended, by a systemd user timer, in the current folder. The user sees everything the task may do and creates it or not; nothing is written otherwise. Interactive terminal only.",
			promptSnippet: "Propose a recurring unattended task; the user confirms it",
			promptGuidelines: [
				"Propose a scheduled task only when the user asks for something to run later or regularly. Ask for the least the task needs: no file changes, commands or hosts it does not use.",
				"If the user declines, do not propose it again unless asked.",
			],
			parameters: proposalSchema,
			async execute(_id, params, signal, _onUpdate, ctx) {
				if (!hasInteractiveClient(ctx) || scheduledRun())
					throw new Error("Scheduled tasks are proposed at the interactive terminal only.");
				const mode = configurationMode(ctx);
				if (mode === undefined || mode === "safe")
					throw new Error("Scheduled tasks cannot be proposed in safe mode.");
				if (!Check(proposalSchema, params)) throw new Error("Invalid proposal.");
				const unsafe = unsafeLauncher(launcher, ctx.cwd);
				if (unsafe) throw new Error(`This Prism cannot schedule tasks: ${unsafe}`);
				if (!validTaskId(params.name))
					throw new Error("Invalid name: lower case letters, digits and dashes, 40 at most.");
				if (readScheduledTask(params.name)) throw new Error(`A task named ${params.name} already exists.`);
				const next = nextElapse(params.when, systemd);
				if ("error" in next) throw new Error(`Invalid schedule: ${next.error}`);
				const hosts = parseHosts((params.hosts ?? []).join(","));
				if ("error" in hosts) throw new Error(hosts.error);
				const task: ScheduledTask = {
					version: 1,
					id: params.name,
					prompt: params.prompt,
					cwd: ctx.cwd,
					onCalendar: params.when,
					operations: operationsFor(params.change_files, params.run_commands, hosts),
					budget: { minutes: params.minutes, tools: params.tool_calls },
					...(ctx.model ? { model: `${ctx.model.provider}/${ctx.model.id}` } : {}),
					catchUp: params.catch_up ?? "report",
					createdAt: new Date().toISOString(),
				};
				if (!(await confirmAndInstall(ctx, task, next, t("The agent proposes a scheduled task."), { signal })))
					throw new Error(
						"The user did not create the task. Nothing was written. Do not propose it again unless asked.",
					);
				const text = `Scheduled task ${task.id} created; it runs ${next.normalized}, next at ${next.at.toISOString()}.`;
				return { content: [{ type: "text", text }], details: { id: task.id } };
			},
		});

		pi.registerCommand("schedule", {
			description: t("Scheduled tasks: create, pause or remove"),
			handler: async (_args, ctx) => {
				if (!hasInteractiveClient(ctx)) {
					ctx.ui.notify(t("/schedule needs the interactive terminal."), "warning");
					return;
				}
				const tasks = listScheduledTasks();
				const add = t("New scheduled task");
				const labels = tasks.map((task) => `${task.id} · ${visibleText(task.onCalendar)}`);
				const choice = await ctx.ui.select(t("Scheduled tasks"), [add, ...labels]);
				if (choice === add) await create(ctx);
				else if (choice !== undefined) {
					const task = tasks[labels.indexOf(choice)];
					if (task) await manage(ctx, task);
				}
			},
		});
	};
}
