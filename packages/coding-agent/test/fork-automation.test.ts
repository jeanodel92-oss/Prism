import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(testDir, "..");
const repoRoot = resolve(packageDir, "../..");
const resolverUrl = pathToFileURL(join(packageDir, "src/experimental/source-resolver.ts")).href;
const cliUrl = pathToFileURL(join(packageDir, "src/cli.ts")).href;
const fakeProvider = resolve(repoRoot, "fork/tools/fake-provider.ts");
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(): { root: string; cwd: string; agentDir: string; packageRoot: string; prism: string } {
	const root = mkdtempSync(join(tmpdir(), "prism-automation-"));
	tempDirs.push(root);
	const cwd = join(root, "work");
	const agentDir = join(root, "agent");
	const packageRoot = join(root, "package");
	const binDir = join(packageRoot, "bin");
	const prism = join(binDir, "prism");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	// These tests expect ask mode; without a configured mode Prism starts in broad.
	writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode: "ask" }));
	mkdirSync(binDir, { recursive: true });
	writeFileSync(
		join(packageRoot, "package.json"),
		JSON.stringify({ type: "module", piConfig: { name: "prism", configDir: ".prism" } }),
	);
	symlinkSync(join(packageDir, "src"), join(packageRoot, "src"), "dir");
	symlinkSync(join(packageDir, "docs"), join(packageRoot, "docs"), "dir");
	symlinkSync(join(packageDir, "examples"), join(packageRoot, "examples"), "dir");
	symlinkSync(join(packageDir, "vendor"), join(packageRoot, "vendor"), "dir");
	writeFileSync(prism, `import ${JSON.stringify(cliUrl)};\n`);
	return { root, cwd, agentDir, packageRoot, prism };
}

interface ChildResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

function startPrism(prism: string, cwd: string, agentDir: string, args: string[]) {
	const child = spawn(process.execPath, ["--import", resolverUrl, prism, ...args], {
		cwd,
		env: {
			...process.env,
			PI_PACKAGE_DIR: dirname(dirname(prism)),
			PRISM_CODING_AGENT_DIR: agentDir,
			PI_OFFLINE: "1",
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
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

async function finishChild(
	process: ReturnType<typeof startPrism>,
	input?: string,
	timeoutMs = 30_000,
): Promise<ChildResult> {
	const { child } = process;
	child.stdin.end(input);
	let timer: NodeJS.Timeout | undefined;
	try {
		const code = await Promise.race([
			new Promise<number | null>((resolveCode, reject) => {
				child.once("error", reject);
				child.once("close", resolveCode);
			}),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() =>
						reject(
							new Error(
								`prism did not exit within ${timeoutMs}ms\nstdout: ${process.stdout}\nstderr: ${process.stderr}`,
							),
						),
					timeoutMs,
				);
			}),
		]);
		return { code, stdout: process.stdout, stderr: process.stderr };
	} finally {
		if (timer) clearTimeout(timer);
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
}

function records(output: string): Array<Record<string, unknown>> {
	return output
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const value: unknown = JSON.parse(line);
			if (typeof value !== "object" || value === null || Array.isArray(value))
				throw new Error("Expected JSON object");
			return value as Record<string, unknown>;
		});
}

