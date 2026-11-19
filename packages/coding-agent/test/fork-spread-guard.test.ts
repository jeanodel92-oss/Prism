/**
 * fork: a spread passed as call arguments puts every element on the stack, and V8
 * throws "Maximum call stack size exceeded" around 150 000 of them (`push(...lines)`, `Math.max(...widths)`,
 * `new Highlight(...ranges)` on data of external size). Most of the existing ones spread bounded data, so they are
 * counted, not banned: this test fails when a file gains one, and when a file loses one, so the baseline stays exact.
 *
 * A new spread of data whose size comes from outside (a file, a server, the model, the user) takes a loop instead. A
 * bounded one is justified in review and the baseline regenerated with PRISM_UPDATE_SPREAD_BASELINE=1.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const root = join(testDir, "../../..");
const baselinePath = join(testDir, "fork-spread-guard.baseline.json");

/** Calls whose arguments all land on the stack, as found in lot 7c. */
const CALL_HEAD =
	/(?:\.(?:push|unshift|splice)|\bMath\.(?:max|min)|\bString\.fromCharCode|\bString\.fromCodePoint|\bnew\s+Highlight)\s*\(/g;

/** `source` with its comments blanked, so a call quoted in a comment does not count. Strings are kept. */
function stripComments(source: string): string {
	let out = "";
	let quote: string | undefined;
	for (let index = 0; index < source.length; index++) {
		const char = source[index];
		if (quote) {
			out += char;
			if (char === "\\") out += source[++index] ?? "";
			else if (char === quote) quote = undefined;
		} else if (char === '"' || char === "'" || char === "`") {
			quote = char;
			out += char;
		} else if (source.startsWith("//", index)) {
			const end = source.indexOf("\n", index);
			index = end === -1 ? source.length : end - 1;
		} else if (source.startsWith("/*", index)) {
			const end = source.indexOf("*/", index + 2);
			index = end === -1 ? source.length : end + 1;
		} else out += char;
	}
	return out;
}

/** Number of `...` spreads among the direct arguments of each matched call in `code`. */
function countArgumentSpreads(code: string): number {
	const source = stripComments(code);
	let count = 0;
	for (const match of source.matchAll(CALL_HEAD)) {
		let depth = 1;
		let quote: string | undefined;
		for (let index = match.index + match[0].length; index < source.length && depth > 0; index++) {
			const char = source[index];
			if (quote) {
				if (char === "\\") index++;
				else if (char === quote) quote = undefined;
			} else if (char === '"' || char === "'" || char === "`") quote = char;
			else if (char === "(" || char === "[" || char === "{") depth++;
			else if (char === ")" || char === "]" || char === "}") depth--;
			else if (depth === 1 && source.startsWith("...", index)) {
				count++;
				index += 2;
			}
		}
	}
	return count;
}

function* sourceFiles(dir: string): Generator<string> {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== "node_modules" && entry.name !== "vendor") yield* sourceFiles(path);
		} else if (/\.(?:ts|tsx|js|mjs)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) yield path;
	}
}

function scan(): Record<string, number> {
	const dirs = readdirSync(join(root, "packages"), { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(root, "packages", entry.name, "src"))
		.filter((dir) => {
			try {
				return readdirSync(dir).length > 0;
			} catch {
				return false;
			}
		});
	dirs.push(join(root, "fork/gui/ui/js"));
	const counts: Record<string, number> = {};
	for (const dir of dirs) {
		for (const file of sourceFiles(dir)) {
			const count = countArgumentSpreads(readFileSync(file, "utf8"));
			if (count > 0) counts[relative(root, file)] = count;
		}
	}
	return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

describe("fork: spreads passed as call arguments", () => {
	it("counts only direct argument spreads of the listed calls", () => {
		expect(countArgumentSpreads("lines.push(...more); Math.max(0, ...widths); new Highlight(...ranges);")).toBe(3);
		expect(countArgumentSpreads("list.push([...a], { ...b }, f(...c)); Math.min(a, b); x.push('...')")).toBe(0);
		expect(countArgumentSpreads("rows.splice(1, 0, ...items); String.fromCharCode(...codes)")).toBe(2);
	});

	it("matches the baseline, file by file", () => {
		const counts = scan();
		if (process.env.PRISM_UPDATE_SPREAD_BASELINE === "1") {
			writeFileSync(baselinePath, `${JSON.stringify(counts, null, "\t")}\n`);
			return;
		}
		const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Record<string, number>;
		const changes = [...new Set([...Object.keys(counts), ...Object.keys(baseline)])]
			.filter((file) => (counts[file] ?? 0) !== (baseline[file] ?? 0))
			.map((file) => `${file}: ${baseline[file] ?? 0} -> ${counts[file] ?? 0}`);
		expect(
			changes,
			"Argument spreads changed. A spread of data of external size overflows the stack around 150 000 elements: " +
				"use a loop. For a bounded one, or after removing one, regenerate the baseline with " +
				"PRISM_UPDATE_SPREAD_BASELINE=1 (see the comment at the top of this test).",
		).toEqual([]);
	});
});
