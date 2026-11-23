// fork: trace persistence and permission events use an isolated temporary agent directory.
import { spawn } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";
import permissionsExtension from "../src/fork/permissions.ts";
import traceExtension from "../src/fork/trace.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

const secret = "trace-canary-secret-123456789";
const tempDirs: string[] = [];

function parseTrace(file: string): Array<Record<string, unknown>> {
	return readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("fork: operation trace", () => {
	const savedAgentDir = process.env[ENV_AGENT_DIR];
	let agentDir: string;
	const harnesses: Harness[] = [];

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-trace-"));
		tempDirs.push(agentDir);
		process.env[ENV_AGENT_DIR] = agentDir;
		// These tests expect ask mode; without a configured mode Prism starts in broad.
		writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode: "ask" }));
	});
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		if (savedAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = savedAgentDir;
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	async function start(
		options: {
			traceEnabled?: boolean;
			allowedWritePath?: string;
			answer?: (title: string, choices: string[]) => string | undefined;
		} = {},
	): Promise<{ harness: Harness; selects: string[][] }> {
		const harness = await createHarness({
			extensionFactories: [
				{ name: "trace", factory: traceExtension },
				{ name: "permissions", factory: permissionsExtension },
			],
			settings: { traceEnabled: options.traceEnabled ?? true, traceRetentionDays: 7 },
		});
		harnesses.push(harness);
		if (options.allowedWritePath) {
			writeFileSync(
				join(agentDir, "permissions.json"),
				JSON.stringify({ mode: "ask", allow: [`write(${options.allowedWritePath})`] }),
			);
		}
		const selects: string[][] = [];
		const uiContext: ExtensionUIContext = {
			...createTestUiContext(),
			select: async (title, choices) => {
				selects.push(choices);
				return options.answer?.(title, choices);
			},
		};
		await harness.session.bindExtensions({ uiContext });
		return { harness, selects };
	}

	async function runWrite(harness: Harness, path: string, content: string): Promise<void> {
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path, content }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
	}

	it("records tool calls, permission decisions and outcomes in order and masks stored auth keys", async () => {
		writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ fake: { type: "api_key", key: secret } }));
		let promptNumber = 0;
		const { harness, selects } = await start({
			allowedWritePath: "**/allowed.txt",
			answer: (_title, choices) => {
				promptNumber++;
				return promptNumber === 1
					? choices.find((choice) => choice.startsWith("Allow once"))
					: choices.find((choice) => choice.startsWith("Block this action once"));
			},
		});
		await runWrite(harness, join(harness.tempDir, "allowed.txt"), "rule");
		await runWrite(harness, join(harness.tempDir, "asked.txt"), secret);
		await runWrite(harness, join(harness.tempDir, "denied.txt"), "denied");
		const traceDir = join(agentDir, "traces");
		const fileName = readdirSync(traceDir).find((name) => name.endsWith(".jsonl"))!;
		expect(statSync(traceDir).mode & 0o777).toBe(0o700);
		expect(statSync(join(traceDir, fileName)).mode & 0o777).toBe(0o600);
		const raw = readFileSync(join(traceDir, fileName), "utf8");
		expect(raw).not.toContain(secret);
		const records = parseTrace(join(traceDir, fileName));
		const operations = records.filter((record) => record.type === "operation");
		const permissions = records.filter((record) => record.type === "permission");
		expect(operations.map((record) => (record.parameters as { path: string }).path)).toEqual([
			join(harness.tempDir, "allowed.txt"),
			join(harness.tempDir, "asked.txt"),
			join(harness.tempDir, "denied.txt"),
		]);
		expect(permissions.map((record) => record.state)).toEqual(["allowed_by_rule", "asked_granted_once", "denied"]);
		for (let index = 0; index < operations.length; index++) {
			expect(permissions[index]!.toolCallId).toBe(operations[index]!.toolCallId);
		}
		for (const record of records) {
			expect(record).toMatchObject({
				schemaVersion: 1,
				sessionId: harness.sessionManager.getSessionId(),
				toolCallId: expect.any(String),
				turnIndex: expect.any(Number),
			});
			expect(new Date(record.timestamp as string).toISOString()).toBe(record.timestamp);
		}
		expect(
			records.some(
				(record) => record.type === "result" && record.state === "success" && typeof record.durationMs === "number",
			),
		).toBe(true);
		expect(
			records.some(
				(record) =>
					record.type === "result" && record.toolCallId === operations[2]!.toolCallId && record.state === "error",
			),
		).toBe(true);
		expect(selects).toHaveLength(2);
	});

	it("truncates large parameters with a marker and their original length", async () => {
		const { harness } = await start();
		await runWrite(harness, "large.txt", "x".repeat(20_000));
		const file = join(agentDir, "traces", readdirSync(join(agentDir, "traces"))[0]!);
		const operation = parseTrace(file).find((record) => record.type === "operation")!;
		expect(operation.parameters).toMatchObject({ marker: "[TRUNCATED]", originalLength: expect.any(Number) });
		expect(operation.parameterLength).toBeGreaterThan(16_000);
	});

	it("deletes trace files older than retention on startup and keeps recent files", async () => {
		const traceDir = join(agentDir, "traces");
		mkdirSync(traceDir);
		const oldFile = join(traceDir, "old.jsonl");
		const recentFile = join(traceDir, "recent.jsonl");
		writeFileSync(oldFile, "{}\n");
		writeFileSync(recentFile, "{}\n");
		const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
		utimesSync(oldFile, old, old);
		await start();
		expect(readdirSync(traceDir)).toContain("recent.jsonl");
		expect(readdirSync(traceDir)).not.toContain("old.jsonl");
	});

	it("does not create a trace directory or write handlers when tracing is off", async () => {
		const { harness } = await start({ traceEnabled: false });
		await runWrite(harness, "not-traced.txt", "content");
		expect(readdirSync(agentDir)).not.toContain("traces");
	});
});

