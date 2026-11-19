// fork: project continuity, an optional module, on by default.
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import projectContinuity, {
	COMMAND_SECTION,
	CONTINUITY_FILES,
	continuitySection,
	findPlanFiles,
	handoffReminderText,
	INIT_STATUS,
	projectRoot,
	REMINDER_INTERVAL,
	readHandoffReminder,
} from "../src/fork/project-continuity.ts";
import { settingsSections } from "../src/fork/settings-sections.ts";
import { createHarness, createTestUiContext, getMessageText, type Harness } from "./suite/harness.ts";

const packageDir = resolve(__dirname, "..");
const resolverUrl = pathToFileURL(join(packageDir, "src/experimental/source-resolver.ts")).href;
const probe = resolve(packageDir, "../../fork/tools/prompt-probe.ts");
const dirs: string[] = [];
const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeStructure(root: string, files: string[]): void {
	mkdirSync(join(root, "project"), { recursive: true });
	for (const file of files) writeFileSync(join(root, file), `# ${file}\n`);
}

async function promptSent(setup: (cwd: string) => void): Promise<string> {
	const harness = await createHarness({
		extensionFactories: [{ name: "project-continuity", factory: projectContinuity }],
	});
	harnesses.push(harness);
	setup(harness.tempDir);
	await harness.session.bindExtensions({ uiContext: createTestUiContext() });
	let systemPrompt = "";
	harness.setResponses([
		() => {
			systemPrompt = harness.session.systemPrompt;
			return fauxAssistantMessage("ok");
		},
	]);
	await harness.session.prompt("hi");
	return systemPrompt;
}

/**
 * Runs the CLI from source with the prompt probe and returns the first request's system messages, with the
 * temporary paths replaced, and their prompt sections.
 */
function firstRequest(
	extensions: string[] | undefined,
	structure = true,
): { dump: string; sections: Record<string, string | null> } {
	const root = mkdtempSync(join(tmpdir(), "prism-continuity-"));
	dirs.push(root);
	const agentDir = join(root, "agent");
	const cwd = join(root, "ws");
	mkdirSync(agentDir);
	mkdirSync(cwd);
	if (structure) writeStructure(cwd, ["AGENTS.md", "project/handoff.md"]);
	// an unapproved folder gets no continuity section; these runs are about a folder the user trusts.
	new ProjectTrustStore(agentDir).set(cwd, true);
	if (extensions) writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions }));
	const out = join(root, "request.json");
	const run = spawnSync(
		process.execPath,
		[
			"--import",
			resolverUrl,
			join(packageDir, "src/cli.ts"),
			"--no-session",
			"-e",
			probe,
			"--model",
			"probe/dump",
			"-p",
			"hi",
		],
		{
			cwd,
			env: {
				...process.env,
				HOME: root,
				PI_CODING_AGENT_DIR: agentDir,
				PRISM_CODING_AGENT_DIR: agentDir,
				PI_OFFLINE: "1",
				PRISM_PROMPT_OUT: out,
			},
			encoding: "utf8",
			timeout: 60_000,
		},
	);
	expect(run.status, run.stderr).toBe(0);
	const text = readFileSync(out, "utf8");
	const dump = JSON.parse(text) as { systemMessages: { sections: Record<string, string | null> }[] };
	return {
		dump: text.split(root).join("<root>"),
		sections: Object.assign({}, ...dump.systemMessages.map((message) => message.sections)),
	};
}

const firstRequestSections = (extensions: string[] | undefined) => firstRequest(extensions).sections;

