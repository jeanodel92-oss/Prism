/**
 * fork: no read blocks the engine or allocates more than its limit
 * before checking. Each reader meets a named pipe with no writer (an open that would wait forever) and a sparse
 * 4 GiB file (no byte on disk, a whole read would allocate 4 GiB); it must refuse or cut promptly, the process's
 * memory barely moving.
 */
import { execFileSync } from "node:child_process";
import {
	closeSync,
	constants,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	statSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processFileArguments } from "../src/cli/file-processor.ts";
import { CONFIG_DIR_NAME, ENV_AGENT_DIR } from "../src/config.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { loadEntriesFromFile } from "../src/core/session-manager.ts";
import { computeEditsDiff } from "../src/core/tools/edit-diff.ts";
import { createReadTool } from "../src/core/tools/read.ts";
import {
	copyBoundedInto,
	copyFileExclusive,
	openRegularSync,
	ReadRefused,
	readBounded,
	readBoundedSync,
	readSmallTextSync,
	readTailSync,
} from "../src/fork/bounded-read.ts";
import { memorySnapshot } from "../src/fork/memory.ts";
import { handoffStaleness } from "../src/fork/project-continuity.ts";
import { type GitCopy, hooksLayer } from "../src/fork/sandbox/git-copy.ts";

const GiB = 1024 * 1024 * 1024;
const linux = process.platform === "linux";

let dir: string;
let fifo: string;
let sparse: string;
const agentDir = process.env[ENV_AGENT_DIR];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "prism-bounded-"));
	// Never the user's own agent folder (memory reads its global MEMORY.md).
	process.env[ENV_AGENT_DIR] = join(dir, "agent");
	fifo = join(dir, "pipe");
	execFileSync("mkfifo", [fifo]);
	sparse = join(dir, "sparse");
	writeFileSync(sparse, "");
	truncateSync(sparse, 4 * GiB);
});

afterEach(() => {
	if (agentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = agentDir;
	// Opening the FIFO read-write never blocks and lets go of any open still waiting on it.
	closeSync(openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK));
	rmSync(dir, { recursive: true, force: true });
});

/** What `run` gave (or threw, as text), "timeout" past a second; the RSS it added, in MiB. */
async function bounded(run: () => unknown): Promise<{ result: unknown; grew: number }> {
	const before = process.memoryUsage().rss;
	const result = await Promise.race([
		Promise.resolve()
			.then(run)
			.catch((error: unknown) => (error instanceof Error ? error.message : String(error))),
		new Promise((done) => setTimeout(() => done("timeout"), 1000)),
	]);
	return { result, grew: (process.memoryUsage().rss - before) / 1024 / 1024 };
}

/** A PNG signature in front of 4 GiB of nothing: detected as an image, not one to load whole. */
function hugeImage(): string {
	const path = join(dir, "huge.png");
	writeFileSync(
		path,
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]),
	);
	truncateSync(path, 4 * GiB);
	return path;
}

