// fork: fuzz targets for coding-agent parsers of untrusted input. Replay with PI_FUZZ_SEED.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Compile } from "typebox/compile";
import { expect, it } from "vitest";
import { ModelConfig } from "../src/core/model-config.ts";
import { parseCommandArgs } from "../src/core/prompt-templates.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import { truncateTail } from "../src/core/tools/truncate.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { sanitizeBinaryOutput } from "../src/utils/shell.ts";

function makeRandom(seed: number): () => number {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
		return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
	};
}

it("fuzzes session JSONL, slash arguments, tool output, and models.json parsing", async () => {
	const seed = Number(process.env.PI_FUZZ_SEED ?? 7_703);
	const random = makeRandom(seed);
	const corpus = [
		"{}",
		'{"type":"message","id":"m1","parentId":null,"timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"hi"}}',
		'{"type":"compaction","id":"c1","parentId":"m1","summary":"s","firstKeptEntryId":"m1","tokensBefore":1}',
		"null",
		"42",
		"{broken",
		"\u001b]52;c;token\u0007",
		"\u001b[31mred\u001b[0m\u001b]8;;https://example.test\u0007link\u001b]8;;\u0007",
		'"quoted value"',
		"a\\ b 'single' \"double",
		"--flag=value",
		"😀‮​",
		'{"providers":{}}',
		'{"providers":{"x":{"baseUrl":"https://example.test","api":"openai-completions","models":[]}}}',
		'{"defaultModel":"x","theme":"dark"}',
	];
	const fragment = () => {
		const source = corpus[Math.floor(random() * corpus.length)]!;
		const start = Math.floor(random() * (source.length + 1));
		return random() < 0.5 ? source : source.slice(start, start + Math.floor(random() * (source.length + 1)));
	};
	const started = process.cpuUsage();
	const tempDir = await mkdtemp(join(tmpdir(), "prism-parser-fuzz-"));
	const modelsPath = join(tempDir, "models.json");
	const settingsPath = join(tempDir, "settings.json");
	const sessionPath = join(tempDir, "session.jsonl");
	const header = JSON.stringify({
		type: "session",
		version: 3,
		id: "fuzz",
		timestamp: "2026-01-01T00:00:00Z",
		cwd: tempDir,
	});
	const readArguments = Compile(createReadToolDefinition(tempDir).parameters);
	const argumentCorpus: unknown[] = [
		null,
		"path",
		{},
		{ path: "../outside" },
		{ path: "file", offset: -1 },
		{ path: "‮/​" },
		{ path: "file", limit: 1.5 },
	];
	try {
		for (let index = 0; index < 700; index++) {
			// One to five corpus fragments, joined on one line or across lines.
			const input = Array.from({ length: 1 + Math.floor(random() * 5) }, fragment).join(random() < 0.5 ? "\n" : "");
			try {
				const argv = parseCommandArgs(input);
				expect(argv, `seed=${seed} case=${index}`).toBeInstanceOf(Array);
				expect(
					() => readArguments.Check(argumentCorpus[Math.floor(random() * argumentCorpus.length)]),
					`seed=${seed} case=${index}`,
				).not.toThrow();
				// The bash output pipeline: stripAnsi leaves an unterminated OSC, sanitizeBinaryOutput drops its ESC.
				expect(sanitizeBinaryOutput(stripAnsi(input)), `seed=${seed} case=${index}`).not.toContain("\u001b");
				const maxBytes = 16 + Math.floor(random() * 240);
				const maxLines = 1 + Math.floor(random() * 6);
				const truncated = truncateTail(input, { maxBytes, maxLines });
				expect(Buffer.byteLength(truncated.content), `seed=${seed} case=${index}`).toBeLessThanOrEqual(maxBytes);
				// A final newline ends the last line, it does not open a new one.
				const outputLines = truncated.content.replace(/\n$/, "").split("\n").length;
				expect(outputLines, `seed=${seed} case=${index}`).toBeLessThanOrEqual(maxLines);
				if (index < 100) {
					// The loader the app uses: a valid header followed by untrusted lines.
					await writeFile(sessionPath, `${header}\n${input}\n`);
					const session = SessionManager.open(sessionPath, tempDir);
					expect(session.getEntries(), `seed=${seed} case=${index}`).toBeInstanceOf(Array);
					session.buildSessionContext();
					await writeFile(modelsPath, input);
					const models = await ModelConfig.load(modelsPath);
					expect(models.getProviderIds(), `seed=${seed} case=${index}`).toBeInstanceOf(Array);
					await writeFile(settingsPath, input);
					const settings = SettingsManager.create(tempDir, tempDir);
					expect(settings.getSettings(), `seed=${seed} case=${index}`).toBeTypeOf("object");
				}
			} catch (error) {
				throw new Error(`Coding-agent fuzz failure seed=${seed} case=${index}: ${String(error)}`);
			}
		}
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
	// CPU time, as fork-config-fuzz: its files wait on a busy disk.
	const used = process.cpuUsage(started);
	expect((used.user + used.system) / 1000, `seed=${seed} exceeded 4000ms of CPU`).toBeLessThan(4_000);
}, 60_000);
