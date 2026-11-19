import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { builtInExtensions } from "../src/extensions/index.ts";
import { getPiInvocation } from "../src/fork/child-invocation.ts";
import {
	diffPrompt,
	formatNoisyDelta,
	formatProcessDelta,
	measureModuleCosts,
	median,
	type PromptSnapshot,
} from "../src/fork/module-cost.ts";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resolverUrl = pathToFileURL(join(packageDir, "src/experimental/source-resolver.ts")).href;
const promptProbe = resolve(packageDir, "../../fork/tools/prompt-probe.ts");
const oldTestDirs: string[] = [];

interface PromptDump {
	systemMessages: Array<{
		sections: Record<string, string | null>;
		toolsAdded: Array<{ name: string }>;
	}>;
}

afterEach(() => {
	for (const dir of oldTestDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function firstRequest(extensions: string[]): PromptDump {
	const root = mkdtempSync(join(tmpdir(), "prism-module-cost-regression-"));
	oldTestDirs.push(root);
	const agentDir = join(root, "agent");
	const cwd = join(root, "workspace");
	const home = join(root, "home");
	mkdirSync(agentDir);
	mkdirSync(cwd);
	mkdirSync(home);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions }));
	const outputPath = join(root, "request.json");
	const result = spawnSync(
		process.execPath,
		[
			"--import",
			resolverUrl,
			join(packageDir, "src/experimental/cli.ts"),
			"--no-session",
			"--extension",
			promptProbe,
			"--model",
			"probe/dump",
			"-p",
			"hi",
		],
		{
			cwd,
			env: {
				PATH: process.env.PATH ?? "",
				TMPDIR: tmpdir(),
				HOME: home,
				PI_CODING_AGENT_DIR: agentDir,
				PRISM_CODING_AGENT_DIR: agentDir,
				PI_OFFLINE: "1",
				PRISM_PROMPT_OUT: outputPath,
			},
			encoding: "utf8",
			timeout: 60_000,
		},
	);
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(readFileSync(outputPath, "utf8")) as PromptDump;
}

const promptTools = (dump: PromptDump) =>
	dump.systemMessages.flatMap((message) => message.toolsAdded.map((tool) => tool.name));
const promptSections = (dump: PromptDump) => dump.systemMessages.flatMap((message) => Object.keys(message.sections));

function snapshot(overrides: Partial<PromptSnapshot> = {}): PromptSnapshot {
	return {
		systemMessages: [{ content: "base", sections: {}, toolsAdded: [], toolsRemoved: [] }],
		rss: 1,
		startupMs: 1,
		children: 0,
		...overrides,
	};
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, { cwd, env, stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("close", (code) =>
			code === 0 ? resolvePromise(stderr) : reject(new Error(stderr || `Child exited ${code}`)),
		);
	});
}

describe("fork: modules turned off cost nothing in the prompt", () => {
	it("leaves only pi's own prompt and tools with every built-in module off", () => {
		const names = builtInExtensions.flatMap((entry) =>
			typeof entry !== "function" && entry.builtin ? [entry.name] : [],
		);
		const on = firstRequest([]);
		const off = firstRequest(names.map((name) => `-builtin:${name}`));
		expect(promptTools(on)).toEqual(expect.arrayContaining(["background", "web_fetch"]));
		// off by default, the model does not see it.
		expect(promptTools(on)).not.toContain("session_search");
		expect(promptSections(on)).toEqual(expect.arrayContaining(["addendum", "language"]));
		expect(promptTools(off).sort()).toEqual(["bash", "edit", "read", "write"]);
		expect(promptSections(off)).not.toEqual(expect.arrayContaining(["addendum"]));
		expect(promptSections(off)).not.toContain("language");
		expect(promptSections(off)).not.toContain("skills");
	}, 120_000);
});

