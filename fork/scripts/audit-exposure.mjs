#!/usr/bin/env node
// Classify the monorepo's npm audit findings by real exposure: does Prism ship the package?
//
// usage: npm audit --package-lock-only --json | node fork/scripts/audit-exposure.mjs   (from the repo root)
//
// A finding is "shipped" when the install lock (packages/coding-agent/install-lock, the
// dependency tree the release installs) holds the same package at the same version;
// otherwise it is "monorepo only" (a workspace's runtime dependency, such as an example) or
// "dev tooling only", with the workspaces that pull it in. Prints a Markdown report (for the
// job summary) and a GitHub warning per finding. Exits 1 when a finding is shipped: the
// blocking audit of the install lock should have caught it first.

import { readFileSync } from "node:fs";

const rootLock = JSON.parse(readFileSync("package-lock.json", "utf8")).packages;
const installLock = JSON.parse(readFileSync("packages/coding-agent/install-lock/package-lock.json", "utf8")).packages;
const audit = JSON.parse(readFileSync(0, "utf8"));

const nameOf = (path) => path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
const shipped = new Set(
	Object.entries(installLock)
		.filter(([path]) => path.includes("node_modules/"))
		.map(([path, entry]) => `${nameOf(path)}@${entry.version}`),
);

// Where `name`, required by the package at `from`, resolves: the nearest node_modules up the tree.
function resolve(from, name) {
	let base = from;
	for (;;) {
		const candidate = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
		if (rootLock[candidate]) return candidate;
		if (!base) return undefined;
		const cut = base.lastIndexOf("/node_modules/");
		base = cut === -1 ? "" : base.slice(0, cut);
	}
}

// What each workspace pulls in, as lock paths: its runtime closure, and with its devDependencies.
const workspaces = Object.keys(rootLock).filter((path) => !path.includes("node_modules/"));
function closure(workspace, withDev) {
	const seen = new Set();
	const own = rootLock[workspace];
	const direct = { ...own.dependencies, ...own.optionalDependencies, ...(withDev ? own.devDependencies : {}) };
	const queue = Object.keys(direct)
		.map((name) => resolve(workspace, name))
		.filter(Boolean);
	while (queue.length) {
		const path = queue.pop();
		if (seen.has(path)) continue;
		seen.add(path);
		const target = rootLock[path].link ? rootLock[path].resolved : path;
		const deps = { ...rootLock[target]?.dependencies, ...rootLock[target]?.optionalDependencies };
		for (const name of Object.keys(deps)) {
			const next = resolve(target, name);
			if (next) queue.push(next);
		}
	}
	return seen;
}
const runtime = new Map(workspaces.map((workspace) => [workspace, closure(workspace, false)]));
const development = new Map(workspaces.map((workspace) => [workspace, closure(workspace, true)]));
const label = (workspace) => workspace || "(root)";

const rows = [];
let shippedCount = 0;
for (const [name, finding] of Object.entries(audit.vulnerabilities ?? {})) {
	const advisories = [
		...new Set(finding.via.filter((via) => typeof via === "object").map((via) => via.url.split("/").pop())),
	];
	const via = finding.via.filter((v) => typeof v === "string");
	for (const node of finding.nodes) {
		const version = rootLock[node]?.version ?? "?";
		const isShipped = shipped.has(`${name}@${version}`);
		if (isShipped) shippedCount++;
		const fromRuntime = workspaces.filter((workspace) => runtime.get(workspace).has(node));
		const fromDev = workspaces.filter(
			(workspace) => !fromRuntime.includes(workspace) && development.get(workspace).has(node),
		);
		const dev = fromDev.length > 3 ? [`${fromDev.length} workspaces (dev)`] : fromDev.map((w) => `${label(w)} (dev)`);
		const from = [...fromRuntime.map(label), ...dev];
		const exposure = isShipped ? "shipped" : fromRuntime.length ? "monorepo only" : "dev tooling only";
		const cause = advisories.length ? advisories.join(", ") : `through ${via.join(", ")}`;
		rows.push(
			`| ${name} | ${version} | ${finding.severity} | ${exposure} | ${from.join(", ") || "-"} | ${cause} | ${finding.fixAvailable ? "yes" : "no"} |`,
		);
		console.error(`::warning title=npm audit (${exposure})::${name}@${version} ${finding.severity}: ${cause}`);
	}
}

console.log("## npm audit by exposure\n");
if (!rows.length) console.log("No finding in the monorepo.");
else {
	console.log("| Package | Version | Severity | Exposure | Pulled in by | Advisories | Fix in range |");
	console.log("|---|---|---|---|---|---|---|");
	for (const row of rows) console.log(row);
}
process.exit(shippedCount ? 1 : 0);
