// fork: fuzz target for the edits a language server sends to lsp_fix (Prism's fork of pi-lsp). With
// write: true, the file must end up exactly as the edits say when they are well formed, and unchanged when any of
// them is not. Before the fork, a malformed edit wrote "undefined", a duplicate or a deleted prefix into the file.
// Replay with PI_FUZZ_SEED.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

function makeRandom(seed: number): () => number {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
		return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
	};
}

const seed = Number(process.env.PI_FUZZ_SEED ?? 7_722);
const SERVER = join(import.meta.dirname, "fixtures", "fake-lsp-server.mjs");

type Position = { line: number; character: number };
type Edit = { range: { start: Position; end: Position }; newText: string };

/**
 * Offset of an LSP position: lines end at LF, CRLF or CR; a character past the end of its
 * line stops before the line's terminator, a line past the end at the text's end.
 */
function offsetOf(text: string, { line, character }: Position): number {
	const lines: { start: number; contentEnd: number }[] = [];
	let start = 0;
	for (const match of text.matchAll(/\r\n|\r|\n/g)) {
		lines.push({ start, contentEnd: match.index });
		start = match.index + match[0].length;
	}
	lines.push({ start, contentEnd: text.length });
	if (line >= lines.length) return text.length;
	return Math.min(lines[line]!.start + character, lines[line]!.contentEnd);
}