describe("fork module cost", () => {
	it("calculates medians, noise, process unknowns and prompt diffs", () => {
		assert.equal(median([]), undefined);
		assert.equal(median([8, 2, 5]), 5);
		assert.equal(median([2, 8]), 5);
		assert.equal(formatNoisyDelta([10, 12, 11], [11, 12, 13], "ms"), "below noise (±2 ms)");
		assert.equal(formatNoisyDelta([], [1], "ms"), "unknown");
		assert.equal(formatProcessDelta([0, 0, 0], [1, 1, 1], "darwin"), "unknown");
		assert.equal(formatProcessDelta([0, undefined], [1, 1]), "unknown");
		assert.equal(formatProcessDelta([0, 0, 0], [1, 1, 1], "linux"), "+1");

		const sharedTool = { name: "shared", description: "shared definition", parameters: { type: "object" } };
		const before = snapshot({
			systemMessages: [{ content: "base", sections: { keep: "same" }, toolsAdded: [sharedTool], toolsRemoved: [] }],
		});
		const after = snapshot({
			systemMessages: [{ content: "base", sections: { keep: "same" }, toolsAdded: [sharedTool], toolsRemoved: [] }],
		});
		assert.equal(diffPrompt(before, after).changed, false);
		// A section that gains one line costs that line, not the whole section on both sides.
		const tools = (lines: string[]) =>
			snapshot({
				systemMessages: [
					{ content: "base", sections: { tools: lines.join("\n") }, toolsAdded: [], toolsRemoved: [] },
				],
			});
		const oneMore = diffPrompt(
			tools(["- read: Read files", "- bash: Run commands"]),
			tools(["- read: Read files", "- bash: Run commands", "- web: Search"]),
		);
		assert.equal(oneMore.removedTokens, 0);
		assert.equal(oneMore.addedTokens, Math.ceil("- web: Search".length / 4));
		// A module that rewrites the base text (memory) is not missed.
		const rewritten = diffPrompt(
			before,
			snapshot({
				systemMessages: [
					{
						content: "base\n\n## Memory\nnotes",
						sections: { keep: "same" },
						toolsAdded: [sharedTool],
						toolsRemoved: [],
					},
				],
			}),
		);
		assert.equal(rewritten.changed, true);
		assert.ok(rewritten.addedTokens > 0);
		assert.deepEqual(
			diffPrompt(
				before,
				snapshot({
					systemMessages: [
						{
							content: "base",
							sections: { keep: "same", language: "Reply in French" },
							toolsAdded: [sharedTool],
							toolsRemoved: [],
						},
					],
				}),
			).addedSections,
			["language"],
		);
	});

	it("measures reply-language and confirms the probe is inert without its output env var", async () => {
		const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
		const temp = await mkdtemp(join(tmpdir(), "prism-module-cost-test-"));
		const originalScript = process.argv[1];
		const originalExecArgv = [...process.execArgv];
		const cli = join(root, "packages/coding-agent/src/experimental/cli.ts");
		const resolver = pathToFileURL(join(root, "packages/coding-agent/src/experimental/source-resolver.ts")).href;
		try {
			process.argv[1] = cli;
			process.execArgv.splice(0, process.execArgv.length, "--import", resolver);
			const report = await measureModuleCosts({
				modules: [{ name: "reply-language", enabled: true }],
				globalExtensions: [],
				selected: "reply-language",
				signal: new AbortController().signal,
				onProgress: () => {},
			});
			assert.deepEqual(report.rows[0]?.prompt.addedSections, ["language"]);
			assert.equal(report.rows[0]?.prompt.removedSections.length, 0);

			const agentDir = join(temp, "agent");
			const home = join(temp, "home");
			const cwd = join(temp, "cwd");
			await Promise.all([mkdir(agentDir), mkdir(home), mkdir(cwd)]);
			await writeFile(join(agentDir, "settings.json"), JSON.stringify({ extensions: [] }));
			const outputPath = join(temp, "normal-prompt.json");
			const invocation = getPiInvocation([
				"--no-session",
				"--extension",
				join(root, "fork/tools/prompt-probe.ts"),
				"--model",
				"probe/dump",
				"-p",
				"hi",
			]);
			const env = {
				PATH: process.env.PATH ?? "",
				TMPDIR: tmpdir(),
				HOME: home,
				PI_CODING_AGENT_DIR: agentDir,
				PRISM_CODING_AGENT_DIR: agentDir,
				PI_OFFLINE: "1",
				PRISM_PROMPT_OUT: outputPath,
			};
			await run(invocation.command, invocation.args, cwd, env);
			const normal = JSON.parse(await readFile(outputPath, "utf8")) as Pick<PromptSnapshot, "systemMessages">;
			await writeFile(
				join(agentDir, "settings.json"),
				JSON.stringify({ extensions: ["-builtin:module-cost-probe"] }),
			);
			const controlPath = join(temp, "control-prompt.json");
			await run(invocation.command, invocation.args, cwd, { ...env, PRISM_PROMPT_OUT: controlPath });
			const control = JSON.parse(await readFile(controlPath, "utf8")) as Pick<PromptSnapshot, "systemMessages">;
			assert.deepEqual(normal.systemMessages, control.systemMessages);
			assert.ok(normal.systemMessages.some(({ sections }) => "language" in sections));
		} finally {
			process.argv[1] = originalScript;
			process.execArgv.splice(0, process.execArgv.length, ...originalExecArgv);
			await rm(temp, { recursive: true, force: true });
		}
	}, 120_000);
});
