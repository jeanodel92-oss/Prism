/**
 * fork: auth.json is replaced through a temporary file and a rename, so an
 * interrupted write leaves the old file or the new one, never a truncated one, and the lock still orders writers.
 */

import { type ChildProcess, spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	lstatSync,
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
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileAuthStorageBackend } from "../src/core/auth-storage.ts";
import { atomicWriteHooks } from "../src/fork/secrets/atomic-write.ts";
import { authLockTiming } from "../src/fork/secrets/auth-lock.ts";

const SRC = resolve(__dirname, "../src");
let root: string;
let authPath: string;

const temporaries = (folder = root) => readdirSync(folder).filter((name) => name.endsWith(".tmp"));
const write = (content: string, path = authPath) =>
	new FileAuthStorageBackend(path).withLock(() => ({ result: undefined, next: content }));

/** A node process running `body` with the backend and the hooks imported; its output lines are collected. */
function child(body: string): { process: ChildProcess; lines: string[]; exit: Promise<number | null> } {
	const script = join(root, `child-${Math.random().toString(36).slice(2)}.ts`);
	writeFileSync(
		script,
		[
			`import { FileAuthStorageBackend } from ${JSON.stringify(join(SRC, "core/auth-storage.ts"))};`,
			`import { atomicWriteHooks } from ${JSON.stringify(join(SRC, "fork/secrets/atomic-write.ts"))};`,
			body,
		].join("\n"),
	);
	const proc = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "inherit"] });
	const lines: string[] = [];
	proc.stdout!.on("data", (chunk: Buffer) => lines.push(...chunk.toString().split("\n").filter(Boolean)));
	return { process: proc, lines, exit: new Promise((done) => proc.on("exit", (code) => done(code))) };
}

describe("atomic writes of auth.json", () => {
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "prism-auth-atomic-"));
		authPath = join(root, "auth.json");
	});
	afterEach(() => {
		atomicWriteHooks.beforeRename = undefined;
		atomicWriteHooks.afterRename = undefined;
		rmSync(root, { recursive: true, force: true });
	});

	it("replaces the file whole, mode 0600 when new, and keeps the mode of an existing file", () => {
		write('{"a":1}');
		expect(readFileSync(authPath, "utf8")).toBe('{"a":1}');
		expect(statSync(authPath).mode & 0o777).toBe(0o600);
		chmodSync(authPath, 0o640);
		write('{"a":2}');
		expect(readFileSync(authPath, "utf8")).toBe('{"a":2}');
		expect(statSync(authPath).mode & 0o777).toBe(0o640);
		expect(temporaries()).toEqual([]);
	});

	it("writes the temporary file with mode 0600 in the same folder", () => {
		const seen: Array<{ folder: string; mode: number }> = [];
		atomicWriteHooks.beforeRename = (temp) =>
			void seen.push({ folder: resolve(temp, ".."), mode: statSync(temp).mode & 0o777 });
		write('{"a":1}');
		expect(seen).toEqual([{ folder: root, mode: 0o600 }]);
	});

	it("leaves the old file and no temporary file when the write fails before the rename", () => {
		write('{"a":1}');
		atomicWriteHooks.beforeRename = () => {
			throw new Error("disk full (simulated)");
		};
		expect(() => write('{"a":2}')).toThrow("disk full");
		expect(readFileSync(authPath, "utf8")).toBe('{"a":1}');
		expect(temporaries()).toEqual([]);
		// The lock was released.
		atomicWriteHooks.beforeRename = undefined;
		write('{"a":3}');
		expect(readFileSync(authPath, "utf8")).toBe('{"a":3}');
	});

	it("reports success once the new file is in place, even if syncing the folder fails", () => {
		atomicWriteHooks.afterRename = () => {
			throw new Error("fsync failed (simulated)");
		};
		expect(() => write('{"a":1}')).not.toThrow();
		expect(readFileSync(authPath, "utf8")).toBe('{"a":1}');
	});

	it("replaces the target of a link and keeps the link", () => {
		mkdirSync(join(root, "real"));
		const target = join(root, "real", "auth.json");
		writeFileSync(target, "{}", { mode: 0o600 });
		symlinkSync(target, authPath);
		write('{"a":1}');
		expect(lstatSync(authPath).isSymbolicLink()).toBe(true);
		expect(readFileSync(target, "utf8")).toBe('{"a":1}');
		expect(temporaries(join(root, "real"))).toEqual([]);
	});

	it("keeps the old file when the writing process is killed before the rename, and cleans up after it", async () => {
		write('{"before":true}');
		const run = child(
			[
				"atomicWriteHooks.beforeRename = (temp) => {",
				"\tconsole.log(temp);",
				"\tAtomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);",
				"};",
				`new FileAuthStorageBackend(${JSON.stringify(authPath)}).withLock(() => ({ result: undefined, next: '{"after":true}' }));`,
			].join("\n"),
		);
		const deadline = Date.now() + 20_000;
		while (!run.lines.length && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20));
		const temp = run.lines[0]!;
		expect(readFileSync(temp, "utf8")).toBe('{"after":true}');
		run.process.kill("SIGKILL");
		await run.exit;
		expect(readFileSync(authPath, "utf8")).toBe('{"before":true}');
		expect(existsSync(temp)).toBe(true);

		// Its lock goes stale (30 s, aged here rather than waited for); the next write removes the dead process's file.
		const old = new Date(Date.now() - 60_000);
		utimesSync(`${authPath}.lock`, old, old);
		await new FileAuthStorageBackend(authPath).withLockAsync(async () => ({
			result: undefined,
			next: '{"next":true}',
		}));
		expect(readFileSync(authPath, "utf8")).toBe('{"next":true}');
		expect(temporaries()).toEqual([]);
	}, 60_000);

	it("keeps the lock's ordering: concurrent processes lose no update", async () => {
		write('{"count":0}');
		const runs = Array.from({ length: 6 }, () =>
			child(
				[
					`const backend = new FileAuthStorageBackend(${JSON.stringify(authPath)});`,
					"for (let i = 0; i < 10; i++)",
					"\tawait backend.withLockAsync(async (current) => {",
					"\t\tconst data = JSON.parse(current ?? '{}');",
					"\t\treturn { result: undefined, next: JSON.stringify({ count: data.count + 1 }) };",
					"\t});",
				].join("\n"),
			),
		);
		expect(await Promise.all(runs.map((run) => run.exit))).toEqual(Array(6).fill(0));
		expect(JSON.parse(readFileSync(authPath, "utf8"))).toEqual({ count: 60 });
		expect(temporaries()).toEqual([]);
	}, 60_000);
});

