/**
 * fork: read accepts any number for offset and limit. offset=1.5 read the
 * first line of a small file (slice rounds its indices) but the second line of a file streamed past 16 MiB, so the
 * same call gave different lines depending on the file's size. Both paths now use whole line numbers.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createReadTool } from "../src/core/tools/read.ts";
import { LARGE_TEXT_BYTES } from "../src/fork/large-text-read.ts";

const root = mkdtempSync(join(tmpdir(), "pi-read-fraction-"));

describe("fork: read with a fractional offset or limit", () => {
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	it("reads the same lines from a small file and from a streamed large one", async () => {
		const head = "first\nsecond\nthird\n";
		writeFileSync(join(root, "small.txt"), head);
		writeFileSync(join(root, "large.txt"), head + "x\n".repeat(LARGE_TEXT_BYTES / 2 + 1024));
		const tool = createReadTool(root);
		const firstLine = async (path: string, offset: number, limit: number) => {
			const result = await tool.execute("read", { path, offset, limit });
			const block = result.content[0];
			return (block?.type === "text" ? block.text : "").split("\n")[0];
		};
		for (const [offset, limit] of [
			[1.5, 1],
			[2.9, 1.7],
		] as const) {
			const small = await firstLine("small.txt", offset, limit);
			expect(await firstLine("large.txt", offset, limit), `offset=${offset} limit=${limit}`).toBe(small);
		}
		expect(await firstLine("large.txt", 1.5, 1)).toBe("first");
	});
});
