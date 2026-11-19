// fork: large grep context is streamed after ripgrep has collected matches.
import { mkdtemp, open, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGrepTool } from "../src/core/tools/grep.ts";

function makeRandom(seed: number): () => number {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
		return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
	};
}

async function output(tool: ReturnType<typeof createGrepTool>, file: string, pattern: string, context: number) {
	const result = await tool.execute("grep-context", { pattern, path: file, context, literal: true });
	return result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
}

describe("grep streams large-file context", () => {
	let root: string;
	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "prism-grep-context-"));
	});
	afterAll(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("matches upstream output across random content and chunk boundaries", async () => {
		const seed = Number(process.env.PI_FUZZ_SEED ?? 7_705);
		const random = makeRandom(seed);
		const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
		const pieces = ["", "a", "é", "日本語", "😀", "\r", "\t", " ", "x".repeat(5000)] as const;
		const upstream = createGrepTool(root, { largeFileContext: { thresholdBytes: Number.POSITIVE_INFINITY } });
		const started = performance.now();
		for (let index = 0; index < 80; index++) {
			const lineCount = 1 + Math.floor(random() * 35);
			const marker = `needle${Math.floor(random() * 4)}`;
			const lines = Array.from({ length: lineCount }, () =>
				Array.from({ length: Math.floor(random() * 5) }, () => pick(pieces)).join(""),
			);
			const matchLine = Math.floor(random() * lines.length);
			lines[matchLine] += marker;
			let body = Buffer.from(
				`${random() < 0.5 ? "\uFEFF" : ""}${lines.join(pick(["\n", "\r\n", "\r"]))}${random() < 0.5 ? "\n" : ""}`,
			);
			if (random() < 0.5) body = Buffer.concat([body, Buffer.from([0xff, 0xe6, 0x97])]);
			const file = `fuzz-${index}.txt`;
			await writeFile(join(root, file), body);
			const pattern = marker;
			const context = pick([0, 1, 2, 5]);
			const expected = await output(upstream, file, pattern, context);
			const actual = await output(
				createGrepTool(root, {
					largeFileContext: {
						thresholdBytes: -1,
						// Tiny chunks split every line and UTF-8 sequence, but are slow on the long-line files.
						chunkBytes: body.length < 4096 ? 1 + Math.floor(random() * 17) : pick([61, 4096, 65_536]),
					},
				}),
				file,
				pattern,
				context,
			);
			expect(actual, `seed=${seed} case=${index} pattern=${pattern} context=${context}`).toBe(expected);
		}
		// 2 s on the CI runner when calm; its disk can make that ten times longer.
		expect(performance.now() - started, `seed=${seed} exceeded 60000ms`).toBeLessThan(60_000);
	}, 120_000);

	it("finds context near the end of a sparse 520 MiB file", async () => {
		const file = join(root, "sparse-large.txt");
		await writeFile(file, "before\n");
		await truncate(file, 520 * 1024 * 1024);
		const handle = await open(file, "r+");
		for (let offset = 1024 * 1024; offset < 520 * 1024 * 1024 - 1024 * 1024; offset += 1024 * 1024) {
			await handle.write(Buffer.from("\n"), 0, 1, offset);
		}
		const marker = Buffer.from("\ncontext-before\nneedle-at-end\ncontext-after\n");
		await handle.write(marker, 0, marker.length, 520 * 1024 * 1024 - marker.length);
		await handle.close();
		const config = join(root, "rg.conf");
		await writeFile(config, "--text\n");
		const previousConfig = process.env.RIPGREP_CONFIG_PATH;
		process.env.RIPGREP_CONFIG_PATH = config;
		let result: string;
		try {
			result = await output(createGrepTool(root), "sparse-large.txt", "needle-at-end", 1);
		} finally {
			if (previousConfig === undefined) delete process.env.RIPGREP_CONFIG_PATH;
			else process.env.RIPGREP_CONFIG_PATH = previousConfig;
		}
		// Upstream read the file whole: over 512 MiB that failed and printed "(unable to read file)".
		expect(result).toMatch(
			/^sparse-large\.txt-(\d+)- context-before\nsparse-large\.txt:\d+: needle-at-end\nsparse-large\.txt-\d+- context-after$/,
		);
	}, 30_000);
});
