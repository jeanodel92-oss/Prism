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
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "../src/core/extensions/types.ts";
import agentsExtension, {
	agentName,
	buildAgentInvocation,
	type CustomAgent,
	invocationRule,
	isValidAgentName,
	mentionsKeyword,
	readAgentInvocation,
	readAgents,
	writeAgent,
} from "../src/fork/agents.ts";
import { getExtensionArgs, setCliExtensions } from "../src/fork/child-invocation.ts";
import { parseFrontmatter } from "../src/utils/frontmatter.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(testDir, "..");
const repoRoot = resolve(packageDir, "../..");
const resolverUrl = pathToFileURL(join(packageDir, "src/experimental/source-resolver.ts")).href;
const cliUrl = pathToFileURL(join(packageDir, "src/cli.ts")).href;
const fakeProvider = resolve(repoRoot, "fork/tools/fake-provider.ts");
/**
 * with an interface (RPC), an agent answers in a message after the turn
 * that started it; the session is done once the turn that message starts has settled.
 */
function settledAfterAnswer(
	expectAnswer = true,
): (record: { type?: string; message?: { customType?: string } }) => boolean {
	let answered = !expectAnswer;
	return (record) => {
		if (record.type === "message_end" && record.message?.customType === "agent-answer") answered = true;
		return record.type === "agent_settled" && answered;
	};
}
const tempDirs: string[] = [];
const savedAgentDir = process.env[ENV_AGENT_DIR];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	if (savedAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = savedAgentDir;
});

function temporaryDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "prism-agents-"));
	tempDirs.push(dir);
	return dir;
}

function startPrism(prism: string, cwd: string, agentDir: string, args: string[], stdin: "ignore" | "pipe" = "ignore") {
	const child = spawn(process.execPath, ["--import", resolverUrl, prism, ...args], {
		cwd,
		env: {
			...process.env,
			PI_PACKAGE_DIR: dirname(dirname(prism)),
			PI_CODING_AGENT_DIR: agentDir,
			// The turn an agent's answer starts gets "ok", not the demo script's tool calls.
			FAKE_PLAIN: "1",
			PRISM_CODING_AGENT_DIR: agentDir,
			[ENV_AGENT_DIR]: agentDir,
			PI_OFFLINE: "1",
		},
		stdio: [stdin, "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
		stderr += chunk;
	});
	return {
		child,
		get stdout() {
			return stdout;
		},
		get stderr() {
			return stderr;
		},
	};
}

async function finishPrism(
	run: ReturnType<typeof startPrism>,
	timeoutMs = 30_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	let timer: NodeJS.Timeout | undefined;
	try {
		const code = await Promise.race([
			new Promise<number | null>((resolveCode, reject) => {
				run.child.once("error", reject);
				run.child.once("close", resolveCode);
			}),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`CLI timeout\n${run.stdout}\n${run.stderr}`)), timeoutMs);
			}),
		]);
		return { code, stdout: run.stdout, stderr: run.stderr };
	} finally {
		if (timer) clearTimeout(timer);
		if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill("SIGKILL");
	}
}

function setupCli(): { cwd: string; agentDir: string; prism: string } {
	const root = temporaryDir();
	const cwd = join(root, "work");
	const agentDir = join(root, "agent");
	const packageRoot = join(root, "package");
	const binDir = join(packageRoot, "bin");
	const prism = join(binDir, "prism");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(binDir, { recursive: true });
	writeFileSync(
		join(packageRoot, "package.json"),
		JSON.stringify({ type: "module", piConfig: { name: "prism", configDir: ".prism" } }),
	);
	for (const name of ["src", "docs", "examples", "vendor"])
		symlinkSync(join(packageDir, name), join(packageRoot, name), "dir");
	writeFileSync(prism, `import ${JSON.stringify(cliUrl)};\n`);
	writeFileSync(join(cwd, "sample.ts"), "sample contents\n");
	return { cwd, agentDir, prism };
}

const agent: CustomAgent = {
	name: "reader",
	description: "Read a file and summarize it",
	model: "fake/scripted",
	tools: ["read", "grep", "find", "ls"],
	instructions: "Return a short answer.",
};

