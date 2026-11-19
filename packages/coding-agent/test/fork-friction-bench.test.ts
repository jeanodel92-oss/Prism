// fork: fixed tool calls measure the harness, never a model or a provider's credentials.
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { release, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { AgentSession } from "../src/core/agent-session.ts";
import { emitSessionShutdownEvent } from "../src/core/extensions/runner.ts";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { setLanguage } from "../src/fork/i18n/index.ts";
import permissionsExtension from "../src/fork/permissions.ts";
import { addProjectHost, addProjectRule, readProjectGrants } from "../src/fork/project-permissions.ts";
import { removeSessionTmpDir, sessionSandbox } from "../src/fork/sandbox/runtime.ts";
import type { ScopeApproval, ScopeView } from "../src/fork/task-scope.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, createTestUiContext, getMessageText, type Harness } from "./suite/harness.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

const scenarios = ["ordinary", "submodules", "approved-port", "new-port", "blocked-note", "away", "overhead"] as const;
type Scenario = (typeof scenarios)[number];
type Mode = "ask" | "broad";
type Call = { tool: string; input: Parameters<typeof fauxToolCall>[1] };
type Question = { title: string; options: string[]; answer: string | null };
type Step = {
	tool: string;
	input: Call["input"];
	wallMs: number | null;
	exitCode: number | null;
	isError: boolean;
	output: string;
	notes: string[];
};
interface Measurement {
	questions: Question[];
	questionCount: number;
	notes: string[];
	noteCount: number;
	steps: Step[];
	wallMs: number;
	timedOut: boolean;
	error: string | null;
}
interface RecordLine extends Measurement {
	scenario: Scenario;
	mode: Mode;
	pass: number;
	project: string;
	status: "mesuré" | "non mesuré";
	reason: string | null;
	targetHolds: boolean | null;
	notices: string[];
	grants: ReturnType<typeof readProjectGrants>;
	control?: Measurement;
	overhead?: { sandboxMs: number; plainMs: number; extraMs: number; ratio: number };
	diagnostic?: Measurement;
}

const STEP_MS = 5_000;
const TASK_MS = 20_000;
const exec = promisify(execFile);
const emptyMeasurement = (): Measurement => ({
	questions: [],
	questionCount: 0,
	notes: [],
	noteCount: 0,
	steps: [],
	wallMs: 0,
	timedOut: false,
	error: null,
});
const bash = (command: string): Call => ({ tool: "bash", input: { command, timeout: 3 } });

async function git(cwd: string, ...args: string[]): Promise<void> {
	await exec("git", ["-C", cwd, ...args], { timeout: STEP_MS });
}

async function projectFixture(project: string, submodules: boolean): Promise<void> {
	mkdirSync(project);
	await git(project, "init", "-q");
	writeFileSync(join(project, "value.txt"), "0\n");
	writeFileSync(
		join(project, "check.test.mjs"),
		[
			'import { readFileSync } from "node:fs";',
			'import assert from "node:assert/strict";',
			'import { test } from "node:test";',
			'test("project value", () => assert.match(readFileSync("value.txt", "utf8"), /^[0-2]\\n$/));',
		].join("\n"),
	);
	await git(project, "add", "value.txt", "check.test.mjs");
	await git(project, "commit", "-qm", "fixture");
	if (!submodules) return;
	// Sources live under the project: the sandbox's private /tmp must not hide the file:// fixtures.
	const lib = join(project, "fixtures", "lib");
	const parent = join(project, "fixtures", "parent");
	mkdirSync(lib, { recursive: true });
	mkdirSync(parent);
	await git(lib, "init", "-q");
	writeFileSync(join(lib, "lib.txt"), "initial\n");
	await git(lib, "add", "lib.txt");
	await git(lib, "commit", "-qm", "library");
	await git(parent, "init", "-q");
	await git(parent, "submodule", "add", "-q", pathToFileURL(lib).href, "lib");
	await git(parent, "commit", "-qam", "parent");
}

async function localServer(): Promise<{ server: Server; host: string; requests: string[] }> {
	const requests: string[] = [];
	const server = createServer((request, response) => {
		requests.push(request.url ?? "");
		response.end("friction-local-ok\n");
	});
	await new Promise<void>((done, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", done);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No local HTTP port");
	return { server, host: `localhost:${address.port}`, requests };
}

// Small UI helpers copied from fork-sandbox.test.ts (not exported there), not imports from a test suite.
const approveAway = (async (factory: (...args: unknown[]) => ScopeView) => {
	let result: ScopeApproval | undefined;
	const view = factory(
		{ terminal: { rows: 40, columns: 100 }, requestRender: () => {} },
		undefined,
		undefined,
		(value: ScopeApproval | undefined) => {
			result = value;
		},
	);
	for (const key of ["\x1b[B", "\x1b[B", "\r", "\x1b[B", "\r"]) view.handleInput(key);
	return result;
}) as unknown as ExtensionUIContext["custom"];

async function start(seed: Harness, project: string, agentDir: string, scenario: Scenario) {
	// createHarness has no cwd option. Reuse its faux runtime with fresh project-bound sessions and gates.
	const extensionsResult = await createTestExtensionsResult(
		[{ name: "permissions", factory: permissionsExtension }],
		project,
	);
	const { session } = await createAgentSession({
		cwd: project,
		agentDir,
		model: seed.getModel(),
		modelRuntime: seed.session.modelRuntime,
		settingsManager: seed.settingsManager,
		sessionManager: SessionManager.inMemory(project),
		resourceLoader: createTestResourceLoader({ extensionsResult }),
	});
	const questions: Question[] = [];
	const notices: string[] = [];
	try {
		await session.bindExtensions({
			uiContext: createTestUiContext({
				notify: (message) => notices.push(message),
				custom: scenario === "away" ? approveAway : undefined,
				select: async (title, options) => {
					const answer =
						scenario === "away"
							? undefined
							: scenario === "new-port"
								? options.find((option) => option.startsWith("Allow") && option.endsWith("for this command"))
								: (options.find((option) => option.startsWith("Allow") && option.endsWith("in this project")) ??
									options.find((option) => option.startsWith("Allow")));
					questions.push({ title, options, answer: answer ?? null });
					return answer;
				},
			}),
		});
		return { session, questions, notices };
	} catch (error) {
		await closeSession(session);
		throw error;
	}
}

async function closeSession(session: AgentSession): Promise<void> {
	try {
		await emitSessionShutdownEvent(session.extensionRunner, { type: "session_shutdown", reason: "quit" });
	} finally {
		removeSessionTmpDir(session.sessionManager.getSessionId());
		session.dispose();
	}
}

async function replay(
	seed: Harness,
	session: AgentSession,
	questions: Question[],
	calls: Call[],
): Promise<Measurement> {
	const measurement = emptyMeasurement();
	const questionStart = questions.length;
	const messageStart = session.messages.length;
	const started = performance.now();
	const timings = new Map<string, { start: number; elapsed?: number }>();
	const exitCodes = new Map<string, number>();
	let stepTimer: NodeJS.Timeout | undefined;
	let taskTimer: NodeJS.Timeout | undefined;
	let unsubscribe = () => {};
	const deadline = new Promise<never>((_done, reject) => {
		const expire = () => {
			measurement.timedOut = true;
			session.agent.abort();
			reject(new Error(`Bench deadline: ${STEP_MS} ms per step, ${TASK_MS} ms per task`));
		};
		taskTimer = setTimeout(expire, TASK_MS);
		unsubscribe = session.subscribe((event) => {
			if (event.type === "tool_execution_start") {
				timings.set(event.toolCallId, { start: performance.now() });
				stepTimer = setTimeout(expire, STEP_MS);
			} else if (event.type === "tool_execution_end") {
				clearTimeout(stepTimer);
				const timing = timings.get(event.toolCallId);
				if (timing) timing.elapsed = performance.now() - timing.start;
				// Structured output is on execution events, not on the model-facing transcript message.
				const result: unknown = event.result;
				if (result && typeof result === "object" && "structuredContent" in result) {
					const structured = result.structuredContent;
					if (
						structured &&
						typeof structured === "object" &&
						"exit_code" in structured &&
						typeof structured.exit_code === "number"
					) {
						exitCodes.set(event.toolCallId, structured.exit_code);
					}
				}
			}
		});
	});
	seed.setResponses([
		...calls.map((call) => fauxAssistantMessage(fauxToolCall(call.tool, call.input), { stopReason: "toolUse" })),
		fauxAssistantMessage("done"),
	]);
	try {
		await Promise.race([session.prompt("Execute the fixed bench script."), deadline]);
	} catch (error) {
		measurement.error = error instanceof Error ? error.message : String(error);
	} finally {
		clearTimeout(stepTimer);
		clearTimeout(taskTimer);
		unsubscribe();
	}
	const results = session.messages
		.slice(messageStart)
		.filter((message): message is ToolResultMessage => message.role === "toolResult");
	measurement.steps = results.map((result, index) => {
		const output = getMessageText(result);
		return {
			tool: result.toolName,
			input: calls[index]?.input ?? {},
			wallMs: timings.get(result.toolCallId)?.elapsed ?? null,
			exitCode: exitCodes.get(result.toolCallId) ?? null,
			isError: result.isError,
			output,
			notes: output
				.split("\n")
				.filter((line) => line.startsWith("[Prism ") || /do not retry|do not work around/i.test(line)),
		};
	});
	measurement.questions = questions.slice(questionStart);
	measurement.questionCount = measurement.questions.length;
	measurement.notes = measurement.steps.flatMap((step) => step.notes);
	measurement.noteCount = measurement.notes.length;
	measurement.wallMs = performance.now() - started;
	if (results.length !== calls.length && !measurement.error)
		measurement.error = `Expected ${calls.length} results, got ${results.length}`;
	return measurement;
}

function script(scenario: Scenario, project: string, outside: string, pass: number, host: string): Call[] {
	switch (scenario) {
		case "ordinary":
			return [
				{ tool: "read", input: { path: "value.txt" } },
				{ tool: "edit", input: { path: "value.txt", oldText: `${pass - 1}\n`, newText: `${pass}\n` } },
				bash("node --test check.test.mjs"),
				bash("git status --short"),
				bash("git diff -- value.txt"),
				bash("git add value.txt"),
				bash(`git commit -m bench-${pass}`),
			];
		case "submodules":
			return [
				bash(
					`git clone --recurse-submodules '${pathToFileURL(join(project, "fixtures", "parent")).href.replaceAll("'", "'\\''")}' work-${pass}`,
				),
				bash(`git -C work-${pass} submodule update --init`),
				{
					tool: "edit",
					input: { path: `work-${pass}/lib/lib.txt`, oldText: "initial\n", newText: `pass-${pass}\n` },
				},
				bash(`git -C work-${pass}/lib add lib.txt`),
				bash(`git -C work-${pass}/lib commit -m bench-${pass}`),
			];
		case "approved-port":
		case "new-port":
			return [bash(`curl --fail --silent --show-error --max-time 3 --noproxy '' http://${host}/pass-${pass}`)];
		case "blocked-note":
			return [bash("unshare -Ur true")];
		case "away":
			return [
				{
					tool: "propose_scope",
					input: {
						operations: [
							{ what: "Write notes and run project tests", commands: ["node --test"], writes: ["notes/**"] },
						],
						minutes: 5,
					},
				},
				{ tool: "write", input: { path: `notes/before-${pass}.txt`, content: "authorized\n" } },
				bash("node --test check.test.mjs"),
				{ tool: "write", input: { path: join(outside, `refused-${pass}.txt`), content: "not authorized\n" } },
				bash(`curl --fail --silent --show-error --max-time 3 --noproxy '' http://${host}/away-${pass}`),
				{ tool: "write", input: { path: `notes/after-${pass}.txt`, content: "continued\n" } },
				bash("node --test check.test.mjs"),
			];
		case "overhead":
			return [
				bash("cat value.txt"),
				bash("git status --short"),
				bash("git diff --exit-code"),
				bash("node --test check.test.mjs"),
			];
	}
}

function target(record: RecordLine, expectedSteps: number, outside: string, host: string, requests: string[]): boolean {
	const complete = record.steps.length === expectedSteps && !record.error && !record.timedOut;
	const success =
		complete && record.steps.every((step) => !step.isError && (step.tool !== "bash" || step.exitCode === 0));
	switch (record.scenario) {
		case "ordinary":
			return (
				success &&
				(record.pass === 1 || record.questionCount === 0) &&
				readFileSync(join(record.project, "value.txt"), "utf8") === `${record.pass}\n`
			);
		case "submodules":
			return (
				success &&
				readFileSync(join(record.project, `work-${record.pass}/lib/lib.txt`), "utf8") === `pass-${record.pass}\n`
			);
		case "approved-port":
			return (
				success &&
				record.questionCount === 0 &&
				requests.includes(`/pass-${record.pass}`) &&
				record.steps[0]?.output.includes("friction-local-ok") === true
			);
		case "new-port":
			return (
				success &&
				record.questionCount === 1 &&
				record.questions[0]!.title.includes(host) &&
				requests.includes(`/pass-${record.pass}`) &&
				record.steps[0]?.output.includes("friction-local-ok") === true
			);
		case "blocked-note":
			return (
				complete &&
				record.steps[0]?.isError === true &&
				record.steps[0]?.exitCode !== 0 &&
				record.notes.some((note) => note.startsWith("[Prism sandbox:") && note.includes("This is intended"))
			);
		case "away":
			return (
				complete &&
				record.questionCount === 0 &&
				[0, 1, 2, 5, 6].every((index) => record.steps[index]?.isError === false) &&
				[3, 4].every((index) => record.steps[index]?.isError === true) &&
				record.steps[0]?.output.includes("The user is away") === true &&
				existsSync(join(record.project, `notes/after-${record.pass}.txt`)) &&
				!existsSync(join(outside, `refused-${record.pass}.txt`)) &&
				!requests.includes(`/away-${record.pass}`)
			);
		case "overhead":
			return success && record.overhead !== undefined;
	}
}

describe.skipIf(!process.env.PRISM_FRICTION_BENCH)("fork: deterministic friction bench", () => {
	it("writes measurements and unmet targets without asserting product behavior", async () => {
		const outputDir = resolve(process.env.PRISM_FRICTION_BENCH!);
		mkdirSync(outputDir, { recursive: true });
		const resultsPath = join(outputDir, "results.jsonl");
		const summaryPath = join(outputDir, "summary.md");
		writeFileSync(resultsPath, "");
		const records: RecordLine[] = [];
		const savedEnv = { ...process.env };
		const root = mkdtempSync(join(tmpdir(), "prism-friction-"));
		try {
			for (const name of Object.keys(process.env)) delete process.env[name];
			Object.assign(process.env, {
				PATH: savedEnv.PATH,
				LANG: "C.UTF-8",
				HOME: join(root, "home"),
				XDG_CONFIG_HOME: join(root, "home", ".config"),
				GIT_CONFIG_GLOBAL: join(root, "home", ".gitconfig"),
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_TERMINAL_PROMPT: "0",
				GIT_AUTHOR_NAME: "Friction Bench",
				GIT_AUTHOR_EMAIL: "friction@example.invalid",
				GIT_COMMITTER_NAME: "Friction Bench",
				GIT_COMMITTER_EMAIL: "friction@example.invalid",
				PI_OFFLINE: "1",
				PRISM_SANDBOX_RELAY_SNAPSHOT: savedEnv.PRISM_SANDBOX_RELAY_SNAPSHOT ?? "1",
			});
			mkdirSync(process.env.HOME!, { recursive: true });
			writeFileSync(
				process.env.GIT_CONFIG_GLOBAL!,
				'[protocol "file"]\n\tallow = always\n[init]\n\tdefaultBranch = main\n',
			);
			setLanguage("en");
			initTheme("dark");
			for (const mode of ["ask", "broad"] as const) {
				for (const scenario of scenarios) {
					const fixture = mkdtempSync(join(root, `${mode}-${scenario}-`));
					const project = join(fixture, "project");
					const outside = join(fixture, "outside");
					const agentDir = join(fixture, "agent");
					mkdirSync(outside);
					mkdirSync(agentDir);
					process.env[ENV_AGENT_DIR] = agentDir;
					writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode }));
					const servers: Awaited<ReturnType<typeof localServer>>[] = [];
					let seed: Harness | undefined;
					let setupError: string | null = null;
					try {
						await projectFixture(project, scenario === "submodules");
						if (["approved-port", "new-port", "away"].includes(scenario)) {
							await exec("curl", ["--version"], { timeout: STEP_MS });
							servers.push(await localServer());
							servers.push(await localServer());
						}
						if (scenario === "approved-port" || scenario === "new-port") {
							await addProjectRule(project, "bash(curl*)");
							await addProjectHost(project, { host: servers[0]!.host, rule: "bash(curl*)" });
						}
						if (scenario === "blocked-note") await addProjectRule(project, "bash(unshare*)");
						if (scenario === "overhead") {
							for (const command of ["cat", "git status", "git diff", "node --test"])
								await addProjectRule(project, `bash(${command}*)`);
						}
						seed = await createHarness({
							settings: { compaction: { enabled: false }, retry: { enabled: false } },
						});
					} catch (error) {
						setupError = error instanceof Error ? error.message : String(error);
					}
					try {
						for (const pass of [1, 2]) {
							const record: RecordLine = {
								...emptyMeasurement(),
								scenario,
								mode,
								pass,
								project,
								status: "non mesuré",
								reason: setupError,
								targetHolds: null,
								notices: [],
								grants: readProjectGrants(project),
							};
							const endpoint = servers[scenario === "approved-port" ? 0 : 1];
							const host = endpoint?.host ?? "";
							if (seed && !setupError) {
								let session: AgentSession | undefined;
								try {
									const run = await start(seed, project, agentDir, scenario);
									session = run.session;
									record.notices = run.notices;
									const sandbox = sessionSandbox(session.sessionManager);
									if (!sandbox || "error" in sandbox) {
										record.reason =
											sandbox && "error" in sandbox ? sandbox.error : "Sandbox unexpectedly inactive";
										record.diagnostic = await replay(seed, session, run.questions, [
											bash("printf bench > sandbox-probe.txt"),
										]);
									} else {
										const calls = script(scenario, project, outside, pass, host);
										Object.assign(record, await replay(seed, session, run.questions, calls));
										record.status = "mesuré";
									}
								} catch (error) {
									record.reason = error instanceof Error ? error.message : String(error);
								} finally {
									if (session) await closeSession(session);
								}
								if (scenario === "overhead") {
									// The sole settings change is the explicitly requested unsandboxed timing control.
									writeFileSync(
										join(agentDir, "settings.json"),
										JSON.stringify({ sandbox: { modes: { [mode]: false } } }),
									);
									try {
										const control = await start(seed, project, agentDir, scenario);
										try {
											record.control = await replay(
												seed,
												control.session,
												control.questions,
												script(scenario, project, outside, pass, host),
											);
										} finally {
											await closeSession(control.session);
										}
									} catch (error) {
										record.control = {
											...emptyMeasurement(),
											error: error instanceof Error ? error.message : String(error),
										};
									} finally {
										rmSync(join(agentDir, "settings.json"), { force: true });
									}
									if (
										record.status === "mesuré" &&
										!record.error &&
										!record.timedOut &&
										record.steps.length === 4 &&
										record.steps.every((step) => !step.isError && step.exitCode === 0) &&
										record.control &&
										!record.control.error &&
										!record.control.timedOut &&
										record.control.steps.length === 4 &&
										record.control.steps.every((step) => !step.isError && step.exitCode === 0)
									) {
										record.overhead = {
											sandboxMs: record.wallMs,
											plainMs: record.control.wallMs,
											extraMs: record.wallMs - record.control.wallMs,
											ratio: record.wallMs / record.control.wallMs,
										};
									}
								}
								if (record.status === "mesuré")
									record.targetHolds = target(
										record,
										script(scenario, project, outside, pass, host).length,
										outside,
										host,
										endpoint?.requests ?? [],
									);
							}
							record.grants = readProjectGrants(project);
							records.push(record);
							appendFileSync(resultsPath, `${JSON.stringify(record)}\n`);
						}
					} finally {
						seed?.cleanup();
						for (const { server } of servers) {
							server.closeAllConnections();
							await new Promise<void>((done) => server.close(() => done()));
						}
					}
				}
			}
		} finally {
			for (const name of Object.keys(process.env)) delete process.env[name];
			Object.assign(process.env, savedEnv);
			rmSync(root, { recursive: true, force: true });
			writeFileSync(
				summaryPath,
				[
					"# Banc de friction déterministe",
					"",
					`Linux : ${release()} ; Node : ${process.version}. Fournisseur factice uniquement.`,
					"",
					"Les cibles échouées sont consignées, jamais des assertions. Durées : tâche scriptée, sans démarrage de session ni réponse humaine.",
					"",
					"| Scénario | Mode | Passe | État | Questions | Notes | Durée ms | Cible | Surcoût ms |",
					"|---|---|---:|---|---:|---:|---:|---|---:|",
					...records.map(
						(record) =>
							`| ${record.scenario} | ${record.mode} | ${record.pass} | ${record.status} | ${record.status === "mesuré" ? record.questionCount : "—"} | ${record.status === "mesuré" ? record.noteCount : "—"} | ${record.status === "mesuré" ? record.wallMs.toFixed(1) : "—"} | ${record.targetHolds === null ? "non mesuré" : record.targetHolds ? "oui" : "non"} | ${record.overhead?.extraMs.toFixed(1) ?? "—"} |`,
					),
					"",
					"## Raisons des mesures impossibles",
					"",
					...[...new Set(records.filter((record) => record.reason).map((record) => record.reason))].map(
						(reason) => `- ${reason?.replaceAll("\n", " ")}`,
					),
					"",
					"Les contrôles sans sandbox et les diagnostics de sandbox indisponible restent séparés dans results.jsonl.",
					"",
				].join("\n"),
			);
		}
		// Only bench integrity is asserted; product targets, including known Git gaps, never fail this test.
		expect(records).toHaveLength(scenarios.length * 2 * 2);
		expect(
			readFileSync(resultsPath, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line)),
		).toHaveLength(records.length);
		expect(readFileSync(summaryPath, "utf8")).toContain("| Scénario | Mode | Passe |");
	}, 480_000);
});
