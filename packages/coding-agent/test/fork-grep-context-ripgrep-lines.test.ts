/**
 * fork: with `context`, grep rebuilt the lines around a match itself and
 * did not split or decode the file as ripgrep does. A lone \r (a progress line) started a new line, so the line ripgrep
 * reported as the match showed the line before it; a UTF-16 file was read as UTF-8, with NUL between its letters.
 * Both the whole-file read and the streamed read of large files are checked.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createGrepTool } from "../src/core/tools/grep.ts";

const root = mkdtempSync(join(tmpdir(), "pi-grep-lines-"));
const tools = {
	"whole file": createGrepTool(root),
	streamed: createGrepTool(root, { largeFileContext: { thresholdBytes: -1, chunkBytes: 3 } }),
};

async function shown(tool: ReturnType<typeof createGrepTool>, file: string, context: number) {
	const result = await tool.execute("call", { pattern: "needle", path: file, context, literal: true });
	return result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
}

describe("fork: grep's context lines follow ripgrep", () => {
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	for (const [name, tool] of Object.entries(tools)) {
		it(`keeps a lone \\r inside its line (${name})`, async () => {
			writeFileSync(join(root, "progress.log"), "before\rprogress\nneedle\nafter\n");
			expect(await shown(tool, "progress.log", 0)).toBe("progress.log:2: needle");
			expect(await shown(tool, "progress.log", 1)).toBe(
				"progress.log-1- beforeprogress\nprogress.log:2: needle\nprogress.log-3- after",
			);
		});

		it(`decodes a UTF-16 file as ripgrep does (${name})`, async () => {
			const text = "first\nneedle here\nlast\n";
			writeFileSync(join(root, "le.txt"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]));
			writeFileSync(
				join(root, "be.txt"),
				Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, "utf16le").swap16()]),
			);
			for (const file of ["le.txt", "be.txt"]) {
				expect(await shown(tool, file, 1)).toBe(`${file}-1- first\n${file}:2: needle here\n${file}-3- last`);
			}
		});
	}
});
