/**
 * fork: every child Prism starts runs in its own process group, is stopped with
 * SIGTERM then SIGKILL to the group, and has ended only once the group is seen empty.
 */
import { mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { execCommand } from "../src/core/exec.ts";
import backgroundExtension, { backgroundTasks } from "../src/fork/background.ts";
import { groupAlive, type Launched, launch } from "../src/fork/child-process.ts";
import { getToolPath } from "../src/utils/tools-manager.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

// A throwaway agent dir, set before the tools manager reads it (vitest hoists this above the imports).
const agentDir = vi.hoisted(() => {
	const dir = `${process.env.TMPDIR ?? "/tmp"}/prism-child-process-${process.pid}`;
	process.env.PRISM_CODING_AGENT_DIR = dir;
	process.env.PI_CODING_AGENT_DIR = dir;
	return dir;
});

// A background task's .pid file can be made to fail, as in a bg/ folder that stopped being writable.
const failure = vi.hoisted(() => ({ pidWrite: false }));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		writeFileSync: ((path: unknown, ...rest: unknown[]) => {
			if (failure.pidWrite && String(path).endsWith(".log.pid"))
				throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
			return (actual.writeFileSync as (...args: unknown[]) => void)(path, ...rest);
		}) as typeof actual.writeFileSync,
	};
});

/** A shell loop that ignores SIGTERM, as does everything it starts (an ignored signal stays ignored across exec). */
const STUBBORN = 'trap "" TERM; while :; do sleep 0.05; done';

const launched: Launched[] = [];
afterEach(async () => {
	await Promise.all(launched.splice(0).map((entry) => entry.stop()));
});
afterAll(() => rmSync(agentDir, { recursive: true, force: true }));

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function firstLine(stream: Readable): Promise<string> {
	let text = "";
	for await (const chunk of stream) {
		text += String(chunk);
		if (text.includes("\n")) break;
	}
	return text.split("\n")[0] ?? "";
}

function start(script: string, options: Parameters<typeof launch>[2] = {}): Launched {
	const entry = launch("sh", ["-c", script], { stdio: ["ignore", "pipe", "ignore"], graceMs: 300, ...options });
	launched.push(entry);
	return entry;
}

