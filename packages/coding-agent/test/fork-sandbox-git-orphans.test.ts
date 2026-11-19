// fork: private Git copies that a stop or a crash left unfinished are
// reported once at the next start and listed in /sandbox, never published, removed or resumed. Prism runs in a child
// process here, so that it can really stop or be killed. Real bubblewrap, real Git, disposable repositories.
import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { describeGitCopies } from "../src/fork/sandbox/git-orphans.ts";
import { DEFAULT_SANDBOX_SETTINGS } from "../src/fork/sandbox/layout.ts";
import { HostPolicy } from "../src/fork/sandbox/proxy.ts";
import {
	createSandboxableBashOperations,
	findBwrap,
	removeSessionTmpDir,
	type SessionSandbox,
	sessionTmpDir,
	startSandbox,
} from "../src/fork/sandbox/runtime.ts";

const bwrap = findBwrap();
const source = (path: string) => new URL(path, import.meta.url).pathname;

// A Prism: starts the sandbox for the repository, then runs a command, or starts a background task the way the
// background tool does and ends once the task has committed.
const PRISM = `
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
const [mode, repo, command] = process.argv.slice(1);
const runtime = await import(${JSON.stringify(source("../src/fork/sandbox/runtime.ts"))});
const { DEFAULT_SANDBOX_SETTINGS: settings } = await import(${JSON.stringify(source("../src/fork/sandbox/layout.ts"))});
const { HostPolicy } = await import(${JSON.stringify(source("../src/fork/sandbox/proxy.ts"))});
const sandbox = await runtime.startSandbox(settings, repo, new HostPolicy(() => settings.network, undefined), runtime.sessionTmpDir("orphans"));
if ("error" in sandbox) {
	console.error(sandbox.error);
	process.exit(3);
}
if (mode === "command") {
	await runtime.createSandboxableBashOperations(() => sandbox).exec(command, repo, { onData: () => {}, toolCallId: "orphans" });
	process.exit(0);
}
const channel = runtime.openSandboxNetwork(sandbox, { toolCallId: "task", command });
const task = runtime.sandboxTask(sandbox, repo, channel, ["/bin/sh", "-c", command], command, process.env);
const child = spawn("/bin/sh", ["-c", '"$@"; exit $?', "sh", ...task.argv], { cwd: repo, detached: true, stdio: "ignore" });
runtime.holdSessionTmp(sandbox.tmp, child.pid);
task.started(child.pid);
child.unref();
console.log(child.pid);
while (!existsSync(repo + "/committed")) await new Promise((resolve) => setTimeout(resolve, 50));
process.exit(0);
`;

