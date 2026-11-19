/**
 * fork: project continuity. An optional built-in module, on by default
 * (`/settings` > Extensions turns it off). When the project has the continuity structure
 * (`project/handoff.md` at the project root), it adds a `<project_continuity>` section to the
 * system prompt that says what each document is for and how to keep it current. Without the
 * structure it adds nothing to the prompt, and shows an "init" button in the footer that runs `/init`
 *; the button goes once the structure exists.
 *
 * `/init` sets the structure up: it shows what exists and what will be created, asks for
 * confirmation, then asks the model, with a dedicated `<project_init>` prompt section, to write
 * the documents from a plan or from the existing repository. The model writes with its usual
 * tools, so the user's permission rules apply; a refusal writes nothing.
 *
 * `/handoff` asks the model to update `project/handoff.md` and gives it the facts Prism measures
 * itself: branch, commit, uncommitted files, background tasks still running. Once the model has
 * written the file, Prism stamps its first line with the current commit. At session start, a
 * handoff whose stamp differs from HEAD, or older than an uncommitted change, is reported to the
 * user and in the prompt section.
 */
import { closeSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";
import { findGitPaths } from "../core/footer-data-provider.ts";
import { resolveToCwd } from "../core/tools/path-utils.ts";
import { anchoredOpenSupported, openAnchored, readAnchored, replaceAnchored } from "./anchored-open.ts";
import { backgroundTasks } from "./background.ts";
import { readBoundedSync } from "./bounded-read.ts";
import { readGlobalSetting, saveGlobalSetting } from "./global-settings.ts";
import { hostGit } from "./host-program.ts";
import { fill, t } from "./i18n/index.ts";
import { chooseInitNative, type InitReview } from "./init-native.ts";
import { hasNativeMenus } from "./interactive-client.ts";
import { planBridge } from "./plan-bridge.ts";
import { realPath } from "./real-path.ts";
import { type SettingsSection, setSettingsSection, settingsSections } from "./settings-sections.ts";

/** The continuity documents, relative to the project root, and what each one is for. */
export const CONTINUITY_FILES: ReadonlyArray<{ path: string; role: string }> = [
	{ path: "AGENTS.md", role: "standing rules for agents working in this project." },
	{
		path: "project/SPEC.md",
		role: "what the project must do. Change a requirement only when the user asks or agrees.",
	},
	{
		path: "project/roadmap.md",
		role: "ordered tasks with a status: [ ] to do, [~] in progress, [?] done but not verified, [x] verified. Mark [x] only with a proof line naming the test or check that passed.",
	},
	{
		path: "project/journal.md",
		role: "dated findings, measurements and limits. Add entries; do not rewrite past ones.",
	},
	{
		path: "project/handoff.md",
		role: "where the work stands for the next session: done, in progress, next steps, pitfalls. Rewrite it when the user asks for a handoff.",
	},
	{
		path: "project/questions.md",
		role: "open questions for the user, each with the default you follow until they answer. Decisions belong to the user: do not settle them yourself.",
	},
];

/** The file whose presence marks a project that uses the continuity structure. */
export const CONTINUITY_MARKER = "project/handoff.md";

/** The footer status that holds the "init" button; Prism's footer runs `/init` when it is clicked. */
export const INIT_STATUS = "project-continuity";
/** the /init choice that turns plan mode on to write the plan first. */
const PLAN_FIRST = "plan-mode";

/** The project root: the enclosing git repository, or the working directory outside one. */
export function projectRoot(cwd: string): string {
	return findGitPaths(cwd)?.repoDir ?? cwd;
}

/** The `<project_continuity>` section for a project root, or undefined without the structure. */
export function continuitySection(root: string): string | undefined {
	if (!existsSync(join(root, CONTINUITY_MARKER))) return undefined;
	const files = CONTINUITY_FILES.filter((file) => existsSync(join(root, file.path)));
	return [
		"This project keeps its continuity in documents at its root. Keep them current as you work:",
		...files.map((file) => `- ${file.path}: ${file.role}`),
		"When you start on the project's work in a new conversation, read project/handoff.md first. What the user says in the conversation overrides these documents.",
	].join("\n");
}

/** Files and folders at a project root that hold documentation rather than code. */
const DOC_ENTRY = /^(project|docs?|.*\.(md|txt|rst)|licen[cs]e.*|copying.*)$/i;

/** Existing files that may already play a continuity role. */
const EQUIVALENTS = ["README.md", "CLAUDE.md", "TODO.md", "ROADMAP.md", "CHANGELOG.md", "docs"];

/** Whether the project root holds anything besides documentation and hidden entries. */
export function hasCode(root: string): boolean {
	try {
		return readdirSync(root).some((name) => !name.startsWith(".") && !DOC_ENTRY.test(name));
	} catch {
		return false;
	}
}

/**
 * fork.9 QA: plan files `/init` can start from, relative to the project root: a name with "plan" in it, at the root
 * or in docs/ and plans/. `PLAN.md` (what /plan exports) first, then the most recently changed.
 */
export function findPlanFiles(root: string): string[] {
	const found: Array<{ path: string; at: number }> = [];
	for (const folder of ["", "docs", "plans"]) {
		let names: string[];
		try {
			names = readdirSync(join(root, folder));
		} catch {
			continue;
		}
		for (const name of names) {
			if (!/\.(md|txt)$/i.test(name) || (folder !== "plans" && !/plan/i.test(name))) continue;
			const stats = statSync(join(root, folder, name), { throwIfNoEntry: false });
			if (stats?.isFile()) found.push({ path: folder ? `${folder}/${name}` : name, at: stats.mtimeMs });
		}
	}
	const first = (path: string) => (path.toLowerCase() === "plan.md" ? 0 : 1);
	return found
		.sort((a, b) => first(a.path) - first(b.path) || b.at - a.at)
		.slice(0, 5)
		.map((file) => file.path);
}

/** The `<project_init>` section that guides the model while it sets the structure up. */
export const INIT_SECTION = [
	"You are setting up this project's continuity documents, at the project root. Create or adapt:",
	...CONTINUITY_FILES.map((file) => `- ${file.path}: ${file.role}`),
	"How to proceed:",
	"- From a plan: turn it into numbered requirements in project/SPEC.md, ordered tasks with acceptance criteria in project/roadmap.md, and every point the plan leaves open into project/questions.md with the default you suggest. Do not invent requirements the plan does not state.",
	"- From the existing repository: read the README, existing docs and agent instruction files, the package manifests, the tests and the recent git log. Describe the current behaviour in project/SPEC.md. In project/roadmap.md, mark a task [x] only after running a check that proves it now; otherwise mark it [?].",
	"- Reuse what exists: when a file already plays one of these roles (for example docs/roadmap.md or CLAUDE.md), make the project/ file a one-line pointer to it instead of copying it. Never delete, move or rewrite existing files; add a section to an existing AGENTS.md instead of replacing it.",
	"- Keep each document short, in plain Markdown that stays useful without Prism.",
	"- Write project/handoff.md last: its presence marks the structure as set up. Then list the files you created or changed.",
].join("\n");

type InitStart = { kind: "repository" } | { kind: "plan"; text: string } | { kind: "plan-file"; path: string };

/** Prism's instruction for /init, given to the model in the system prompt of that turn only. */
function initRequest(start: InitStart): string {
	if (start.kind === "repository")
		return "The user ran /init: set up the project continuity documents from the existing repository.";
	if (start.kind === "plan-file")
		return `The user ran /init: set up the project continuity documents from the plan in ${start.path}.`;
	return "The user ran /init: set up the project continuity documents from the plan in their message.";
}

/** the prompt section that carries Prism's instruction for /init or /handoff, for one turn. */
export const COMMAND_SECTION = "command_instruction";

/** The stamp Prism keeps on the first line of project/handoff.md: the commit the handoff was written at. */
const HANDOFF_STAMP = /^<!-- prism-handoff: commit=([0-9a-f]*) -->\n?/m;

/** Uncommitted paths listed in full before the list is cut short. */
const LISTED_CHANGES = 20;

/** What Prism measures for a handoff, without asking the model. `changes` is undefined outside a git repository. */
export type HandoffFacts = {
	branch?: string;
	commit?: string;
	subject?: string;
	changes?: string[];
	background: string[];
};

/** Why project/handoff.md no longer matches the repository: the commit it describes, if HEAD moved since, and newer changes. */
export type HandoffStaleness = { described?: string; head?: string; newer: string[] };

function modifiedAt(path: string): number | undefined {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return undefined;
	}
}

