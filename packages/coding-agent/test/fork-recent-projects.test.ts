// the window's "Choose a project folder" lists the folders worked in lately.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recentProjects } from "../src/fork/recent-projects.ts";

let root: string;
let sessions: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "prism-recent-"));
	sessions = join(root, "sessions");
	mkdirSync(sessions);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A saved session of `cwd`, last written `age` seconds ago. */
function saved(dir: string, cwd: string, age: number, file = "s.jsonl") {
	mkdirSync(join(sessions, dir), { recursive: true });
	const path = join(sessions, dir, file);
	writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id: file, cwd })}\n{"type":"message"}\n`);
	const when = Date.now() / 1000 - age;
	utimesSync(path, when, when);
}

function project(name: string): string {
	const path = join(root, name);
	mkdirSync(path, { recursive: true });
	return path;
}

describe("fork: recent project folders", () => {
	it("lists the folders of the saved sessions, most recently used first", async () => {
		const one = project("one");
		const two = project("two");
		const three = project("three");
		saved("a", one, 300);
		saved("b", two, 10);
		saved("c", three, 100, "old.jsonl");
		saved("c", three, 5, "new.jsonl");
		expect(await recentProjects(sessions)).toEqual([three, two, one]);
		expect(await recentProjects(sessions, { limit: 2 })).toEqual([three, two]);
	});

	it("leaves out the current folder, deleted folders and throwaway work folders", async () => {
		const here = project("here");
		const kept = project("kept");
		saved("a", here, 1);
		saved("b", join(root, "deleted"), 2);
		saved("c", join(tmpdir(), "prism-work-abc123"), 3);
		saved("d", kept, 4);
		writeFileSync(join(sessions, "not-a-folder.jsonl"), "x");
		mkdirSync(join(sessions, "empty"));
		expect(await recentProjects(sessions, { exclude: here })).toEqual([kept]);
	});

	// one session that cannot be read hid its whole project.
	it("keeps a project whose older session is a dangling link", async () => {
		const one = project("one");
		saved("a", one, 10, "new.jsonl");
		symlinkSync(join(root, "gone.jsonl"), join(sessions, "a", "old.jsonl"));
		expect(await recentProjects(sessions)).toEqual([one]);
	});

	it("is empty without saved sessions", async () => {
		expect(await recentProjects(join(root, "missing"))).toEqual([]);
	});
});
