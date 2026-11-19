#!/usr/bin/env node
// Rough code and docs audit of the fork. Text-based, not type-aware:
// confirm each finding with `git grep -w` before acting on it.
//
// usage: node fork/tools/audit-code.mjs exports [UPSTREAM_REF]   exports of the fork's own .ts modules that no other
//                                                                 file names, or that only tests name
//        node fork/tools/audit-code.mjs copies [LINES]           blocks of LINES normalized lines (default 8) found in
//                                                                 two places or more in the fork's own code
//        node fork/tools/audit-code.mjs links                     broken relative links and orphan docs under fork/
//
// "The fork's own files" are files tracked on the current branch and absent from UPSTREAM_REF (default upstream/main).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28 });
const root = git("rev-parse", "--show-toplevel").trim();
const read = (f) => {
	try {
		return fs.readFileSync(path.join(root, f), "utf8");
	} catch {
		return undefined;
	}
};
const lines = (s) => s.split("\n").filter(Boolean);
const forkOwn = (ref) => {
	const upstream = new Set(lines(git("-C", root, "ls-tree", "-r", "--name-only", ref)));
	return lines(git("-C", root, "ls-files")).filter((f) => !upstream.has(f));
};
const isTest = (f) => /\/test\//.test(f) || /\.test\.[mc]?[jt]s$/.test(f);

function exportsReport(ref) {
	const own = new Set(forkOwn(ref));
	const all = lines(git("-C", root, "ls-files", "packages/*", "fork/*", "scripts/*")).filter((f) =>
		/\.(ts|tsx|mts|js|mjs|cjs)$/.test(f),
	);
	const index = new Map();
	const text = new Map();
	for (const f of all) {
		const t = read(f);
		if (t === undefined) continue;
		text.set(f, t);
		for (const w of new Set(t.match(/[A-Za-z_$][\w$]*/g) || [])) {
			if (!index.has(w)) index.set(w, []);
			index.get(w).push(f);
		}
	}
	const rows = [];
	for (const f of all) {
		if (!own.has(f) || isTest(f) || !/\/src\/.*\.ts$/.test(f) || !text.has(f)) continue;
		const t = text.get(f);
		const re = /^export\s+(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
		for (const m of t.matchAll(re)) {
			const name = m[1];
			const users = (index.get(name) || []).filter((u) => u !== f);
			if (users.some((u) => !isTest(u))) continue;
			const uses = (t.match(new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`, "g")) || []).length;
			const kind = users.length ? "tests only" : uses > 1 ? "own file only" : "unused";
			rows.push(`${kind}\t${f}:${t.slice(0, m.index).split("\n").length}\t${name}`);
		}
	}
	rows.sort();
	console.log(rows.join("\n"));
	const count = {};
	for (const r of rows) count[r.split("\t")[0]] = (count[r.split("\t")[0]] || 0) + 1;
	console.error(JSON.stringify(count));
}

function copiesReport(n) {
	const files = forkOwn("upstream/main").filter(
		(f) => /\.(ts|js|mjs|rs|c)$/.test(f) && !/\/(vendor|dist|target|site)\//.test(f),
	);
	const seen = new Map();
	for (const f of files) {
		const src = read(f);
		if (src === undefined) continue;
		const kept = src
			.split("\n")
			.map((l, i) => [i + 1, l.replace(/\/\/.*$/, "").trim()])
			.filter(([, l]) => l && !/^(\*|\/\*|export \{|\}|\);?|\]|\{)$/.test(l) && !l.startsWith("*") && !l.startsWith("import "));
		for (let i = 0; i + n <= kept.length; i++) {
			const win = kept
				.slice(i, i + n)
				.map(([, l]) => l)
				.join("\n");
			if (win.length < 260) continue; // trivial windows
			if (!seen.has(win)) seen.set(win, []);
			seen.get(win).push(`${f}:${kept[i][0]}`);
		}
	}
	// Overlapping windows of the same pair of places are reported once.
	const reported = new Set();
	const out = [];
	for (const [win, places] of seen) {
		if (places.length < 2) continue;
		const sig = places.map((p) => `${p.split(":")[0]}@${Math.floor(Number(p.split(":")[1]) / 40)}`).join("|");
		if (reported.has(sig)) continue;
		reported.add(sig);
		out.push(`${places.length}x  ${places.join("  ")}\n    ${win.split("\n")[0].slice(0, 110)}`);
	}
	console.log(out.join("\n"));
	console.error(`${out.length} groups`);
}

function linksReport() {
	const docs = lines(git("-C", root, "ls-files", "fork/*.md", "AGENTS.md", "CLAUDE.md"));
	const slug = (h) =>
		h
			.trim()
			.toLowerCase()
			.replace(/[`*_~]/g, "")
			.replace(/[^\p{L}\p{N}\s-]/gu, "")
			.replace(/\s/g, "-");
	const anchors = new Map(docs.map((d) => [d, new Set([...read(d).matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1])))]));
	const incoming = new Map(docs.map((d) => [d, 0]));
	const broken = [];
	for (const d of docs) {
		const t = read(d).replace(/```[\s\S]*?```/g, "");
		for (const m of t.matchAll(/\]\(([^)\s]+)\)/g)) {
			const href = m[1];
			if (/^(https?:|mailto:)/.test(href)) continue;
			if (href.startsWith("#")) {
				if (!anchors.get(d).has(decodeURIComponent(href.slice(1)))) broken.push(`${d}: ${href} (anchor)`);
				continue;
			}
			const [file, anchor] = href.split("#");
			const target = path.normalize(path.join(path.dirname(d), decodeURIComponent(file)));
			if (!fs.existsSync(path.join(root, target))) {
				broken.push(`${d}: ${href}`);
				continue;
			}
			if (incoming.has(target) && target !== d) incoming.set(target, incoming.get(target) + 1);
			if (anchor && anchors.has(target) && !anchors.get(target).has(decodeURIComponent(anchor)))
				broken.push(`${d}: ${href} (anchor)`);
		}
	}
	console.log(`docs: ${docs.length}, broken links: ${broken.length}`);
	console.log(broken.join("\n"));
	console.log("--- orphans (no incoming link; feedback/, archive/ and reference/ excluded):");
	console.log(
		[...incoming]
			.filter(([d, n]) => n === 0 && !/\/(feedback|archive|reference)\//.test(d))
			.map(([d]) => d)
			.join("\n"),
	);
}

const [mode, arg] = process.argv.slice(2);
if (mode === "exports") exportsReport(arg || "upstream/main");
else if (mode === "copies") copiesReport(Number(arg || 8));
else if (mode === "links") linksReport();
else {
	console.error("usage: audit-code.mjs exports [UPSTREAM_REF] | copies [LINES] | links");
	process.exit(2);
}
