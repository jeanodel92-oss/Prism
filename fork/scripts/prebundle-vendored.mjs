// Prebundle the vendored plugins whose startup cost comes from module resolution.
//
// usage: node fork/scripts/prebundle-vendored.mjs <vendor/node_modules dir> <out dir>
//
// jiti resolves each `./x.js` import of a TypeScript plugin by trying `.js` first, then
// falling back to `.ts`, and each failed attempt builds an error with a stack trace:
// about 0.1 s at startup for rpiv-ask-user-question (40 files) and 0.04 s for
// pi-context-inspector. One file per plugin removes those lookups. The output keeps
// the `.ts` extension so jiti still transforms it with the harness's virtual modules
// (a `.js` file under node_modules would be imported natively, with a second copy of
// the harness). `src/fork/vendored.ts` loads `<out dir>/<entry>` when it exists, with a
// leading `../` removed (`../forks/x` is written to `<out dir>/forks/x`).
//
// a module reached through a dynamic import is bundled as a lazy `init_*()` function,
// async when its graph has a top-level await. Two such functions in an import cycle await
// each other forever: the plugin hangs on first use, without any error. Native ESM handles
// the same cycle. The build fails when a bundle contains such a cycle.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { build } from "esbuild";

/** Entries, relative to vendor/node_modules, worth prebundling (measured, see the journal). */
const ENTRIES = ["../forks/rpiv-ask-user-question/index.ts", "../forks/pi-context-inspector/index.ts"];

/**
 * Left as imports: the harness's virtual modules (src/core/extensions/virtual-modules.ts),
 * and the optional rpiv-i18n peer, absent from the vendored set, whose import the plugin
 * wraps in try/catch.
 */
const EXTERNAL = [
	"@earendil-works/*",
	"@mariozechner/*",
	"typebox",
	"typebox/*",
	"@sinclair/*",
	"@juicesharp/rpiv-i18n",
	"@juicesharp/rpiv-i18n/*",
];

const [vendorDir, outDir] = process.argv.slice(2);
if (!vendorDir || !outDir) {
	console.error("usage: prebundle-vendored.mjs <vendor/node_modules dir> <out dir>");
	process.exit(1);
}
/** Cycles of async lazy inits (`await init_a()` inside `init_b`, and back) in an esbuild bundle. */
function asyncInitCycles(code) {
	const edges = new Map();
	const block = /^var (init_\w+) = __esm\(\{\n {2}async "[^"]*"\(\) \{\n([\s\S]*?)\n {2}\}\n\}\);$/gm;
	for (const [, name, body] of code.matchAll(block)) {
		edges.set(name, [...body.matchAll(/await (init_\w+)\(\)/g)].map((m) => m[1]));
	}
	const cycles = [];
	const state = new Map();
	const visit = (name, path) => {
		if (state.get(name) === "done") return;
		if (state.get(name) === "open") {
			cycles.push([...path.slice(path.indexOf(name)), name].join(" -> "));
			return;
		}
		state.set(name, "open");
		for (const next of edges.get(name) ?? []) if (edges.has(next)) visit(next, [...path, name]);
		state.set(name, "done");
	};
	for (const name of edges.keys()) visit(name, []);
	return cycles;
}

for (const entry of ENTRIES) {
	const outfile = join(outDir, entry.replace(/^\.\.\//, ""));
	mkdirSync(dirname(outfile), { recursive: true });
	await build({
		entryPoints: [join(vendorDir, entry)],
		outfile,
		bundle: true,
		format: "esm",
		platform: "node",
		target: "node22",
		external: EXTERNAL,
		logLevel: "warning",
	});
	const cycles = asyncInitCycles(readFileSync(outfile, "utf-8"));
	if (cycles.length > 0) {
		console.error(`${entry}: import cycle between async modules, the bundle would hang:\n  ${cycles.join("\n  ")}`);
		process.exit(1);
	}
}
