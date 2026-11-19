// fork: the file that keeps a command's full output is capped at 32 MiB, its first and last
// halves kept around a line that says how much was left out. A command looping forever once wrote 5.5 GB into /tmp.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { executeBashWithOperations } from "../src/core/bash-executor.ts";
import { OutputAccumulator } from "../src/core/tools/output-accumulator.ts";
import { CappedLog, MAX_LOG_BYTES } from "../src/fork/capped-log.ts";

describe("fork: capped output logs", () => {
	const dirs: string[] = [];
	const dir = () => {
		const path = mkdtempSync(join(tmpdir(), "prism-capped-log-"));
		dirs.push(path);
		return path;
	};
	afterEach(() => {
		for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true });
	});

	it("keeps everything up to the cap, then the first and last halves around an omission line", async () => {
		const short = join(dir(), "short.log");
		const whole = new CappedLog(short, 20);
		whole.write("0123456789");
		whole.write(Buffer.from("abcdefghij"));
		await whole.end();
		expect(readFileSync(short, "utf8")).toBe("0123456789abcdefghij");

		const long = join(dir(), "long.log");
		const capped = new CappedLog(long, 20);
		for (const chunk of ["0123456789", "abc", "déf", "ghijklmnop", "qrstuvwxyz", "é1234567"]) capped.write(chunk);
		await capped.end();
		await capped.end();
		const text = readFileSync(long, "utf8");
		const [head, tail] = text.split(/\n\n\[\.\.\. \d+ bytes omitted: [^\n]*\]\n\n/);
		expect(head).toBe("0123456789");
		// Cut between two characters: the é of the last chunk is not split.
		expect(Buffer.byteLength(tail!)).toBeLessThanOrEqual(10);
		expect("qrstuvwxyzé1234567".endsWith(tail!)).toBe(true);
		expect(text).not.toContain("�");
		const omitted = Number(/(\d+) bytes omitted/.exec(text)![1]);
		expect(omitted + Buffer.byteLength(head!) + Buffer.byteLength(tail!)).toBe(
			Buffer.byteLength("0123456789abcdéfghijklmnopqrstuvwxyzé1234567"),
		);

		// The head is cut between two characters too.
		const split = join(dir(), "split.log");
		const accented = new CappedLog(split, 20);
		accented.write("012345678é");
		accented.write("0123456789abcdefghij");
		await accented.end();
		// The byte the cut left out of the head goes to the end.
		expect(readFileSync(split, "utf8").startsWith("012345678\n\n[... 11 bytes omitted")).toBe(true);
	});

	// fork: a character split between two writes stays whole, at the head's limit
	// and at the start of the kept end, and output that fits the cap is kept whole.
	it("keeps characters split between two writes whole, and loses nothing that fits the cap", async () => {
		const read = async (writes: Array<string | Buffer>, max: number) => {
			const file = join(dir(), "log");
			const log = new CappedLog(file, max);
			for (const chunk of writes) log.write(chunk);
			await log.end();
			return readFileSync(file);
		};
		const e = Buffer.from("é");
		const headSplit = await read(
			[
				Buffer.concat([Buffer.from("1234"), e.subarray(0, 1)]),
				Buffer.concat([e.subarray(1), Buffer.from("x".repeat(30))]),
			],
			10,
		);
		expect(headSplit.toString("utf8"), "head").not.toContain("\ufffd");
		const tailSplit = await read(
			["12345", e.subarray(0, 1), Buffer.concat([e.subarray(1), Buffer.from("abcd")])],
			10,
		);
		expect(tailSplit.toString("utf8"), "tail").not.toContain("\ufffd");
		expect((await read(["1234éABCD"], 10)).toString("utf8"), "fits").toBe("1234éABCD");
	});

	it("caps the logs of the bash tool and of the user's ! commands at 32 MiB", async () => {
		const total = MAX_LOG_BYTES + 8 * 1024 * 1024;
		const chunk = (index: number) => Buffer.from(`${String(index).padStart(8, "0")}${"x".repeat(65527)}\n`);
		const chunks = Math.ceil(total / chunk(0).length);
		const check = (path: string) => {
			expect(statSync(path).size).toBeLessThanOrEqual(MAX_LOG_BYTES + 200);
			const text = readFileSync(path, "utf8");
			expect(text.startsWith("00000000x")).toBe(true);
			expect(text.trimEnd().endsWith("x")).toBe(true);
			expect(text).toContain(`${String(chunks - 1).padStart(8, "0")}x`);
			expect(text).toMatch(
				/\[\.\.\. \d+ bytes omitted: this log keeps the first and last 16 MiB of the output \.\.\.\]/,
			);
		};

		const output = new OutputAccumulator({ tempFilePrefix: "prism-capped-test" });
		for (let index = 0; index < chunks; index++) output.append(chunk(index));
		output.finish();
		const path = output.snapshot({ persistIfTruncated: true }).fullOutputPath!;
		await output.closeTempFile();
		check(path);
		rmSync(path);

		const result = await executeBashWithOperations("loop", dir(), {
			exec: async (_command, _cwd, { onData }) => {
				for (let index = 0; index < chunks; index++) onData(chunk(index));
				return { exitCode: 0 };
			},
		});
		check(result.fullOutputPath!);
		rmSync(result.fullOutputPath!);
	});

	it("keeps the end when the command is cancelled, and when Prism exits while it runs", async () => {
		const chunk = (index: number) => `${String(index).padStart(4, "0")}${"y".repeat(1019)}\n`;
		const controller = new AbortController();
		const cancelled = await executeBashWithOperations(
			"loop",
			dir(),
			{
				exec: async (_command, _cwd, { onData }) => {
					for (let index = 0; index < 4096; index++) onData(Buffer.from(chunk(index)));
					controller.abort();
					throw new Error("aborted");
				},
			},
			{ signal: controller.signal },
		);
		expect(cancelled.cancelled).toBe(true);
		expect(readFileSync(cancelled.fullOutputPath!, "utf8").endsWith(chunk(4095))).toBe(true);
		rmSync(cancelled.fullOutputPath!);

		// Exiting without ending the log, as Prism does on /quit or a signal while a command runs.
		const path = join(dir(), "exit.log");
		const script = `import { CappedLog } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "../src/fork/capped-log.ts")).href)};
const log = new CappedLog(${JSON.stringify(path)}, 4096);
for (let index = 0; index < 1000; index++) log.write("line " + index + "\\n");
process.exit(3);`;
		expect(() => execFileSync(process.execPath, ["--input-type=module", "-e", script], { stdio: "pipe" })).toThrow();
		const text = readFileSync(path, "utf8");
		expect(text.startsWith("line 0\n")).toBe(true);
		expect(text).toContain("bytes omitted");
		expect(text.endsWith("line 999\n")).toBe(true);
	});
});
