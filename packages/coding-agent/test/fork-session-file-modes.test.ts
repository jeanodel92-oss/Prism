// Hardening consolidation: session files hold the whole conversation (prompts, tool output, file
// contents). New ones are readable by their owner only, whatever the umask; folders Prism creates for them too.
// Existing files and folders keep the permissions their owner gave them.
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDefaultSessionDir, SessionManager } from "../src/core/session-manager.ts";

const mode = (path: string) => statSync(path).mode & 0o777;
const user = { role: "user" as const, content: "secret prompt", timestamp: 1 };

describe.each([
	["022", 0o022],
	["077", 0o077],
	["002", 0o002],
])("fork: session file permissions (umask %s)", (_label, umask) => {
	let root: string;
	let previous: number;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "prism-session-modes-"));
		previous = process.umask(umask);
	});
	afterEach(() => {
		process.umask(previous);
		rmSync(root, { recursive: true, force: true });
	});

	it("creates a new session file 0600 in a new folder 0700", () => {
		const dir = join(root, "custom", "sessions");
		const session = SessionManager.create(root, dir);
		session.appendMessage(user);
		expect(mode(join(root, "custom"))).toBe(0o700);
		expect(mode(dir)).toBe(0o700);
		expect(mode(session.getSessionFile()!)).toBe(0o600);
	});

	it("creates the default session folders 0700", () => {
		const agentDir = join(root, "agent");
		const dir = getDefaultSessionDir(join(root, "project"), agentDir);
		expect(mode(join(agentDir, "sessions"))).toBe(0o700);
		expect(mode(dir)).toBe(0o700);
	});

	it("creates a forked session 0600, and a /new after resume 0600", () => {
		const source = SessionManager.create(root, join(root, "a"));
		source.appendMessage(user);
		const forked = SessionManager.forkFrom(source.getSessionFile()!, root, join(root, "b"));
		expect(mode(join(root, "b"))).toBe(0o700);
		expect(mode(forked.getSessionFile()!)).toBe(0o600);
		expect(forked.getEntries().some((entry) => entry.type === "message")).toBe(true);

		const resumed = SessionManager.open(source.getSessionFile()!);
		resumed.newSession();
		resumed.appendMessage(user);
		expect(mode(resumed.getSessionFile()!)).toBe(0o600);
	});

	it("leaves existing files and folders as their owner set them", () => {
		const dir = join(root, "shared");
		mkdirSync(dir);
		chmodSync(dir, 0o755);
		const first = SessionManager.create(root, dir);
		first.appendMessage(user);
		const file = first.getSessionFile()!;
		chmodSync(file, 0o644);

		const resumed = SessionManager.open(file);
		resumed.appendMessage({ ...user, content: "again" });
		expect(mode(dir)).toBe(0o755);
		expect(mode(file)).toBe(0o644);
		expect(resumed.getEntries().filter((entry) => entry.type === "message")).toHaveLength(2);
		expect(readdirSync(dir)).toHaveLength(1);
	});

	it("leaves an existing file written before as it is when a /new reuses its folder", () => {
		const dir = join(root, "kept");
		mkdirSync(dir, { mode: 0o750 });
		chmodSync(dir, 0o750);
		writeFileSync(join(dir, "notes.txt"), "x", { mode: 0o640 });
		chmodSync(join(dir, "notes.txt"), 0o640);
		SessionManager.create(root, dir).appendMessage(user);
		expect(mode(dir)).toBe(0o750);
		expect(mode(join(dir, "notes.txt"))).toBe(0o640);
	});
});
