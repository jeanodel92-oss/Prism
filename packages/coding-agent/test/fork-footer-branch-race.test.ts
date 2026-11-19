/**
 * fork: a branch resolved by git for the previous project does not come
 * back in the footer after the session moved to another project.
 */
import { execFile } from "child_process";
import { type FSWatcher, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const git = vi.hoisted(() => ({ answer: undefined as ((branch: string) => void) | undefined }));

vi.mock("child_process", () => ({
	execFile: vi.fn(
		(
			_command: string,
			_args: readonly string[],
			_options: unknown,
			callback: (error: Error | null, stdout: string, stderr: string) => void,
		) => {
			git.answer = (branch) => callback(null, `${branch}\n`, "");
		},
	),
	spawnSync: vi.fn(() => ({ status: 0, stdout: "main\n", stderr: "" })),
}));

import { FooterDataProvider } from "../src/core/footer-data-provider.ts";

describe("fork: a late git answer for the previous project", () => {
	let tempDir: string;
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "prism-footer-branch-"));
		git.answer = undefined;
		vi.mocked(execFile).mockClear();
	});
	afterEach(() => {
		vi.useRealTimers();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("keeps the new project's branch", async () => {
		vi.useFakeTimers();
		const first = join(tempDir, "a");
		mkdirSync(join(first, ".git", "reftable"), { recursive: true });
		writeFileSync(join(first, ".git", "HEAD"), "ref: refs/heads/.invalid\n");
		const second = join(tempDir, "b");
		mkdirSync(join(second, ".git"), { recursive: true });
		writeFileSync(join(second, ".git", "HEAD"), "ref: refs/heads/b-branch\n");

		const provider = new FooterDataProvider(first);
		try {
			expect(provider.getGitBranch()).toBe("main");
			const { reftableWatcher } = provider as unknown as { reftableWatcher: FSWatcher | null };
			reftableWatcher?.emit("change", "change", "tables.list");
			await vi.advanceTimersByTimeAsync(501);
			expect(git.answer).toBeDefined();

			provider.setCwd(second);
			expect(provider.getGitBranch()).toBe("b-branch");
			const changed = vi.fn();
			provider.onBranchChange(changed);
			git.answer?.("a-branch");
			await vi.advanceTimersByTimeAsync(1);

			expect(provider.getGitBranch()).toBe("b-branch");
			expect(changed).not.toHaveBeenCalled();
		} finally {
			provider.dispose();
		}
	});
});