describe("fork: lsp_fix edits from the language server", () => {
	let tempDir: string;
	let harness: Harness;
	const previousAgentDir = process.env[ENV_AGENT_DIR];
	const editsFile = () => join(tempDir, "edits.json");

	beforeAll(async () => {
		tempDir = mkdtempSync(join(tmpdir(), "prism-lsp-fuzz-"));
		const agentDir = join(tempDir, "agent");
		mkdirSync(agentDir);
		process.env[ENV_AGENT_DIR] = agentDir;
		writeFileSync(
			join(agentDir, "pi-lsp.json"),
			JSON.stringify({
				timeout: 20_000,
				servers: {
					fake: {
						command: [process.execPath, SERVER],
						extensions: [".fake"],
						env: { FAKE_LSP_EDITS_FILE: editsFile(), FAKE_LSP_PAD: "0" },
					},
				},
			}),
		);
		const lsp = builtInExtensions.find((extension) => typeof extension !== "function" && extension.name === "pi-lsp");
		if (!lsp || typeof lsp === "function") throw new Error("no built-in pi-lsp");
		harness = await createHarness({ extensionFactories: [{ name: "pi-lsp", factory: lsp.factory }] });
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });
	});

	afterAll(() => {
		harness?.cleanup();
		if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = previousAgentDir;
		rmSync(tempDir, { recursive: true, force: true });
	});

	async function fix(file: string, edits: unknown, root = tempDir) {
		writeFileSync(editsFile(), JSON.stringify(edits));
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("lsp_fix", { path: file, root, write: true })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("fix");
		return harness.session.messages.findLast((message) => message.role === "toolResult")!;
	}

	it("writes exactly the well-formed edits, and nothing when one is malformed", async () => {
		const random = makeRandom(seed);
		const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
		const integer = (max: number) => Math.floor(random() * max);
		const junk: unknown[] = [undefined, null, -1, 1.5, Number.NaN, "2", {}, [], true];
		let malformedCases = 0;
		for (let index = 0; index < 60; index++) {
			const text = Array.from({ length: 1 + integer(5) }, () =>
				Array.from({ length: integer(8) }, () => pick(["a", "b", " ", "é", "\r"])).join(""),
			).join("\n");
			const file = join(tempDir, `case-${index}.fake`);
			writeFileSync(file, text);
			// Non-overlapping ranges, in random order, some past the end of a line or of the text.
			const positions = Array.from({ length: 2 * integer(4) }, () => ({
				line: integer(7),
				character: integer(10),
			})).sort((left, right) => offsetOf(text, left) - offsetOf(text, right) || left.line - right.line);
			const edits: unknown[] = [];
			for (let at = 0; at < positions.length; at += 2) {
				edits.push({
					range: { start: positions[at]!, end: positions[at + 1]! },
					newText: pick(["", "X", "\n", "ü"]),
				});
			}
			let malformed = false;
			if (edits.length > 0 && random() < 0.5) {
				malformed = true;
				const edit = pick(edits) as Record<string, unknown> & Edit;
				const damage = integer(4);
				if (damage === 0) edit.newText = pick(junk) as string;
				else if (damage === 1)
					(edit.range.start as Record<string, unknown>)[pick(["line", "character"])] = pick(junk);
				else if (damage === 2) edit.range = { start: edit.range.end, end: edit.range.start };
				else edits[edits.indexOf(edit)] = pick(junk);
				// Swapping equal or clamped-equal positions leaves a valid range.
				if (damage === 2 && offsetOf(text, edit.range.start) === offsetOf(text, edit.range.end)) malformed = false;
			}
			edits.sort(() => random() - 0.5);
			const label = `seed=${seed} case=${index} text=${JSON.stringify(text)} edits=${JSON.stringify(edits)}`;
			const result = await fix(file, edits);
			const written = readFileSync(file, "utf8");
			if (malformed) {
				malformedCases++;
				expect(result.isError, label).toBe(true);
				expect(written, label).toBe(text);
				continue;
			}
			// Applied from the end; edits at the same place keep the order the server sent them in.
			const placed = (edits as Edit[]).map((edit, order) => ({
				edit,
				order,
				start: offsetOf(text, edit.range.start),
				end: offsetOf(text, edit.range.end),
			}));
			placed.sort((left, right) => right.start - left.start || right.end - left.end || right.order - left.order);
			let expected = text;
			for (const { edit, start, end } of placed)
				expected = expected.slice(0, start) + edit.newText + expected.slice(end);
			expect(result.isError, label).toBe(false);
			expect(written, label).toBe(expected);
		}
		expect(malformedCases).toBeGreaterThan(10);
	}, 120_000);

	it.each([
		["newText missing", { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }],
		[
			"newText an object",
			{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: {} },
		],
		["NaN position", { range: { start: { line: 1, character: null }, end: { line: 1, character: 1 } }, newText: "" }],
		["reversed range", { range: { start: { line: 1, character: 2 }, end: { line: 0, character: 1 } }, newText: "" }],
		[
			"negative character",
			{ range: { start: { line: 1, character: -2 }, end: { line: 1, character: 0 } }, newText: "" },
		],
		["negative line", { range: { start: { line: -1, character: 0 }, end: { line: 0, character: 0 } }, newText: "" }],
	])("leaves the file alone on the probe's malformed edit: %s", async (_name, edit) => {
		const file = join(tempDir, "probe.fake");
		writeFileSync(file, "first\nsecond\n");
		const result = await fix(file, [edit]);
		expect(result.isError).toBe(true);
		expect(readFileSync(file, "utf8")).toBe("first\nsecond\n");
	});

	// overlaps found without comparing every pair, with the same rules.
	it("refuses overlapping edits as before: random ranges against the pairwise check", async () => {
		const random = makeRandom(seed + 1);
		const integer = (max: number) => Math.floor(random() * max);
		const text = "0123456789\nabcdefghij\n";
		const file = join(tempDir, "overlap.fake");
		const conflict = (left: { start: number; end: number }, right: { start: number; end: number }) => {
			if (left.start === left.end && right.start === right.end) return false;
			if (left.start === left.end || right.start === right.end) {
				const insert = left.start === left.end ? left : right;
				const replacement = left.start === left.end ? right : left;
				return replacement.start < insert.start && insert.start < replacement.end;
			}
			return Math.max(left.start, right.start) < Math.min(left.end, right.end);
		};
		let overlapping = 0;
		for (let index = 0; index < 60; index++) {
			const edits: Edit[] = Array.from({ length: 2 + integer(5) }, () => {
				const start = integer(22);
				const end = random() < 0.4 ? start : start + integer(5);
				const at = (offset: number) =>
					offset <= 10 ? { line: 0, character: offset } : { line: 1, character: Math.min(offset - 11, 10) };
				return { range: { start: at(start), end: at(Math.min(end, 21)) }, newText: "_" };
			});
			const placed = edits.map((edit) => ({
				start: offsetOf(text, edit.range.start),
				end: offsetOf(text, edit.range.end),
			}));
			const expected = placed.some((left, i) => placed.some((right, j) => i < j && conflict(left, right)));
			if (expected) overlapping++;
			writeFileSync(file, text);
			const result = await fix(file, edits);
			const label = `seed=${seed} case=${index} edits=${JSON.stringify(edits)}`;
			expect(result.isError, label).toBe(expected);
			if (expected) expect(JSON.stringify(result.content), label).toContain("overlapping");
		}
		expect(overlapping).toBeGreaterThan(10);
	}, 120_000);

	it("applies 150 000 insertions at one place without comparing every pair", async () => {
		const file = join(tempDir, "inserts.fake");
		writeFileSync(file, "end");
		const at = { line: 0, character: 0 };
		const edits = Array.from({ length: 150_000 }, (_, index) => ({
			range: { start: at, end: at },
			newText: String(index % 10),
		}));
		const started = performance.now();
		const result = await fix(file, edits);
		expect(result.isError).toBe(false);
		expect(readFileSync(file, "utf8").slice(0, 12)).toBe("012345678901");
		// 1.2 s alone with the server's round trip; comparing every pair took 25.7 s (measured).
		expect(performance.now() - started).toBeLessThan(20_000);
	}, 60_000);

	it("reads a large server message in linear time", async () => {
		const config = join(process.env[ENV_AGENT_DIR]!, "pi-lsp.json");
		const original = readFileSync(config, "utf8");
		// 32 MB took 4.3 s before the fork; the answer arrives in 64 KiB chunks. The reader joined the pending bytes
		// with each chunk: about 512 joins of a growing buffer, 8 GiB copied. Counting the bytes it joins proves the
		// reading linear whatever the machine's load, where a wall-clock limit failed under `./test.sh`.
		const padding = 32 * 1024 * 1024;
		writeFileSync(config, original.replace('"FAKE_LSP_PAD":"0"', `"FAKE_LSP_PAD":"${padding}"`));
		const concat = Buffer.concat;
		let joined = 0;
		const spy = vi.spyOn(Buffer, "concat").mockImplementation((list, totalLength) => {
			const result = concat.call(Buffer, list, totalLength);
			joined += result.length;
			return result;
		});
		try {
			const file = join(tempDir, "large.fake");
			writeFileSync(file, "abc");
			const result = await fix(file, [
				{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "z" },
			]);
			expect(result.isError).toBe(false);
			expect(readFileSync(file, "utf8")).toBe("zbc");
			expect(joined).toBeLessThan(4 * padding);
		} finally {
			spy.mockRestore();
			writeFileSync(config, original);
		}
	}, 60_000);

	// the edits were computed on the text read before the analysis and
	// written over whatever the file had become meanwhile.
	it("does not write edits computed on a text the file no longer has", async () => {
		const file = join(tempDir, "changed.fake");
		writeFileSync(file, "abc");
		writeFileSync(`${editsFile()}.change`, "changed meanwhile");
		const result = await fix(file, [
			{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "z" },
		]);
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain("Run lsp_fix again");
		expect(readFileSync(file, "utf8")).toBe("changed meanwhile");
	});

	// a column past the line stops before CRLF, and a lone CR ends a line.
	it("places edits by LF, CRLF and CR line endings", async () => {
		const crlf = join(tempDir, "crlf.fake");
		writeFileSync(crlf, "abc\r\ndef");
		const at = { line: 0, character: 1000 };
		expect((await fix(crlf, [{ range: { start: at, end: at }, newText: "X" }])).isError).toBe(false);
		expect(readFileSync(crlf, "utf8")).toBe("abcX\r\ndef");

		const cr = join(tempDir, "cr.fake");
		writeFileSync(cr, "abc\rdef\rghi");
		const range = { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } };
		expect((await fix(cr, [{ range, newText: "XYZ" }])).isError).toBe(false);
		expect(readFileSync(cr, "utf8")).toBe("abc\rXYZ\rghi");
	});

	// a name starting with ".." is inside the root; a real parent path is not.
	it("accepts a root file named ..generated and still refuses ../outside", async () => {
		const inside = join(tempDir, "..generated.fake");
		writeFileSync(inside, "abc");
		const edit = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "z" };
		const accepted = await fix(inside, [edit]);
		expect(accepted.isError, JSON.stringify(accepted.content)).toBe(false);
		expect(readFileSync(inside, "utf8")).toBe("zbc");

		const nested = join(tempDir, "nested");
		mkdirSync(nested, { recursive: true });
		const outside = join(tempDir, "outside.fake");
		writeFileSync(outside, "abc");
		const refused = await fix("../outside.fake", [edit], nested);
		expect(refused.isError).toBe(true);
		expect(readFileSync(outside, "utf8")).toBe("abc");
	});

	// the client announces CodeAction literals, so a conforming server sends edits; a server
	// that still sends only Commands gets an explicit error, not a silent "no change".
	it("receives CodeAction literals and reports a server that sends only commands", async () => {
		const file = join(tempDir, "literal.fake");
		writeFileSync(file, "abc");
		const edit = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "z" };
		expect((await fix(file, [edit])).isError).toBe(false);
		expect(readFileSync(file, "utf8")).toBe("zbc");

		writeFileSync(`${editsFile()}.commands`, "");
		const result = await fix(file, [edit]);
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain("only commands");
		expect(readFileSync(file, "utf8")).toBe("zbc");
	});
});
