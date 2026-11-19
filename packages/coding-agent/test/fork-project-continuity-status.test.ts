// fork: what /handoff reads from `git status`.
// a file rewritten after the handoff, in an untracked folder whose date did not change, makes it stale.
// a rename seen only in the worktree (" R") is one change, not two with an invented path.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execCommand } from "../src/core/exec.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { handoffFacts, handoffStaleness } from "../src/fork/project-continuity.ts";

describe("handoff facts from git status", () => {
	let root: string;
	const git = (...args: string[]) =>
		execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root, stdio: "ignore" });
	const pi = {
		exec: (command: string, args: string[], options?: { cwd?: string; timeout?: number }) =>
			execCommand(command, args, options?.cwd ?? root, options),
	} as unknown as ExtensionAPI;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "prism-continuity-status-"));
		git("init", "-q");
		mkdirSync(join(root, "project"));
		writeFileSync(join(root, "project", "handoff.md"), "# Handoff\n");
		writeFileSync(join(root, "old.txt"), "a tracked file with enough content\n");
		git("add", ".");
		git("commit", "-qm", "init");
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("sees a file rewritten after the handoff inside an untracked folder", async () => {
		const scratch = join(root, "scratch");
		mkdirSync(scratch);
		writeFileSync(join(scratch, "a.txt"), "before");
		const at = (seconds: number) => new Date(Date.now() + seconds * 1000);
		utimesSync(join(scratch, "a.txt"), at(-100), at(-100));
		utimesSync(scratch, at(-100), at(-100));
		utimesSync(join(root, "project", "handoff.md"), at(-50), at(-50));
		// Rewriting an existing file leaves its folder's date alone.
		writeFileSync(join(scratch, "a.txt"), "after");
		utimesSync(scratch, at(-100), at(-100));
		expect((await handoffStaleness(pi, root))?.newer).toEqual(["scratch/a.txt"]);
	});

	it("counts a worktree-only rename once, under its new name", async () => {
		renameSync(join(root, "old.txt"), join(root, "new.txt"));
		git("add", "-N", "new.txt");
		expect((await handoffFacts(pi, root)).changes).toEqual(["new.txt"]);
	});
});