describe("fork: operation trace through the real CLI", () => {
	const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const fakeProvider = resolve(packageDir, "../../fork/tools/fake-provider.ts");

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("records the built-in extension's calls and permission decisions in order, without stored keys", async () => {
		const root = mkdtempSync(join(tmpdir(), "prism-trace-cli-"));
		tempDirs.push(root);
		const cwd = join(root, "work");
		const agentDir = join(root, "agent");
		const packageRoot = join(root, "package");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		// These tests expect ask mode; without a configured mode Prism starts in broad.
		writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode: "ask" }));
		mkdirSync(join(packageRoot, "bin"), { recursive: true });
		writeFileSync(
			join(packageRoot, "package.json"),
			JSON.stringify({ type: "module", piConfig: { name: "prism", configDir: ".prism" } }),
		);
		for (const name of ["src", "docs", "examples", "vendor"])
			symlinkSync(join(packageDir, name), join(packageRoot, name), "dir");
		const prism = join(packageRoot, "bin", "prism");
		writeFileSync(prism, `import ${JSON.stringify(pathToFileURL(join(packageDir, "src/cli.ts")).href)};\n`);
		writeFileSync(join(cwd, "sample.ts"), "sample contents\n");
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ traceEnabled: true }));
		writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ fake: { type: "api_key", key: secret } }));

		const child = spawn(
			process.execPath,
			[
				"--import",
				pathToFileURL(join(packageDir, "src/experimental/source-resolver.ts")).href,
				prism,
				"--mode",
				"rpc",
				"-e",
				fakeProvider,
				"--provider",
				"fake",
				"--model",
				"scripted",
				"--no-session",
			],
			{
				cwd,
				env: {
					...process.env,
					PI_PACKAGE_DIR: packageRoot,
					PI_CODING_AGENT_DIR: agentDir,
					PRISM_CODING_AGENT_DIR: agentDir,
					[ENV_AGENT_DIR]: agentDir,
					PI_OFFLINE: "1",
				},
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		let stderr = "";
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		const prompts = [
			`call read ${JSON.stringify({ path: "sample.ts" })}`,
			`call write ${JSON.stringify({ path: "granted.txt", content: secret })}`,
			`call write ${JSON.stringify({ path: "denied.txt", content: "no" })}`,
		];
		// the label of the key in the second call is put back after its own question (secrets/reveal.ts).
		const answers = ["Allow once", "Yes, this time", "Block this action once"];
		const send = (record: unknown) => child.stdin.write(`${JSON.stringify(record)}\n`);
		let timer: NodeJS.Timeout | undefined;
		try {
			await Promise.race([
				new Promise<void>((resolveDone, reject) => {
					let buffer = "";
					child.once("close", (code) => reject(new Error(`CLI exited early (${code})\n${stderr}`)));
					child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
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
							if (record.type === "agent_settled") {
								const next = prompts.shift();
								if (next) send({ type: "prompt", message: next });
								else resolveDone();
							}
							if (record.type === "extension_ui_request" && record.method === "select") {
								const prefix = answers.shift() ?? "Block this action once";
								send({
									type: "extension_ui_response",
									id: record.id,
									value: record.options?.find((option) => option.startsWith(prefix)),
								});
							}
						}
					});
					send({ type: "prompt", message: prompts.shift() });
				}),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => reject(new Error(`CLI timeout\n${stderr}`)), 60_000);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
			child.kill("SIGKILL");
		}

		const traceDir = join(agentDir, "traces");
		const files = readdirSync(traceDir).filter((name) => name.endsWith(".jsonl"));
		expect(files).toHaveLength(1);
		const file = join(traceDir, files[0] ?? "");
		expect(readFileSync(file, "utf8")).not.toContain(secret);
		const sequence = parseTrace(file).map((record) => `${record.type}:${record.toolName}:${record.state}`);
		expect(sequence).toEqual([
			"operation:read:called",
			"permission:read:allowed_by_rule",
			"result:read:success",
			"operation:write:called",
			"permission:write:asked_granted_once",
			"result:write:success",
			"operation:write:called",
			"permission:write:denied",
			"result:write:error",
		]);
		// fork (review lot 2, F-H3 (a)): the key in the prompt never reaches the model, which writes its label;
		// Prism puts the key back in at the write, after a yes, and the trace still holds only the label.
		expect(readFileSync(join(cwd, "granted.txt"), "utf8")).toBe(secret);
	}, 70_000);
});
