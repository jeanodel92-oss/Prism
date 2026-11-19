import { spawn } from "node:child_process";
import { once } from "node:events";
import {
	closeSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	rmSync,
	truncateSync,
	utimesSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { type BackgroundTask, pruneLogs, requestTaskStop, shellInvocation, tail } from "../src/fork/background.ts";
import {
	appendStderrTail,
	ChildLines,
	MAX_CHILD_LINE_BYTES,
	MAX_CHILD_STDERR_BYTES,
	stopProcessGroup,
} from "../src/fork/child-process.ts";
import { computeSessionStats } from "../src/fork/prism/footer.ts";
import { searchSessions } from "../src/fork/session-search.ts";
import { directFetch, pendingDirectUrls } from "../src/fork/web.ts";

// fork: keep transport mocked now that directFetch uses undici's matching dispatcher API.
vi.mock("undici", async (original) => ({
	...(await original<Record<string, unknown>>()),
	fetch: (url: string, options: RequestInit) => fetch(url, options),
}));

describe("fork resource bounds", () => {
	let tempDir: string;
	const savedAgentDir = process.env[ENV_AGENT_DIR];

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		if (savedAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = savedAgentDir;
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	});

	it("stops a direct web fetch at its byte cap and preserves HTML detection", async () => {
		let cancelled = false;
		let pulls = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls += 1;
				controller.enqueue(new Uint8Array(64 * 1024).fill(65));
			},
			cancel() {
				cancelled = true;
			},
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(stream, { headers: { "content-type": "text/plain" } })),
		);
		const result = await directFetch("https://example.test/stream");
		expect(Buffer.byteLength(result.text)).toBe(2 * 1024 * 1024);
		expect(cancelled).toBe(true);
		expect(pulls).toBeLessThan(40);

		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response("<html><title>Title</title><p>Body</p></html>", {
						headers: { "content-type": "text/html" },
					}),
			),
		);
		expect(await directFetch("https://example.test/page")).toMatchObject({ title: "Title", text: "Title Body" });
	});

	it("does not directly refetch URLs Exa delivered under a normalized URL", () => {
		const requested = ["http://example.test/page", "https://other.test/path"];
		expect(
			pendingDirectUrls(
				requested,
				[{ id: requested[1], status: "success" }],
				[{ url: "https://example.test/page/" }],
			),
		).toEqual(new Set());
	});

	it("reads a bounded tail from a log larger than 512 MiB and skips split UTF-8", () => {
		tempDir = mkdtempSync(join(tmpdir(), "prism-resource-bounds-"));
		const path = join(tempDir, "large.log");
		const fd = openSync(path, "w");
		truncateSync(path, 513 * 1024 * 1024);
		writeSync(fd, Buffer.alloc(4000, 32), 0, 4000, 513 * 1024 * 1024 - 4000);
		writeSync(fd, Buffer.from("final line\n"), 0, 11, 513 * 1024 * 1024 - 11);
		closeSync(fd);
		expect(tail(path)).toBe("final line");
		const utf8 = join(tempDir, "utf8.log");
		writeFileSync(utf8, "zéx");
		expect(tail(utf8, 2)).toBe("x");
	});

	it("prunes only expired background logs whose process group is gone", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "prism-resource-bounds-"));
		const running = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			detached: true,
			stdio: "ignore",
		});
		const log = join(tempDir, "old.log");
		writeFileSync(log, "running task output");
		writeFileSync(`${log}.pid`, String(running.pid));
		const legacyLog = join(tempDir, "legacy.log");
		writeFileSync(legacyLog, "no process metadata");
		const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
		utimesSync(log, old, old);
		utimesSync(legacyLog, old, old);
		pruneLogs(tempDir);
		expect(tail(log)).toBe("running task output");
		expect(tail(legacyLog)).toBe("no process metadata");
		const exited = once(running, "close");
		process.kill(-(running.pid as number), "SIGKILL");
		await exited;
		pruneLogs(tempDir);
		expect(tail(log)).toBe("(no output yet)");
		expect(tail(legacyLog)).toBe("no process metadata");
	});

	it("keeps a killed background task in stopping state and uses the configured shell transport", async () => {
		vi.useFakeTimers();
		const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
		const task: BackgroundTask = {
			id: "bg1",
			command: "echo test",
			cwd: "/work",
			pid: 1234,
			status: "running",
			startedAt: Date.now(),
			logPath: "/tmp/bg1.log",
		};
		const updateStatus = vi.fn();
		expect(requestTaskStop(task, updateStatus)).toBeUndefined();
		expect(task.status).toBe("stopping");
		expect(kill).toHaveBeenNthCalledWith(1, -1234, "SIGTERM");
		expect(kill).toHaveBeenNthCalledWith(2, -1234, 0);
		await vi.advanceTimersByTimeAsync(3000);
		expect(kill).toHaveBeenLastCalledWith(-1234, "SIGKILL");
		await vi.advanceTimersByTimeAsync(5000);
		expect(shellInvocation({ shell: "/bin/bash", args: ["-s"], commandTransport: "stdin" }, "echo test")).toEqual({
			args: ["-s"],
			stdin: true,
		});
		expect(shellInvocation({ shell: "/bin/bash", args: ["-c"] }, "echo test")).toEqual({
			args: ["-c", "echo test"],
			stdin: false,
		});
	});

	it("terminates a process group with TERM before escalating to KILL", async () => {
		vi.useFakeTimers();
		const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
		kill.mockClear();
		const stopped = stopProcessGroup(4321, 3000);
		expect(kill).toHaveBeenNthCalledWith(1, -4321, "SIGTERM");
		await vi.advanceTimersByTimeAsync(2900);
		expect(kill).not.toHaveBeenCalledWith(-4321, "SIGKILL");
		await vi.advanceTimersByTimeAsync(100);
		expect(kill).toHaveBeenLastCalledWith(-4321, "SIGKILL");
		await vi.advanceTimersByTimeAsync(5000);
		await expect(stopped).resolves.toEqual({ confirmed: false });
	});

	it("caps partial JSON lines and stderr while retaining the newest bytes", () => {
		expect(new ChildLines().push("x".repeat(MAX_CHILD_LINE_BYTES + 1)).overflow).toBe(true);
		const result = appendStderrTail(Buffer.alloc(0), Buffer.alloc(MAX_CHILD_STDERR_BYTES + 20, 65));
		expect(result.byteLength).toBe(MAX_CHILD_STDERR_BYTES);
		expect(result.every((byte) => byte === 65)).toBe(true);
	});

	it("searches project sessions asynchronously after checking their small headers", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "prism-resource-bounds-"));
		const agentDir = join(tempDir, "agent");
		process.env[ENV_AGENT_DIR] = agentDir;
		const sessions = join(agentDir, "sessions", "project");
		mkdirSync(sessions, { recursive: true });
		writeFileSync(
			join(sessions, "match.jsonl"),
			`${JSON.stringify({ type: "session", cwd: "/work", timestamp: "2026-01-01T00:00:00Z" })}\n${JSON.stringify({ type: "message", message: { role: "user", content: "needle here" } })}\n`,
		);
		writeFileSync(
			join(sessions, "skip.jsonl"),
			`${JSON.stringify({ type: "session", cwd: "/other" })}\n${"needle ".repeat(400_000)}\n`,
		);
		const result = await searchSessions("needle", "project", "/work", 8);
		expect(result.scanned).toBe(1);
		expect(result.hits).toHaveLength(1);
	});

	it("updates footer usage incrementally and recomputes after a changed prefix", () => {
		const first = { type: "usage", usage: { input: 3, output: 2, cost: { total: 0.1 } } };
		const assistant = {
			type: "message",
			message: {
				role: "assistant",
				usage: { input: 10, output: 4, cacheRead: 20, cacheWrite: 5, cost: { total: 0.2 } },
				stopReason: "stop",
				model: "physical-model",
				thinkingLevel: "high",
			},
		};
		const ctx = {
			model: { provider: "router", id: "virtual", api: "pi-virtual" },
			sessionManager: {
				getSessionId: () => "s1",
				getLeafId: () => `l${ctx.sessionManager.getEntries().length}`,
				getEntries: (() => {
					const entries: unknown[] = [first];
					return () => entries;
				})(),
			},
		};
		const one = computeSessionStats(undefined, ctx);
		const entries = ctx.sessionManager.getEntries();
		entries.push(assistant);
		const two = computeSessionStats(one, ctx);
		// Each new entry moves the leaf; the sums so far are reused, not recomputed.
		expect(two).toBe(one);
		expect(two.input).toBe(13);
		expect(two.output).toBe(6);
		expect(two.hitRate).toBeCloseTo((20 / 35) * 100);
		expect(two.routed).toEqual({ id: "physical-model", level: "high" });
		expect(two.latest).toBe(assistant.message);
		const replacement = { ...first, usage: { input: 30 } };
		const replacementAssistant = { ...assistant, message: { ...assistant.message } };
		entries.splice(0, entries.length, replacement, replacementAssistant);
		expect(computeSessionStats(two, ctx).input).toBe(40);
	});
});