async function git(pi: ExtensionAPI, root: string, args: string[]): Promise<string | undefined> {
	// fork: run on the host, so no fsmonitor, hook or filter the repository names.
	const git = hostGit(root);
	if (!git) return undefined;
	const result = await pi.exec(git.program, [...git.options, ...args], { cwd: root, timeout: 5_000 });
	return result.code === 0 ? result.stdout : undefined;
}

/**
 * Paths with uncommitted changes, relative to the root, or undefined outside a git repository. `untracked`: "normal"
 * lists an untracked folder as itself, "all" lists the files in it.
 */
async function uncommittedPaths(
	pi: ExtensionAPI,
	root: string,
	untracked: "normal" | "all" = "normal",
): Promise<string[] | undefined> {
	// fork: Git checks a submodule's working tree
	// with that submodule's own configuration (filters, fsmonitor), which a sandboxed command can write in a repository
	// it makes; `.gitmodules` overrides a configured `diff.ignoreSubmodules`, the option does not. A submodule moved
	// to another commit is still listed.
	const out = await git(pi, root, [
		"status",
		"--porcelain=v1",
		"-z",
		`--untracked-files=${untracked}`,
		"--ignore-submodules=dirty",
	]);
	if (out === undefined) return undefined;
	const entries = out.split("\0");
	const paths: string[] = [];
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.length < 4) continue;
		paths.push(entry.slice(3));
		// A rename or copy is followed by its original path. fork: in either
		// column; a rename seen only in the worktree (" R") has one too.
		if ("RC".includes(entry[0]) || "RC".includes(entry[1])) i++;
	}
	return paths;
}