describe("fork: children held by their process group", () => {
	it("stops a group that ignores SIGTERM, descendants included, and ends only once it is empty", async () => {
		const entry = start(`trap "" TERM; sh -c 'while :; do sleep 0.05; done' & echo $!; while :; do sleep 0.05; done`);
		const grandchild = Number(await firstLine(entry.child.stdout as Readable));
		expect(alive(grandchild)).toBe(true);
		let ended = false;
		void entry.ended.then(() => {
			ended = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(ended).toBe(false);
		const startedAt = Date.now();
		await expect(entry.stop()).resolves.toEqual({ confirmed: true });
		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(300);
		expect(groupAlive(entry.pgid as number)).toBe(false);
		expect(alive(grandchild)).toBe(false);
		await expect(entry.ended).resolves.toEqual({ confirmed: true });
	});

	it("waits for the descendant that ignores SIGTERM when the first process quits on it", async () => {
		const entry = start(`(${STUBBORN}) & echo $!; wait`);
		const worker = Number(await firstLine(entry.child.stdout as Readable));
		const startedAt = Date.now();
		await expect(entry.stop()).resolves.toEqual({ confirmed: true });
		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(300);
		expect(alive(worker)).toBe(false);
	});

	it("keeps a launcher's group until its worker ends", async () => {
		const entry = start("sleep 30 & echo $!", { stdio: ["ignore", "pipe", "ignore"] });
		const worker = Number(await firstLine(entry.child.stdout as Readable));
		let ended = false;
		void entry.ended.then(() => {
			ended = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(ended).toBe(false);
		expect(alive(worker)).toBe(true);
		await entry.stop();
		await entry.ended;
		expect(alive(worker)).toBe(false);
	});

	it("stops a child past its time limit", async () => {
		const entry = start(STUBBORN, { timeoutMs: 200, graceMs: 200 });
		await expect(entry.ended).resolves.toEqual({ confirmed: true });
		expect(entry.timedOut).toBe(true);
	});

	it("never signals a group it saw empty", async () => {
		const entry = start("exit 0");
		await entry.ended;
		const kill = vi.spyOn(process, "kill");
		try {
			await entry.stop();
			expect(kill).not.toHaveBeenCalled();
		} finally {
			kill.mockRestore();
		}
	});

	it("pi.exec kills a command that ignores SIGTERM, on timeout and on abort", async () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 200);
		const startedAt = Date.now();
		const [timedOut, aborted] = await Promise.all([
			execCommand("sh", ["-c", STUBBORN], tmpdir(), { timeout: 200 }),
			execCommand("sh", ["-c", STUBBORN], tmpdir(), { signal: controller.signal }),
		]);
		expect({ timedOut: timedOut.killed, aborted: aborted.killed }).toEqual({ timedOut: true, aborted: true });
		// About 5.2 s (the grace before SIGKILL); a command never killed runs on forever.
		expect(Date.now() - startedAt).toBeLessThan(12_000);
	}, 20_000);

	// the timeout stayed armed after the command exited.
	it("pi.exec leaves running the worker a command started once the command has exited", async () => {
		const pidFile = join(agentDir, "worker.pid");
		mkdirSync(agentDir, { recursive: true });
		const controller = new AbortController();
		const result = await execCommand(
			"sh",
			["-c", `sleep 30 >/dev/null 2>&1 & echo $! > ${pidFile}; echo started`],
			tmpdir(),
			{ timeout: 300, signal: controller.signal },
		);
		expect({ code: result.code, killed: result.killed, stdout: result.stdout.trim() }).toEqual({
			code: 0,
			killed: false,
			stdout: "started",
		});
		const worker = Number(readFileSync(pidFile, "utf8"));
		try {
			await new Promise((done) => setTimeout(done, 600));
			controller.abort();
			await new Promise((done) => setTimeout(done, 300));
			expect(() => process.kill(worker, 0)).not.toThrow();
		} finally {
			try {
				process.kill(worker, "SIGKILL");
			} catch {}
		}
	}, 15_000);

	it("gives up on a tool candidate that never answers --version", () => {
		const bin = join(agentDir, "fake-path");
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "fd"), "#!/bin/sh\nexec /bin/sleep 61.37\n", { mode: 0o755 });
		const savedPath = process.env.PATH;
		process.env.PATH = bin;
		try {
			const startedAt = Date.now();
			expect(getToolPath("fd")).toBeNull();
			// About 5 s (the probe's timeout); the candidate itself answers after 61 s.
			expect(Date.now() - startedAt).toBeLessThan(30_000);
		} finally {
			process.env.PATH = savedPath;
		}
	}, 20_000);
});

describe("fork: a background task that fails to start releases what it acquired", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		failure.pidWrite = false;
		for (const harness of harnesses.splice(0)) harness.cleanup();
		rmSync(join(agentDir, "settings.json"), { force: true });
	}, 60_000);

	/** Descriptors of this process open on a background log. */
	const openLogs = () =>
		readdirSync("/proc/self/fd").filter((fd) => {
			try {
				return readlinkSync(`/proc/self/fd/${fd}`).startsWith(join(agentDir, "bg"));
			} catch {
				return false;
			}
		}).length;

	async function run(command: string): Promise<Harness> {
		const harness = await createHarness({
			extensionFactories: [{ name: "background", factory: backgroundExtension }],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("background", { action: "run", command }), { stopReason: "toolUse" }),
			fauxAssistantMessage("seen"),
		]);
		await harness.session.prompt("start a task");
		return harness;
	}

	it("opens no log when the configured shell is missing", async () => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ shellPath: join(agentDir, "no-such-shell") }));
		const before = openLogs();
		await run("echo never");
		expect(backgroundTasks() ?? []).toHaveLength(0);
		expect(openLogs()).toBe(before);
		expect(readdirSync(join(agentDir, "bg")).filter((name) => name.endsWith(".log"))).toEqual([]);
	});

	it("stops the started command and closes its log when a later step fails", async () => {
		failure.pidWrite = true;
		await run("exec sleep 62.41");
		expect(backgroundTasks() ?? []).toHaveLength(0);
		await vi.waitFor(
			() => {
				const running = readdirSync("/proc").filter((pid) => {
					try {
						return /^\d+$/.test(pid) && readlinkSync(`/proc/${pid}/exe`).endsWith("sleep")
							? readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("62.41")
							: false;
					} catch {
						return false;
					}
				});
				expect(running).toEqual([]);
				expect(openLogs()).toBe(0);
			},
			{ timeout: 5000 },
		);
	});
});
