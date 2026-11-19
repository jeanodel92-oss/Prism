import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { type ExternalEditorResult, editInExternalEditor } from "../src/modes/interactive/external-editor.ts";

const editorFixturePath = fileURLToPath(new URL("./fixtures/fake-external-editor.mjs", import.meta.url));

interface EditorCapture {
	filePath: string;
	content: string;
	entries: string[];
	directoryMode: number;
}

async function runExternalEditor(fixtureFlag?: "--fail" | "--empty"): Promise<{
	result: ExternalEditorResult;
	capture: EditorCapture;
}> {
	const testDirectory = mkdtempSync(join(tmpdir(), "pi-external-editor-test-"));
	const capturePath = join(testDirectory, "capture.json");
	try {
		const result = await editInExternalEditor({
			command: `${process.execPath} ${editorFixturePath} ${capturePath}${fixtureFlag ? ` ${fixtureFlag}` : ""}`,
			content: "original",
		});
		const capture = JSON.parse(readFileSync(capturePath, "utf-8")) as EditorCapture;
		return { result, capture };
	} finally {
		rmSync(testDirectory, { recursive: true, force: true });
	}
}

describe("editInExternalEditor", () => {
	it("edits a prompt inside a private temporary directory", async () => {
		const { result, capture } = await runExternalEditor();
		const directory = dirname(capture.filePath);

		expect(result).toEqual({ status: "complete", content: "edited" });
		expect(dirname(directory)).toBe(tmpdir());
		expect(basename(directory)).toMatch(/^pi-editor-.+$/);
		expect(basename(capture.filePath)).toBe("prompt.md");
		expect(capture.entries).toEqual(["prompt.md"]);
		expect(capture.content).toBe("original");
		if (process.platform !== "win32") {
			expect(capture.directoryMode & 0o077).toBe(0);
		}
		expect(existsSync(directory)).toBe(false);
	});

	it("keeps the original content when the editor exits unsuccessfully", async () => {
		const { result, capture } = await runExternalEditor("--fail");

		expect(result).toEqual({ status: "failed" });
		expect(existsSync(dirname(capture.filePath))).toBe(false);
	});
	it("returns empty content when the editor clears the prompt", async () => {
		const { result } = await runExternalEditor("--empty");

		expect(result).toEqual({ status: "complete", content: "" });
	});

	// fork: a temporary file that cannot be made or read back is a failure with
	// its reason, never an exception thrown at the interface.
	it("fails with a reason when the prompt file cannot be created or is gone after the editor", async () => {
		vi.stubEnv("TMPDIR", join(tmpdir(), "pi-missing-tmp-dir", "nested"));
		try {
			const unwritable = await editInExternalEditor({ command: "true", content: "x" });
			expect(unwritable).toMatchObject({ status: "failed", error: expect.stringContaining("ENOENT") });
		} finally {
			vi.unstubAllEnvs();
		}
		const removed = await editInExternalEditor({ command: "rm", content: "x" });
		expect(removed).toMatchObject({ status: "failed", error: expect.stringContaining("ENOENT") });
	});
});
