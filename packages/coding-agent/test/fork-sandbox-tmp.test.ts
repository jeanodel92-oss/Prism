// fork: each session's sandboxed commands get a private /tmp, removed with the session; the
// folders of Prism processes that died without removing theirs are swept on the next start.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { holdSessionTmp, removeSessionTmpDir, SHARED_TMP_ENV, sessionTmpDir } from "../src/fork/sandbox/runtime.ts";

describe("fork: the sandbox's private /tmp", () => {
	it("keeps one folder per session, private to the user, and sweeps dead processes' folders", () => {
		// Above Linux's largest pid, so no process has it.
		const orphan = join(tmpdir(), "prism-tmp-4194399-test");
		mkdirSync(orphan, { recursive: true });
		try {
			const first = sessionTmpDir("session-a");
			expect(existsSync(orphan)).toBe(false);
			expect(statSync(first).mode & 0o777).toBe(0o700);
			expect(first).toContain(`prism-tmp-${process.pid}-`);
			expect(sessionTmpDir("session-a")).toBe(first);
			const second = sessionTmpDir("session-b");
			expect(second).not.toBe(first);
			removeSessionTmpDir("session-a");
			removeSessionTmpDir("session-b");
			expect(existsSync(first)).toBe(false);
			expect(existsSync(second)).toBe(false);
		} finally {
			rmSync(orphan, { recursive: true, force: true });
		}
	});

	it("keeps a folder a live task holds, past its session and its Prism process, and sweeps it once released", () => {
		const dir = sessionTmpDir("session-held");
		const release = holdSessionTmp(dir, process.pid);
		removeSessionTmpDir("session-held");
		expect(existsSync(dir)).toBe(true);
		release();
		expect(existsSync(dir)).toBe(false);
		expect(existsSync(`${dir}.task-${process.pid}`)).toBe(false);

		// A dead Prism's folder: kept while a live task's marker names it, swept with its stale markers otherwise.
		const orphan = join(tmpdir(), "prism-tmp-4194398-held");
		mkdirSync(orphan, { recursive: true });
		writeFileSync(`${orphan}.task-${process.pid}`, "");
		writeFileSync(`${orphan}.task-4194397`, "");
		try {
			sessionTmpDir("session-sweep");
			expect(existsSync(orphan)).toBe(true);
			removeSessionTmpDir("session-sweep");
			rmSync(`${orphan}.task-${process.pid}`);
			sessionTmpDir("session-sweep-2");
			expect(existsSync(orphan)).toBe(false);
			expect(readdirSync(tmpdir()).filter((name) => name.startsWith("prism-tmp-4194398-held"))).toEqual([]);
			removeSessionTmpDir("session-sweep-2");
		} finally {
			rmSync(orphan, { recursive: true, force: true });
			rmSync(`${orphan}.task-${process.pid}`, { force: true });
			rmSync(`${orphan}.task-4194397`, { force: true });
		}
	});

	// an agent works in its parent session's /tmp, and leaves it in place.
	it("borrows the parent's /tmp named in PRISM_SHARED_TMP, never removes it, and refuses a folder others can open", () => {
		const shared = mkdtempSync(join(tmpdir(), `prism-tmp-${process.pid}-`));
		chmodSync(shared, 0o700);
		try {
			process.env[SHARED_TMP_ENV] = shared;
			expect(sessionTmpDir("session-agent")).toBe(shared);
			removeSessionTmpDir("session-agent");
			expect(existsSync(shared)).toBe(true);
			chmodSync(shared, 0o755);
			const own = sessionTmpDir("session-agent-2");
			expect(own).not.toBe(shared);
			removeSessionTmpDir("session-agent-2");
			process.env[SHARED_TMP_ENV] = join(tmpdir(), "elsewhere");
			const other = sessionTmpDir("session-agent-3");
			expect(other).not.toBe(join(tmpdir(), "elsewhere"));
			removeSessionTmpDir("session-agent-3");
		} finally {
			delete process.env[SHARED_TMP_ENV];
			rmSync(shared, { recursive: true, force: true });
		}
	});

	it("adds one exit listener per process, however many sessions come and go", () => {
		sessionTmpDir("session-count");
		const before = process.listenerCount("exit");
		for (let i = 0; i < 12; i++) {
			removeSessionTmpDir(i === 0 ? "session-count" : `session-count-${i - 1}`);
			sessionTmpDir(`session-count-${i}`);
		}
		removeSessionTmpDir("session-count-11");
		expect(process.listenerCount("exit")).toBe(before);
	});

	it("removes the folder when ctrl+c (SIGINT) ends Prism, which ends as it did before", async () => {
		const runtime = resolve(__dirname, "../src/fork/sandbox/runtime.ts");
		const child = spawn(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`import { sessionTmpDir } from ${JSON.stringify(runtime)}; console.log(sessionTmpDir("s")); setInterval(() => {}, 1000);`,
			],
			{ stdio: ["ignore", "pipe", "inherit"] },
		);
		const dir = await new Promise<string>((done) => child.stdout.once("data", (data) => done(String(data).trim())));
		expect(existsSync(dir)).toBe(true);
		const ended = new Promise<NodeJS.Signals | null>((done) => child.once("exit", (_code, signal) => done(signal)));
		child.kill("SIGINT");
		expect(await ended).toBe("SIGINT");
		expect(existsSync(dir)).toBe(false);
	});
});