describe("fork: project continuity", () => {
	it("is a built-in module, on by default", () => {
		const entry = builtInExtensions.find(
			(extension) => typeof extension !== "function" && extension.name === "project-continuity",
		);
		expect(entry).toEqual({ name: "project-continuity", factory: projectContinuity, builtin: true });
	});

	it("adds its section by default in a project with the structure", () => {
		const section = firstRequestSections(undefined).project_continuity;
		expect(section).toContain("project/handoff.md: where the work stands");
	}, 90_000);

	it("adds nothing when turned off, even in a project with the structure", () => {
		expect(firstRequestSections(["-builtin:project-continuity"]).project_continuity ?? undefined).toBeUndefined();
	}, 90_000);

	it("sends the same prompt on or off before /init", () => {
		const on = firstRequest(undefined, false).dump;
		const off = firstRequest(["-builtin:project-continuity"], false).dump;
		expect(on).not.toContain("project_continuity");
		expect(on).toBe(off);
	}, 120_000);

	it("adds nothing when on in a project without the structure", async () => {
		const prompt = await promptSent((cwd) => writeFileSync(join(cwd, "AGENTS.md"), "# rules\n"));
		expect(prompt).not.toContain("<project_continuity>");
	});

	it("lists only the continuity documents the project has", async () => {
		const prompt = await promptSent((cwd) => writeStructure(cwd, ["project/handoff.md", "project/roadmap.md"]));
		expect(prompt).toContain("<project_continuity>");
		expect(prompt).toContain("- project/roadmap.md: ordered tasks with a status");
		expect(prompt).toContain("- project/handoff.md: where the work stands");
		expect(prompt).not.toContain("- project/SPEC.md:");
		expect(prompt).not.toContain("- AGENTS.md:");
	});

	it("finds the structure at the git root from a subdirectory", () => {
		const root = mkdtempSync(join(tmpdir(), "prism-continuity-git-"));
		dirs.push(root);
		mkdirSync(join(root, ".git"));
		writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
		writeStructure(root, ["project/handoff.md"]);
		const sub = join(root, "src");
		mkdirSync(sub);
		expect(projectRoot(sub)).toBe(root);
		expect(continuitySection(projectRoot(sub))).toContain("project/handoff.md");
	});

	it("costs a bounded number of prompt tokens with every document present", () => {
		const root = mkdtempSync(join(tmpdir(), "prism-continuity-cost-"));
		dirs.push(root);
		writeStructure(
			root,
			CONTINUITY_FILES.map((file) => file.path),
		);
		const section = continuitySection(root);
		expect(section).toBeDefined();
		// Estimate at 4 characters per token; measured at 266 tokens on 2026-10-19.
		expect(Math.ceil((section?.length ?? 0) / 4)).toBeLessThan(400);
	});
});