describe.skipIf(!bwrap)("fork: private Git copies a stop or crash left", () => {
	let scratch: string;
	let agentDir: string;
	let repo: string;
	let prism: ChildProcess | undefined;
	let prismErrors = "";
	const env = {
		PATH: process.env.PATH,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
	};
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", repo, ...args], { env: { ...env, HOME: repo }, encoding: "utf8" }).trim();
	const copiesFolder = () => join(agentDir, "sandbox", "git-copies");
	const copies = () =>
		existsSync(copiesFolder()) ? readdirSync(copiesFolder()).filter((name) => !name.endsWith(".old")) : [];

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "prism-git-orphans-"));
		agentDir = join(scratch, "agent");
		repo = join(scratch, "repo");
		mkdirSync(agentDir);
		vi.stubEnv("HOME", join(scratch, "home"));
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) vi.stubEnv(key, undefined);
		for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
		mkdirSync(join(scratch, "home"));
		mkdirSync(repo);
		git("init", "-q", "-b", "main");
		git("config", "user.name", "Sandbox Test");
		git("config", "user.email", "sandbox@example.invalid");
		git("commit", "-q", "--allow-empty", "-m", "initial");
	});

	afterEach(() => {
		prism?.kill("SIGKILL");
		prism = undefined;
		removeSessionTmpDir("orphans-check");
		vi.unstubAllEnvs();
		rmSync(scratch, { recursive: true, force: true });
	});

	function runPrism(mode: "command" | "task", command: string): ChildProcess {
		prism = spawn(process.execPath, ["--input-type=module", "-e", PRISM, mode, repo, command], {
			env: { ...process.env, HOME: join(scratch, "home") },
			stdio: ["ignore", "pipe", "pipe"],
		});
		prismErrors = "";
		prism.stderr?.on("data", (data) => {
			prismErrors += String(data);
		});
		return prism;
	}
	const ended = (child: ChildProcess) =>
		new Promise<number | null>((resolve) => {
			if (child.exitCode !== null || child.signalCode !== null) resolve(child.exitCode);
			else child.once("exit", (code) => resolve(code));
		});
	async function waitFor(condition: () => boolean) {
		const deadline = Date.now() + 15_000;
		while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
		expect(condition()).toBe(true);
	}
	/** A later Prism starting: what it reports. */
	async function start(): Promise<SessionSandbox> {
		const settings = DEFAULT_SANDBOX_SETTINGS;
		return await startSandbox(
			settings,
			repo,
			new HostPolicy(() => settings.network, undefined),
			sessionTmpDir("orphans-check"),
		);
	}
	const running = (pattern: string) => spawnSync("pgrep", ["-f", pattern]).status === 0;
	const locks = () =>
		execFileSync("find", [join(repo, ".git"), "-name", "*.lock"], { encoding: "utf8" })
			.trim()
			.split("\n")
			.filter(Boolean);

	it("reports nothing after a normal stop: the command's changes were published", async () => {
		const child = runPrism("command", "git commit -q --allow-empty -m normal");
		expect(await ended(child), prismErrors).toBe(0);
		expect(git("log", "-1", "--format=%s")).toBe("normal");
		const sandbox = await start();
		expect(sandbox).not.toHaveProperty("error");
		expect(sandbox.gitReport).toBeUndefined();
		expect(describeGitCopies(copiesFolder())).toEqual(["Kept Git copies: (none)"]);
	});

	it("reports once, without publishing, a copy a killed Prism left while the repository moved on", async () => {
		const child = runPrism("command", "git commit -q --allow-empty -m orphan && touch committed && exec sleep 31.7");
		await waitFor(() => existsSync(join(repo, "committed")));
		// While that Prism runs, its copy is its own: another start neither reports nor lists it.
		expect((await start()).gitReport ?? "").not.toContain(join(repo, ".git"));
		expect(describeGitCopies(copiesFolder())).toEqual(["Kept Git copies: (none)"]);
		child.kill("SIGKILL");
		await ended(child);
		// bubblewrap dies with its parent: nothing writes the copy any more.
		await waitFor(() => !running("sleep 31.7"));
		// The repository moves on meanwhile.
		git("commit", "-q", "--allow-empty", "-m", "host");

		const sandbox = await start();
		expect(sandbox).not.toHaveProperty("error");
		const report = sandbox.gitReport ?? "";
		expect(report).toContain(`${join(repo, ".git")}: command "git commit -q --allow-empty -m orphan`);
		expect(report).toContain("before this command did, so its Git changes were not checked");
		expect(report).toContain("refs/heads/main:");
		// Nothing of it is applied, and nothing is removed.
		expect(git("log", "--format=%s")).toBe("host\ninitial");
		expect(locks()).toEqual([]);
		expect(copies()).toHaveLength(1);

		// /sandbox: its origin, its state, and a command that reads its commit with the repository's configuration.
		const lines = describeGitCopies(copiesFolder());
		expect(lines.join("\n")).toContain("not checked");
		expect(lines.join("\n")).toContain(`From: command "git commit -q --allow-empty -m orphan`);
		const read = lines
			.find((line) => line.includes("Read it with"))!
			.split(": ")
			.slice(1)
			.join(": ");
		expect(read).toContain(`--git-dir=${join(repo, ".git")} `);
		expect(execFileSync("sh", ["-c", `${read} -1 --format=%s`], { env, encoding: "utf8" }).trim()).toBe("orphan");

		// Once: a later start says nothing more; /sandbox still lists it.
		expect((await start()).gitReport).toBeUndefined();
		expect(describeGitCopies(copiesFolder()).join("\n")).toContain("not checked");
		expect(copies()).toHaveLength(1);
	}, 60_000);

	it("leaves a background task that outlives its Prism alone, then reports its copy once it ends", async () => {
		const child = runPrism(
			"task",
			"git commit -q --allow-empty -m task && touch committed && while [ ! -e go ]; do sleep 0.05; done",
		);
		let output = "";
		child.stdout?.on("data", (data) => {
			output += String(data);
		});
		expect(await ended(child), prismErrors).toBe(0);
		const pid = Number(output.trim());
		expect(pid).toBeGreaterThan(0);
		expect(existsSync(`/proc/${pid}`)).toBe(true);

		// Its Prism stopped normally; the task still works in its copy: not an orphan.
		expect((await start()).gitReport ?? "").not.toContain(join(repo, ".git"));
		const lines = describeGitCopies(copiesFolder()).join("\n");
		expect(lines).toContain("in use by a background task");
		expect(lines).toContain(`background task ${pid} still works in it`);
		expect(git("log", "-1", "--format=%s")).toBe("initial");

		writeFileSync(join(repo, "go"), "");
		await waitFor(() => !existsSync(`/proc/${pid}`));
		const report = (await start()).gitReport ?? "";
		expect(report).toContain(`${join(repo, ".git")}: background task "git commit -q --allow-empty -m task`);
		expect(report).toContain("before this background task did");
		expect(git("log", "-1", "--format=%s")).toBe("initial");
		expect(copies()).toHaveLength(1);
		expect((await start()).gitReport).toBeUndefined();
	}, 60_000);

	it("keeps a refused copy with its reasons, readable without running its configuration", async () => {
		const sandbox = await start();
		if ("error" in sandbox) throw new Error(sandbox.error);
		let output = "";
		await createSandboxableBashOperations(() => sandbox).exec(
			`git config core.pager "touch ${join(scratch, "ran")}; cat" && git commit -q --allow-empty -m refused`,
			repo,
			{
				onData: (data) => {
					output += String(data);
				},
				toolCallId: "refused",
			},
		);
		expect(output).toContain(`this command's Git changes were not applied to ${join(repo, ".git")}`);
		expect(output).toContain("Read it with the repository's own configuration");
		const [copy] = copies();
		expect(output).not.toContain(`--git-dir=${join(copiesFolder(), copy!)}`);
		const lines = describeGitCopies(copiesFolder()).join("\n");
		expect(lines).toContain("kept, its changes were refused");
		expect(lines).toContain("core.pager");
		// A refused copy was said at once, by the command's note: the next start does not report it again.
		expect((await start()).gitReport).toBeUndefined();
		expect(existsSync(join(scratch, "ran"))).toBe(false);
		// The read command in a terminal, where Git starts a pager: the one of the copy's configuration must not run.
		const read = /Read it with the repository's own configuration, not the copy's: (.+)$/m.exec(output)?.[1];
		expect(read).toBeDefined();
		const terminal = "import pty, sys\nsys.exit(pty.spawn(['sh', '-c', sys.argv[1]]) >> 8)";
		const shown = spawnSync("python3", ["-c", terminal, read!], {
			cwd: scratch,
			// No pager at all, not even the user's.
			env: { ...process.env, PAGER: `touch ${join(scratch, "paged")}; cat`, HOME: join(scratch, "home") },
			input: "",
			encoding: "utf8",
			timeout: 20_000,
		});
		expect(shown.status).toBe(0);
		expect(shown.stdout).toContain("refused");
		expect(existsSync(join(scratch, "ran"))).toBe(false);
		expect(existsSync(join(scratch, "paged"))).toBe(false);
	});

	it("reports an invalid recovery state without blocking the start, removing nothing", async () => {
		const folder = copiesFolder();
		const dead = spawnSync("true").pid!;
		const origin = (pid: number, start?: string) =>
			JSON.stringify({
				gitDir: join(repo, ".git"),
				cwd: repo,
				command: "true",
				task: false,
				prism: { pid, start },
				created: "2026-10-25T00:00:00.000Z",
			});
		mkdirSync(join(folder, "corrupt", "metadata"), { recursive: true });
		writeFileSync(join(folder, "corrupt", "origin.json"), "{");
		mkdirSync(join(folder, "bare", "metadata"), { recursive: true });
		// Copies being made: by a Prism that ended (only its origin: removed), by one whose pid another process now
		// has (removed), by one holding more, and by a live one.
		for (const [name, pid, start] of [
			[".ended", dead, undefined],
			[".reused", process.pid, "1"],
			[".more", dead, undefined],
			[".live", process.pid, undefined],
		] as const) {
			mkdirSync(join(folder, name));
			writeFileSync(join(folder, name, "origin.json"), origin(pid, start));
		}
		writeFileSync(join(folder, ".more", "other"), "");
		mkdirSync(join(agentDir, "sandbox", "git-journal"), { recursive: true });
		writeFileSync(join(agentDir, "sandbox", "git-journal", "cut.json"), "{");

		const sandbox = await start();
		expect(sandbox).not.toHaveProperty("error");
		const report = sandbox.gitReport ?? "";
		expect(report).toContain("cut.json: unreadable journal left in place");
		expect(report).toContain(`${join(folder, "corrupt")}: its origin.json is unreadable`);
		expect(report).toContain(`${join(folder, "bare")}: it has no origin.json`);
		expect(readdirSync(folder).sort()).toEqual([".live", ".more", "bare", "corrupt"]);
		expect(readFileSync(join(agentDir, "sandbox", "git-journal", "cut.json"), "utf8")).toBe("{");
		expect(describeGitCopies(folder).join("\n")).toContain("provenance unreadable");
		expect((await start()).gitReport ?? "").not.toContain("origin.json");
	});
});
