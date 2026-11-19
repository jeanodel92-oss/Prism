// fork: where the time of a sandboxed command goes. Measurement only, skipped unless
// PRISM_SANDBOX_COST names an output folder; run it alone, on an idle machine. Each step of the real path
// (`createSandboxableBashOperations`) is wrapped where it is defined, so the runtime's own calls are the ones timed;
// the rest of the command's time is the processes: bubblewrap, the relay, the shell and the command.
//
//   PRISM_SANDBOX_COST=<dir> [PRISM_SANDBOX_COST_FOLDERS=<n>] [PRISM_SANDBOX_COST_RUNS=<n>]
//   [PRISM_SANDBOX_COST_PROJECT=<a disposable Git repository to run in, instead of a synthetic one>]
//   [PRISM_SANDBOX_COST_COMMAND=<command>]
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { createLocalBashOperations } from "../src/core/tools/bash.ts";
import { DEFAULT_SANDBOX_SETTINGS, type SandboxSettings } from "../src/fork/sandbox/layout.ts";
import { HostPolicy } from "../src/fork/sandbox/proxy.ts";
import {
	createSandboxableBashOperations,
	findBwrap,
	removeSessionTmpDir,
	sessionTmpDir,
	startSandbox,
	takeSandboxLayout,
} from "../src/fork/sandbox/runtime.ts";

const timing = vi.hoisted(() => {
	const spans: Record<string, number> = {};
	const timed = (name: string, fn: (...args: never[]) => unknown) =>
		function (this: unknown, ...args: never[]) {
			const start = performance.now();
			const done = () => {
				spans[name] = (spans[name] ?? 0) + performance.now() - start;
			};
			let result: unknown;
			try {
				result = fn.apply(this, args);
			} catch (error) {
				done();
				throw error;
			}
			if (result instanceof Promise) return result.finally(done);
			done();
			return result;
		};
	const wrap = <T extends Record<string, unknown>>(module: T, names: string[]): T => {
		const wrapped: Record<string, unknown> = { ...module };
		for (const name of names) wrapped[name] = timed(name, module[name] as (...args: never[]) => unknown);
		return wrapped as T;
	};
	return { spans, wrap };
});

vi.mock("../src/fork/sandbox/layout.ts", async (original) =>
	timing.wrap(await original(), ["buildLayout", "prepareLayout", "bwrapArgs", "readSandboxSettings"]),
);
vi.mock("../src/fork/sandbox/read-limit.ts", async (original) => timing.wrap(await original(), ["readableSet"]));
vi.mock("../src/fork/sandbox/nested-git.ts", async (original) =>
	timing.wrap(await original(), ["findRepositories", "checkNewRepositories"]),
);
vi.mock("../src/fork/sandbox/git-copy.ts", async (original) =>
	timing.wrap(await original(), ["prepareGitCopies", "finishGitCopy", "hooksLayer", "gitCopyArgs"]),
);
vi.mock("../src/fork/sandbox/tool-caches.ts", async (original) => timing.wrap(await original(), ["createToolCaches"]));
vi.mock("../src/fork/sandbox/tool-settings.ts", async (original) =>
	timing.wrap(await original(), ["rebuiltSettingsCopies"]),
);
vi.mock("../src/fork/sandbox/ssh-config.ts", async (original) => timing.wrap(await original(), ["sshConfigCopies"]));
vi.mock("../src/fork/sandbox/ssh-provenance.ts", async (original) => timing.wrap(await original(), ["sandboxWrites"]));
vi.mock("../src/fork/sandbox/proxy.ts", async (original) => timing.wrap(await original(), ["openNetworkChannel"]));

