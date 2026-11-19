/**
 * fork: readers of another program's output keep a bounded amount of
 * it, and join a message's pieces once, not with every piece.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeBashWithOperations } from "../src/core/bash-executor.ts";
import { LineReader, NativeReader } from "../src/fork/browser/protocol.ts";
import { CappedLog } from "../src/fork/capped-log.ts";
import { startLspClientForTest } from "../vendor/forks/pi-lsp/dist/index.ts";

describe("fork: bounded readers", () => {
	afterEach(() => vi.restoreAllMocks());

	it("a native message in many pieces is joined once", () => {
		const body = Buffer.from(JSON.stringify({ data: "x".repeat(8 * 1024 * 1024) }));
		const framed = Buffer.alloc(4 + body.length);
		framed.writeUInt32LE(body.length, 0);
		body.copy(framed, 4);
		const concat = vi.spyOn(Buffer, "concat");
		const reader = new NativeReader();
		const messages: unknown[] = [];
		for (let offset = 0; offset < framed.length; offset += 16 * 1024) {
			messages.push(...reader.push(framed.subarray(offset, offset + 16 * 1024)));
		}
		expect(messages).toHaveLength(1);
		const copied = concat.mock.results.reduce((sum, result) => sum + (result.value as Buffer).length, 0);
		// Before, every piece copied everything received so far: about 2 GiB for this 8 MiB message.
		expect(copied).toBeLessThanOrEqual(2 * framed.length);
	});

	it("a line in many pieces is split once it ends", () => {
		const reader = new LineReader();
		const split = vi.spyOn(String.prototype, "split");
		for (let index = 0; index < 512; index++) expect(reader.push("x".repeat(1024))).toEqual([]);
		expect(split).not.toHaveBeenCalled();
		split.mockRestore();
		expect(reader.push(`${JSON.stringify("tail")}\n`)).toEqual([]);
		expect(reader.push(`${JSON.stringify({ ok: true })}\n`)).toEqual([{ ok: true }]);
	});

	it("output that cleans down to nothing is not kept, piece by piece", async () => {
		const dir = mkdtempSync(join(tmpdir(), "prism-empty-chunks-"));
		try {
			// A command that prints carriage returns only: each piece is empty once cleaned.
			let pieces = 0;
			const result = await executeBashWithOperations(
				"spinner",
				dir,
				{
					exec: async (_command, _cwd, { onData }) => {
						onData(Buffer.from("start\n"));
						const carriageReturn = Buffer.from("\r");
						for (let index = 0; index < 200_000; index++) onData(carriageReturn);
						onData(Buffer.from("end\n"));
						return { exitCode: 0 };
					},
				},
				{
					onChunk: () => {
						pieces++;
					},
				},
			);
			expect(result.output).toBe("start\nend\n");
			expect(pieces).toBe(2);
			if (result.fullOutputPath) rmSync(result.fullOutputPath, { force: true });

			// The capped log keeps no empty pieces either.
			const log = new CappedLog(join(dir, "log"), 20);
			log.write("0123456789abcdefghijklmnopqrstuvwxyz");
			for (let index = 0; index < 200_000; index++) log.write("");
			expect((log as unknown as { tail: Buffer[] }).tail.length).toBeLessThanOrEqual(2);
			await log.end();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("a language server announcing a huge message, or chatty on stderr, is refused and stopped", async () => {
		// 4 MiB of stderr, then a header announcing 4 GB and a body that never ends.
		const script = `
			process.stderr.write("e".repeat(4 * 1024 * 1024));
			process.stdout.write("Content-Length: 4000000000\\r\\n\\r\\n");
			const piece = "x".repeat(64 * 1024);
			setInterval(() => process.stdout.write(piece), 1);
		`;
		const client = await startLspClientForTest(
			{ name: "fake", env: {}, missingCommandHint: "" },
			{ command: process.execPath, args: ["-e", script] },
			process.cwd(),
			10_000,
		);
		const started = Date.now();
		const error = await client.request("initialize", {}).catch((caught: unknown) => caught);
		expect(String(error)).toMatch(/exceeds 64 MiB/);
		expect(Date.now() - started).toBeLessThan(5_000);
		// The server's stderr shown with the error is its last 64 KiB at most.
		expect(String(error).length).toBeLessThan(80 * 1024);
	});
});
