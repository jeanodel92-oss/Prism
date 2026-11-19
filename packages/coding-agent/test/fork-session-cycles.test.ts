/**
 * fork: a long session and a corrupt one. The GUI's tree marked the path to the
 * current point by a recursive walk down that overflowed the stack on a long chain; a session whose parents
 * form a cycle made every walk to the root endless.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSessionContext, type SessionEntry, SessionManager } from "../src/core/session-manager.ts";
import { handleInspectCommand } from "../src/fork/rpc-inspect.ts";
import { createHarness } from "./suite/harness.ts";

const user = (text: string) => ({ role: "user" as const, content: text, timestamp: Date.now() });

describe("fork: the GUI's tree of a long session", () => {
	it("lists a chain of 100 000 entries with a side branch, the path to the current point marked", async () => {
		// The chain is written as a session file: 100 000 appends took 15 s here and over 60 s on the CI runner
		//; opening the file takes 0.2 s.
		const dir = mkdtempSync(join(tmpdir(), "prism-long-session-"));
		const header = { type: "session", version: 3, id: "long", timestamp: "2026-11-11T00:00:00.000Z", cwd: "/" };
		const lines = [JSON.stringify(header)];
		for (let index = 0; index < 100_000; index++) {
			const parentId = index ? `e${index - 1}` : null;
			lines.push(
				JSON.stringify({
					type: "message",
					id: `e${index}`,
					parentId,
					timestamp: header.timestamp,
					message: user(`m${index}`),
				}),
			);
		}
		const path = join(dir, "long.jsonl");
		writeFileSync(path, `${lines.join("\n")}\n`);
		const sessionManager = SessionManager.open(path);
		sessionManager.branch("e10");
		const side = sessionManager.appendMessage(user("side"));
		const harness = await createHarness({ sessionManager });
		try {
			const tree = (await handleInspectCommand({ type: "get_tree" }, harness.session)) as {
				leafId: string;
				nodes: { id: string; onPath: boolean; text: string }[];
			};
			expect(tree.leafId).toBe(side);
			expect(tree.nodes).toHaveLength(100_001);
			const onPath = tree.nodes.filter((node) => node.onPath);
			expect(onPath).toHaveLength(12);
			expect(onPath.at(-1)?.text).toBe("side");
			// The branch holding the current point is listed first.
			expect(tree.nodes[11]?.text).toBe("side");
		} finally {
			harness.cleanup();
			rmSync(dir, { recursive: true, force: true });
		}
	}, 60_000);
});

describe("fork: parent cycles in a session file", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "prism-cycles-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const header = {
		type: "session",
		version: 3,
		id: "0b9b7a4e-cycle",
		timestamp: "2026-11-11T00:00:00.000Z",
		cwd: "/",
	};
	const entry = (id: string, parentId: string | null) => ({
		type: "message",
		id,
		parentId,
		timestamp: "2026-11-11T00:00:01.000Z",
		message: user(id),
	});
	const file = (entries: object[]) => {
		const path = join(dir, `${entries.length}.jsonl`);
		writeFileSync(path, [header, ...entries].map((line) => `${JSON.stringify(line)}\n`).join(""));
		return path;
	};

	it("refuses an entry that is its own parent and two entries each other's", () => {
		expect(() => SessionManager.open(file([entry("a", "a")]))).toThrow("parent cycle at entry a");
		expect(() => SessionManager.open(file([entry("a", "b"), entry("b", "a")]))).toThrow("parent cycle");
		const raw = [entry("a", "b"), entry("b", "a")] as unknown as SessionEntry[];
		expect(() => buildSessionContext(raw, "b")).toThrow("parent cycle");
	});

	it("still loads roots and orphans", () => {
		const manager = SessionManager.open(
			file([entry("a", null), entry("b", "a"), entry("c", "missing"), entry("d", "c")]),
		);
		expect(manager.getBranch().map((one) => one.id)).toEqual(["c", "d"]);
		expect(manager.getTree().map((node) => node.entry.id)).toEqual(["a", "c"]);
	});
});