export async function handoffFacts(pi: ExtensionAPI, root: string): Promise<HandoffFacts> {
	const head = (await git(pi, root, ["log", "-1", "--format=%H%x00%s"]))?.trim();
	const [commit, subject] = head ? head.split("\0") : [];
	return {
		branch: (await git(pi, root, ["symbolic-ref", "--quiet", "--short", "HEAD"]))?.trim(),
		commit,
		subject,
		changes: await uncommittedPaths(pi, root),
		background: (backgroundTasks() ?? [])
			.filter((task) => task.status === "running")
			.map((task) => `${task.id}: ${task.command}`),
	};
}

export function handoffRequest(facts: HandoffFacts, note = false): string {
	const lines = [
		"The user ran /handoff: update project/handoff.md so the next session can resume from it.",
		"",
		"Facts measured by Prism:",
	];
	if (facts.changes === undefined) lines.push("- Not a git repository.");
	else {
		lines.push(`- Branch: ${facts.branch ?? "detached HEAD"}`);
		lines.push(
			`- Commit: ${facts.commit ? `${facts.commit.slice(0, 12)} ${facts.subject ?? ""}`.trim() : "none yet"}`,
		);
		const shown = facts.changes.slice(0, LISTED_CHANGES).join(", ");
		const more = facts.changes.length > LISTED_CHANGES ? `, and ${facts.changes.length - LISTED_CHANGES} more` : "";
		lines.push(
			facts.changes.length === 0
				? "- Uncommitted changes: none"
				: `- Uncommitted changes (${facts.changes.length}): ${shown}${more}`,
		);
	}
	lines.push(
		`- Background tasks still running: ${facts.background.length > 0 ? facts.background.join("; ") : "none"}`,
		"",
		"Copy these facts as they are. From the conversation, add the immediate goal, the next action, blockers, decisions waiting for the user, and the checks done and still missing. Mark nothing done without proof. Leave the first line, <!-- prism-handoff … -->, alone: Prism updates it.",
	);
	if (note) lines.push("", "The text after /handoff in the user's message is a note for this handoff.");
	return lines.join("\n");
}

