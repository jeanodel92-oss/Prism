// fork: the walk that finds nested repositories trusts a folder's change time
// only on filesystems that keep it (sandbox.md § 10.10, option 1). Elsewhere it reads every folder again.
import type * as Fs from "node:fs";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { findRepositories } from "../src/fork/sandbox/nested-git.ts";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof Fs>();
	return {
		...actual,
		readdirSync: vi.fn(actual.readdirSync),
		// A FUSE filesystem, whose change times Prism cannot rely on.
		statfsSync: vi.fn((path: string) => ({ ...actual.statfsSync(path), type: 0x65735546 })),
	};
});

afterEach(() => vi.restoreAllMocks());

it("reads every folder again on a filesystem that may not keep change times", () => {
	const root = mkdtempSync(join(tmpdir(), "prism-nested-walk-"));
	try {
		for (const path of ["a/b", "a/c", "d"]) mkdirSync(join(root, path), { recursive: true });
		// Long after the folders changed: on a filesystem Prism trusts, the second walk would read none.
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
		findRepositories([root]);
		vi.mocked(readdirSync).mockClear();
		findRepositories([root]);
		expect(vi.mocked(readdirSync)).toHaveBeenCalledTimes(5);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
