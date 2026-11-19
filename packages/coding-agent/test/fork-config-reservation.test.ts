// a shipped Prism reserves only its own `.prism` in a project; it creates no `.pi`
// any more, keeps an existing `.pi` read-only, and /files hides an empty configuration folder.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listDirectory } from "../src/fork/file-browser.ts";
import { buildLayout, DEFAULT_SANDBOX_SETTINGS } from "../src/fork/sandbox/layout.ts";

// A shipped Prism's configuration folder (the sources use `.pi`); vi.mock is hoisted above the imports.
vi.mock("../src/config.ts", async (original) => ({
	...(await original<Record<string, unknown>>()),
	CONFIG_DIR_NAME: ".prism",
}));

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(): { home: string; cwd: string; agent: string } {
	const home = mkdtempSync(join(tmpdir(), "prism-reservation-"));
	dirs.push(home);
	const cwd = join(home, "project");
	const agent = join(home, ".prism", "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agent, { recursive: true });
	return { home, cwd, agent };
}

describe("fork: configuration folders reserved in a project", () => {
	it("reserves .prism only, and keeps an existing .pi read-only", () => {
		const { home, cwd, agent } = project();
		let plan = buildLayout({ cwd, home, agentDir: agent, settings: DEFAULT_SANDBOX_SETTINGS });
		const reserved = (plan.missing ?? []).map(({ path }) => path);
		expect(reserved).toContain(join(cwd, ".prism"));
		expect(reserved).not.toContain(join(cwd, ".pi"));
		mkdirSync(join(cwd, ".pi"));
		plan = buildLayout({ cwd, home, agentDir: agent, settings: DEFAULT_SANDBOX_SETTINGS });
		expect(plan.readOnly).toContain(join(cwd, ".pi"));
	});

	it("hides an empty configuration folder from /files, not one with content", () => {
		const { cwd } = project();
		mkdirSync(join(cwd, ".prism"));
		mkdirSync(join(cwd, ".pi"));
		mkdirSync(join(cwd, ".other"));
		writeFileSync(join(cwd, "notes.md"), "x");
		expect(listDirectory(cwd).map((entry) => entry.name)).toEqual(["notes.md", ".other"]);
		writeFileSync(join(cwd, ".prism", "settings.json"), "{}");
		expect(listDirectory(cwd).map((entry) => entry.name)).toEqual(["notes.md", ".other", ".prism"]);
	});
});