/** Why project/handoff.md no longer matches the repository, or undefined when it does or cannot be told. */
export async function handoffStaleness(pi: ExtensionAPI, root: string): Promise<HandoffStaleness | undefined> {
	const path = join(root, CONTINUITY_MARKER);
	const written = modifiedAt(path);
	if (written === undefined) return undefined;
	// fork: the stamp is the first line; a FIFO is refused, a large file not read whole.
	let start = "";
	try {
		start = readBoundedSync(path, 4096, { over: "truncate" }).toString("utf8");
	} catch {
		return undefined;
	}
	const stamped = HANDOFF_STAMP.exec(start)?.[1] || undefined;
	// The commit the handoff describes: its stamp, or a later commit that included the handoff itself.
	const committed = (await git(pi, root, ["log", "-1", "--format=%H", "--", CONTINUITY_MARKER]))?.trim() || undefined;
	let described = stamped ?? committed;
	if (stamped && committed && stamped !== committed) {
		if ((await git(pi, root, ["merge-base", "--is-ancestor", stamped, committed])) !== undefined)
			described = committed;
	}
	const head = described ? (await git(pi, root, ["rev-parse", "HEAD"]))?.trim() : undefined;
	// fork: the files themselves; rewriting a file in an untracked folder leaves
	// the folder's date as it was.
	const newer = ((await uncommittedPaths(pi, root, "all")) ?? []).filter(
		(file) => file !== CONTINUITY_MARKER && (modifiedAt(join(root, file)) ?? 0) > written,
	);
	const moved = described !== undefined && head !== undefined && head !== described;
	return moved || newer.length > 0 ? { described: moved ? described : undefined, head, newer } : undefined;
}

function listFiles(files: string[]): string {
	return files.length > 5 ? `${files.slice(0, 5).join(", ")}, …` : files.join(", ");
}

/** The staleness, for the model. */
function staleNote(stale: HandoffStaleness): string {
	const reasons: string[] = [];
	if (stale.described && stale.head)
		reasons.push(`it describes commit ${stale.described.slice(0, 12)} and HEAD is now ${stale.head.slice(0, 12)}`);
	if (stale.newer.length > 0)
		reasons.push(`${stale.newer.length} uncommitted files changed after it (${listFiles(stale.newer)})`);
	return `project/handoff.md may be out of date: ${reasons.join("; ")}. Check git status and the log before relying on it.`;
}

/** The staleness, for the user. */
function staleNotice(stale: HandoffStaleness): string {
	const reasons: string[] = [];
	if (stale.described && stale.head)
		reasons.push(
			fill("it describes commit {0}, HEAD is now {1}", stale.described.slice(0, 12), stale.head.slice(0, 12)),
		);
	if (stale.newer.length > 0)
		reasons.push(
			fill("{0} uncommitted files changed after it ({1})", String(stale.newer.length), listFiles(stale.newer)),
		);
	return fill("project/handoff.md may be out of date: {0}. /handoff updates it.", reasons.join("; "));
}

/** the handoff reminder, in settings.json under `handoffReminder`; off by default. */
export type HandoffReminder = { enabled: boolean; interval: number };

/** Tool calls between two reminders, by default and as offered in /settings. */
export const REMINDER_INTERVAL = 100;
const REMINDER_INTERVALS = ["50", "100", "200", "500"];

export function readHandoffReminder(): HandoffReminder {
	const value = readGlobalSetting("handoffReminder");
	const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
	const interval = record.interval;
	return {
		enabled: record.enabled === true,
		interval:
			typeof interval === "number" && Number.isInteger(interval) && interval > 0 ? interval : REMINDER_INTERVAL,
	};
}

/** The reminder, added to the result of the tool call that reaches the interval: the model reads it and goes on. */
export function handoffReminderText(calls: number): string {
	return `Reminder from Prism: ${calls} tool calls since project/handoff.md was last brought up to date. Go on with the current task; in your final answer, offer the user to update the handoff (/handoff). Do not update it or stop now for this.`;
}

const SETTINGS_OWNER = "project-continuity";

