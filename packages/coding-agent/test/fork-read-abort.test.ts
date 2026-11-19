/**
 * fork: a cancelled read stops its work. The large-file scan ran to the end
 * of the file (and held the file's write queue meanwhile), grep's context reading read every large file, and a document
 * extraction kept its program running.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { documentTextForModel, type Runner } from "../src/fork/document-preview.ts";
import { cacheLargeFileContext } from "../src/fork/grep-context-lines.ts";
import { readLargeText } from "../src/fork/large-text-read.ts";

describe("fork: a cancelled read stops its work", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "prism-read-abort-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("the large-file scan stops when the read is cancelled", async () => {
		const file = join(dir, "large.txt");
		writeFileSync(file, "line\n".repeat(800_000));
		const controller = new AbortController();
		const reading = readLargeText(file, "large.txt", undefined, 1, {
			thresholdBytes: 1,
			chunkBytes: 1024,
			signal: controller.signal,
		});
		setImmediate(() => controller.abort());
		await expect(reading).rejects.toThrow("Operation aborted");
	});

	it("grep's context reading reads nothing once the search is cancelled", async () => {
		const file = join(dir, "large.txt");
		writeFileSync(file, "a\nneedle\nb\n");
		const controller = new AbortController();
		controller.abort();
		const cache = new Map<string, string[]>();
		await cacheLargeFileContext([{ filePath: file, lineNumber: 2 }], 1, cache, {
			thresholdBytes: 1,
			signal: controller.signal,
		});
		expect(cache.has(file)).toBe(false);
	});

	it("a document extraction gets the read's signal, to stop its program", async () => {
		const file = join(dir, "doc.pdf");
		writeFileSync(file, "%PDF-1.4\n");
		const controller = new AbortController();
		let received: AbortSignal | undefined;
		const run: Runner = async (_program, _args, options) => {
			received = options.signal;
			return "text";
		};
		await documentTextForModel(file, { which: (name) => `/usr/bin/${name}`, run, signal: controller.signal });
		expect(received).toBe(controller.signal);
	});
});
