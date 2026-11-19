/**
 * fork: permission globs are matched without backtracking, with the
 * meaning of the former regex, and a glob the model proposes for a scope is bounded.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { globMatches } from "../src/fork/glob-match.ts";
import { decidePermission } from "../src/fork/permissions.ts";
import { realPath } from "../src/fork/real-path.ts";
import { MAX_GLOB_LENGTH, MAX_SCOPE_GLOBS, parseProposal } from "../src/fork/task-scope.ts";

/** The compiler the gate used before: kept here as the reference meaning. */
function formerRegExp(glob: string, loose: boolean): RegExp {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*") {
			if (loose) re += ".*";
			else if (glob[i + 1] === "*") {
				re += ".*";
				i++;
			} else re += "[^/]*";
		} else if (c === "?") re += loose ? "." : "[^/]";
		else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${re}$`, loose ? "" : "s");
}

function random(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

describe("fork: permission globs without backtracking", () => {
	it("matches as the former regex: random globs and texts, paths and commands", () => {
		const next = random(426);
		const pick = (from: string[]) => from[Math.floor(next() * from.length)]!;
		const text = (alphabet: string[]) =>
			Array.from({ length: Math.floor(next() * 9) }, () => pick(alphabet)).join("");
		const letters = ["a", "b", "/", ".", "\n", "\r", " ", "\ud83d", "\ude00", "("];
		let matched = 0;
		for (let index = 0; index < 20_000; index++) {
			const glob = text([...letters, "*", "*", "?"]);
			const subject = text(letters);
			const loose = index % 2 === 0;
			const expected = formerRegExp(glob, loose).test(subject);
			if (expected) matched++;
			expect(globMatches(glob, loose, subject), JSON.stringify({ glob, subject, loose })).toBe(expected);
		}
		// Both answers are exercised.
		expect(matched).toBeGreaterThan(400);
	});

	describe("the gate", () => {
		let root: string;
		const saved = process.env[ENV_AGENT_DIR];
		beforeEach(() => {
			root = realPath(mkdtempSync(join(tmpdir(), "prism-glob-match-")));
			process.env[ENV_AGENT_DIR] = join(root, "agent");
			mkdirSync(join(root, "agent"), { recursive: true });
		});
		afterEach(() => {
			if (saved === undefined) delete process.env[ENV_AGENT_DIR];
			else process.env[ENV_AGENT_DIR] = saved;
			rmSync(root, { recursive: true, force: true });
		});

		it("refuses an ambiguous glob's non-match at once (14 stars on 30 characters: 1.8 s before)", () => {
			const rule = `write(src/${"*a".repeat(14)}*b)`;
			const started = process.cpuUsage();
			const decision = decidePermission("write", { path: `src/${"a".repeat(30)}c` }, root, {
				mode: "ask",
				allow: [rule],
			});
			const used = process.cpuUsage(started);
			expect((used.user + used.system) / 1000).toBeLessThan(1000);
			expect(decision.effect).not.toBe("allow");
			const covered = decidePermission("write", { path: `src/${"a".repeat(30)}b` }, root, {
				mode: "ask",
				allow: [rule],
			});
			expect(covered.effect).toBe("allow");
		}, 60_000);
	});

	it("bounds a glob the model proposes for a scope", () => {
		const glob = (length: number) => `src/${"x".repeat(length - 4)}`;
		const accepted = parseProposal({ operations: [{ what: "Edit", writes: [glob(MAX_GLOB_LENGTH)] }] });
		expect(accepted).not.toBeInstanceOf(Error);
		const refused = parseProposal({ operations: [{ what: "Edit", writes: [glob(MAX_GLOB_LENGTH + 1)] }] });
		expect(refused).toBeInstanceOf(Error);
		expect((refused as Error).message).toContain(`at most ${MAX_GLOB_LENGTH} characters`);
	});

	// fork: every write is matched against every glob; their number is bounded too.
	it("bounds the number of globs the model proposes for a scope, across its operations", () => {
		const globs = (from: number, count: number) => Array.from({ length: count }, (_, i) => `src/f${from + i}.ts`);
		const half = MAX_SCOPE_GLOBS / 2;
		const accepted = parseProposal({
			operations: [
				{ what: "Edit", writes: globs(0, half) },
				{ what: "Test", writes: globs(half, half) },
			],
		});
		expect(accepted).not.toBeInstanceOf(Error);
		const refused = parseProposal({
			operations: [
				{ what: "Edit", writes: globs(0, half) },
				{ what: "Test", writes: globs(half, half + 1) },
			],
		});
		expect(refused).toBeInstanceOf(Error);
		expect((refused as Error).message).toContain(`at most ${MAX_SCOPE_GLOBS} in a scope`);
	});

	it("walks a long glob over a long command in bounded time", () => {
		const glob = `${"*a".repeat(200)}*b`;
		// CPU time: a busy machine stretches wall time, not the work.
		const started = process.cpuUsage();
		expect(globMatches(glob, true, `${"a".repeat(100_000)}c`)).toBe(false);
		expect(globMatches(glob, false, `${"a".repeat(4000)}c`)).toBe(false);
		const used = process.cpuUsage(started);
		expect((used.user + used.system) / 1000).toBeLessThan(2000);
	});
});
