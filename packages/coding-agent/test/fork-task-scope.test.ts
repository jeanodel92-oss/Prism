// fork: the task scope, at the permission gate.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";
import { setLanguage } from "../src/fork/i18n/index.ts";
import permissionsExtension, { operationRules } from "../src/fork/permissions.ts";
import { findBwrap } from "../src/fork/sandbox/runtime.ts";
import {
	blockedReport,
	MAX_MINUTES,
	maxScopeMinutes,
	parseProposal,
	type ScopeApproval,
	ScopeView,
} from "../src/fork/task-scope.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

const DOWN = "\x1b[B";
const ENTER = "\r";
/** On the screen, from the first line: approve, after `lines` operation lines. */
const approve = (lines: number) => [...Array(lines + 2).fill(DOWN), ENTER];
/** The same, saying the user goes away. */
const approveAway = (lines: number) => [...Array(lines + 1).fill(DOWN), ENTER, DOWN, ENTER];

const strip = (text: string) => text.replace(/\x1b\[[0-9;:]*m|\x1b_[^\x07]*\x07/g, "");

interface Run {
	harness: Harness;
	selects: { title: string; options: string[] }[];
	notices: string[];
	screens: string[];
}

describe("fork: task scope", () => {
	let agentDir: string;
	const savedAgentDir = process.env[ENV_AGENT_DIR];
	const harnesses: Harness[] = [];

	beforeAll(() => initTheme("dark"));

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-scope-"));
		process.env[ENV_AGENT_DIR] = agentDir;
		// These tests expect ask mode; without a configured mode Prism starts in broad.
		writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode: "ask" }));
	});

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		if (savedAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = savedAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	});

	/** A session in ask mode; `keys` are typed on the approval screen, `answer` picks a question's option. */
	async function start(options: {
		keys?: string[];
		answer?: (options: string[]) => string | undefined;
		withUI?: boolean;
	}): Promise<Run> {
		const harness = await createHarness({
			extensionFactories: [{ name: "permissions", factory: permissionsExtension }],
		});
		harnesses.push(harness);
		const run: Run = { harness, selects: [], notices: [], screens: [] };
		const custom = (async (factory: (...args: unknown[]) => ScopeView) => {
			let result: ScopeApproval | undefined;
			const view = factory(
				{ terminal: { rows: 40, columns: 100 }, requestRender: () => {} },
				undefined,
				undefined,
				(value: ScopeApproval | undefined) => {
					result = value;
				},
			);
			run.screens.push(strip(view.render(100).join("\n")));
			for (const key of options.keys ?? []) view.handleInput(key);
			return result;
		}) as unknown as ExtensionUIContext["custom"];
		await harness.session.bindExtensions(
			options.withUI === false
				? {}
				: {
						uiContext: createTestUiContext({
							custom,
							notify: (message) => run.notices.push(message),
							select: async (title, selectOptions) => {
								run.selects.push({ title, options: selectOptions });
								return options.answer?.(selectOptions);
							},
						}),
					},
		);
		return run;
	}

	const NOTES = { what: "Write the notes", writes: ["notes/**"] };

	type Input = Parameters<typeof fauxToolCall>[1];

	/** One run of the agent: it calls propose_scope with `proposal` (when given), then makes `calls` in turn. */
	async function task(run: Run, proposal: Input | undefined, calls: [string, Input][]): Promise<void> {
		run.harness.setResponses([
			...(proposal
				? [fauxAssistantMessage(fauxToolCall("propose_scope", proposal), { stopReason: "toolUse" })]
				: []),
			...calls.map(([tool, input]) => fauxAssistantMessage(fauxToolCall(tool, input), { stopReason: "toolUse" })),
			fauxAssistantMessage("done"),
		]);
		await run.harness.session.prompt("go");
	}

	const results = (run: Run, tool: string) =>
		run.harness.session.messages
			.filter((message) => message.role === "toolResult" && message.toolName === tool)
			.map((message) => JSON.stringify((message as { content: unknown }).content));

	it("cannot be approved by the model: nothing changes until the user approves it", async () => {
		// The user closes the screen; the model claims approval and absence in its own arguments.
		const run = await start({ keys: ["\x1b"], answer: () => "Block this action once" });
		await task(run, { operations: [NOTES], minutes: 30, approved: true, away: true }, [
			["write", { path: "notes/a.txt", content: "x" }],
		]);
		expect(results(run, "propose_scope")[0]).toContain("The user did not approve the scope. Nothing changed");
		expect(run.selects).toHaveLength(1);
		expect(existsSync(join(run.harness.tempDir, "notes/a.txt"))).toBe(false);
		expect(run.screens[0]).toContain("Task scope proposed by the agent");
	});

	it("is not offered without a UI, where nobody could approve it", async () => {
		const run = await start({ withUI: false });
		expect(run.harness.session.getAllTools().map((tool) => tool.name)).not.toContain("propose_scope");
		await task(run, { operations: [NOTES] }, [["write", { path: "notes/a.txt", content: "x" }]]);
		expect(results(run, "propose_scope")[0]).toContain("not found");
		expect(existsSync(join(run.harness.tempDir, "notes/a.txt"))).toBe(false);
	});

	it("shows the operations in words and what a scope does not limit", async () => {
		// Reading everything: what the scope says with reading limited is tested below.
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sandbox: { read: { limit: "all" } } }));
		const run = await start({ keys: ["\x1b"] });
		await task(
			run,
			{
				operations: [
					NOTES,
					{ what: "Install the dependencies", commands: ["npm install"], hosts: ["registry.npmjs.org"] },
				],
			},
			[],
		);
		const screen = run.screens[0] ?? "";
		expect(screen).toContain("[x] Write the notes");
		expect(screen).toContain("changes notes/**");
		expect(screen).toContain("runs npm install · connects to registry.npmjs.org");
		expect(screen).toContain("While it runs: I stay here");
		expect(screen).toContain("Does not limit: reading files outside the project");
		expect(screen).not.toMatch(/limited to (this|the) project/);
	});

	it("allows what it covers without a question, asks for the rest while the user stays, and ends with the task", async () => {
		const run = await start({
			keys: approve(1),
			answer: (options) => options.find((option) => option.endsWith("for this task")),
		});
		await task(run, { operations: [NOTES] }, [
			["write", { path: "notes/a.txt", content: "x" }],
			["write", { path: "other.txt", content: "x" }],
			["write", { path: "other.txt", content: "y" }],
		]);
		expect(results(run, "propose_scope")[0]).toContain("The user approved this scope");
		expect(existsSync(join(run.harness.tempDir, "notes/a.txt"))).toBe(true);
		// One question, outside the scope; "for this task" widens it, so the second write is not asked.
		expect(run.selects).toHaveLength(1);
		expect(run.selects[0]!.options).toContain(`Allow "change the project's files" for this task`);
		expect(run.selects[0]!.options).toContain(`Block "change the project's files" for this task`);
		expect(existsSync(join(run.harness.tempDir, "other.txt"))).toBe(true);
		// The next task has no scope: asked again.
		await task(run, undefined, [["write", { path: "notes/b.txt", content: "x" }]]);
		expect(run.selects).toHaveLength(2);
	});

	it("set from /perm scope: covers the next task, and ends with it", async () => {
		// Up twice from the first line: « Approve », whether the sandbox line is offered or not.
		const run = await start({ keys: ["\x1b[A", "\x1b[A", ENTER] });
		await run.harness.session.prompt("/perm scope");
		expect(run.screens[0]).toContain("Set a task scope");
		expect(run.notices.some((notice) => notice.startsWith("Task scope set for your next task"))).toBe(true);
		await task(run, undefined, [["write", { path: "a.txt", content: "x" }]]);
		expect(existsSync(join(run.harness.tempDir, "a.txt"))).toBe(true);
		expect(run.selects).toHaveLength(0);
		// The task it covered has ended: the next one is asked about.
		await task(run, undefined, [["write", { path: "b.txt", content: "x" }]]);
		expect(run.selects).toHaveLength(1);
	});

	it("never covers a write outside the project, even with a glob that matches everything", async () => {
		// Not under /tmp: with the sandbox, the file tools write there in the session's private /tmp.
		const outside = mkdtempSync(join("/var/tmp", "prism-scope-outside-"));
		try {
			const run = await start({ keys: approveAway(1) });
			const parsed = parseProposal({ operations: [{ what: "Everything", writes: ["**"] }] });
			expect(parsed).not.toBeInstanceOf(Error);
			await task(run, { operations: [{ what: "Everything", writes: ["**"] }] }, [
				["write", { path: join(outside, "x.txt"), content: "x" }],
			]);
			expect(existsSync(join(outside, "x.txt"))).toBe(false);
			expect(results(run, "write")[0]).toContain("outside the task scope");
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("while the user is away: refuses at once, then without a question, and reports when the task ends", async () => {
		const run = await start({ keys: approveAway(1), answer: () => "Allow once" });
		await task(run, { operations: [NOTES] }, [
			["write", { path: "notes/a.txt", content: "x" }],
			["bash", { command: "npm run build" }],
			["bash", { command: "npm run build --watch" }],
		]);
		expect(existsSync(join(run.harness.tempDir, "notes/a.txt"))).toBe(true);
		expect(run.selects).toHaveLength(0);
		const [first, second] = results(run, "bash");
		expect(first).toContain("outside the task scope the user approved, and the user is away");
		expect(first).toContain("say at the end what is left");
		expect(second).toContain("already refused in this task");
		expect(run.notices.join("\n")).toContain("run npm run build: refused while you were away (2 times)");
	});

	it("while the user stays: one refusal holds for the rest of the task", async () => {
		const run = await start({
			keys: approve(1),
			answer: (options) => options.find((option) => option.startsWith("Block")),
		});
		await task(run, { operations: [NOTES] }, [
			["bash", { command: "npm run build" }],
			["bash", { command: "npm run build --watch" }],
		]);
		expect(run.selects).toHaveLength(1);
		expect(results(run, "bash")[0]).toContain("Denied by the user for the rest of this task");
		expect(results(run, "bash")[1]).toContain("already refused in this task");
	});

	it("never covers a dangerous call", async () => {
		const run = await start({ keys: approve(1), answer: () => undefined });
		await task(run, { operations: [{ what: "Clean up", commands: ["rm"] }] }, [
			["bash", { command: 'rm -rf "$UNSET"build' }],
		]);
		expect(run.selects).toHaveLength(1);
		expect(run.selects[0]!.title).toContain("Potentially dangerous action");
	});

	// fork.9 QA.
	it("is refused in safe mode, and for a dangerous command, without putting it to the user", async () => {
		const safe = await start({ keys: approve(1) });
		await safe.harness.session.prompt("/perm mode safe");
		await task(safe, { operations: [{ what: "Write", writes: ["**"] }] }, []);
		expect(results(safe, "propose_scope")[0]).toContain("Scope not proposed: safe mode");
		expect(safe.screens).toEqual([]);

		const dangerous = await start({ keys: approve(1) });
		await task(dangerous, { operations: [{ what: "Install", commands: ["sudo dnf install x"] }] }, []);
		expect(results(dangerous, "propose_scope")[0]).toContain("never covers dangerous commands (sudo dnf install x)");
		expect(dangerous.screens).toEqual([]);
	});

	// fork.9 QA: the limit is the user's.
	it("takes its longest duration from the settings, wrong values keeping the default", () => {
		expect(maxScopeMinutes(agentDir)).toBe(MAX_MINUTES);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ scopeMaxMinutes: 2 }));
		expect(maxScopeMinutes(agentDir)).toBe(MAX_MINUTES);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ scopeMaxMinutes: 1440 }));
		expect(maxScopeMinutes(agentDir)).toBe(1440);
		const operations = [{ what: "Test", commands: ["npm test"] }];
		const long = parseProposal({ operations, minutes: 1000 }, 1440);
		expect(long instanceof Error ? 0 : long.minutes).toBe(1000);
		const capped = parseProposal({ operations, minutes: 1000 });
		expect(capped instanceof Error ? 0 : capped.minutes).toBe(MAX_MINUTES);
		let chosen: ScopeApproval | undefined;
		const proposal = parseProposal({ operations, minutes: 60 }, 45);
		if (proposal instanceof Error) throw proposal;
		const view = new ScopeView(
			proposal,
			(approval) => {
				chosen = approval;
			},
			false,
			45,
		);
		// Enter on the duration line goes to the next value: 45 is the longest, then back to 15.
		for (const key of [DOWN, ENTER, DOWN, DOWN, ENTER]) view.handleInput(key);
		expect(chosen?.minutes).toBe(15);
	});

	// fork: the model's words reach the approval screen and /perm scope.
	it("shows the terminal controls of a proposal's words, and refuses them in a command or a path", () => {
		const parsed = parseProposal({
			operations: [{ what: "Run tests\x1b[8m and upload ~/.ssh", commands: ["npm test"] }],
		});
		expect(parsed instanceof Error ? parsed.message : parsed.operations[0]!.what).toBe(
			"Run tests<U+001B>[8m and upload ~/.ssh",
		);
		for (const operation of [
			{ what: "x", commands: ["npm test\x1b[8m"] },
			{ what: "x", writes: ["src/\u202e**"] },
		]) {
			const refused = parseProposal({ operations: [operation] });
			expect(refused instanceof Error ? refused.message : "").toContain("no control or invisible characters");
		}
	});

	it("rejects a proposal that would allow more than it shows", () => {
		const error = (operation: Record<string, unknown>) => {
			const parsed = parseProposal({ operations: [operation] });
			return parsed instanceof Error ? parsed.message : "";
		};
		expect(error({ what: "x", commands: ["npm *"] })).toContain("no wildcards");
		expect(error({ what: "x", commands: ["echo $(id)"] })).toContain("no wildcards or substitutions");
		expect(error({ what: "x", writes: ["../up/**"] })).toContain("only paths inside the project");
		expect(error({ what: "x", writes: ["/etc/**"] })).toContain("only paths inside the project");
		expect(error({ what: "x", hosts: ["*"] })).toContain("a host name");
		expect(error({ what: "x" })).toContain("allows nothing");
	});

	// fork: reading is said to be limited only while it is.
	it.skipIf(!findBwrap())("says reading stays limited while the limit is on and commands are sandboxed", async () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sandbox: { read: { limit: "project" } } }));
		const run = await start({ keys: ["\x1b"] });
		await task(run, { operations: [NOTES] }, []);
		// The lines are wrapped at the screen's width, inside its frame.
		const screen = (run.screens[0] ?? "").replace(/[│\s]+/g, " ");
		expect(screen).toContain("Reading stays limited to the project");
		expect(screen).not.toContain("Does not limit: reading");
		expect(screen).toContain("what MCP and LSP servers and your browser read themselves");
		// Limit on, but this mode runs commands outside the sandbox: reading is not limited.
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ sandbox: { read: { limit: "project" }, modes: { ask: false } } }),
		);
		const unsandboxed = await start({ keys: ["\x1b"] });
		await task(unsandboxed, { operations: [NOTES] }, []);
		expect((unsandboxed.screens[0] ?? "").replace(/[│\s]+/g, " ")).toContain("Does not limit: reading files");
		const off = new ScopeView({ operations: [], minutes: 60, from: "user" }, () => {}, false).render(100).join("\n");
		expect(strip(off)).toContain("Does not limit: reading files outside the project");
		setLanguage("fr");
		try {
			const view = new ScopeView({ operations: [], minutes: 60, from: "user" }, () => {}, true);
			const french = strip(view.render(100).join("\n")).replace(/[│\s]+/g, " ");
			expect(french).toContain("La lecture reste limitée au projet");
			expect(french).not.toMatch(/\b(Reading|Does not limit)\b/);
		} finally {
			setLanguage("en");
		}
	});

	it("lets the any-command line cover nothing while the sandbox is off", () => {
		const any = { what: "Run commands in the sandbox", commands: ["*"], writes: [], hosts: [] };
		expect(operationRules(any, true).map((rule) => rule.label)).toEqual(["bash(*)", "background(*)"]);
		expect(operationRules(any, false)).toEqual([]);
	});

	it("is written in French when the interface is", () => {
		setLanguage("fr");
		try {
			const proposal = parseProposal({
				operations: [
					{ what: "Écrire les notes", writes: ["notes/**"] },
					{ what: "Installer les dépendances", commands: ["npm install"], hosts: ["registry.npmjs.org"] },
				],
			});
			if (proposal instanceof Error) throw proposal;
			const screen = strip(new ScopeView(proposal, () => {}).render(100).join("\n"));
			expect(screen).toContain("Périmètre de tâche proposé par l'agent");
			expect(screen).toContain("lance npm install · se connecte à registry.npmjs.org");
			expect(screen).toContain("Durée : 60 min");
			expect(screen).toContain("Ne limite pas : la lecture des fichiers hors du projet");
			expect(screen).toContain("Approuver");
			// Every fixed text of the screen has its translation: no English sentence is left.
			expect(screen).not.toMatch(/\b(the|while|Approve|Cancel|Duration|Limits|runs|changes)\b/);
			expect(
				blockedReport([
					{ what: "lancer curl", why: "away" },
					{ what: "lancer curl", why: "again" },
				]),
			).toBe(
				[
					"Périmètre de tâche terminé. Hors de lui, Prism a refusé :",
					"  • lancer curl: refusé pendant votre absence (2 fois)",
				].join("\n"),
			);
		} finally {
			setLanguage("en");
		}
	});

	it("groups the report: each refused action once, with how many times", () => {
		expect(
			blockedReport([
				{ what: "run curl", why: "away" },
				{ what: "Connect to example.com", why: "away" },
				{ what: "run curl", why: "again" },
			]),
		).toBe(
			[
				"Task scope ended. Outside it, Prism refused:",
				"  • run curl: refused while you were away (2 times)",
				"  • Connect to example.com: refused while you were away",
			].join("\n"),
		);
	});
});
