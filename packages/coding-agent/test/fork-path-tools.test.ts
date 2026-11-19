// fork: invariant for the shipped tools that write a file the model names
// . The permission gate must judge
// such a call at least as strictly as the write tool on the file the tool really writes, computed by the vendored
// code itself. Replay with PI_FUZZ_SEED.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, expect, it } from "vitest";
import { decidePermission } from "../src/fork/permissions.ts";

function makeRandom(seed: number): () => number {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
		return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
	};
}

const seed = Number(process.env.PI_FUZZ_SEED ?? 7_721);
const cwd = mkdtempSync(join(tmpdir(), "prism-path-tools-"));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

type Verdict = ReturnType<typeof decidePermission>;
const rank = (verdict: Verdict) =>
	verdict.effect === "allow" ? 0 : verdict.effect === "block" ? 3 : verdict.tier === "danger" ? 2 : 1;

// 6,000 permission decisions on paths that mostly do not exist, each resolving links one level at a time: 4.2 s on an
// idle 14-core machine, 22 s beside 28 busy loops, over 30 s in a loaded ./test.sh. Its time follows the load, not
// the fixed seed, so it gets the margin of a CPU-bound test.
it("judges a write by a shipped tool at least like the write tool on the file it writes", { timeout: 120_000 }, () => {
	const random = makeRandom(seed);
	const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
	const segments = ["src", "a.ts", "shot.png", ".pi", "settings.json", ".git", "config", "~", "node_modules", "x y"];
	const relative = () => Array.from({ length: 1 + Math.floor(random() * 3) }, () => pick(segments)).join("/");
	let checked = 0;
	for (let index = 0; index < 3000; index++) {
		const mode = pick(["safe", "ask", "broad"] as const);
		const root = random() < 0.4 ? undefined : pick([cwd, "/home/other", tmpdir(), "/", "src"]);
		const path = `${pick(["", "", `${cwd}/`, "/home/other/"])}${relative()}`;
		// pi-lsp: path.resolve(root ?? process.cwd(), path), the session's cwd being the process's.
		const target = resolve(cwd, root ?? ".", path);
		const tool = "lsp_fix";
		const input = { path, write: true, ...(root === undefined ? {} : { root }) };
		const label = `seed=${seed} case=${index} ${mode} ${tool} ${JSON.stringify(input)} -> ${target}`;
		const asTool = decidePermission(tool, input, cwd, { mode });
		const asWrite = decidePermission("write", { path: target, content: "" }, cwd, { mode });
		expect(rank(asTool), label).toBeGreaterThanOrEqual(rank(asWrite));
		checked++;
	}
	expect(checked).toBeGreaterThan(1500);
});

it("leaves lsp_diagnostics to the code review's gate", () => {
	// It starts a language server the project chooses: safe blocks it.
	expect(decidePermission("lsp_diagnostics", { path: "/etc/x.ts" }, cwd, { mode: "safe" }).effect).toBe("block");
});
