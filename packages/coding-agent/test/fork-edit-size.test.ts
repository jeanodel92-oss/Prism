// fork: edit refuses a file above its size limit, untouched, with guidance for the model.
import { closeSync, ftruncateSync, mkdtempSync, openSync, readSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { assertEditableSize, MAX_EDITABLE_FILE_SIZE } from "../src/fork/regular-file.ts";

let tempDir: string;

afterEach(() => {
	if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

describe("edit file size limit", () => {
	it("refuses a sparse file above the limit and returns actionable guidance", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-edit-size-"));
		const path = join(tempDir, "large.txt");
		const fd = openSync(path, "w+");
		ftruncateSync(fd, MAX_EDITABLE_FILE_SIZE + 1);
		writeSync(fd, "unchanged");
		closeSync(fd);

		const edit = createEditToolDefinition(tempDir);
		await expect(
			edit.execute(
				"tool-1",
				{ path, edits: [{ oldText: "x", newText: "y" }] },
				undefined,
				undefined,
				{} as ExtensionToolContext,
			),
		).rejects.toThrow(
			`Could not edit file: ${path}. Error: ${path} is ${MAX_EDITABLE_FILE_SIZE + 1} bytes, above the edit limit of ${MAX_EDITABLE_FILE_SIZE} bytes. The file was not changed. Use bash to edit this file instead, for example with sed -i, awk, perl -pi, or a short python3 script. View the relevant parts first with head, tail, grep -n, or sed -n 'X,Yp'.`,
		);

		const checkFd = openSync(path, "r");
		const marker = Buffer.alloc(9);
		readSync(checkFd, marker);
		closeSync(checkFd);
		expect(marker.toString()).toBe("unchanged");
		expect(statSync(path).size).toBe(MAX_EDITABLE_FILE_SIZE + 1);
	});

	it("allows a file below a lowered limit and rejects one above it", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-edit-size-"));
		const path = join(tempDir, "small.txt");
		const fd = openSync(path, "w+");
		ftruncateSync(fd, 7);
		closeSync(fd);

		await expect(assertEditableSize(path, 8)).resolves.toBeUndefined();
		await expect(assertEditableSize(path, 6)).rejects.toThrow("7 bytes, above the edit limit of 6 bytes");
	});
});
