// fork: a read running alongside an edit of the same file could see it empty: the edit
// truncates the file before writing it ("read a renvoyé vide une fois").
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEditTool } from "../src/core/tools/edit.ts";
import { createReadTool } from "../src/core/tools/read.ts";

describe("fork: read alongside an edit of the same file", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("never sees the file empty or torn", async () => {
		const dir = mkdtempSync(join(tmpdir(), "prism-race-"));
		dirs.push(dir);
		const file = join(dir, "big.txt");
		// 5.6 MB, so writing it leaves a window to land in, in 2 000 long lines: the diff each edit computes over
		// 200 000 short ones took 400 ms, 40 edits outgrew the timeout under the load of `./test.sh`. Same window, and
		// a truncating edit with an unqueued read still fails every run (5 of 5), in 2 s instead of 16.
		const body = Array.from({ length: 2_000 }, (_, i) => `line ${i} ${"x".repeat(2_800)}`).join("\n");
		writeFileSync(file, `HEADER\n${body}\nTARGET-0\n`);
		const read = createReadTool(dir);
		const edit = createEditTool(dir);

		// Start the read at staggered points of the edit, so some land while it writes.
		for (let i = 0; i < 40; i++) {
			const editing = edit.execute(`e${i}`, {
				path: "big.txt",
				edits: [{ oldText: `TARGET-${i}`, newText: `TARGET-${i + 1}` }],
			});
			await new Promise((resolve) => setTimeout(resolve, i % 20));
			const [readResult] = await Promise.all([read.execute(`r${i}`, { path: "big.txt", limit: 1 }), editing]);
			const first = readResult.content[0];
			expect(first?.type === "text" ? first.text : "").toMatch(/^HEADER/);
		}
	}, 60_000);
});
