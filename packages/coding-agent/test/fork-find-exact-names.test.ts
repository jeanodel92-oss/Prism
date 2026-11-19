/**
 * fork: find trimmed each name fd printed and split them on line breaks.
 * "report.txt " (ending with a space) came back as "report.txt", another file or none, and a name holding a newline
 * came back as two names. fd now separates its results with NUL and the names keep every character.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFindTool } from "../src/core/tools/find.ts";

describe("fork: find keeps the names fd found", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	const found = async (files: string[]) => {
		const dir = mkdtempSync(join(tmpdir(), "pi-find-names-"));
		dirs.push(dir);
		mkdirSync(join(dir, "sub"));
		for (const file of files) writeFileSync(join(dir, file), "");
		const result = await createFindTool(dir).execute("call", { pattern: "*", path: dir });
		const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
		return text.split("\n").filter((line) => line && line !== "sub/");
	};

	it("keeps a name's leading and trailing spaces", async () => {
		expect((await found(["report.txt ", " notes.md"])).sort()).toEqual([" notes.md", "report.txt "]);
		expect((await found(["report.txt ", "report.txt"])).sort()).toEqual(["report.txt", "report.txt "]);
	});

	it("shows a name holding a newline as one path", async () => {
		expect(await found(["partA\npartB.txt"])).toEqual([JSON.stringify("partA\npartB.txt")]);
	});
});
