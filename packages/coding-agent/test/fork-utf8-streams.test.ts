// fork: a multi-byte UTF-8 character split across two chunks of a
// stream is decoded whole, never as two replacement characters.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { execCommand } from "../src/core/exec.ts";
import { createLocalBashOperations } from "../src/core/tools/bash.ts";
import { createGrepTool } from "../src/core/tools/grep.ts";
import { LineReader } from "../src/fork/browser/protocol.ts";

const SAMPLES = ["é", "€", "😀"];

describe("fork: UTF-8 split across stream chunks", () => {
	it("011: the browser line reader keeps a character split at every byte", () => {
		for (const text of SAMPLES) {
			const bytes = Buffer.from(`${JSON.stringify({ text })}\n`);
			for (let cut = 1; cut < bytes.length; cut++) {
				const reader = new LineReader();
				const messages = [...reader.push(bytes.subarray(0, cut)), ...reader.push(bytes.subarray(cut))];
				expect(messages, `${text} cut at ${cut}`).toEqual([{ text }]);
			}
		}
	});

	it("011: execCommand keeps a character split between two writes, on stdout and stderr", async () => {
		const script = [
			"const bytes = Buffer.from('a😀é');",
			"process.stdout.write(bytes.subarray(0, 2));",
			"process.stderr.write(bytes.subarray(0, 3));",
			"setTimeout(() => { process.stdout.write(bytes.subarray(2)); process.stderr.write(bytes.subarray(3)); }, 50);",
		].join("\n");
		const result = await execCommand(process.execPath, ["-e", script], process.cwd());
		expect(result.stdout).toBe("a😀é");
		expect(result.stderr).toBe("a😀é");
	});

	it("268: the shell keeps a stdout character whole when stderr writes between its bytes", async () => {
		const chunks: Buffer[] = [];
		const command = String.raw`printf 'a\xc3'; sleep 0.05; printf 'warn' >&2; sleep 0.05; printf '\xa9\xf0\x9f'; sleep 0.05; printf 'X' >&2; sleep 0.05; printf '\x98\x80'`;
		const { exitCode } = await createLocalBashOperations().exec(command, process.cwd(), {
			onData: (data) => chunks.push(Buffer.from(data)),
		});
		expect(exitCode).toBe(0);
		const decoder = new TextDecoder();
		const text = chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("") + decoder.decode();
		expect(text.replace(/warn|X/g, "")).toBe("aé😀");
		expect(text).not.toContain("\ufffd");
	});

	it("405: grep shows a match in a file whose name is not UTF-8, and does not spend the limit on nothing", async () => {
		const root = mkdtempSync(join(tmpdir(), "prism-grep-bytes-"));
		try {
			mkdirSync(join(root, "a"));
			mkdirSync(join(root, "b"));
			writeFileSync(Buffer.concat([Buffer.from(`${root}/a/`), Buffer.from([0x66, 0xff])]), "needle one\n");
			writeFileSync(join(root, "b", "plain.txt"), "needle two\n");
			const tool = createGrepTool(root);
			const text = (result: { content: Array<{ type: string; text?: string }> }) =>
				result.content.map((block) => block.text ?? "").join("");
			const all = text(await tool.execute("grep-bytes", { pattern: "needle", literal: true }));
			expect(all).toContain("a/f\ufffd:1: needle one");
			expect(all).toContain("b/plain.txt:1: needle two");
			const withContext = text(await tool.execute("grep-bytes", { pattern: "needle", literal: true, context: 1 }));
			expect(withContext).toContain("needle one");
			expect(withContext).toContain("needle two");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
