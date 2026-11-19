/**
 * fork: the accessibility walk of prism-desktop-helper recursed once per
 * level of the tree, bounded in nodes and time but not in depth: a window of 4 000 nested boxes on the agent's
 * desktop stopped the helper (stack overflow). fork/desktop-helper/tests/a11y-deep.c drives the walk's own code on a
 * fake tree. Skipped without gcc.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const helperDir = fileURLToPath(new URL("../../../fork/desktop-helper/", import.meta.url));

function hasGcc(): boolean {
	try {
		execFileSync("sh", ["-c", "command -v gcc"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

const dir = mkdtempSync(join(tmpdir(), "prism-a11y-deep-"));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(!hasGcc())("prism-desktop-helper on a deep accessibility tree (AS-029)", () => {
	const binary = join(dir, "a11y-deep");

	it("builds the walk with a fake libatspi", () => {
		execFileSync("gcc", [
			"-std=c11",
			"-O2",
			"-Wall",
			"-Wextra",
			"-Werror",
			"-Wno-unused-parameter",
			"-Wno-unused-function",
			"-o",
			binary,
			join(helperDir, "tests", "a11y-deep.c"),
			"-ldl",
		]);
	});

	it("lists a tree 19 000 levels deep as truncated instead of stopping", () => {
		// Under MAX_NODES (20 000): without a depth bound, the walk recursed to the bottom and overflowed the stack.
		const listing = join(dir, "deep.txt");
		const run = spawnSync(binary, ["19000", listing], { encoding: "utf8", timeout: 30_000 });
		expect(run.signal).toBeNull();
		expect(run.status).toBe(0);
		expect(run.stdout.trim()).toBe("ok 1 truncated");
		expect(readFileSync(listing, "utf8")).toContain("W\t1\tapp\tframe\tDeep\t");
	});

	it("still lists the leaf of a tree 400 levels deep", () => {
		const listing = join(dir, "shallow.txt");
		const run = spawnSync(binary, ["400", listing], { encoding: "utf8", timeout: 30_000 });
		expect(run.status).toBe(0);
		expect(run.stdout.trim()).toBe("ok 2");
		expect(readFileSync(listing, "utf8")).toContain("push button\tDEEP-LEAF");
	});
});
