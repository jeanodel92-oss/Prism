// fork: `read` streams large text files instead of loading them whole.
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createReadTool } from "../src/core/tools/read.ts";
import { readLargeText } from "../src/fork/large-text-read.ts";

function makeRandom(seed: number): () => number {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
		return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
	};
}

const outcome = (run: () => Promise<{ text: string; details: unknown }>) =>
	run().then(
		(result) => result,
		(error: unknown) => ({ error: String(error) }),
	);

describe("read streams large text files", () => {
	let root: string;
	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "prism-large-read-"));
	});
	afterAll(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("gives the upstream output for any content, offset, limit and chunking", async () => {
		const seed = Number(process.env.PI_FUZZ_SEED ?? 7_705);
		const random = makeRandom(seed);
		const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
		const shortPieces = ["", "a", "line", "é", "日本語", "😀", "\r", "\t", " "] as const;
		const pieces = [...shortPieces, "x".repeat(300)] as const;
		const tool = createReadTool(root);
		// CPU time, not wall time: under a loaded test run, each of the thousands of one-byte reads waits for the
		// scheduler, and the same work took 9.7 s of wall time (0.5 s alone) in ./test.sh, 2026-10-25.
		const started = process.cpuUsage();
		for (let index = 0; index < 160; index++) {
			const lineCount = pick([0, 1, 2, 5, 40, 1999, 2000, 2001, 2600]);
			// Short lines let the 2000-line limit bite before the 50 KB one.
			const palette = random() < 0.4 ? shortPieces : pieces;
			const lines = Array.from({ length: lineCount }, () =>
				Array.from({ length: Math.floor(random() * 4) }, () => pick(palette)).join(""),
			);
			if (random() < 0.15 && lines.length > 0) lines[Math.floor(random() * lines.length)] = "y".repeat(60_000);
			let body: Buffer = Buffer.from(`${lines.join("\n")}${random() < 0.5 ? "\n" : ""}`, "utf-8");
			// Invalid UTF-8 and a truncated multi-byte sequence decode to U+FFFD on both paths.
			if (random() < 0.2) body = Buffer.concat([body, Buffer.from([0xff, 0x0a, 0xe6, 0x97])]);
			if (random() < 0.1) body = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]);
			const name = `file-${index}.txt`;
			await writeFile(join(root, name), body);
			const offset = pick([undefined, undefined, 1, 2, 3, 1500, 2001, 2602, 9999]);
			const limit = pick([undefined, undefined, 0, 1, 10, 2000, 2500]);
			const expected = await outcome(async () => {
				const result = await tool.execute("read", { path: name, offset, limit });
				const first = result.content[0];
				return { text: first?.type === "text" ? first.text : "", details: result.details };
			});
			const actual = await outcome(async () => {
				const result = await readLargeText(join(root, name), name, offset, limit, {
					thresholdBytes: -1,
					chunkBytes: body.length < 2048 ? 1 + Math.floor(random() * 16) : pick([61, 4096, 65_536]),
				});
				if (!result) throw new Error("streaming path not taken");
				return result;
			});
			expect(actual, `seed=${seed} case=${index} offset=${offset} limit=${limit}`).toEqual(expected);
		}
		const used = process.cpuUsage(started);
		expect((used.user + used.system) / 1000, `seed=${seed} exceeded 8000ms of CPU`).toBeLessThan(8_000);
	}, 120_000);

	it("reads a 520 MiB file that the upstream path cannot turn into a string", async () => {
		// Sparse: no disk or memory is used for the zeros. Over 512 MiB, Buffer.toString throws.
		// Text first, so the binary-file check sees no NUL in its first 8000 bytes.
		const name = "huge.bin.txt";
		await writeFile(join(root, name), "a".repeat(8192));
		await truncate(join(root, name), 520 * 1024 * 1024);
		const result = await createReadTool(root).execute("read", { path: name });
		const first = result.content[0];
		expect(first?.type === "text" ? first.text : "").toMatch(/^\[Line 1 is 520\.0MB, exceeds 50\.0KB limit\./);
	}, 30_000);
});