async function waitForRecordType(child: ReturnType<typeof startPrism>, type: string): Promise<void> {
	let buffer = "";
	let timer: NodeJS.Timeout | undefined;
	try {
		await Promise.race([
			new Promise<void>((resolveWait, reject) => {
				child.child.stdout.on("data", (chunk: string) => {
					buffer += chunk;
					const lines = buffer.split("\n");
					buffer = lines.pop() ?? "";
					for (const line of lines) {
						if (line && records(line).some((record) => record.type === type)) resolveWait();
					}
				});
				child.child.once("close", (code) => reject(new Error(`prism exited with ${code} before ${type}`)));
			}),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`prism did not emit ${type} within 30000ms`)), 30_000);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

describe("Prism automation entry points", () => {
	test("print mode blocks a confirmation without UI and permits an explicitly allowed write", async () => {
		const denied = setup();
		const blocked = startPrism(denied.prism, denied.cwd, denied.agentDir, [
			"-ne",
			"-e",
			fakeProvider,
			"--provider",
			"fake",
			"--model",
			"scripted",
			"--no-session",
			"-p",
			'call write {"path":"blocked.txt","content":"no"}',
		]);
		const blockedResult = await finishChild(blocked);
		expect(blockedResult.code, `${blockedResult.stdout}\n${blockedResult.stderr}`).toBe(0);
		expect(blockedResult.stdout).toContain("ok");
		expect(blockedResult.stdout + blockedResult.stderr).toMatch(/needs confirmation|non-interactive|Blocked/i);
		expect(blockedResult.stderr).toContain("Re-run prism");
		expect(() => readFileSync(join(denied.cwd, "blocked.txt"))).toThrow();

		const allowed = setup();
		writeFileSync(join(allowed.agentDir, "permissions.json"), JSON.stringify({ mode: "broad" }));
		const writing = startPrism(allowed.prism, allowed.cwd, allowed.agentDir, [
			"-ne",
			"-e",
			fakeProvider,
			"--provider",
			"fake",
			"--model",
			"scripted",
			"--no-session",
			"-p",
			'call write {"path":"allowed.txt","content":"yes"}',
		]);
		const allowedResult = await finishChild(writing);
		expect(allowedResult.code).toBe(0);
		expect(readFileSync(join(allowed.cwd, "allowed.txt"), "utf8")).toBe("yes");
	}, 80_000);

	test("JSON mode emits valid event records", async () => {
		const env = setup();
		const child = startPrism(env.prism, env.cwd, env.agentDir, [
			"-ne",
			"--mode",
			"json",
			"-e",
			fakeProvider,
			"--provider",
			"fake",
			"--model",
			"scripted",
			"--no-session",
			"hello",
		]);
		const result = await finishChild(child);
		expect(result.code).toBe(0);
		const output = records(result.stdout);
		expect(output.map((record) => record.type)).toContain("agent_start");
		expect(output.map((record) => record.type)).toContain("message_end");
	}, 40_000);

	test("RPC mode sends a confirmation to the client and applies its answer", async () => {
		const env = setup();
		const rpc = startPrism(env.prism, env.cwd, env.agentDir, [
			"-ne",
			"--mode",
			"rpc",
			"-e",
			fakeProvider,
			"--provider",
			"fake",
			"--model",
			"scripted",
		]);
		try {
			let buffer = "";
			rpc.child.stdout.on("data", (chunk: string) => {
				buffer += chunk;
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const record of records(lines.join("\n"))) {
					if (record.type !== "extension_ui_request" || record.method !== "select") continue;
					const options = record.options as string[];
					const value = options.find((option) => option.startsWith("Allow once"));
					rpc.child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: record.id, value })}\n`);
				}
			});
			rpc.child.stdin.write(
				`${JSON.stringify({ id: "prompt-1", type: "prompt", message: 'call write {"path":"rpc.txt","content":"rpc"}' })}\n`,
			);
			await waitForRecordType(rpc, "agent_settled");
			const result = await finishChild(rpc, undefined, 10_000);
			expect(result.code).toBe(0);
			expect(records(result.stdout)).toContainEqual(
				expect.objectContaining({ type: "extension_ui_request", method: "select" }),
			);
			expect(readFileSync(join(env.cwd, "rpc.txt"), "utf8")).toBe("rpc");
		} finally {
			if (rpc.child.exitCode === null && rpc.child.signalCode === null) rpc.child.kill("SIGKILL");
		}
	}, 45_000);

	test("RPC mode accepts a prompt and exits after stdin closes", async () => {
		const env = setup();
		const rpc = startPrism(env.prism, env.cwd, env.agentDir, [
			"-ne",
			"--mode",
			"rpc",
			"-e",
			fakeProvider,
			"--provider",
			"fake",
			"--model",
			"scripted",
		]);
		try {
			rpc.child.stdin.write(`${JSON.stringify({ id: "prompt-1", type: "prompt", message: "md" })}\n`);
			await waitForRecordType(rpc, "agent_settled");
			const result = await finishChild(rpc, undefined, 10_000);
			expect(result.code).toBe(0);
			const output = records(result.stdout);
			expect(output).toContainEqual(
				expect.objectContaining({ type: "response", command: "prompt", id: "prompt-1", success: true }),
			);
			expect(
				output.map((record) => record.type),
				JSON.stringify(output),
			).toContain("agent_settled");
		} finally {
			if (rpc.child.exitCode === null && rpc.child.signalCode === null) rpc.child.kill("SIGKILL");
		}
	}, 45_000);
});