describe("fork: custom agents", () => {
	it("parses and writes the compatible Markdown format", () => {
		const dir = temporaryDir();
		const path = writeAgent(agent, dir);
		const content = readFileSync(path, "utf8");
		const parsed = parseFrontmatter(content);
		expect(parsed.frontmatter).toMatchObject({
			name: agent.name,
			description: agent.description,
			model: agent.model,
			tools: agent.tools.join(", "),
		});
		expect(parsed.body.trim()).toBe(agent.instructions);
		expect(readAgents(dir)).toEqual([agent]);
	});

	it("validates names and builds a source-safe invocation with extension pass-through", () => {
		expect(isValidAgentName("read-files-2")).toBe(true);
		expect(isValidAgentName("Read_files")).toBe(false);
		expect(isValidAgentName("-reader")).toBe(false);
		expect(agentName("  Lecteur d'Écrans_2 ")).toBe("lecteur-d-ecrans-2");
		expect(agentName("!!!")).toBe("");
		setCliExtensions(["/launch/one.ts", "/launch/two.ts"]);
		expect(getExtensionArgs()).toEqual(["--extension", "/launch/one.ts", "--extension", "/launch/two.ts"]);
		setCliExtensions([]);
		expect(buildAgentInvocation(agent, "fake/parent", ["-e", "/tmp/provider.ts"])).toEqual([
			"--mode",
			"rpc",
			"--no-session",
			"--model",
			"fake/scripted",
			"--tools",
			"read,grep,find,ls",
			"--exclude-tools",
			"bash,edit,write",
			"--append-system-prompt",
			agent.instructions,
			"-e",
			"/tmp/provider.ts",
		]);
		// the session's other tools too, except those that address the user and agents themselves.
		const session = ["read", "bash", "background", "web_fetch", "ask_user_question", "show_ui", "agent", "sudo"];
		const tools = buildAgentInvocation(agent, "fake/parent", [], [], session);
		expect(tools[tools.indexOf("--tools") + 1]).toBe("read,grep,find,ls,background,web_fetch");
	});

	it("creates an agent through /agents dialogs without using the default config", async () => {
		const dir = temporaryDir();
		process.env[ENV_AGENT_DIR] = dir;
		const choices = ["New agent", "provider/custom", "Done", "Close"];
		const inputs = ["helper", "Read and explain files"];
		let editorText = "";
		let command: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
		const api = {
			getAllTools: () => [],
			registerTool: () => {},
			registerMessageRenderer: () => {},
			on: () => {},
			registerCommand: (_name: string, options: { handler: typeof command }) => {
				command = options.handler;
			},
		} as unknown as ExtensionAPI;
		agentsExtension(api);
		const ui = {
			select: async () => choices.shift(),
			input: async () => inputs.shift(),
			editor: async (_title: string, prefill?: string) => {
				editorText = prefill ?? "";
				return "Read the requested file and summarize it.";
			},
			notify: () => {},
			confirm: async () => false,
		};
		const ctx = {
			ui,
			modelRegistry: { getAvailable: () => [{ provider: "provider", id: "custom" }] },
		} as unknown as ExtensionCommandContext;
		await command?.("", ctx);
		expect(editorText).toBe("");
		expect(readAgents(dir)).toEqual([
			{
				name: "helper",
				description: "Read and explain files",
				model: "provider/custom",
				tools: ["read", "grep", "find", "ls"],
				instructions: "Read the requested file and summarize it.",
			},
		]);
		expect(existsSync(join(dir, ".pi"))).toBe(false);

		// Edit asks the name too; a new one renames the agent.
		choices.push("helper — Read and explain files", "Edit", "Same as the current session", "Done", "Close");
		inputs.push("Lecteur Rapide", "");
		await command?.("", ctx);
		expect(readAgents(dir).map((entry) => [entry.name, entry.description])).toEqual([
			["lecteur-rapide", "Read and explain files"],
		]);
	});

	// fork: /agents did not say what an agent is, and told the user to « use agent » to run one,
	// a tool only the model can call.
	it("explains agents above their list, and how to run a new one", async () => {
		const dir = temporaryDir();
		process.env[ENV_AGENT_DIR] = dir;
		const titles: string[] = [];
		const notes: string[] = [];
		const choices = ["New agent", "Same as the current session", "Done", "Close"];
		const inputs = ["helper", "Read and explain files"];
		let command: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
		agentsExtension({
			getAllTools: () => [],
			registerTool: () => {},
			registerMessageRenderer: () => {},
			on: () => {},
			registerCommand: (_name: string, options: { handler: typeof command }) => {
				command = options.handler;
			},
		} as unknown as ExtensionAPI);
		const ctx = {
			ui: {
				select: async (title: string) => {
					titles.push(title);
					return choices.shift();
				},
				input: async () => inputs.shift(),
				editor: async () => "Explain.",
				notify: (message: string) => void notes.push(message),
				confirm: async () => false,
			},
			modelRegistry: { getAvailable: () => [] },
		} as unknown as ExtensionCommandContext;
		await command?.("", ctx);
		expect(titles[0]).toBe(
			[
				"Agents",
				"An agent is your own helper: its instructions, model and tools. When a task fits its purpose, the model runs it, or ask for it by name.",
				"Runs agents: on its own, when a task fits.",
			].join("\n"),
		);
		expect(notes).toEqual(["Agent created: helper. Ask the model to use it, e.g. « use the helper agent to … »."]);
	});

	// the user chooses when the model may run an agent; only the keyword alone can be enforced.
	it("lets the model run agents on its own by default, and matches the keyword as a word", () => {
		process.env[ENV_AGENT_DIR] = temporaryDir();
		const policy = readAgentInvocation();
		expect(policy).toEqual({ autonomous: true, explicitRequest: true, keyword: true, keywordText: "@agent" });
		expect(invocationRule(policy)).toBe("");
		expect(invocationRule({ ...policy, autonomous: false })).toBe(
			" Call it only when the user's latest message explicitly asks for an agent or contains @agent.",
		);
		expect(invocationRule({ ...policy, autonomous: false, explicitRequest: false })).toBe(
			" Call it only when the user's latest message contains @agent; any other call is refused.",
		);
		expect(mentionsKeyword("please ask @Agent, then stop", "@agent")).toBe(true);
		expect(mentionsKeyword("@agent", "@agent")).toBe(true);
		expect(mentionsKeyword("ask @agents", "@agent")).toBe(false);
		expect(mentionsKeyword("mail me at me@agent.dev", "@agent")).toBe(false);
		expect(mentionsKeyword("ask @@agent", "@agent")).toBe(false);
	});

	it("saves the policy from /agents, refuses calls without the keyword, and turns agents off", async () => {
		const dir = temporaryDir();
		process.env[ENV_AGENT_DIR] = dir;
		writeAgent(agent);
		const descriptions: string[] = [];
		const handlers = new Map<string, (event: Record<string, unknown>) => unknown>();
		let command: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
		agentsExtension({
			getAllTools: () => [],
			registerTool: (tool: { description: string }) => void descriptions.push(tool.description),
			registerMessageRenderer: () => {},
			on: (name: string, handler: (event: Record<string, unknown>) => unknown) => void handlers.set(name, handler),
			registerCommand: (_name: string, options: { handler: typeof command }) => {
				command = options.handler;
			},
		} as unknown as ExtensionAPI);
		const gate = (prompt: string) => {
			handlers.get("before_agent_start")?.({ type: "before_agent_start", prompt });
			return handlers.get("tool_call")?.({ type: "tool_call", toolName: "agent", toolCallId: "1", input: {} });
		};
		expect(gate("summarize the repo")).toBeUndefined();

		const choices = [
			"When the model may run an agent…",
			"When your message contains @agent",
			"Change the keyword (@agent)",
			"Back",
			"Close",
		];
		let reloaded = 0;
		const ctx = {
			ui: {
				select: async () => choices.shift(),
				input: async () => "@helper",
				notify: () => {},
				confirm: async () => true,
			},
			reload: async () => void reloaded++,
		} as unknown as ExtensionCommandContext;
		await command?.("", ctx);
		const settingsPath = join(dir, "settings.json");
		expect(JSON.parse(readFileSync(settingsPath, "utf8")).agentInvocation).toEqual({
			autonomous: false,
			explicitRequest: false,
			keyword: true,
			keywordText: "@helper",
		});
		expect(descriptions.at(-1)).toContain(
			"Call it only when the user's latest message contains @helper; any other call is refused.",
		);
		expect(gate("summarize the repo")).toEqual({
			block: true,
			reason: "Refused: the user lets you run an agent only when their latest message contains @helper.",
		});
		expect(gate("@helper summarize the repo")).toBeUndefined();

		choices.push("Turn agents off");
		await command?.("", ctx);
		expect(JSON.parse(readFileSync(settingsPath, "utf8")).extensions).toEqual(["-builtin:agents"]);
		expect(reloaded).toBe(1);
	});

	// a template whose text holds the keyword, invoked without it.
	it("checks the keyword on what the user typed, not on the template it expands to", () => {
		const dir = temporaryDir();
		process.env[ENV_AGENT_DIR] = dir;
		writeAgent(agent);
		writeFileSync(
			join(dir, "settings.json"),
			JSON.stringify({
				agentInvocation: { autonomous: false, explicitRequest: false, keyword: true, keywordText: "@agent" },
			}),
		);
		const handlers = new Map<string, (event: Record<string, unknown>) => unknown>();
		agentsExtension({
			getAllTools: () => [],
			registerTool: () => {},
			registerMessageRenderer: () => {},
			on: (name: string, handler: (event: Record<string, unknown>) => unknown) => void handlers.set(name, handler),
			registerCommand: () => {},
		} as unknown as ExtensionAPI);
		const run = (typed: string, expanded: string) => {
			handlers.get("input")?.({ type: "input", text: typed, source: "interactive" });
			handlers.get("before_agent_start")?.({ type: "before_agent_start", prompt: expanded });
			handlers.get("message_start")?.({
				type: "message_start",
				message: { role: "user", content: [{ type: "text", text: expanded }] },
			});
			const verdict = handlers.get("tool_call")?.({
				type: "tool_call",
				toolName: "agent",
				toolCallId: "1",
				input: {},
			});
			handlers.get("agent_settled")?.({ type: "agent_settled" });
			return verdict;
		};
		expect(run("/delegate", "Hand this to @agent and report back.")).toMatchObject({ block: true });
		expect(run("/delegate @agent", "Hand this to @agent and report back.")).toBeUndefined();
	});

	it("runs the real source CLI with the agent model and restricted tools", async () => {
		const env = setupCli();
		process.env[ENV_AGENT_DIR] = env.agentDir;
		writeAgent(agent);
		const run = startPrism(env.prism, env.cwd, env.agentDir, [
			"--mode",
			"json",
			"-e",
			fakeProvider,
			"--provider",
			"fake",
			"--model",
			"scripted",
			"--perm-mode",
			"broad",
			"--no-session",
			"-p",
			'call agent {"agent":"reader","task":"call read {\\"path\\":\\"sample.ts\\"}"}',
		]);
		const result = await finishPrism(run, 60_000);
		expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(result.stdout).toContain("ok");
		expect(result.stdout).toContain('"model":"scripted"');
		expect(result.stdout).toContain('"toolsUsed":["read"]');
		writeFileSync(join(env.agentDir, "permissions.json"), JSON.stringify({ mode: "broad" }));
		const blocked = startPrism(env.prism, env.cwd, env.agentDir, [
			"--mode",
			"json",
			"-e",
			fakeProvider,
			"--provider",
			"fake",
			"--model",
			"scripted",
			"--perm-mode",
			"broad",
			"--no-session",
			"-p",
			'call agent {"agent":"reader","task":"call bash {\\"command\\":\\"touch forbidden.txt\\"}"}',
		]);
		const blockedResult = await finishPrism(blocked, 60_000);
		expect(blockedResult.code, `${blockedResult.stdout}\n${blockedResult.stderr}`).toBe(0);
		expect(existsSync(join(env.cwd, "forbidden.txt"))).toBe(false);
	}, 70_000);

	// fork: the agent's first prompt refused before its turn starts (no key for
	// its model) ends the call with that error, instead of waiting for a turn that never comes.
	it("reports an agent whose first prompt is refused, without waiting for its turn", async () => {
		const env = setupCli();
		process.env[ENV_AGENT_DIR] = env.agentDir;
		writeFileSync(
			join(env.agentDir, "models.json"),
			JSON.stringify({
				providers: {
					keyless: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", models: [{ id: "m" }] },
				},
			}),
		);
		writeAgent({ ...agent, name: "keyless", model: "keyless/m" });
		const run = startPrism(env.prism, env.cwd, env.agentDir, [
			"--mode",
			"json",
			"-e",
			fakeProvider,
			"--provider",
			"fake",
			"--model",
			"scripted",
			"--perm-mode",
			"broad",
			"--no-session",
			"-p",
			'call agent {"agent":"keyless","task":"hello"}',
		]);
		const result = await finishPrism(run, 30_000);
		expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(result.stdout).toMatch(/"toolName":"agent"[^\n]*"isError":true/);
		expect(result.stdout).toContain("No access key is available for keyless.");
	}, 40_000);

	it("forwards the agent's permission prompts to the parent's client, named after the agent", async () => {
		const env = setupCli();
		process.env[ENV_AGENT_DIR] = env.agentDir;
		// In ask mode, where a write asks; without a configured mode Prism starts in broad.
		writeFileSync(join(env.agentDir, "permissions.json"), JSON.stringify({ mode: "ask" }));
		writeAgent({ ...agent, name: "writer", tools: ["write"] });
		const rpc = startPrism(
			env.prism,
			env.cwd,
			env.agentDir,
			["--mode", "rpc", "-e", fakeProvider, "--provider", "fake", "--model", "scripted", "--no-session"],
			"pipe",
		);
		const titles: string[] = [];
		const afterAnswer = settledAfterAnswer();
		const settled = new Promise<void>((resolveSettled) => {
			let buffer = "";
			rpc.child.stdout?.on("data", (chunk: string) => {
				buffer += chunk;
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					if (!line.startsWith("{")) continue;
					const record = JSON.parse(line) as {
						type?: string;
						method?: string;
						id?: string;
						title?: string;
						options?: string[];
					};
					if (afterAnswer(record)) resolveSettled();
					if (record.type !== "extension_ui_request" || record.method !== "select") continue;
					titles.push(record.title ?? "");
					const value = record.options?.find((option) => option.startsWith("Allow once"));
					rpc.child.stdin?.write(`${JSON.stringify({ type: "extension_ui_response", id: record.id, value })}\n`);
				}
			});
		});
		const task = `call write ${JSON.stringify({ path: "agent.txt", content: "agent" })}`;
		rpc.child.stdin?.write(
			`${JSON.stringify({ id: "p1", type: "prompt", message: `call agent ${JSON.stringify({ agent: "writer", task })}` })}\n`,
		);
		await settled;
		rpc.child.stdin?.end();
		const result = await finishPrism(rpc, 30_000);
		expect(result.code, result.stderr).toBe(0);
		expect(titles).toContainEqual(expect.stringMatching(/^writer: /));
		expect(readFileSync(join(env.cwd, "agent.txt"), "utf8")).toBe("agent");
	}, 70_000);

	// an agent has the session's tools except those addressed to the user,
	// and its background task outlives its answer: its end reaches the main session through the agent.
	it("keeps the agent alive for its background task and reports its end to the main session", async () => {
		const env = setupCli();
		process.env[ENV_AGENT_DIR] = env.agentDir;
		writeAgent({ ...agent, name: "worker", tools: ["bash"] });
		const rpc = startPrism(
			env.prism,
			env.cwd,
			env.agentDir,
			[
				"--mode",
				"rpc",
				"-e",
				fakeProvider,
				"--provider",
				"fake",
				"--model",
				"scripted",
				"--perm-mode",
				"broad",
				"--no-session",
			],
			"pipe",
		);
		let started = "";
		let answer = "";
		const report = new Promise<string>((resolveReport) => {
			let buffer = "";
			rpc.child.stdout?.on("data", (chunk: string) => {
				buffer += chunk;
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					if (!line.startsWith("{")) continue;
					const record = JSON.parse(line) as {
						type?: string;
						toolName?: string;
						result?: { content?: Array<{ text?: string }> };
						message?: { role?: string; customType?: string; content?: unknown };
					};
					if (record.type === "tool_execution_end" && record.toolName === "agent")
						started = record.result?.content?.[0]?.text ?? "";
					if (record.type === "message_end" && record.message?.customType === "agent-answer")
						answer = String(record.message.content);
					if (record.type === "message_end" && record.message?.customType === "agent-background")
						resolveReport(String(record.message.content));
				}
			});
		});
		const task = `steps ${JSON.stringify([["background", { action: "run", command: "sleep 1; echo from-bg" }]])}`;
		rpc.child.stdin?.write(
			`${JSON.stringify({ id: "p1", type: "prompt", message: `call agent ${JSON.stringify({ agent: "worker", task })}` })}\n`,
		);
		const text = await report;
		// the tool returns at once; the answer comes as a message.
		expect(started).toMatch(/^Started agent worker \(ag1\)\. It works in the background/);
		expect(answer).toMatch(/^\*\*Agent worker answered \(ag1\)\*\*\n\n/);
		expect(answer).toContain("Still running in worker's background: bg1 (sleep 1; echo from-bg).");
		expect(text).toMatch(/^\*\*Agent worker: background task ended\*\*/);
		expect(text).toContain("from-bg");
		expect(text).toContain("Agent worker then answered:\n");
		rpc.child.stdin?.end();
		const result = await finishPrism(rpc, 30_000);
		expect(result.code, result.stderr).toBe(0);
	}, 70_000);

	// fork: the agent answered and its background task still runs when the
	// session is replaced. The task's end used to reach the old session's `pi` from the child's output handler, which
	// throws ("stale") and could stop Prism.
	it("stops an answered agent with its session, and its later report reaches no one", async () => {
		const env = setupCli();
		process.env[ENV_AGENT_DIR] = env.agentDir;
		writeAgent({ ...agent, name: "worker", tools: ["bash"] });
		const rpc = startPrism(
			env.prism,
			env.cwd,
			env.agentDir,
			["--mode", "rpc", "-e", fakeProvider, "--provider", "fake", "--model", "scripted", "--perm-mode", "broad"],
			"pipe",
		);
		const seen: string[] = [];
		let replaced: () => void = () => {};
		const newSession = new Promise<void>((resolveNew) => {
			replaced = resolveNew;
		});
		let answeredNow: () => void = () => {};
		const answered = new Promise<void>((resolveAnswer) => {
			answeredNow = resolveAnswer;
		});
		let buffer = "";
		rpc.child.stdout?.on("data", (chunk: string) => {
			buffer += chunk;
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.startsWith("{")) continue;
				const record = JSON.parse(line) as { type?: string; command?: string; message?: { customType?: string } };
				if (record.type === "message_end" && record.message?.customType) seen.push(record.message.customType);
				if (record.type === "message_end" && record.message?.customType === "agent-answer") answeredNow();
				if (record.type === "response" && record.command === "new_session") replaced();
			}
		});
		const task = `steps ${JSON.stringify([["background", { action: "run", command: "sleep 2; echo from-bg" }]])}`;
		rpc.child.stdin?.write(
			`${JSON.stringify({ id: "p1", type: "prompt", message: `call agent ${JSON.stringify({ agent: "worker", task })}` })}\n`,
		);
		await answered;
		rpc.child.stdin?.write(`${JSON.stringify({ id: "n1", type: "new_session" })}\n`);
		await newSession;
		// Past the background task's end (2 s).
		await new Promise((resolveWait) => setTimeout(resolveWait, 4000));
		expect(rpc.child.exitCode, rpc.stderr).toBeNull();
		expect(seen).not.toContain("agent-background");
		expect(rpc.stderr).not.toMatch(/stale/);
		rpc.child.stdin?.end();
		const result = await finishPrism(rpc, 30_000);
		expect(result.code, result.stderr).toBe(0);
	}, 70_000);

	// a background task outlives its session on purpose, but its end must not clear the
	// next session's counter. Next to the agents' case, whose helpers it shares.
	it("leaves the next session's background counter alone when an older task ends", async () => {
		const env = setupCli();
		const rpc = startPrism(
			env.prism,
			env.cwd,
			env.agentDir,
			["--mode", "rpc", "-e", fakeProvider, "--provider", "fake", "--model", "scripted", "--perm-mode", "broad"],
			"pipe",
		);
		const statuses: Array<string | undefined> = [];
		const waiters: Array<{ until: () => boolean; resolve: () => void }> = [];
		const waitFor = (until: () => boolean) =>
			new Promise<void>((resolveWait) => {
				if (until()) resolveWait();
				else waiters.push({ until, resolve: resolveWait });
			});
		let replaced = false;
		let buffer = "";
		rpc.child.stdout?.on("data", (chunk: string) => {
			buffer += chunk;
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.startsWith("{")) continue;
				const record = JSON.parse(line) as {
					type?: string;
					command?: string;
					method?: string;
					statusKey?: string;
					statusText?: string;
				};
				if (
					record.type === "extension_ui_request" &&
					record.method === "setStatus" &&
					record.statusKey === "background"
				)
					statuses.push(record.statusText);
				if (record.type === "response" && record.command === "new_session") replaced = true;
			}
			for (const waiter of waiters.splice(0)) {
				if (waiter.until()) waiter.resolve();
				else waiters.push(waiter);
			}
		});
		const run = (id: string, command: string) =>
			rpc.child.stdin?.write(
				`${JSON.stringify({ id, type: "prompt", message: `call background ${JSON.stringify({ action: "run", command })}` })}\n`,
			);
		run("a", "sleep 2");
		await waitFor(() => statuses.length > 0);
		rpc.child.stdin?.write(`${JSON.stringify({ id: "n1", type: "new_session" })}\n`);
		await waitFor(() => replaced);
		const before = statuses.length;
		run("b", "sleep 8");
		await waitFor(() => statuses.length > before);
		expect(statuses.at(-1)).toBe("bg: 1 running");
		// Past the first task's end (2 s), before the second's (8 s).
		await new Promise((resolveWait) => setTimeout(resolveWait, 4000));
		expect(statuses.at(-1), JSON.stringify(statuses)).toBe("bg: 1 running");
		expect(rpc.child.exitCode, rpc.stderr).toBeNull();
		rpc.child.stdin?.end();
		const result = await finishPrism(rpc, 30_000);
		expect(result.code, result.stderr).toBe(0);
	}, 70_000);

	// an agent writes in the session's /tmp, where the session finds it.
	it("shares the session's /tmp with the agent", async () => {
		const env = setupCli();
		process.env[ENV_AGENT_DIR] = env.agentDir;
		writeAgent({ ...agent, name: "runner", tools: ["bash"] });
		const rpc = startPrism(
			env.prism,
			env.cwd,
			env.agentDir,
			[
				"--mode",
				"rpc",
				"-e",
				fakeProvider,
				"--provider",
				"fake",
				"--model",
				"scripted",
				"--perm-mode",
				"broad",
				"--no-session",
			],
			"pipe",
		);
		const afterAnswer = settledAfterAnswer();
		let answered: () => void = () => {};
		const settled = new Promise<void>((resolveSettled) => {
			answered = resolveSettled;
		});
		let read: (text: string) => void = () => {};
		const catOutput = new Promise<string>((resolveRead) => {
			read = resolveRead;
		});
		let buffer = "";
		rpc.child.stdout?.on("data", (chunk: string) => {
			buffer += chunk;
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.startsWith("{")) continue;
				const record = JSON.parse(line) as {
					type?: string;
					toolName?: string;
					message?: { customType?: string };
					result?: { content?: Array<{ text?: string }> };
				};
				if (afterAnswer(record)) answered();
				if (record.type === "tool_execution_end" && record.toolName === "bash")
					read(record.result?.content?.[0]?.text ?? "");
			}
		});
		const send = (message: string, id: string) =>
			rpc.child.stdin?.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);
		const task = `call bash ${JSON.stringify({ command: "echo from-agent > /tmp/shared.txt" })}`;
		send(`call agent ${JSON.stringify({ agent: "runner", task })}`, "p1");
		await settled;
		send(`call bash ${JSON.stringify({ command: "cat /tmp/shared.txt" })}`, "p2");
		expect(await catOutput).toContain("from-agent");
		rpc.child.stdin?.end();
		const result = await finishPrism(rpc, 30_000);
		expect(result.code, result.stderr).toBe(0);
	}, 70_000);

	// the user stops a running agent; the model is told, no turn starts.
	it("stops a running agent on request and tells the session without starting a turn", async () => {
		const env = setupCli();
		process.env[ENV_AGENT_DIR] = env.agentDir;
		writeAgent({ ...agent, name: "runner", tools: ["bash"] });
		const rpc = startPrism(
			env.prism,
			env.cwd,
			env.agentDir,
			[
				"--mode",
				"rpc",
				"-e",
				fakeProvider,
				"--provider",
				"fake",
				"--model",
				"scripted",
				"--perm-mode",
				"broad",
				"--no-session",
			],
			"pipe",
		);
		let turns = 0;
		const started = Date.now();
		const stopped = new Promise<string>((resolveStopped) => {
			let buffer = "";
			rpc.child.stdout?.on("data", (chunk: string) => {
				buffer += chunk;
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					if (!line.startsWith("{")) continue;
					const record = JSON.parse(line) as {
						type?: string;
						toolName?: string;
						message?: { customType?: string; content?: unknown };
					};
					if (record.type === "agent_start") turns++;
					if (record.type === "tool_execution_end" && record.toolName === "agent")
						rpc.child.stdin?.write(`${JSON.stringify({ id: "s1", type: "agents_stop", run: "ag1" })}\n`);
					if (record.type === "message_end" && record.message?.customType === "agent-answer")
						resolveStopped(String(record.message.content));
				}
			});
		});
		const task = `call bash ${JSON.stringify({ command: "sleep 30" })}`;
		rpc.child.stdin?.write(
			`${JSON.stringify({ id: "p1", type: "prompt", message: `call agent ${JSON.stringify({ agent: "runner", task })}` })}\n`,
		);
		const text = await stopped;
		expect(text).toBe("**Agent runner stopped (ag1)**\n\nThe user stopped this agent before it answered.");
		expect(Date.now() - started).toBeLessThan(25_000);
		await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
		expect(turns).toBe(1);
		rpc.child.stdin?.end();
		const result = await finishPrism(rpc, 30_000);
		expect(result.code, result.stderr).toBe(0);
	}, 70_000);

	// the window's side menu lists the session's runs and shows a run's full
	// transcript, which the agent keeps in its own session beside the main one (agent-transcript.ts).
	it("keeps the agent's transcript in its own session and lists the run", async () => {
		const env = setupCli();
		process.env[ENV_AGENT_DIR] = env.agentDir;
		writeAgent(agent);
		const rpc = startPrism(
			env.prism,
			env.cwd,
			env.agentDir,
			["--mode", "rpc", "-e", fakeProvider, "--provider", "fake", "--model", "scripted", "--perm-mode", "broad"],
			"pipe",
		);
		const responses = new Map<string, (record: { success?: boolean; data?: unknown; error?: string }) => void>();
		const answered = new Promise<void>((resolveAnswered) => {
			let buffer = "";
			rpc.child.stdout?.on("data", (chunk: string) => {
				buffer += chunk;
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					if (!line.startsWith("{")) continue;
					const record = JSON.parse(line) as {
						type?: string;
						id?: string;
						success?: boolean;
						data?: unknown;
						error?: string;
						message?: { customType?: string };
					};
					if (record.type === "response" && record.id) responses.get(record.id)?.(record);
					if (record.type === "message_end" && record.message?.customType === "agent-answer") resolveAnswered();
				}
			});
		});
		const request = <T>(id: string, command: Record<string, unknown>) =>
			new Promise<{ success?: boolean; data?: T; error?: string }>((resolveRequest) => {
				responses.set(id, (record) => resolveRequest(record as { success?: boolean; data?: T; error?: string }));
				rpc.child.stdin?.write(`${JSON.stringify({ id, ...command })}\n`);
			});
		const task = `call read ${JSON.stringify({ path: "sample.ts" })}`;
		rpc.child.stdin?.write(
			`${JSON.stringify({ id: "p1", type: "prompt", message: `call agent ${JSON.stringify({ agent: "reader", task })}` })}\n`,
		);
		await answered;
		const runs =
			(
				await request<{ runs: Array<{ id: string; state: string; task: string; session?: string }> }>("g1", {
					type: "agents_get",
				})
			).data?.runs ?? [];
		expect(runs).toHaveLength(1);
		expect(runs[0]).toMatchObject({ id: "ag1", agent: "reader", state: "answered", task });
		expect(runs[0].session).toMatch(/^[0-9a-f-]{36}$/);
		const entries =
			(
				await request<{ entries: Array<{ kind: string; text?: string; name?: string; output?: string }> }>("t1", {
					type: "agent_transcript",
					session: runs[0].session,
				})
			).data?.entries ?? [];
		expect(entries[0]).toEqual({ kind: "user", text: task });
		expect(entries.find((entry) => entry.kind === "tool")).toMatchObject({
			name: "read",
			output: expect.stringContaining("sample contents"),
		});
		// Never among the user's sessions: a directory of its own beside the main session's file.
		const sessions = join(env.agentDir, "sessions");
		const folder = readdirSync(sessions)[0];
		const listed = readdirSync(join(sessions, folder));
		expect(listed.filter((name) => name.endsWith(".jsonl"))).toHaveLength(1);
		const agents = listed.find((name) => name.endsWith(".agents"));
		expect(
			agents &&
				readdirSync(join(sessions, folder, agents)).some((name) => name.endsWith(`_${runs[0].session}.jsonl`)),
		).toBe(true);
		const refused = await request("t2", { type: "agent_transcript", session: "../../etc/passwd" });
		expect(refused).toMatchObject({ success: false, error: "Invalid agent session id." });
		rpc.child.stdin?.end();
		const result = await finishPrism(rpc, 30_000);
		expect(result.code, result.stderr).toBe(0);
	}, 70_000);

	it("runs the agent in the parent's permission mode, not the configured one", async () => {
		const env = setupCli();
		process.env[ENV_AGENT_DIR] = env.agentDir;
		// Configured broad, this session in ask: the agent must not write without asking.
		writeFileSync(join(env.agentDir, "permissions.json"), JSON.stringify({ mode: "broad" }));
		writeAgent({ ...agent, name: "writer", tools: ["write"] });
		const rpc = startPrism(
			env.prism,
			env.cwd,
			env.agentDir,
			[
				"--mode",
				"rpc",
				"-e",
				fakeProvider,
				"--provider",
				"fake",
				"--model",
				"scripted",
				"--no-session",
				"--perm-mode",
				"ask",
			],
			"pipe",
		);
		const titles: string[] = [];
		const afterAnswer = settledAfterAnswer();
		const settled = new Promise<void>((resolveSettled) => {
			let buffer = "";
			rpc.child.stdout?.on("data", (chunk: string) => {
				buffer += chunk;
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					if (!line.startsWith("{")) continue;
					const record = JSON.parse(line) as {
						type?: string;
						method?: string;
						id?: string;
						title?: string;
						options?: string[];
					};
					if (afterAnswer(record)) resolveSettled();
					if (record.type !== "extension_ui_request" || record.method !== "select") continue;
					const title = record.title ?? "";
					titles.push(title);
					// The parent's question about starting the agent is allowed; the agent's own write is blocked.
					const choice = title.startsWith("writer: ") ? "Block this action once" : "Allow once";
					const value = record.options?.find((option) => option.startsWith(choice));
					rpc.child.stdin?.write(`${JSON.stringify({ type: "extension_ui_response", id: record.id, value })}\n`);
				}
			});
		});
		const task = `call write ${JSON.stringify({ path: "agent.txt", content: "agent" })}`;
		rpc.child.stdin?.write(
			`${JSON.stringify({ id: "p1", type: "prompt", message: `call agent ${JSON.stringify({ agent: "writer", task })}` })}\n`,
		);
		await settled;
		rpc.child.stdin?.end();
		const result = await finishPrism(rpc, 30_000);
		expect(result.code, result.stderr).toBe(0);
		expect(titles).toContainEqual(expect.stringMatching(/^writer: /));
		expect(existsSync(join(env.cwd, "agent.txt"))).toBe(false);
	}, 70_000);

	it("keeps the parent's session deny rules in the agent", async () => {
		const env = setupCli();
		process.env[ENV_AGENT_DIR] = env.agentDir;
		writeFileSync(join(env.agentDir, "permissions.json"), JSON.stringify({ mode: "broad" }));
		writeAgent({ ...agent, name: "writer", tools: ["write"] });
		const rpc = startPrism(
			env.prism,
			env.cwd,
			env.agentDir,
			["--mode", "rpc", "-e", fakeProvider, "--provider", "fake", "--model", "scripted", "--no-session"],
			"pipe",
		);
		const afterAnswer = settledAfterAnswer();
		const settled = new Promise<void>((resolveSettled) => {
			let buffer = "";
			rpc.child.stdout?.on("data", (chunk: string) => {
				buffer += chunk;
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					if (line.startsWith("{") && afterAnswer(JSON.parse(line))) resolveSettled();
				}
			});
		});
		const send = (message: string, id: string) =>
			rpc.child.stdin?.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);
		send("/perm deny write", "p1");
		const task = `call write ${JSON.stringify({ path: "agent.txt", content: "agent" })}`;
		send(`call agent ${JSON.stringify({ agent: "writer", task })}`, "p2");
		await settled;
		rpc.child.stdin?.end();
		const result = await finishPrism(rpc, 30_000);
		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout).toContain('"toolName":"agent"');
		expect(existsSync(join(env.cwd, "agent.txt"))).toBe(false);
	}, 70_000);
	// fork: an agent already running took its rights from its launch only. The parent
	// narrowed later (safe mode, a deny rule): the agent, held in a command, then wrote anyway.
	for (const [what, restriction] of [
		["a narrower mode", { type: "perm_mode", mode: "safe" }],
		["a session deny rule", { type: "perm_rule", action: "add", effect: "deny", rule: "write", where: "session" }],
	] as const)
		it(`applies ${what} the parent sets to the agent already running`, async () => {
			const env = setupCli();
			process.env[ENV_AGENT_DIR] = env.agentDir;
			writeFileSync(
				join(env.agentDir, "settings.json"),
				JSON.stringify({ sandbox: { modes: { broad: false, ask: false, safe: false } } }),
			);
			writeAgent({ ...agent, name: "writer", tools: ["bash", "write"] });
			const rpc = startPrism(
				env.prism,
				env.cwd,
				env.agentDir,
				[
					"--mode",
					"rpc",
					"-e",
					fakeProvider,
					"--provider",
					"fake",
					"--model",
					"scripted",
					"--no-session",
					"--perm-mode",
					"broad",
				],
				"pipe",
			);
			const afterAnswer = settledAfterAnswer();
			let restricted: (() => void) | undefined;
			const restrictedNow = new Promise<void>((resolveRestricted) => {
				restricted = resolveRestricted;
			});
			const settled = new Promise<void>((resolveSettled) => {
				let buffer = "";
				rpc.child.stdout?.on("data", (chunk: string) => {
					buffer += chunk;
					const lines = buffer.split("\n");
					buffer = lines.pop() ?? "";
					for (const line of lines) {
						if (!line.startsWith("{")) continue;
						const record = JSON.parse(line) as { type?: string; id?: string; success?: boolean };
						if (record.type === "response" && record.id === "r") restricted?.();
						if (afterAnswer(record)) resolveSettled();
					}
				});
			});
			// The agent waits in a command for the file "go", then writes.
			const task = `steps ${JSON.stringify([
				["bash", { command: "touch started; until [ -e go ]; do sleep 0.1; done" }],
				["write", { path: "agent.txt", content: "agent" }],
			])}`;
			rpc.child.stdin?.write(
				`${JSON.stringify({ id: "p1", type: "prompt", message: `call agent ${JSON.stringify({ agent: "writer", task })}` })}\n`,
			);
			const deadline = Date.now() + 30_000;
			while (!existsSync(join(env.cwd, "started")) && Date.now() < deadline)
				await new Promise((resolveTick) => setTimeout(resolveTick, 50));
			expect(existsSync(join(env.cwd, "started")), rpc.stderr).toBe(true);
			rpc.child.stdin?.write(`${JSON.stringify({ id: "r", ...restriction })}\n`);
			await restrictedNow;
			await new Promise((resolveTick) => setTimeout(resolveTick, 500));
			writeFileSync(join(env.cwd, "go"), "");
			await settled;
			rpc.child.stdin?.end();
			const result = await finishPrism(rpc, 30_000);
			expect(result.code, result.stderr).toBe(0);
			expect(existsSync(join(env.cwd, "agent.txt"))).toBe(false);
		}, 70_000);

	// two narrowings in a row reached the agent while the first
	// one's sandbox was starting; the first answered "Unrestricted mode not enabled." and the agent was stopped.
	it("keeps the agent running when the parent narrows its mode twice in a row", async () => {
		const env = setupCli();
		process.env[ENV_AGENT_DIR] = env.agentDir;
		writeFileSync(
			join(env.agentDir, "settings.json"),
			JSON.stringify({ sandbox: { modes: { broad: false, ask: false, safe: true } } }),
		);
		writeAgent({ ...agent, name: "writer", tools: ["bash"] });
		const rpc = startPrism(
			env.prism,
			env.cwd,
			env.agentDir,
			[
				"--mode",
				"rpc",
				"-e",
				fakeProvider,
				"--provider",
				"fake",
				"--model",
				"scripted",
				"--no-session",
				"--perm-mode",
				"broad",
			],
			"pipe",
		);
		const afterAnswer = settledAfterAnswer();
		const answered = new Map<string, () => void>();
		const answer = (id: string) => new Promise<void>((resolveAnswer) => answered.set(id, resolveAnswer));
		let output = "";
		const settled = new Promise<void>((resolveSettled) => {
			let buffer = "";
			rpc.child.stdout?.on("data", (chunk: string) => {
				output += chunk;
				buffer += chunk;
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					if (!line.startsWith("{")) continue;
					const record = JSON.parse(line) as { type?: string; id?: string };
					if (record.type === "response" && record.id) answered.get(record.id)?.();
					if (afterAnswer(record)) resolveSettled();
				}
			});
		});
		const task = `steps ${JSON.stringify([["bash", { command: "touch started; until [ -e go ]; do sleep 0.1; done" }]])}`;
		rpc.child.stdin?.write(
			`${JSON.stringify({ id: "p1", type: "prompt", message: `call agent ${JSON.stringify({ agent: "writer", task })}` })}\n`,
		);
		const deadline = Date.now() + 30_000;
		while (!existsSync(join(env.cwd, "started")) && Date.now() < deadline)
			await new Promise((resolveTick) => setTimeout(resolveTick, 50));
		expect(existsSync(join(env.cwd, "started")), rpc.stderr).toBe(true);
		// safe starts a sandbox in the agent; ask, sent as soon as safe applies in the parent, starts none.
		const safe = answer("r1");
		rpc.child.stdin?.write(`${JSON.stringify({ id: "r1", type: "perm_mode", mode: "safe" })}\n`);
		await safe;
		const ask = answer("r2");
		rpc.child.stdin?.write(`${JSON.stringify({ id: "r2", type: "perm_mode", mode: "ask" })}\n`);
		await ask;
		await new Promise((resolveTick) => setTimeout(resolveTick, 1500));
		writeFileSync(join(env.cwd, "go"), "");
		await settled;
		rpc.child.stdin?.end();
		const result = await finishPrism(rpc, 30_000);
		expect(result.code, result.stderr).toBe(0);
		expect(output).not.toContain("did not apply the session's new permissions");
	}, 70_000);

	// the task is the model's text, sent to the agent as its prompt; a task starting with "/" must not
	// run one of the agent's commands, such as /perm always, which would save a rule for every later session.
	it("never runs the task as a command in the agent", async () => {
		const env = setupCli();
		process.env[ENV_AGENT_DIR] = env.agentDir;
		writeAgent({ ...agent, name: "writer", tools: ["write"] });
		const rpc = startPrism(
			env.prism,
			env.cwd,
			env.agentDir,
			[
				"--mode",
				"rpc",
				"-e",
				fakeProvider,
				"--provider",
				"fake",
				"--model",
				"scripted",
				"--no-session",
				"--perm-mode",
				"broad",
			],
			"pipe",
		);
		const afterAnswer = settledAfterAnswer();
		const settled = new Promise<void>((resolveSettled) => {
			let buffer = "";
			rpc.child.stdout?.on("data", (chunk: string) => {
				buffer += chunk;
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					if (line.startsWith("{") && afterAnswer(JSON.parse(line))) resolveSettled();
				}
			});
		});
		const send = (message: string, id: string) =>
			rpc.child.stdin?.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);
		send(`call agent ${JSON.stringify({ agent: "writer", task: "/perm always bash" })}`, "p1");
		// Run as a command, the task saved the rule and the agent never settled: bounded, so the rule is checked.
		const done = await Promise.race([
			settled.then(() => true),
			new Promise<boolean>((resolveLater) => setTimeout(() => resolveLater(false), 30_000)),
		]);
		const saved = [join(env.cwd, ".prism", "permissions.json"), join(env.agentDir, "permissions.json")]
			.filter((file) => existsSync(file))
			.map((file) => readFileSync(file, "utf8"));
		expect(saved.join("\n")).not.toContain("bash");
		expect(done).toBe(true);
		rpc.child.stdin?.end();
		const result = await finishPrism(rpc, 30_000);
		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout).toContain('"toolName":"agent"');
	}, 70_000);

	// the agent's commands run in the parent's sandbox: no write outside the project where the parent's
	// mode sandboxes commands; safe mode refuses to start the agent; unrestricted, without a sandbox, the same command
	// writes (shows the check works).
	it.each([
		["broad", "sandboxed"],
		["ask", "sandboxed"],
		["safe", "refused"],
		["unrestricted", "writes"],
	] as const)(
		"gives the agent the parent's sandbox in %s mode",
		async (mode, outcome) => {
			const env = setupCli();
			process.env[ENV_AGENT_DIR] = env.agentDir;
			writeAgent({ ...agent, name: "runner", tools: ["bash"] });
			const outside = join(dirname(env.cwd), "outside.txt");
			const rpc = startPrism(
				env.prism,
				env.cwd,
				env.agentDir,
				[
					"--mode",
					"rpc",
					"-e",
					fakeProvider,
					"--provider",
					"fake",
					"--model",
					"scripted",
					"--no-session",
					"--perm-mode",
					mode,
				],
				"pipe",
			);
			// Safe mode refuses the agent itself: no answer comes.
			const afterAnswer = settledAfterAnswer(outcome !== "refused");
			const settled = new Promise<void>((resolveSettled) => {
				let buffer = "";
				rpc.child.stdout?.on("data", (chunk: string) => {
					buffer += chunk;
					const lines = buffer.split("\n");
					buffer = lines.pop() ?? "";
					for (const line of lines) {
						if (!line.startsWith("{")) continue;
						const record = JSON.parse(line) as {
							type?: string;
							method?: string;
							id?: string;
							options?: string[];
						};
						if (afterAnswer(record)) resolveSettled();
						// Every question is allowed: only the sandbox stands between the command and the file.
						if (record.type !== "extension_ui_request" || record.method !== "select") continue;
						const value = record.options?.find((option) => option.startsWith("Allow once"));
						rpc.child.stdin?.write(
							`${JSON.stringify({ type: "extension_ui_response", id: record.id, value })}\n`,
						);
					}
				});
			});
			const task = `call bash ${JSON.stringify({ command: `echo escaped > ${outside}` })}`;
			rpc.child.stdin?.write(
				`${JSON.stringify({ id: "p1", type: "prompt", message: `call agent ${JSON.stringify({ agent: "runner", task })}` })}\n`,
			);
			await settled;
			rpc.child.stdin?.end();
			const result = await finishPrism(rpc, 30_000);
			expect(result.code, result.stderr).toBe(0);
			if (outcome === "refused") expect(result.stdout).toContain("Blocked by safe mode");
			// the agent's progress shows in the footer's status (it runs in the background).
			else expect(result.stdout).toMatch(/"statusKey":"agents","statusText":"runner: [^"]*bash/);
			expect(existsSync(outside)).toBe(outcome === "writes");
		},
		70_000,
	);
});