export default function projectContinuity(pi: ExtensionAPI) {
	// Set by a confirmed /init; kept until project/handoff.md exists, so answers to the model's questions stay guided.
	let initRoot: string | undefined;
	// Set by /handoff; kept until the model changes project/handoff.md, which Prism then stamps.
	let pendingHandoff: { root: string; before: number | undefined } | undefined;
	// Measured once per session, so the prompt section stays stable between turns.
	let stale: HandoffStaleness | undefined;
	// tool calls since the handoff was last brought up to date or the last reminder, and whether
	// the current run was already reminded: one reminder per run at most, so they never pile up in the context.
	let reminder = readHandoffReminder();
	let callsSinceHandoff = 0;
	let remindedThisRun = false;
	let settingsSection: SettingsSection | undefined;

	const reminderSection = (report: (message: string) => void): SettingsSection => ({
		domain: "conversation",
		items: () => [
			{
				id: "handoff-reminder",
				label: "Handoff reminder",
				description:
					"In a project with project/handoff.md, reminds the model at the interval below to offer a handoff update in its final answer, without stopping it.",
				currentValue: reminder.enabled ? "on" : "off",
				values: ["on", "off"],
			},
			{
				id: "handoff-reminder-interval",
				label: "Handoff reminder interval",
				description: "Tool calls between two handoff reminders.",
				currentValue: String(reminder.interval),
				values: [...new Set([...REMINDER_INTERVALS, String(reminder.interval)])],
			},
		],
		onChange: (id, value) => {
			const next =
				id === "handoff-reminder"
					? { ...reminder, enabled: value === "on" }
					: id === "handoff-reminder-interval"
						? { ...reminder, interval: Number(value) }
						: undefined;
			if (!next) return;
			reminder = next;
			try {
				saveGlobalSetting(["handoffReminder"], next);
			} catch (error) {
				report(error instanceof Error ? error.message : String(error));
			}
		},
	});
	// Prism's instruction for the turn /init or /handoff starts, and the user message that starts it.
	// The instruction is a system prompt section of that turn only: never a user message, never kept afterwards.
	let pendingInstruction: { prompt: string; instruction: string } | undefined;
	const sendInstruction = (prompt: string, instruction: string) => {
		pendingInstruction = { prompt, instruction };
		// What the user typed stays theirs, word for word; `expandPromptTemplates` is off, so it does not run again.
		pi.sendUserMessage(prompt);
	};

	// the "init" button, shown while the project has no project/handoff.md.
	const showInitButton = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		if (!ctx.isProjectTrusted()) {
			ctx.ui.setStatus(INIT_STATUS, undefined);
			return;
		}
		const initialised = existsSync(join(projectRoot(ctx.cwd), CONTINUITY_MARKER));
		ctx.ui.setStatus(INIT_STATUS, initialised ? undefined : t("init"));
	};

	pi.on("session_start", async (_event, ctx) => {
		initRoot = undefined;
		pendingHandoff = undefined;
		stale = undefined;
		reminder = readHandoffReminder();
		callsSinceHandoff = 0;
		remindedThisRun = false;
		settingsSection = reminderSection((message) => ctx.ui.notify(message, "error"));
		setSettingsSection(SETTINGS_OWNER, settingsSection);
		showInitButton(ctx);
		if (!ctx.isProjectTrusted()) return;
		const root = projectRoot(ctx.cwd);
		if (!existsSync(join(root, CONTINUITY_MARKER))) return;
		stale = await handoffStaleness(pi, root);
		if (stale) ctx.ui.notify(staleNotice(stale), "warning");
	});

	pi.on("session_shutdown", () => {
		// A session started since then has put its own section in place: leave it.
		if (settingsSection && settingsSections().includes(settingsSection))
			setSettingsSection(SETTINGS_OWNER, undefined);
		settingsSection = undefined;
	});

	pi.on("tool_result", (event, ctx) => {
		// Calls a tool makes itself (a codemode script) are part of its own call; after a reminder, the rest of its
		// run does not count: the model has been told, and the next reminder comes a full interval later.
		if (!reminder.enabled || event.parentToolCallId || remindedThisRun) return;
		callsSinceHandoff += 1;
		if (callsSinceHandoff < reminder.interval) return;
		if (!ctx.isProjectTrusted() || !existsSync(join(projectRoot(ctx.cwd), CONTINUITY_MARKER))) return;
		const calls = callsSinceHandoff;
		callsSinceHandoff = 0;
		remindedThisRun = true;
		return { content: [...event.content, { type: "text", text: handoffReminderText(calls) }] };
	});

	pi.on("before_agent_start", async (event, ctx) => {
		remindedThisRun = false;
		const pending = pendingInstruction;
		pendingInstruction = undefined;
		if (pending?.prompt === event.prompt) event.systemPromptOptions.sections[COMMAND_SECTION] = pending.instruction;
		if (!ctx.isProjectTrusted()) return;
		const root = projectRoot(ctx.cwd);
		if (initRoot === root && !existsSync(join(root, CONTINUITY_MARKER))) {
			event.systemPromptOptions.sections.project_init = INIT_SECTION;
			return;
		}
		initRoot = undefined;
		const section = continuitySection(root);
		if (section)
			event.systemPromptOptions.sections.project_continuity = stale ? `${section}\n${staleNote(stale)}` : section;
	});

	pi.on("agent_end", async (_event, ctx) => {
		showInitButton(ctx);
		if (!pendingHandoff) return;
		const path = join(pendingHandoff.root, CONTINUITY_MARKER);
		const after = modifiedAt(path);
		if (after === undefined || after === pendingHandoff.before) return;
		const head = (await git(pi, pendingHandoff.root, ["rev-parse", "HEAD"]))?.trim() ?? "";
		const stamp = (text: string) => `<!-- prism-handoff: commit=${head} -->\n${text.replace(HANDOFF_STAMP, "")}`;
		if (anchoredOpenSupported) {
			// fork: the project's own file, reached through no link and with no other name;
			// read and written through one descriptor. Anything else is left as it is.
			try {
				const { fd, stat } = openAnchored(join(realPath(pendingHandoff.root), CONTINUITY_MARKER), "update");
				try {
					if (stat.nlink === 1) replaceAnchored(fd, stamp(readAnchored(fd).toString("utf8")));
				} finally {
					closeSync(fd);
				}
			} catch {
				// Not the file /handoff asked for: no stamp.
			}
		} else writeFileSync(path, stamp(readFileSync(path, "utf8")));
		pendingHandoff = undefined;
		stale = undefined;
		callsSinceHandoff = 0;
	});

	pi.registerCommand("init", {
		description: t("Set up the project's continuity documents, from a plan or from the existing repository"),
		handler: async (args, ctx) => {
			if (!ctx.isProjectTrusted()) {
				ctx.ui.notify(t("Project is not trusted — project continuity is disabled."), "warning");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify(
					t("/init needs the interactive interface, to show what it will create and ask you."),
					"error",
				);
				return;
			}
			const root = projectRoot(ctx.cwd);
			const argument = args.trim();
			// A plan typed or pasted: the file it names, or the plan itself.
			const planStart = (text: string): InitStart => {
				const path = resolveToCwd(text, ctx.cwd);
				return existsSync(path) && statSync(path).isFile() ? { kind: "plan-file", path } : { kind: "plan", text };
			};
			const review = (start: InitStart): InitReview => {
				const equivalents = EQUIVALENTS.filter((name) => existsSync(join(root, name)));
				return {
					lines: [
						fill("Project: {0}", root),
						t(
							start.kind === "repository"
								? "Starting point: the existing repository"
								: "Starting point: your plan",
						),
					],
					files: CONTINUITY_FILES.map((file) => ({ path: file.path, exists: existsSync(join(root, file.path)) })),
					notes: [
						...(equivalents.length > 0
							? [fill("Already present, reused rather than copied: {0}", equivalents.join(", "))]
							: []),
						t("The model writes these files with its usual tools; your permission rules apply."),
					],
				};
			};
			// fork.9 QA: a plan already in the project is offered as it is, so nobody has to type its path.
			const plans = findPlanFiles(root);
			// without a plan yet, /init offers to write one first in plan mode.
			const bridge = planBridge();
			const planFirst = plans.length === 0 && bridge !== undefined && bridge.enabled?.() === false;
			const choices: Array<{ id: string; label: string; start?: InitStart; direct?: boolean }> = [
				...plans.map((path, index) => ({
					id: `plan-file:${index}`,
					label: fill("From the plan {0}", path),
					start: { kind: "plan-file", path: join(root, path) } as InitStart,
				})),
				...(hasCode(root) ? ["repository", "plan"] : ["plan", "repository"]).map((id) =>
					id === "repository"
						? { id, label: t("From the existing repository"), start: { kind: "repository" } as InitStart }
						: { id, label: t("From a plan") },
				),
				...(planFirst
					? [{ id: PLAN_FIRST, label: t("No plan yet: write one first in plan mode"), direct: true }]
					: []),
			];
			const startPlanning = () => {
				bridge?.toggle(ctx);
				ctx.ui.notify(
					t(
						"Describe the project to plan it. Once the plan is complete, export it (PLAN.md) and run /init again: it offers that plan.",
					),
					"info",
				);
			};
			let start: InitStart;
			if (hasNativeMenus(ctx)) {
				// the Prism window asks the starting point, the plan and the confirmation in one panel.
				const fixed = argument ? planStart(argument) : undefined;
				const startOf = (id: string, plan?: string) =>
					fixed ?? choices.find((choice) => choice.id === id)?.start ?? planStart(plan ?? "");
				const answer = await chooseInitNative(
					ctx,
					fixed
						? undefined
						: choices.map(({ id, label, start, direct }) => ({ id, label, asksPlan: !start && !direct, direct })),
					(id, plan) => review(startOf(id, plan)),
					fixed ? "argument" : undefined,
				);
				if (answer === "declined") ctx.ui.notify(t("Nothing was written."));
				if (!answer || answer === "declined") return;
				if (answer.id === PLAN_FIRST) return startPlanning();
				start = startOf(answer.id, answer.plan);
			} else {
				if (argument) start = planStart(argument);
				else {
					const choice = await ctx.ui.select(
						t("Start from"),
						choices.map((option) => option.label),
					);
					const chosen = choices.find((option) => option.label === choice);
					if (!chosen) return;
					if (chosen.id === PLAN_FIRST) return startPlanning();
					if (chosen.start) start = chosen.start;
					else {
						const text = (await ctx.ui.editor(t("Paste the plan, or the path of a plan file")))?.trim();
						if (!text) return;
						start = planStart(text);
					}
				}
				const { lines, files, notes } = review(start);
				const summary = [
					...lines,
					"",
					...files.map((file) => `${t(file.exists ? "adapt" : "create")}  ${file.path}`),
					...notes.flatMap((note) => ["", note]),
				].join("\n");
				if (!(await ctx.ui.confirm(t("Set up project continuity?"), summary))) {
					ctx.ui.notify(t("Nothing was written."));
					return;
				}
			}
			initRoot = root;
			// A plan typed in the editor is the user's message; otherwise the command line they typed.
			sendInstruction(
				start.kind === "plan" && !argument ? start.text : `/init ${argument}`.trim(),
				initRequest(start),
			);
		},
	});

	pi.registerCommand("handoff", {
		description: t(
			"Have the model update project/handoff.md, with the Git state and running tasks measured by Prism",
		),
		handler: async (args, ctx) => {
			if (!ctx.isProjectTrusted()) {
				ctx.ui.notify(t("Project is not trusted — project continuity is disabled."), "warning");
				return;
			}
			const root = projectRoot(ctx.cwd);
			const path = join(root, CONTINUITY_MARKER);
			if (!existsSync(path)) {
				ctx.ui.notify(
					t("This project has no project/handoff.md: /init sets up the continuity documents."),
					"error",
				);
				return;
			}
			const facts = await handoffFacts(pi, root);
			pendingHandoff = { root, before: modifiedAt(path) };
			const note = args.trim();
			sendInstruction(`/handoff ${note}`.trim(), handoffRequest(facts, note !== ""));
		},
	});
}