const out = process.env.PRISM_SANDBOX_COST;
const folders = Number(process.env.PRISM_SANDBOX_COST_FOLDERS ?? 0);
const runs = Number(process.env.PRISM_SANDBOX_COST_RUNS ?? 15);
const realProject = process.env.PRISM_SANDBOX_COST_PROJECT;
const bwrap = findBwrap();
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
const scratch = mkdtempSync(join(tmpdir(), "prism-sandbox-cost-"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

it.skipIf(!out || !bwrap)(
	"measures each step of a sandboxed command",
	async () => {
		const home = join(scratch, "home");
		const agentDir = join(home, "agent");
		const project = realProject ?? join(home, "project");
		mkdirSync(agentDir, { recursive: true });
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		vi.stubEnv("HOME", home);
		vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
		vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
		if (!realProject) {
			execFileSync("git", ["init", "-q", project]);
			writeFileSync(join(project, "value.txt"), "0\n");
			execFileSync("git", ["-C", project, "add", "value.txt"]);
			execFileSync("git", ["-C", project, "-c", "user.name=x", "-c", "user.email=x@x", "commit", "-qm", "initial"]);
		}
		// A synthetic tree, ten folders per folder, as large as asked.
		for (let index = 0; index < folders; index++)
			mkdirSync(join(project, "tree", ...String(index).split("")), { recursive: true });
		const settings: SandboxSettings = DEFAULT_SANDBOX_SETTINGS;
		const tmp = sessionTmpDir("sandbox-cost");
		const sandbox = await startSandbox(settings, project, new HostPolicy(() => settings.network, undefined), tmp);
		expect(sandbox).not.toHaveProperty("error");
		const sandboxed = createSandboxableBashOperations(() => sandbox);
		const plain = createLocalBashOperations({});
		const command = process.env.PRISM_SANDBOX_COST_COMMAND ?? (realProject ? "true" : "cat value.txt");
		const exec = async (operations: typeof plain) => {
			const start = performance.now();
			const { exitCode } = await operations.exec(command, project, { onData: () => {}, toolCallId: "cost" });
			expect(exitCode).toBe(0);
			return performance.now() - start;
		};
		const steps: Record<string, number[]> = {};
		const totals: number[] = [];
		const plains: number[] = [];
		const bare: number[] = [];
		// Warm-up: the first walk and the first copy fill their caches.
		const cold = await exec(sandboxed);
		const coldSteps = { ...timing.spans };
		// The measured path is the one with a private Git copy.
		const privateGit = takeSandboxLayout(sandbox as Parameters<typeof takeSandboxLayout>[0], "cost")?.privateGit;
		expect(privateGit).toHaveLength(1);
		for (let run = 0; run < runs; run++) {
			for (const name of Object.keys(timing.spans)) delete timing.spans[name];
			totals.push(await exec(sandboxed));
			for (const [name, ms] of Object.entries(timing.spans)) steps[name] = [...(steps[name] ?? []), ms];
			plains.push(await exec(plain));
			const start = performance.now();
			spawnSync(bwrap!, ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--", "/bin/true"]);
			bare.push(performance.now() - start);
		}
		removeSessionTmpDir("sandbox-cost");
		const measured = Object.fromEntries(Object.entries(steps).map(([name, values]) => [name, median(values)]));
		const lines = [
			`# Sandboxed \`${command}\`: medians of ${runs} runs, ${folders} extra folders`,
			"",
			`Private Git copy: ${JSON.stringify(privateGit ?? [])}`,
			"",
			"| Step | ms |",
			"|---|---|",
			`| whole command, sandboxed | ${median(totals).toFixed(1)} |`,
			`| first command (cold caches) | ${cold.toFixed(1)} |`,
			`| first command: findRepositories | ${(coldSteps.findRepositories ?? 0).toFixed(1)} |`,
			`| whole command, not sandboxed | ${median(plains).toFixed(1)} |`,
			`| bwrap alone (\`/bin/true\`, minimal mounts) | ${median(bare).toFixed(1)} |`,
			...Object.entries(measured)
				.sort(([, a], [, b]) => b - a)
				.map(([name, ms]) => `| ${name} | ${ms.toFixed(1)} |`),
			"",
			"Nested calls are counted in their caller too: `findRepositories` and `readableSet` are inside `buildLayout`.",
		];
		mkdirSync(out!, { recursive: true });
		writeFileSync(join(out!, "summary.md"), `${lines.join("\n")}\n`);
		writeFileSync(join(out!, "runs.json"), JSON.stringify({ totals, plains, bare, steps }));
	},
	600_000,
);
