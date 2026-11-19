/**
 * fork: a repository created in the session's folder after start, or
 * nested inside the repository found at start, shows its branch in the footer.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FooterDataProvider } from "../src/core/footer-data-provider.ts";

/** What `git init` leaves: `.git` first, its HEAD a moment later. */
async function initRepository(dir: string, branch: string): Promise<void> {
	mkdirSync(join(dir, ".git"));
	await new Promise((done) => setTimeout(done, 100));
	writeFileSync(join(dir, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
}

function nextBranchChange(provider: FooterDataProvider): Promise<void> {
	return new Promise((done, fail) => {
		const timer = setTimeout(() => fail(new Error("no branch change")), 5_000);
		const stop = provider.onBranchChange(() => {
			clearTimeout(timer);
			stop();
			done();
		});
	});
}

describe("footer branch after a repository appears", () => {
	let dir: string;
	let provider: FooterDataProvider | undefined;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "prism-footer-discovery-"));
	});
	afterEach(() => {
		provider?.dispose();
		provider = undefined;
		rmSync(dir, { recursive: true, force: true });
	});

	it("shows the branch of a repository initialized in a folder that had none", async () => {
		provider = new FooterDataProvider(dir);
		expect(provider.getGitBranch()).toBeNull();
		const changed = nextBranchChange(provider);
		await initRepository(dir, "main");
		await changed;
		expect(provider.getGitBranch()).toBe("main");
	});

	it("switches to a repository nested in the one found at start", async () => {
		await initRepository(dir, "outer");
		const sub = join(dir, "sub");
		mkdirSync(sub);
		provider = new FooterDataProvider(sub);
		expect(provider.getGitBranch()).toBe("outer");
		const changed = nextBranchChange(provider);
		await initRepository(sub, "inner");
		await changed;
		expect(provider.getGitBranch()).toBe("inner");
	});
});