describe.runIf(linux)("fork: bounded reads", () => {
	it("the primitives refuse a FIFO without waiting and never read past their limit", async () => {
		for (const read of [
			() => openRegularSync(fifo),
			() => readBoundedSync(fifo, 10),
			() => readBounded(fifo, 10),
			() => readTailSync(fifo, 10),
			() => readSmallTextSync(fifo),
		]) {
			const { result } = await bounded(read);
			expect(result).toMatch(/is a named pipe \(FIFO\), not a regular file/);
		}
		for (const read of [() => readBoundedSync(sparse, 1024), () => readBounded(sparse, 1024)]) {
			const { result, grew } = await bounded(read);
			expect(result).toMatch(/is larger than 1024 bytes/);
			expect(grew).toBeLessThan(64);
		}
		const cut = await bounded(() => readBoundedSync(sparse, 1024, { over: "truncate" }));
		expect((cut.result as Buffer).length).toBe(1024);
		const tail = readTailSync(sparse, 2048);
		expect(tail.cut).toBe(true);
		expect(tail.data.length).toBe(2048);
		expect(() => readBoundedSync(sparse, 10)).toThrow(ReadRefused);
	});

	it("a bounded copy stops at its limit and at the file's end, keeps the mode, and refuses an existing target", () => {
		const source = join(dir, "source.sh");
		writeFileSync(source, "#!/bin/sh\necho hi\n", { mode: 0o750 });
		const target = join(dir, "copy.sh");
		copyFileExclusive(source, target, 1024);
		expect(readFileSync(target, "utf-8")).toBe("#!/bin/sh\necho hi\n");
		expect(statSync(target).mode & 0o777).toBe(0o750);
		expect(() => copyFileExclusive(source, target, 1024)).toThrow(/EEXIST/);
		const big = join(dir, "big-copy");
		expect(() => copyFileExclusive(sparse, big, 1024)).toThrow(/is larger than 1024 bytes/);
		expect(() => statSync(big)).toThrow(/ENOENT/);
		expect(() => copyFileExclusive(fifo, join(dir, "fifo-copy"), 1024)).toThrow(/named pipe/);
		const fd = openSync(join(dir, "into"), "w");
		try {
			expect(copyBoundedInto(source, fd, 1024).size).toBe(18);
		} finally {
			closeSync(fd);
		}
	});

	it("the edit preview refuses a FIFO and a file over its limit before reading", async () => {
		const edits = [{ oldText: "a", newText: "b" }];
		const pipe = await bounded(() => computeEditsDiff(fifo, edits, dir));
		expect(JSON.stringify(pipe.result)).toMatch(/named pipe/);
		const big = await bounded(() => computeEditsDiff(sparse, edits, dir));
		expect(JSON.stringify(big.result)).toMatch(/is larger than/);
		expect(big.grew).toBeLessThan(64);
	});

	it("read refuses a huge file with an image signature instead of loading it", async () => {
		const path = hugeImage();
		const { result, grew } = await bounded(() => createReadTool(dir).execute("read", { path }));
		expect(result).toMatch(/is larger than 20971520 bytes/);
		expect(grew).toBeLessThan(64);
	});

	describe("@path arguments", () => {
		let exit: ReturnType<typeof vi.spyOn>;
		let errors: string[];
		beforeEach(() => {
			errors = [];
			exit = vi.spyOn(process, "exit").mockImplementation((code) => {
				throw new Error(`exit ${code}`);
			});
			vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
				errors.push(args.join(" "));
			});
		});
		afterEach(() => vi.restoreAllMocks());

		it("refuses a FIFO, a huge image and a binary file, and still takes text", async () => {
			const binary = join(dir, "tool.bin");
			writeFileSync(binary, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 1, 2, 3]));
			for (const path of [fifo, hugeImage(), binary]) {
				const { result, grew } = await bounded(() => processFileArguments([path]));
				expect(result).toBe("exit 1");
				expect(grew).toBeLessThan(64);
			}
			expect(errors[0]).toMatch(/not a regular file/);
			expect(errors[1]).toMatch(/is larger than 20971520 bytes/);
			expect(errors[2]).toMatch(/binary/i);
			const text = join(dir, "note.txt");
			writeFileSync(text, "﻿hello\n");
			const done = await processFileArguments([text]);
			expect(done.text).toBe(`<file name="${text}">\nhello\n\n</file>\n`);
			expect(exit).toHaveBeenCalledTimes(3);
		});
	});

	it("opening a session refuses a FIFO without waiting", async () => {
		const { result } = await bounded(() => loadEntriesFromFile(fifo));
		expect(result).toMatch(/named pipe/);
	});

	it("memory and the handoff stamp read a FIFO as empty and a huge file only in part", async () => {
		const memory = join(dir, CONFIG_DIR_NAME, "MEMORY.md");
		mkdirSync(join(dir, CONFIG_DIR_NAME));
		execFileSync("mkfifo", [memory]);
		try {
			const pipe = await bounded(() => memorySnapshot(dir, true).project?.text);
			expect(pipe.result).toBe("");
		} finally {
			closeSync(openSync(memory, constants.O_RDWR | constants.O_NONBLOCK));
			rmSync(memory);
		}
		writeFileSync(memory, "fact\n");
		truncateSync(memory, 4 * GiB);
		const big = await bounded(() => memorySnapshot(dir, true).project?.text.length);
		expect(big.result).toBeLessThanOrEqual(1024 * 1024);
		expect(big.grew).toBeLessThan(64);

		mkdirSync(join(dir, "project"));
		execFileSync("mkfifo", [join(dir, "project", "handoff.md")]);
		const pi = { exec: () => Promise.reject(new Error("no git here")) } as unknown as ExtensionAPI;
		try {
			const stamp = await bounded(() => handoffStaleness(pi, dir));
			expect(stamp.result).toBeUndefined();
		} finally {
			closeSync(openSync(join(dir, "project", "handoff.md"), constants.O_RDWR | constants.O_NONBLOCK));
		}
	});

	it("a hooks folder over its limit is refused before its file is read whole", async () => {
		const hooks = join(dir, "hooks");
		mkdirSync(hooks);
		writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\n");
		// Under the 2 GiB a whole read refuses by itself: the old reader allocated it all.
		truncateSync(join(hooks, "pre-commit"), GiB);
		const folder = join(dir, "copy");
		mkdirSync(folder);
		const { result, grew } = await bounded(() => hooksLayer({ folder } as GitCopy, hooks, 0));
		expect(result).toBeUndefined();
		expect(grew).toBeLessThan(64);
	});
});
