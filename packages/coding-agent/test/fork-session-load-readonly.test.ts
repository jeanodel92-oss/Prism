import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadEntriesFromFile, SessionManager } from "../src/core/session-manager.ts";

const HEADER = '{"type":"session","version":3,"id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n';
const MESSAGE =
	'{"type":"message","id":"m1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}';

describe("loading a session whose last record has no newline", () => {
	let dir: string;
	let file: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fork-session-load-"));
		file = join(dir, "session.jsonl");
		writeFileSync(file, HEADER + MESSAGE);
	});
	afterEach(() => {
		chmodSync(file, 0o600);
		rmSync(dir, { recursive: true, force: true });
	});

	// the loader appended "\n" to its source, which fails on a read-only archive.
	it("loads and opens a read-only file without writing to it", () => {
		chmodSync(file, 0o444);
		expect(loadEntriesFromFile(file)).toHaveLength(2);
		const session = SessionManager.open(file, dir);
		expect(session.getEntries()).toHaveLength(1);
		expect(readFileSync(file, "utf8")).toBe(HEADER + MESSAGE);
	});

	it("adds the missing newline before the next appended record", () => {
		const session = SessionManager.open(file, dir);
		expect(readFileSync(file, "utf8")).toBe(HEADER + MESSAGE);
		session.appendMessage({ role: "user", content: "again", timestamp: 2 });
		session.appendMessage({ role: "user", content: "third", timestamp: 3 });
		const lines = readFileSync(file, "utf8").split("\n");
		expect(lines.at(-1)).toBe("");
		expect(lines.slice(0, -1).map((line) => JSON.parse(line).type)).toEqual([
			"session",
			"message",
			"message",
			"message",
		]);
		expect(SessionManager.open(file, dir).getEntries()).toHaveLength(3);
	});
});
