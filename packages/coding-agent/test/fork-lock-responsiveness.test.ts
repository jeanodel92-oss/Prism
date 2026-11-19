import { fork } from "node:child_process";
import { once } from "node:events";
import type * as fileSystem from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";
import { afterEach, expect, it, vi } from "vitest";
import { lockForkFile } from "../src/fork/file-lock.ts";
import { addProjectRule, readProjectGrants } from "../src/fork/project-permissions.ts";
import { captureGitStart, publishGitChanges } from "../src/fork/sandbox/git-publish.ts";
import { closeSessionNet, sessionNetReport } from "../src/fork/sandbox/session-net.ts";

const namespace = vi.hoisted(() => ({ until: 0, holders: new Set<string>() }));
vi.mock("node:fs", async (original) => {
	const fs = await original<typeof fileSystem>();
	return {
		...fs,
		readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
			if (namespace.until && String(args[0]).endsWith("/children")) {
				namespace.holders.add(String(args[0]));
				if (Date.now() < namespace.until) return "";
				throw new Error("namespace holder ended");
			}
			return fs.readFileSync(...args);
		},
	};
});

const dirs: string[] = [];
afterEach(() => {
	namespace.until = 0;
	namespace.holders.clear();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function directory() {
	const dir = mkdtempSync(join(tmpdir(), "prism-lock-ticks-"));
	dirs.push(dir);
	return dir;
}

async function held(path: string, kind = "directory") {
	const child = fork(fileURLToPath(new URL("./fixtures/fork-lock-holder.mjs", import.meta.url)), [path, kind], {
		execArgv: [],
		stdio: ["ignore", "ignore", "inherit", "ipc"],
	});
	await once(child, "message");
	return child;
}

// fork: a waiting lock must leave the event loop free most of the
// time, not never pause it. Each synchronous fs call can stall for hundreds of ms on a busy slow disk
// ; waiting for the lock synchronously stalls the whole wait.
async function measure(name: string, run: () => unknown, blocked: boolean) {
	let last = performance.now();
	let gap = 0;
	let stalled = 0;
	const timer = setInterval(() => {
		const now = performance.now();
		gap = Math.max(gap, now - last);
		stalled += Math.max(0, now - last - 50);
		last = now;
	}, 10);
	await pause(30);
	const start = performance.now();
	try {
		await run();
		const elapsed = performance.now() - start;
		await pause(30);
		console.log(
			`${name}: elapsed=${elapsed.toFixed(1)}ms, max tick gap=${gap.toFixed(1)}ms, stalled=${stalled.toFixed(1)}ms`,
		);
		expect(elapsed).toBeGreaterThan(1800);
		if (blocked) expect(gap).toBeGreaterThan(1800);
		else expect(stalled).toBeLessThan(elapsed / 2);
	} finally {
		clearInterval(timer);
	}
}

it("keeps ticking while another process holds the shared store lock for two seconds", async () => {
	const path = join(directory(), "store.json");
	const holder = await held(`${path}.lock`);
	try {
		await measure("fork file", () => lockForkFile(path, () => {}), false);
	} finally {
		holder.kill();
	}
});

it("keeps ticking until the project lock's existing timeout without changing its refusal", async () => {
	const dir = directory();
	const holder = await held(join(dir, "project-permissions.json.lock"));
	try {
		await measure(
			"project permissions",
			async () => {
				try {
					await addProjectRule(dir, "write(src/**)", "allow", dir);
				} catch (error) {
					expect(error).toMatchObject({ code: "ELOCKED", message: "Lock file is already being held" });
				}
			},
			false,
		);
	} finally {
		holder.kill();
	}
});

// fork: run again once when it fails; its time bound is missed
// now and then on a slower machine under the full suite.
it("keeps ticking while another Git holds its publication lock for two seconds", { retry: 1 }, async () => {
	const dir = directory();
	const path = join(dir, "HEAD");
	writeFileSync(path, "before");
	const start = captureGitStart(dir);
	const holder = await held(`${path}.lock`, "file");
	try {
		await measure(
			"Git publication",
			async () => {
				const result = await publishGitChanges(
					dir,
					start,
					[{ path: "HEAD", before: Buffer.from("before"), after: Buffer.from("after") }],
					join(dir, "journal"),
					{ lockAttempts: 150 },
				);
				expect(result.published).toBe(true);
			},
			false,
		);
	} finally {
		holder.kill();
	}
});

it("keeps ticking during two seconds of namespace readiness polling", async () => {
	const session = directory();
	namespace.until = Date.now() + 2030;
	try {
		await measure("session network", () => sessionNetReport(session, "/bin/false", "/usr/bin/nsenter"), false);
	} finally {
		closeSessionNet(session);
	}
});

it("shares namespace initialization and forgets a session closed while it starts", async () => {
	const session = directory();
	try {
		namespace.until = Date.now() + 60;
		const first = sessionNetReport(session, "/bin/false");
		const second = sessionNetReport(session, "/bin/false");
		closeSessionNet(session);
		expect(await first).toBe(await second);
		expect(namespace.holders.size).toBe(1);
		// The late result must not cache a closed session: the next start needs a new holder.
		namespace.until = Date.now() + 60;
		await sessionNetReport(session, "/bin/false");
		expect(namespace.holders.size).toBe(2);
	} finally {
		closeSessionNet(session);
	}
});

it("serializes concurrent writers, returns their results, and releases after an error", async () => {
	const path = join(directory(), "store.json");
	writeFileSync(path, "0");
	const write = () =>
		lockForkFile(path, async () => {
			const before = Number(readFileSync(path, "utf8"));
			await pause(30);
			writeFileSync(path, String(before + 1));
			return before + 1;
		});
	expect((await Promise.all([write(), write()])).sort()).toEqual([1, 2]);
	expect(readFileSync(path, "utf8")).toBe("2");
	const error = Object.assign(new Error("callback failed"), { code: "ELOCKED" });
	await expect(
		lockForkFile(path, () => {
			throw error;
		}),
	).rejects.toBe(error);
	expect(existsSync(`${path}.lock`)).toBe(false);
	await expect(write()).resolves.toBe(3);
});

it("keeps both updates when two processes start writing together", async () => {
	const path = join(directory(), "store.json");
	writeFileSync(path, "0");
	const writers = await Promise.all([held(path, "writer"), held(path, "writer")]);
	try {
		const done = Promise.all(writers.map((writer) => once(writer, "message")));
		for (const writer of writers) writer.send("start");
		await done;
		expect(readFileSync(path, "utf8")).toBe("2");
		expect(existsSync(`${path}.lock`)).toBe(false);
	} finally {
		for (const writer of writers) writer.kill();
	}
});

it("recovers stale shared and project locks with the existing age rules", async () => {
	const dir = directory();
	const stale = new Date(Date.now() - 20_000);
	for (const name of ["store.json", "project-permissions.json"]) {
		const path = join(dir, name);
		mkdirSync(`${path}.lock`);
		utimesSync(`${path}.lock`, stale, stale);
		if (name === "store.json") await lockForkFile(path, () => writeFileSync(path, "recovered"));
		else await addProjectRule(dir, "write(src/**)", "allow", dir);
		expect(existsSync(`${path}.lock`)).toBe(false);
	}
	expect(readProjectGrants(dir, dir).allow).toEqual(["write(src/**)"]);
});

it("keeps both retry limits and the original lock errors", async () => {
	const dir = directory();
	const lock = vi.spyOn(lockfile, "lockSync");
	vi.useFakeTimers();
	try {
		for (const [name, attempts, run] of [
			["store.json", 500, () => lockForkFile(join(dir, "store.json"), () => {})],
			["project-permissions.json", 100, () => addProjectRule(dir, "read", "allow", dir)],
		] as const) {
			mkdirSync(join(dir, `${name}.lock`));
			lock.mockClear();
			const refused = expect(run()).rejects.toMatchObject({
				code: "ELOCKED",
				message: "Lock file is already being held",
				file: join(dir, name),
			});
			await vi.runAllTimersAsync();
			await refused;
			expect(lock).toHaveBeenCalledTimes(attempts);
		}
	} finally {
		vi.useRealTimers();
		lock.mockRestore();
	}
	await expect(lockForkFile(join(dir, "missing", "store.json"), () => {})).rejects.toMatchObject({ code: "ENOENT" });
});