describe("fork: /init", () => {
	async function start(ui: Partial<ExtensionUIContext>, setup: (cwd: string) => void = () => {}) {
		const harness = await createHarness({
			extensionFactories: [{ name: "project-continuity", factory: projectContinuity }],
		});
		harnesses.push(harness);
		setup(harness.tempDir);
		await harness.session.bindExtensions({ uiContext: createTestUiContext(ui) });
		return harness;
	}

	/** Records each request's system prompt; the first reply writes `firstWrite`, then answers, when given. */
	function record(harness: Harness, firstWrite?: string) {
		const prompts: string[] = [];
		const capture = () => {
			prompts.push(harness.session.systemPrompt);
		};
		harness.setResponses([
			() => {
				capture();
				return firstWrite
					? fauxAssistantMessage(fauxToolCall("write", { path: firstWrite, content: "# Handoff\n" }), {
							stopReason: "toolUse",
						})
					: fauxAssistantMessage("Which language should the CLI use?");
			},
			...(firstWrite
				? [
						() => {
							capture();
							return fauxAssistantMessage("Created the documents.");
						},
					]
				: []),
			() => {
				capture();
				return fauxAssistantMessage("ok");
			},
		]);
		return prompts;
	}

	/** What the conversation holds besides the model's replies: only what the user typed. */
	const sent = (harness: Harness) =>
		harness.session.messages.flatMap((message) =>
			message.role === "user" ? [getMessageText(message)] : message.role === "custom" ? [message.customType] : [],
		);

	/** Runs /init, then waits for the turn its request starts, which the command does not await. */
	async function init(harness: Harness, command: string) {
		// The model's first reply: by then the instruction, and the user's text after it, have started the turn.
		const replies = () => harness.session.messages.filter((message) => message.role === "assistant").length;
		const before = replies();
		await harness.session.prompt(command);
		await vi.waitFor(() => expect(replies()).toBeGreaterThan(before), { timeout: 5_000 });
		await harness.session.waitForIdle();
	}

	it("writes nothing and asks the model nothing when the user refuses", async () => {
		const notes: string[] = [];
		let summary = "";
		const harness = await start({
			confirm: async (_title, message) => {
				summary = message;
				return false;
			},
			notify: (message) => void notes.push(message),
		});
		const prompts = record(harness);
		await harness.session.prompt("/init Build a todo CLI");
		// The request /init sends is not awaited: leave it time to start if it was wrongly sent.
		await new Promise((done) => setTimeout(done, 200));
		await harness.session.waitForIdle();
		expect(summary).toContain("create  project/SPEC.md");
		expect(summary).toContain("Starting point: your plan");
		expect(notes).toContain("Nothing was written.");
		expect(prompts).toEqual([]);
		expect(sent(harness)).toEqual([]);
		expect(existsSync(join(harness.tempDir, "project"))).toBe(false);
	});

	it("does nothing without the interactive interface", async () => {
		const harness = await createHarness({
			extensionFactories: [{ name: "project-continuity", factory: projectContinuity }],
		});
		harnesses.push(harness);
		const prompts = record(harness);
		await harness.session.prompt("/init Build a todo CLI");
		await new Promise((done) => setTimeout(done, 200));
		await harness.session.waitForIdle();
		expect(prompts).toEqual([]);
		expect(sent(harness)).toEqual([]);
	});

	it("from a plan, gives the model its dedicated section until project/handoff.md exists", async () => {
		const harness = await start({ confirm: async () => true });
		const prompts = record(harness, join(harness.tempDir, "project", "handoff.md"));
		mkdirSync(join(harness.tempDir, "project"));
		await init(harness, "/init Build a todo CLI");
		// what the user typed is their message; Prism's instruction is in the system prompt of the
		// turn /init starts, for every request of it, and gone afterwards.
		expect(sent(harness)).toEqual(["/init Build a todo CLI"]);
		const instruction = `<${COMMAND_SECTION}>\nThe user ran /init: set up the project continuity documents from the plan in their message.\n</${COMMAND_SECTION}>`;
		expect(prompts[0]).toContain(instruction);
		expect(prompts[1]).toContain(instruction);
		expect(prompts[0]).toContain("<project_init>");
		expect(prompts[0]).toContain("Write project/handoff.md last");
		await harness.session.prompt("next");
		expect(prompts[2]).not.toContain(`<${COMMAND_SECTION}>`);
		expect(prompts[2]).not.toContain("<project_init>");
		expect(prompts[2]).toContain("<project_continuity>");
	});

	it("shows the init button until the model has written project/handoff.md", async () => {
		const statuses: Array<string | undefined> = [];
		const harness = await start({
			confirm: async () => true,
			setStatus: (key, text) => {
				if (key === INIT_STATUS) statuses.push(text);
			},
		});
		expect(statuses).toEqual(["init"]);
		record(harness, join(harness.tempDir, "project", "handoff.md"));
		mkdirSync(join(harness.tempDir, "project"));
		await init(harness, "/init Build a todo CLI");
		expect(statuses.at(-1)).toBeUndefined();
	});

	it("keeps the dedicated section while the model asks questions", async () => {
		const harness = await start({ confirm: async () => true });
		const prompts = record(harness);
		await init(harness, "/init Build a todo CLI");
		await harness.session.prompt("English");
		expect(prompts).toHaveLength(2);
		expect(prompts[1]).toContain("<project_init>");
		// The answer is the user's: Prism's instruction was for the turn /init started only.
		expect(prompts[0]).toContain(`<${COMMAND_SECTION}>`);
		expect(prompts[1]).not.toContain(`<${COMMAND_SECTION}>`);
		expect(sent(harness)).toEqual(["/init Build a todo CLI", "English"]);
	});

	it("finds plan files at the root, in docs and in plans, PLAN.md first", () => {
		const root = mkdtempSync(join(tmpdir(), "prism-init-plans-"));
		try {
			expect(findPlanFiles(root)).toEqual([]);
			mkdirSync(join(root, "docs"));
			mkdirSync(join(root, "plans"));
			mkdirSync(join(root, "plan-folder.md"));
			writeFileSync(join(root, "docs", "launch-plan.txt"), "x");
			writeFileSync(join(root, "docs", "guide.md"), "x");
			writeFileSync(join(root, "plans", "next.md"), "x");
			writeFileSync(join(root, "planet.png"), "x");
			writeFileSync(join(root, "PLAN.md"), "x");
			const found = findPlanFiles(root);
			expect(found[0]).toBe("PLAN.md");
			expect(found.slice().sort()).toEqual(["PLAN.md", "docs/launch-plan.txt", "plans/next.md"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("starts from a detected plan without asking for its path", async () => {
		let editorOpened = false;
		const harness = await start(
			{
				select: async (_title, choices) => choices[0],
				editor: async () => {
					editorOpened = true;
					return undefined;
				},
				confirm: async () => true,
			},
			(cwd) => writeFileSync(join(cwd, "PLAN.md"), "# Plan\n"),
		);
		const prompts = record(harness);
		await init(harness, "/init");
		expect(editorOpened).toBe(false);
		expect(prompts[0]).toContain(`from the plan in ${join(harness.tempDir, "PLAN.md")}`);
	});

	it("offers the existing repository first in a folder with code, and reuses what is there", async () => {
		let options: string[] = [];
		let summary = "";
		const harness = await start(
			{
				select: async (_title, choices) => {
					options = choices;
					return choices[0];
				},
				confirm: async (_title, message) => {
					summary = message;
					return true;
				},
			},
			(cwd) => {
				writeFileSync(join(cwd, "package.json"), "{}");
				writeFileSync(join(cwd, "AGENTS.md"), "# rules\n");
				writeFileSync(join(cwd, "README.md"), "# app\n");
			},
		);
		const prompts = record(harness);
		await init(harness, "/init");
		expect(options).toEqual(["From the existing repository", "From a plan"]);
		expect(summary).toContain("adapt  AGENTS.md");
		expect(summary).toContain("Already present, reused rather than copied: README.md");
		expect(sent(harness)).toEqual(["/init"]);
		expect(prompts[0]).toContain(
			"The user ran /init: set up the project continuity documents from the existing repository.",
		);
	});

	it("offers a plan first in an empty folder and reads a plan file by its path", async () => {
		let options: string[] = [];
		const harness = await start(
			{
				select: async (_title, choices) => {
					options = choices;
					return choices[0];
				},
				editor: async () => "plan.md",
				confirm: async () => true,
			},
			(cwd) => writeFileSync(join(cwd, "plan.md"), "# Plan\n"),
		);
		const prompts = record(harness);
		await init(harness, "/init");
		expect(options).toEqual(["From the plan plan.md", "From a plan", "From the existing repository"]);
		expect(sent(harness)).toEqual(["/init"]);
		expect(prompts[0]).toContain(
			`The user ran /init: set up the project continuity documents from the plan in ${join(harness.tempDir, "plan.md")}.`,
		);
	});

	// Code review 2026-10-20 (L10): `~` was not expanded, so the path was taken for the plan's text.
	it("reads a plan file given as a ~/ path", async () => {
		const savedHome = process.env.HOME;
		const harness = await start({ select: async (_title, choices) => choices[0], confirm: async () => true }, (cwd) =>
			writeFileSync(join(cwd, "plan.md"), "# Plan\n"),
		);
		process.env.HOME = harness.tempDir;
		let prompts: string[] = [];
		try {
			prompts = record(harness);
			await init(harness, "/init ~/plan.md");
		} finally {
			process.env.HOME = savedHome;
		}
		expect(sent(harness)).toEqual(["/init ~/plan.md"]);
		expect(prompts[0]).toContain(`from the plan in ${join(harness.tempDir, "plan.md")}.`);
	});
});

describe("fork: /handoff", () => {
	const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

	function git(cwd: string, ...args: string[]): string {
		const run = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
			cwd,
			env: gitEnv,
			encoding: "utf8",
		});
		expect(run.status, run.stderr).toBe(0);
		return run.stdout.trim();
	}

	/** A repository with the continuity structure, everything committed, the harness's own files ignored. */
	function repo(cwd: string): string {
		git(cwd, "init", "-q", "-b", "main");
		writeFileSync(join(cwd, ".gitignore"), "*\n!.gitignore\n!AGENTS.md\n!app.ts\n!new.ts\n!project/\n!project/*\n");
		writeStructure(cwd, ["AGENTS.md", "project/handoff.md"]);
		writeFileSync(join(cwd, "app.ts"), "export {};\n");
		git(cwd, "add", ".");
		git(cwd, "commit", "-q", "-m", "first");
		return git(cwd, "rev-parse", "HEAD");
	}

	const handoff = (cwd: string) => join(cwd, "project", "handoff.md");
	const stamp = (cwd: string, commit: string) =>
		writeFileSync(handoff(cwd), `<!-- prism-handoff: commit=${commit} -->\n# Handoff\n`);
	const age = (path: string, seconds: number) => utimesSync(path, seconds, seconds);

	async function start(setup: (cwd: string) => void, notes: string[] = []) {
		const harness = await createHarness({
			extensionFactories: [{ name: "project-continuity", factory: projectContinuity }],
		});
		harnesses.push(harness);
		setup(harness.tempDir);
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({ notify: (message) => void notes.push(message) }),
		});
		return harness;
	}

	/** What the conversation holds besides the model's replies: only what the user typed. */
	const sent = (harness: Harness) =>
		harness.session.messages.flatMap((message) =>
			message.role === "user" ? [getMessageText(message)] : message.role === "custom" ? [message.customType] : [],
		);

	/** Answers `count` requests with "ok", recording the system prompt of each and the messages the provider got. */
	function answer(harness: Harness, count: number): string[] & { requests: TranscriptContext["messages"][] } {
		const prompts = Object.assign([] as string[], { requests: [] as TranscriptContext["messages"][] });
		harness.setResponses(
			Array.from({ length: count }, () => (context: TranscriptContext) => {
				prompts.push(harness.session.systemPrompt);
				prompts.requests.push(structuredClone(context.messages));
				return fauxAssistantMessage("ok");
			}),
		);
		return prompts;
	}

	/** Prism's instruction in a system prompt, without its tags; undefined when there is none. */
	const instructionIn = (prompt: string) =>
		prompt.match(new RegExp(`<${COMMAND_SECTION}>\\n([\\s\\S]*?)\\n</${COMMAND_SECTION}>`))?.[1];

	async function command(harness: Harness, text: string) {
		// The model's first reply: by then the instruction, and the user's text after it, have started the turn.
		const replies = () => harness.session.messages.filter((message) => message.role === "assistant").length;
		const before = replies();
		await harness.session.prompt(text);
		await vi.waitFor(() => expect(replies()).toBeGreaterThan(before), { timeout: 5_000 });
		await harness.session.waitForIdle();
	}

	it("gives the model the Git state Prism measured", async () => {
		let head = "";
		const harness = await start((cwd) => {
			head = repo(cwd);
			writeFileSync(join(cwd, "app.ts"), "export const changed = 1;\n");
			writeFileSync(join(cwd, "new.ts"), "export {};\n");
		});
		const prompts = answer(harness, 2);
		await command(harness, "/handoff the export test is flaky");
		// the measured facts are Prism's instruction, in the system prompt of this turn only; the note
		// is the user's, in their message as they typed it.
		const request = instructionIn(prompts[0]!);
		expect(request).toMatch(/^The user ran \/handoff: update project\/handoff.md/);
		expect(request).toContain("- Branch: main");
		expect(request).toContain(`- Commit: ${head.slice(0, 12)} first`);
		expect(request).toContain("- Uncommitted changes (2): app.ts, new.ts");
		expect(request).toContain("- Background tasks still running: none");
		expect(request).toContain("The text after /handoff in the user's message is a note for this handoff.");
		expect(sent(harness)).toEqual(["/handoff the export test is flaky"]);
		// What the provider got: the user's words alone as a user message, the instruction as a system section.
		const [first] = prompts.requests;
		expect(first!.filter((message) => message.role === "user").map(getMessageText)).toEqual([
			"/handoff the export test is flaky",
		]);
		expect(first!.some((message) => message.role === "system" && message.sections?.[COMMAND_SECTION])).toBe(true);
		await harness.session.prompt("thanks");
		expect(instructionIn(prompts[1]!)).toBeUndefined();
		expect(prompts[1]).toContain("<project_continuity>");
		// The next request takes the section back out, at the end, so the cached start of the conversation stays.
		expect(prompts.requests[1]!.filter((message) => message.role === "system").at(-1)?.sections).toEqual({
			[COMMAND_SECTION]: null,
		});
	});

	it("says when the project is not a git repository", async () => {
		const harness = await start((cwd) => writeStructure(cwd, ["project/handoff.md"]));
		const prompts = answer(harness, 1);
		await command(harness, "/handoff");
		expect(sent(harness)).toEqual(["/handoff"]);
		expect(instructionIn(prompts[0]!)).toContain("- Not a git repository.");
		expect(instructionIn(prompts[0]!)).not.toContain("- Branch:");
		expect(instructionIn(prompts[0]!)).not.toContain("note for this handoff");
	});

	it("sends nothing in a project without the structure", async () => {
		const notes: string[] = [];
		const harness = await start(() => {}, notes);
		await harness.session.prompt("/handoff");
		await new Promise((done) => setTimeout(done, 200));
		await harness.session.waitForIdle();
		expect(sent(harness)).toEqual([]);
		expect(notes).toContain("This project has no project/handoff.md: /init sets up the continuity documents.");
	});

	it("stamps the handoff with HEAD once the model has written it, not before", async () => {
		let head = "";
		const harness = await start((cwd) => {
			head = repo(cwd);
		});
		harness.setResponses([
			() => fauxAssistantMessage("What is the next action?"),
			() =>
				fauxAssistantMessage(
					fauxToolCall("write", { path: handoff(harness.tempDir), content: "# Handoff\n\nNext: ship.\n" }),
					{ stopReason: "toolUse" },
				),
			() => fauxAssistantMessage("Updated."),
		]);
		await command(harness, "/handoff");
		expect(readFileSync(handoff(harness.tempDir), "utf8")).toBe("# project/handoff.md\n");
		await harness.session.prompt("Ship the release.");
		expect(readFileSync(handoff(harness.tempDir), "utf8")).toBe(
			`<!-- prism-handoff: commit=${head} -->\n# Handoff\n\nNext: ship.\n`,
		);
	});

	it("does not stamp a file the handoff was made a link to before the turn ended", async () => {
		const outside = mkdtempSync(join(tmpdir(), "prism-continuity-host-"));
		dirs.push(outside);
		const target = join(outside, "settings.json");
		writeFileSync(target, "{}\n");
		const harness = await start((cwd) => {
			repo(cwd);
		});
		harness.setResponses([
			() => {
				rmSync(handoff(harness.tempDir));
				symlinkSync(target, handoff(harness.tempDir));
				return fauxAssistantMessage("Updated.");
			},
		]);
		await command(harness, "/handoff");
		expect(readFileSync(target, "utf8")).toBe("{}\n");
	});

	it("reports nothing at startup when the handoff matches the repository", async () => {
		const notes: string[] = [];
		const harness = await start((cwd) => {
			stamp(cwd, repo(cwd));
			git(cwd, "commit", "-q", "-am", "handoff");
			writeFileSync(join(cwd, "app.ts"), "export const before = 1;\n");
			age(join(cwd, "app.ts"), 1_000);
			age(handoff(cwd), 2_000);
		}, notes);
		expect(notes).toEqual([]);
		const prompt = await promptOf(harness);
		expect(prompt).toContain("<project_continuity>");
		expect(prompt).not.toContain("may be out of date");
	});

	it("reports a handoff whose commit is no longer HEAD", async () => {
		const notes: string[] = [];
		let described = "";
		let head = "";
		const harness = await start((cwd) => {
			stamp(cwd, repo(cwd));
			git(cwd, "commit", "-q", "-am", "handoff");
			described = git(cwd, "rev-parse", "HEAD");
			writeFileSync(join(cwd, "app.ts"), "export const later = 1;\n");
			git(cwd, "commit", "-q", "-am", "later work");
			head = git(cwd, "rev-parse", "HEAD");
		}, notes);
		expect(notes).toEqual([
			`project/handoff.md may be out of date: it describes commit ${described.slice(0, 12)}, HEAD is now ${head.slice(0, 12)}. /handoff updates it.`,
		]);
		expect(await promptOf(harness)).toContain(
			`project/handoff.md may be out of date: it describes commit ${described.slice(0, 12)} and HEAD is now ${head.slice(0, 12)}.`,
		);
	});

	it("reports uncommitted changes made after the handoff", async () => {
		const notes: string[] = [];
		await start((cwd) => {
			stamp(cwd, repo(cwd));
			git(cwd, "commit", "-q", "-am", "handoff");
			age(handoff(cwd), 1_000);
			writeFileSync(join(cwd, "app.ts"), "export const after = 1;\n");
			age(join(cwd, "app.ts"), 2_000);
		}, notes);
		expect(notes).toEqual([
			"project/handoff.md may be out of date: 1 uncommitted files changed after it (app.ts). /handoff updates it.",
		]);
	});

	async function promptOf(harness: Harness): Promise<string> {
		let systemPrompt = "";
		harness.setResponses([
			() => {
				systemPrompt = harness.session.systemPrompt;
				return fauxAssistantMessage("ok");
			},
		]);
		await harness.session.prompt("hi");
		return systemPrompt;
	}
});

describe("fork: handoff reminder", () => {
	const savedAgentDir = process.env[ENV_AGENT_DIR];

	afterEach(() => {
		if (savedAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = savedAgentDir;
	});

	/** A project with project/handoff.md, its reminder setting in a throwaway agent dir. */
	async function start(handoffReminder?: unknown, structure = true) {
		const agentDir = mkdtempSync(join(tmpdir(), "prism-reminder-"));
		dirs.push(agentDir);
		if (handoffReminder !== undefined)
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ handoffReminder }));
		process.env[ENV_AGENT_DIR] = agentDir;
		const harness = await createHarness({
			extensionFactories: [{ name: "project-continuity", factory: projectContinuity }],
		});
		harnesses.push(harness);
		if (structure) writeStructure(harness.tempDir, ["project/handoff.md"]);
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });
		return { harness, agentDir };
	}

	/** One run in which the model reads a file `calls` times, one call per response, then answers. */
	async function run(harness: Harness, calls: number) {
		harness.setResponses([
			...Array.from({ length: calls }, () =>
				fauxAssistantMessage(fauxToolCall("read", { path: "project/handoff.md" }), { stopReason: "toolUse" }),
			),
			fauxAssistantMessage("finished"),
		]);
		await harness.session.prompt("go");
	}

	const results = (harness: Harness) =>
		harness.session.messages
			.filter((message) => message.role === "toolResult")
			.map((message) => getMessageText(message));
	const reminded = (harness: Harness) =>
		results(harness).flatMap((text, index) => (text.includes("Reminder from Prism") ? [index] : []));

	it("is off by default", async () => {
		const { harness } = await start();
		await run(harness, 5);
		expect(readHandoffReminder()).toEqual({ enabled: false, interval: REMINDER_INTERVAL });
		expect(REMINDER_INTERVAL).toBe(100);
		expect(reminded(harness)).toEqual([]);
	});

	it("reminds once a run, in the result of the call that reaches the interval, without stopping the model", async () => {
		const { harness } = await start({ enabled: true, interval: 3 });
		await run(harness, 7);
		expect(reminded(harness)).toEqual([2]);
		expect(results(harness)[2]).toContain(handoffReminderText(3));
		expect(handoffReminderText(3)).toContain("in your final answer, offer the user to update the handoff");
		// The model went on to its final answer.
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(getMessageText(harness.session.messages.at(-1))).toBe("finished");
		// The next run counts from the reminder.
		await run(harness, 2);
		expect(reminded(harness)).toEqual([2]);
		await run(harness, 1);
		expect(reminded(harness)).toEqual([2, 9]);
	});

	it("reminds nothing in a project without project/handoff.md", async () => {
		const { harness } = await start({ enabled: true, interval: 2 }, false);
		writeFileSync(join(harness.tempDir, "notes.md"), "# notes\n");
		harness.setResponses([
			...Array.from({ length: 3 }, () =>
				fauxAssistantMessage(fauxToolCall("read", { path: "notes.md" }), { stopReason: "toolUse" }),
			),
			fauxAssistantMessage("finished"),
		]);
		await harness.session.prompt("go");
		expect(reminded(harness)).toEqual([]);
	});

	it("is set in /settings > Conversation, saved to settings.json", async () => {
		const { agentDir } = await start();
		const section = settingsSections().find((entry) =>
			entry.items({ advanced: () => true, requestRender() {} }).some((item) => item.id === "handoff-reminder"),
		)!;
		expect(section.domain).toBe("conversation");
		const items = section.items({ advanced: () => true, requestRender() {} });
		expect(items.map((item) => [item.id, item.currentValue, item.values])).toEqual([
			["handoff-reminder", "off", ["on", "off"]],
			["handoff-reminder-interval", "100", ["50", "100", "200", "500"]],
		]);
		section.onChange!("handoff-reminder", "on");
		section.onChange!("handoff-reminder-interval", "200");
		expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))).toEqual({
			handoffReminder: { enabled: true, interval: 200 },
		});
	});
});
