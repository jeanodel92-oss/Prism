/**
 * fork: a lock that
 * names a process is taken over only from a process that is gone, and a name another session may take is reserved by
 * an exclusive creation, never "look for a free name, then use it".
 */
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { firefoxRunning, launchFirefoxWithBidi, readBidiPort } from "../src/fork/browser/bidi.ts";
import { attachFile } from "../src/fork/file-attachments.ts";
import { processStamp, stampAlive, takeProcessLock } from "../src/fork/process-lock.ts";
import { sessionTmpDir } from "../src/fork/sandbox/runtime.ts";

let root: string;

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "prism-process-locks-")));
});

afterEach(() => {
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

/** A process that runs until killed. */
async function sleeper(): Promise<ChildProcess> {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	await once(child, "spawn");
	return child;
}

describe("fork: locks that name a process", () => {
	it("a process is its pid and its start time: the same pid started again is another process", async () => {
		const child = await sleeper();
		try {
			const stamp = processStamp(child.pid);
			expect(stamp?.start).toMatch(/^\d+$/);
			expect(stampAlive(stamp)).toBe(true);
			expect(stampAlive({ pid: child.pid, start: "1" })).toBe(false);
		} finally {
			child.kill("SIGKILL");
			await once(child, "exit");
		}
		expect(stampAlive(processStamp(process.pid))).toBe(true);
	});

	it("is refused while its process runs, taken over once it is gone, and released only while it is ours", async () => {
		const file = join(root, "task.lock");
		const child = await sleeper();
		writeFileSync(file, JSON.stringify(processStamp(child.pid)));
		expect(takeProcessLock(file)).toBeUndefined();
		child.kill("SIGKILL");
		await once(child, "exit");
		const release = takeProcessLock(file);
		expect(release).toBeDefined();
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(processStamp());
		// Another run took it over meanwhile (this one judged gone): releasing does not remove its lock.
		writeFileSync(file, JSON.stringify({ pid: 1, start: "other" }));
		release?.();
		expect(readFileSync(file, "utf8")).toBe(JSON.stringify({ pid: 1, start: "other" }));
		expect(readdirSync(root)).toEqual(["task.lock"]);
	});

	it("a lock written before this change (a bare pid) still counts while its process runs", () => {
		const file = join(root, "old.lock");
		writeFileSync(file, String(process.pid));
		expect(takeProcessLock(file)).toBeUndefined();
	});
});

describe("fork: Firefox's remote-control port stays recorded while its holder runs", () => {
	it("a second /browser firefox does not replace the port of the first", async () => {
		const child = await sleeper();
		try {
			writeFileSync(
				join(root, "firefox-bidi.json"),
				`${JSON.stringify({ port: 45123, owner: processStamp(child.pid) })}\n`,
			);
			await expect(launchFirefoxWithBidi("true", root)).rejects.toThrow();
			expect(readBidiPort(root)).toBe(45123);
		} finally {
			child.kill("SIGKILL");
			await once(child, "exit");
		}
	});

	it("a record whose holder is gone is replaced", async (context) => {
		if (firefoxRunning() !== false) return context.skip("a Firefox runs on this machine");
		writeFileSync(
			join(root, "firefox-bidi.json"),
			`${JSON.stringify({ port: 45123, owner: { pid: 1, start: "0" } })}\n`,
		);
		const port = await launchFirefoxWithBidi("true", root);
		expect(readBidiPort(root)).toBe(port);
	});
});

describe("fork: names reserved by an exclusive creation", () => {
	it("a failed Git package install does not remove another session's finished one", async () => {
		const agentDir = join(root, "agent");
		mkdirSync(agentDir);
		const manager = new DefaultPackageManager({ cwd: root, agentDir, settingsManager: SettingsManager.inMemory() });
		let clones = 0;
		let secondSettled: Promise<unknown> = Promise.resolve();
		const commands = manager as unknown as { runCommand(command: string, args: string[]): Promise<void> };
		vi.spyOn(commands, "runCommand").mockImplementation(async (command, args) => {
			if (command !== "git" || args[0] !== "clone") return;
			const target = args[2]!;
			// Both found the package missing; the first clone ends after the second install.
			if (++clones === 1) await secondSettled;
			// What git does: refuse a folder that is not empty.
			if (existsSync(target) && readdirSync(target).length > 0)
				throw new Error(`destination path '${target}' already exists and is not an empty directory`);
			mkdirSync(target, { recursive: true });
			writeFileSync(join(target, "index.ts"), "export {};\n");
		});
		const first = manager.install("git:github.com/team/tools");
		const second = manager.install("git:github.com/team/tools");
		secondSettled = second.catch(() => undefined);
		const results = await Promise.allSettled([first, second]);
		expect(results.some((result) => result.status === "fulfilled")).toBe(true);
		const installed = manager.getInstalledPath("git:github.com/team/tools", "user");
		expect(installed && existsSync(join(installed, "index.ts"))).toBe(true);
	});

	it("a new attachment never takes the saved name of an earlier one whose working copy is gone", () => {
		const sessionId = `process-locks-${process.pid}`;
		const tmp = sessionTmpDir(sessionId);
		try {
			const project = join(root, "project");
			mkdirSync(project);
			const sessionFile = join(root, "session.jsonl");
			const target = { cwd: project, sessionId, sessionFile, session: {} };
			const first = join(root, "a", "report.bin");
			const second = join(root, "b", "report.bin");
			mkdirSync(join(root, "a"));
			mkdirSync(join(root, "b"));
			writeFileSync(first, Buffer.from([0, 1, 1, 1]));
			writeFileSync(second, Buffer.from([0, 2, 2, 2]));
			expect(attachFile(first, target)).toMatchObject({ kind: "file" });
			rmSync(join(tmp, "attachments", "report.bin"));
			const again = attachFile(second, target);
			expect(again).toMatchObject({ kind: "file" });
			const store = join(root, "session.attachments");
			expect([...readFileSync(join(store, "report.bin"))]).toEqual([0, 1, 1, 1]);
			expect([...readFileSync(join(store, "report-2.bin"))]).toEqual([0, 2, 2, 2]);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});
