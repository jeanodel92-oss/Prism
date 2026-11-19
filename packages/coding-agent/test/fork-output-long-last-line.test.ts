/**
 * fork: a single line longer than the rolling buffer, ended by a newline,
 * left an empty snapshot: the cut start of the line and its final newline were dropped together, so bash reported
 * "(no output)" and "Showing lines 2-1 of 1". The end of that line is now kept, with the line's real size.
 */
import { describe, expect, it } from "vitest";
import { createBashTool } from "../src/core/tools/bash.ts";
import { OutputAccumulator } from "../src/core/tools/output-accumulator.ts";
import { DEFAULT_MAX_BYTES } from "../src/core/tools/truncate.ts";

const LINE_BYTES = 300 * 1024;

function accumulate(chunks: string[]): OutputAccumulator {
	const output = new OutputAccumulator({ tempFilePrefix: "pi-long-line-test" });
	for (const chunk of chunks) output.append(Buffer.from(chunk));
	output.finish();
	return output;
}

const longLine = `${"a".repeat(LINE_BYTES - 3)}END`;

describe("fork: a long last line in a command's output", () => {
	for (const [name, chunks] of [
		["one chunk with a newline", [`${longLine}\n`]],
		["many chunks with a newline", [...longLine.match(/.{1,4096}/gs)!, "\n"]],
		["one chunk without a newline", [longLine]],
	] as const) {
		it(`keeps the end of the line (${name})`, async () => {
			const output = accumulate([...chunks]);
			const snapshot = output.snapshot();
			await output.closeTempFile();
			expect(snapshot.content.endsWith("END")).toBe(true);
			expect(Buffer.byteLength(snapshot.content)).toBe(DEFAULT_MAX_BYTES);
			expect(snapshot.truncation).toMatchObject({ totalLines: 1, outputLines: 1, lastLinePartial: true });
			expect(output.getLastLineBytes()).toBe(LINE_BYTES);
		});
	}

	it("shows a short line after the long one as the last line", async () => {
		const output = accumulate([`${longLine}\n`, "ok\n"]);
		const snapshot = output.snapshot();
		await output.closeTempFile();
		expect(snapshot.content).toBe("ok\n");
		expect(snapshot.truncation).toMatchObject({ totalLines: 2, outputLines: 1, lastLinePartial: false });
	});

	it("reports the end of the line from bash, not (no output)", async () => {
		const command = `head -c ${LINE_BYTES} /dev/zero | tr '\\0' x; echo`;
		const result = await createBashTool(process.cwd()).execute("bash-long-line", { command });
		const block = result.content[0];
		const text = block?.type === "text" ? block.text : "";
		expect(text).not.toContain("(no output)");
		expect(text.startsWith("x".repeat(1000))).toBe(true);
		expect(text).toContain("of line 1 (line is 300.0KB)");
	});
});
