/**
 * fork: grep's limits apply before the work they limit. A huge `context`
 * and a match on a giant line must answer promptly, the process's memory barely moving.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGrepTool } from "../src/core/tools/grep.ts";
import { grepContext, MAX_GREP_CONTEXT, oversizeMatch, readJsonLines } from "../src/fork/grep-bounds.ts";

const MiB = 1024 * 1024;

/** `run`'s result and the most the RSS rose while it ran, in MiB (sampled, so a peak freed before the end counts). */
async function peak<T>(run: () => Promise<T>): Promise<{ result: T; grew: number }> {
	const before = process.memoryUsage().rss;
	let highest = before;
	const sample = setInterval(() => {
		highest = Math.max(highest, process.memoryUsage().rss);
	}, 5);
	try {
		const result = await run();
		highest = Math.max(highest, process.memoryUsage().rss);
		return { result, grew: (highest - before) / MiB };
	} finally {
		clearInterval(sample);
	}
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
}

describe("fork: grep bounds", () => {
	let root: string;
	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "prism-grep-bounds-"));
	});
	afterAll(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("context is a whole number of lines, bounded", () => {
		expect(grepContext(undefined)).toBe(0);
		expect(grepContext(-3)).toBe(0);
		expect(grepContext(Number.NaN)).toBe(0);
		expect(grepContext(Number.POSITIVE_INFINITY)).toBe(0);
		expect(grepContext(2.7)).toBe(2);
		expect(grepContext(1e9)).toBe(MAX_GREP_CONTEXT);
	});

	it("a huge context on a large file answers promptly without noting every line", async () => {
		await writeFile(join(root, "small.txt"), "one\ntwo\nneedle\nfour\n");
		// The empty fifth line is the one after the last newline, as upstream shows it.
		// Every file counts as large: its context lines are gathered by the streamed reader.
		const tool = createGrepTool(root, { largeFileContext: { thresholdBytes: -1 } });
		const started = performance.now();
		const { result, grew } = await peak(() =>
			tool.execute("grep", { pattern: "needle", path: "small.txt", context: 1e9, literal: true }),
		);
		expect(text(result)).toBe(
			"small.txt-1- one\nsmall.txt-2- two\nsmall.txt:3: needle\nsmall.txt-4- four\nsmall.txt-5- ",
		);
		expect(performance.now() - started).toBeLessThan(5000);
		expect(grew).toBeLessThan(64);
	}, 20_000);

	it("a match on a 128 MiB line keeps its line number and shows its start, without gathering it", async () => {
		await writeFile(join(root, "giant.txt"), `one\ntwo\nstart needle ${"x".repeat(128 * MiB)}\nfour needle\n`);
		const tool = createGrepTool(root);
		const plain = await peak(() => tool.execute("grep", { pattern: "needle", path: "giant.txt", literal: true }));
		const lines = text(plain.result).split("\n");
		expect(lines[0]).toMatch(/^giant\.txt:3: start needle x+/);
		expect(lines[0].length).toBeLessThan(600);
		expect(lines[1]).toBe("giant.txt:4: four needle");
		expect(plain.grew).toBeLessThan(64);
		// With context, the file is over the streamed threshold: the giant line is read only in part.
		const around = await peak(() =>
			tool.execute("grep", { pattern: "four", path: "giant.txt", context: 1, literal: true }),
		);
		const block = text(around.result).split("\n");
		expect(block[0]).toMatch(/^giant\.txt-3- start needle x+/);
		expect(block[0].length).toBeLessThan(600);
		expect(block[1]).toBe("giant.txt:4: four needle");
		expect(around.grew).toBeLessThan(64);
	}, 30_000);

	it("a giant match whose line number is out of reach is counted in a notice", async () => {
		// Thousands of matches on the line: ripgrep's event ends with their offsets, far past its line number.
		await writeFile(join(root, "many.txt"), `${"needle ".repeat(4000)}${"x".repeat(2 * MiB)}\n`);
		const { result, grew } = await peak(() =>
			createGrepTool(root).execute("grep", { pattern: "needle", path: "many.txt", literal: true }),
		);
		expect(text(result)).toMatch(/1 matching line over 1 MB not shown: their line number was not found/);
		expect(grew).toBeLessThan(64);
	}, 20_000);

	it("readJsonLines keeps whole lines and the two ends of a longer one, across chunks", async () => {
		const input = new PassThrough();
		const lines: string[] = [];
		const oversize: Array<[string, string]> = [];
		readJsonLines(
			input,
			(line) => lines.push(line),
			(head, tail) => oversize.push([head.toString("latin1"), tail.toString("latin1")]),
		);
		const long = `A${"b".repeat(3 * MiB)}C`;
		for (const piece of ["first\nsec", "ond\n", long.slice(0, MiB), long.slice(MiB), "\nlast"]) input.write(piece);
		input.end();
		await new Promise((done) => input.on("end", done));
		expect(lines).toEqual(["first", "second", "last"]);
		expect(oversize).toHaveLength(1);
		expect(oversize[0][0].length).toBe(64 * 1024);
		expect(oversize[0][0].startsWith("Ab")).toBe(true);
		expect(oversize[0][1].length).toBe(64 * 1024);
		expect(oversize[0][1].endsWith("bC")).toBe(true);
	});

	it("oversizeMatch reads the path, a cut escape and the real line number only", () => {
		const head = Buffer.from(
			'{"type":"match","data":{"path":{"text":"a \\"b\\".txt"},"lines":{"text":"caf\\u00e9 \\"line_number\\":9,\\"absolute_offset\\" \\u00',
		);
		const tail = Buffer.from(
			'xx\\"line_number\\":7,\\"absolute_offset\\"\\n"},"line_number":42,"absolute_offset":10}',
		);
		expect(oversizeMatch(head, tail)).toEqual({
			path: { text: 'a "b".txt' },
			lineStart: 'café "line_number":9,"absolute_offset" ',
			lineNumber: 42,
		});
		expect(oversizeMatch(Buffer.from('{"type":"context"'), tail)).toBeUndefined();
	});
});