// fork: proper-lockfile renews a lock from a timer. A holder whose event loop
// stopped renews nothing, another writer takes the lock as stale, and the holder's write would then overwrite it.
describe("a lock that may have passed to another writer", () => {
	/** Blocks this thread, as a synchronous call did. */
	const block = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "prism-auth-lock-"));
		authPath = join(root, "auth.json");
		authLockTiming.staleMs = 2_000;
	});
	afterEach(() => {
		authLockTiming.staleMs = 30_000;
		rmSync(root, { recursive: true, force: true });
	});

	it("refuses the write after the holder's loop stopped long enough for the lock to go stale", async () => {
		write('{"before":true}');
		await expect(
			new FileAuthStorageBackend(authPath).withLockAsync(async () => {
				block(1_500);
				return { result: undefined, next: '{"after":true}' };
			}),
		).rejects.toThrow("auth.json was not written: its lock may have passed to another writer");
		expect(readFileSync(authPath, "utf8")).toBe('{"before":true}');
		// Its lock is left to go stale, as it may be another writer's now: the next writer waits for that.
		expect(existsSync(`${authPath}.lock`)).toBe(true);
		await new Promise((done) => setTimeout(done, 2_100));
		expect(() =>
			new FileAuthStorageBackend(authPath).withLock(() => {
				block(1_500);
				return { result: undefined, next: '{"after":true}' };
			}),
		).toThrow("auth.json was not written");
		expect(readFileSync(authPath, "utf8")).toBe('{"before":true}');
		// A holder that waits without blocking keeps its lock fresh, and writes.
		await new FileAuthStorageBackend(authPath).withLockAsync(async () => {
			await new Promise((done) => setTimeout(done, 2_500));
			return { result: undefined, next: '{"after":true}' };
		});
		expect(readFileSync(authPath, "utf8")).toBe('{"after":true}');
	}, 30_000);

	it("loses neither write when another process takes the lock from a stopped holder", async () => {
		write('{"before":true}');
		const thief = child(
			[
				`import { authLockTiming } from ${JSON.stringify(join(SRC, "fork/secrets/auth-lock.ts"))};`,
				"authLockTiming.staleMs = 2_000;",
				`const backend = new FileAuthStorageBackend(${JSON.stringify(authPath)});`,
				"console.log('asks');",
				"for (;;) {",
				"\ttry {",
				"\t\tawait backend.withLockAsync(async (current) => {",
				"\t\t\tconsole.log('holds');",
				"\t\t\tawait new Promise((done) => setTimeout(done, 3_000));",
				"\t\t\treturn { result: undefined, next: JSON.stringify({ ...JSON.parse(current ?? '{}'), other: true }) };",
				"\t\t});",
				"\t\tbreak;",
				"\t} catch (error) {",
				"\t\tif (error.code !== 'ELOCKED') throw error;",
				"\t}",
				"}",
				"console.log('wrote');",
			].join("\n"),
		);
		const holder = new FileAuthStorageBackend(authPath).withLockAsync(async (current) => {
			const deadline = Date.now() + 20_000;
			while (!thief.lines.includes("asks") && Date.now() < deadline)
				await new Promise((done) => setTimeout(done, 20));
			block(3_500);
			return { result: undefined, next: JSON.stringify({ ...JSON.parse(current ?? "{}"), holder: true }) };
		});
		await expect(holder).rejects.toThrow("auth.json was not written");
		// The holder left the lock it lost: removing it would have freed the other writer's.
		const deadline = Date.now() + 10_000;
		while (!thief.lines.includes("holds") && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20));
		expect(thief.lines).toEqual(["asks", "holds"]);
		expect(existsSync(`${authPath}.lock`)).toBe(true);
		expect(await thief.exit).toBe(0);
		expect(thief.lines).toContain("wrote");
		expect(JSON.parse(readFileSync(authPath, "utf8"))).toEqual({ before: true, other: true });
	}, 60_000);

	it("bounds another writer's wait for a live holder", async () => {
		write("{}");
		const holder = new FileAuthStorageBackend(authPath).withLockAsync(async () => {
			// 6 s held, 5 s bound: the 2 s budget keeps 3 s of margin on a busy CI runner.
			await new Promise((done) => setTimeout(done, 6_000));
			return { result: undefined, next: '{"holder":true}' };
		});
		await new Promise((done) => setTimeout(done, 100));
		const started = Date.now();
		await expect(
			new FileAuthStorageBackend(authPath).withLockAsync(async () => ({ result: undefined, next: "{}" })),
		).rejects.toMatchObject({ code: "ELOCKED" });
		expect(Date.now() - started).toBeLessThan(5_000);
		await holder;
		expect(readFileSync(authPath, "utf8")).toBe('{"holder":true}');
	}, 30_000);
});
