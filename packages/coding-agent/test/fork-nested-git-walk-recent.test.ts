// fork: on a filesystem that keeps change times, the walk that finds nested
// repositories reads a folder again only when it changed, or changed within the last second (sandbox.md § 10.10).
// Its own file: which filesystems keep change times is cached per process.
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
		statfsSync: vi.fn((path: string) => ({ ...actual.statfsSync(path), type: 0x01021994 })),
	};
});

afterEach(() => vi.restoreAllMocks());

it("reads again a folder changed within the last second, then trusts it", () => {
	const root = mkdtempSync(join(tmpdir(), "prism-nested-walk-"));
	try {
		for (const path of ["a/b", "a/c", "d"]) mkdirSync(join(root, path), { recursive: true });
		findRepositories([root]);
		vi.mocked(readdirSync).mockClear();
		// A change in the same clock tick as this read would keep the folder's change time.
		findRepositories([root]);
		expect(vi.mocked(readdirSync)).toHaveBeenCalledTimes(5);
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
		findRepositories([root]);
		vi.mocked(readdirSync).mockClear();
		findRepositories([root]);
		expect(vi.mocked(readdirSync)).toHaveBeenCalledTimes(0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
