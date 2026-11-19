/**
 * fork: browsing the window's file screen started one document extraction
 * per file shown, and a preview nobody waited for any more ran to its end. A newer preview now stops the older one.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleBuiltinCommand } from "../src/fork/rpc-builtins.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const signals = vi.hoisted(() => [] as AbortSignal[]);
vi.mock("../src/fork/document-preview.ts", async (importOriginal) => {
	const real = await importOriginal<Record<string, unknown>>();
	return {
		...real,
		// An extraction that runs until its signal stops it.
		previewDocument: (path: string, options: { signal?: AbortSignal } = {}) => {
			const signal = options.signal!;
			signals.push(signal);
			return new Promise((resolve) => {
				signal.addEventListener("abort", () => resolve({ path, kind: "extracted", problem: "stopped" }));
			});
		},
	};
});

describe("fork: the file screen's stale previews", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("stops the extraction of a preview when another one is asked", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		for (const name of ["a.docx", "b.docx"]) writeFileSync(join(harness.tempDir, name), "x");
		const preview = (path: string) =>
			handleBuiltinCommand(
				{ type: "files_preview", path },
				harness.session,
				{} as never,
				{} as never,
				async () => {},
			);
		const first = preview("a.docx");
		await vi.waitFor(() => expect(signals).toHaveLength(1));
		expect(signals[0]!.aborted).toBe(false);
		const second = preview("b.docx");
		await vi.waitFor(() => expect(signals).toHaveLength(2));
		expect(signals[0]!.aborted).toBe(true);
		expect(signals[1]!.aborted).toBe(false);
		await first;
		// A third one stops the second; it stays pending, as an extraction nobody stops would.
		void preview("a.docx");
		await second;
	});
});
