/**
 * fork: find, ls, session_search and the language survey stop collecting at
 * their limit.
 */
import type * as fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { createFindTool } from "../src/core/tools/find.ts";
import { createLsTool } from "../src/core/tools/ls.ts";
import { firstSorted, wholeLimit } from "../src/fork/listing-bounds.ts";
import { projectExtensions } from "../src/fork/lsp-setup.ts";
import { searchSessions } from "../src/fork/session-search.ts";

/** A folder name the fs mock below answers for: a flat folder of a million files, counted as they are handed out. */
const HUGE = "/prism-test-huge-folder";
const handedOut = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:fs", async (original) => {
	const real = await original<typeof import("node:fs")>();
	const entry = (index: number) => ({ name: `f${index}.ts`, isDirectory: () => false, isFile: () => true });
	return {
		...real,
		readdirSync: ((path: fs.PathLike, options?: unknown) => {
			if (path !== HUGE) return real.readdirSync(path, options as fs.ObjectEncodingOptions);
			handedOut.count += 1_000_000;
			return Array.from({ length: 1_000_000 }, (_, index) => entry(index));
		}) as typeof real.readdirSync,
		opendirSync: ((path: fs.PathLike, options?: fs.OpenDirOptions) => {
			if (path !== HUGE) return real.opendirSync(path, options);
			let index = 0;
			return {
				readSync: () => {
					if (index >= 1_000_000) return null;
					handedOut.count++;
					return entry(index++);
				},
				closeSync: () => {},
			};
		}) as typeof real.opendirSync,
	};
});

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
}

let dir: string;
const agentDir = process.env[ENV_AGENT_DIR];
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "prism-listing-"));
	process.env[ENV_AGENT_DIR] = join(dir, "agent");
});
afterEach(() => {
	if (agentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = agentDir;
	rmSync(dir, { recursive: true, force: true });
});

describe("fork: listing bounds", () => {
	it("a limit is a whole number of at least 1", () => {
		expect(wholeLimit(undefined, 7)).toBe(7);
		expect(wholeLimit(3, 7)).toBe(3);
		for (const bad of [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => wholeLimit(bad, 7)).toThrow(/whole number of at least 1/);
		}
	});

	it("find refuses limit 0, which fd reads as no limit", async () => {
		const glob = vi.fn(() => ["a.ts"]);
		const tool = createFindTool(dir, { operations: { exists: () => true, glob } });
		for (const limit of [0, -2, 1.5]) {
			await expect(tool.execute("find", { pattern: "*", limit })).rejects.toThrow(/whole number of at least 1/);
		}
		expect(glob).not.toHaveBeenCalled();
		await expect(createFindTool(dir).execute("find", { pattern: "*", limit: 0 })).rejects.toThrow(/at least 1/);
	});

	it("find stops collecting once it holds more than the output can show", async () => {
		for (let index = 0; index < 4000; index++)
			writeFileSync(join(dir, `file-${String(index).padStart(30, "0")}`), "");
		const result = await createFindTool(dir).execute("find", { pattern: "file-*", limit: 100_000 });
		const details = result.details as { truncation?: { truncated: boolean; totalLines: number } };
		expect(details.truncation?.truncated).toBe(true);
		// 4000 names of 36 bytes are 144 KB: about 1400 of them fill the 50 KB budget.
		expect(details.truncation?.totalLines).toBeLessThan(2000);
	});

	it("ls refuses limit 0 instead of answering that the folder is empty", async () => {
		writeFileSync(join(dir, "a"), "");
		await expect(createLsTool(dir).execute("ls", { limit: 0 })).rejects.toThrow(/whole number of at least 1/);
	});

	it("ls keeps the first entries in the former order, ties included, and marks the limit", async () => {
		const names = ["b", "B", "a", "_x", "é", "E", "e", "10", "9", "A"];
		for (const name of names) writeFileSync(join(dir, name), "");
		mkdirSync(join(dir, "d"));
		const listed = text(await createLsTool(dir).execute("ls", { limit: 4 }));
		const order = [...names, "d"].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
		// Ties ("a"/"A") keep the folder's own reading order, so compare them case-insensitively.
		expect(
			listed
				.split("\n")
				.slice(0, 4)
				.map((name) => name.toLowerCase()),
		).toEqual(order.slice(0, 4).map((name) => name.toLowerCase()));
		expect(listed).toMatch(/4 entries limit reached/);
		const all = text(await createLsTool(dir).execute("ls", {}));
		expect(all.split("\n").map((name) => name.toLowerCase())).toEqual(
			order.map((name) => (name === "d" ? "d/" : name.toLowerCase())),
		);
	});

	it("firstSorted equals a stable sort then a slice, holding only what it keeps", async () => {
		let seed = 11;
		const random = () => {
			seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
			return seed / 2_147_483_648;
		};
		const letters = ["a", "A", "b", "B", "é", "É", "_", "1", "2", "z"];
		for (let round = 0; round < 200; round++) {
			const names = Array.from({ length: Math.floor(random() * 40) }, () =>
				Array.from(
					{ length: 1 + Math.floor(random() * 3) },
					() => letters[Math.floor(random() * letters.length)],
				).join(""),
			);
			const keep = 1 + Math.floor(random() * 45);
			const expected = [...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())).slice(0, keep);
			const got = await firstSorted(names, keep);
			expect(got.names).toEqual(expected);
			expect(got.more).toBe(names.length > keep);
		}
		// A million names streamed through, three kept.
		function* many() {
			for (let index = 1_000_000; index > 0; index--) yield `n${index}`;
		}
		expect((await firstSorted(many(), 3)).names).toEqual(["n1", "n10", "n100"]);
		const aborted = AbortSignal.abort();
		await expect(firstSorted(many(), 3, aborted)).rejects.toThrow(/aborted/);
	});

	it("session_search keeps only its best hits, in the former order", async () => {
		const sessions = join(dir, "agent", "sessions", "project");
		mkdirSync(sessions, { recursive: true });
		const header = JSON.stringify({ type: "session", cwd: "/work", timestamp: "2026-01-01T00:00:00Z" });
		const message = (content: string) => JSON.stringify({ type: "message", message: { role: "user", content } });
		const expected: string[][] = [];
		for (const [index, age] of [3, 1, 2].entries()) {
			const lines = Array.from({ length: 30 }, (_, line) =>
				message(line % 3 === 0 ? `alpha beta ${index}-${line}` : `alpha ${index}-${line}`),
			);
			const path = join(sessions, `s${index}.jsonl`);
			writeFileSync(path, `${header}\n${lines.join("\n")}\n`);
			utimesSync(path, age * 1000, age * 1000);
			expected.push(lines.map((_, line) => `${index}-${line}`));
		}
		// Both words first (newest session first, then reading order), then one word, alike.
		const both = (index: number) => expected[index].filter((_, line) => line % 3 === 0);
		const one = (index: number) => expected[index].filter((_, line) => line % 3 !== 0);
		const order = [...both(0), ...both(2), ...both(1), ...one(0), ...one(2), ...one(1)];
		for (const limit of [1, 5, 12, 25, 100]) {
			const { hits } = await searchSessions("alpha beta", "project", "/work", limit);
			expect(hits.map((hit) => /\d+-\d+/.exec(hit.text)?.[0])).toEqual(order.slice(0, limit));
		}
	});

	it("the language survey stops reading a huge folder at its budget", () => {
		handedOut.count = 0;
		const found = projectExtensions(HUGE);
		expect(found).toEqual(new Set([".ts"]));
		expect(handedOut.count).toBeLessThanOrEqual(5001);
	});
});
