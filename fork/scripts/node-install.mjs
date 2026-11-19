#!/usr/bin/env node
// Install the coding agent for Node into <dir>: pack the built workspace packages, then install them with
// `npm ci` (no lifecycle scripts) from the committed install lock (packages/coding-agent/install-lock), so
// the release ships exactly the third-party tree that lock pins and the CI audits; then run upstream's
// consumer smoke test. Used by install-local.sh.
//
// The install lock lists Prism's own packages as registry packages: here they point to the local tarballs
// built from this commit, with their integrity, after checking that each tarball has the version and the
// dependencies the lock records. Nothing is resolved at install time and npm ci refuses a lock that does
// not match package.json; there is no fallback to `npm install`. After the install, the tree on disk must
// be the lock's: same paths and versions, third-party integrities as locked, internal packages from the
// tarballs. Only optional packages for another platform may be missing.
//
// usage: node fork/scripts/node-install.mjs <dir> <tarball-dir>   (from the repo root)

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { packReleasePackages, smokeTestCodingAgentConsumer } from "../../scripts/coding-agent-consumer.mjs";
import { getPublicWorkspacePackages } from "../../scripts/release-packages.mjs";

const [dir, tarballDir] = process.argv.slice(2);
if (!dir || !tarballDir) throw new Error("usage: node fork/scripts/node-install.mjs <dir> <tarball-dir>");
const directory = resolve(dir);
const lockDir = resolve("packages/coding-agent/install-lock");
const codingAgent = "@earendil-works/pi-coding-agent";
const registry = "https://registry.npmjs.org/";

const fail = (message) => {
	throw new Error(`node-install: ${message}`);
};
const nameOf = (path) => path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
const sorted = (object = {}) => JSON.stringify(Object.fromEntries(Object.entries(object).sort()));
// npm's os/cpu fields: a list of allowed values, or of "!value" exclusions.
const allows = (list, value) =>
	!list || (list.includes(`!${value}`) ? false : list.some((v) => !v.startsWith("!")) ? list.includes(value) : true);
const forThisPlatform = (entry) => allows(entry.os, process.platform) && allows(entry.cpu, process.arch);

const tarballs = packReleasePackages(getPublicWorkspacePackages(), resolve(tarballDir));
const manifest = JSON.parse(readFileSync(join(lockDir, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(lockDir, "package-lock.json"), "utf8"));
const spec = (name) => `file:${relative(directory, tarballs.get(name)).replaceAll("\\", "/")}`;

// Prism's packages: the local tarballs, checked against what the lock records for them.
for (const [path, entry] of Object.entries(lock.packages)) {
	if (!path) continue;
	const name = nameOf(path);
	if (!tarballs.has(name)) {
		if (!entry.integrity || !entry.resolved?.startsWith(registry))
			fail(`${path} is neither one of Prism's packages nor a registry package with an integrity`);
		continue;
	}
	const tarball = tarballs.get(name);
	const packed = spawnSync("tar", ["-xzOf", tarball, "package/package.json"], { encoding: "utf8" });
	if (packed.status !== 0) fail(`cannot read the manifest of ${tarball}: ${packed.stderr}`);
	const own = JSON.parse(packed.stdout);
	if (own.version !== entry.version) fail(`${name} is ${own.version}, the install lock has ${entry.version}`);
	for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
		if (sorted(own[field]) !== sorted(entry[field]))
			fail(`${name}: ${field} differ from the install lock; run npm run install-lock:coding-agent`);
	}
	entry.resolved = spec(name);
	entry.integrity = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
}
const root = lock.packages[""];
if (Object.keys(root.dependencies ?? {}).join() !== codingAgent) fail(`the install lock must depend on ${codingAgent} only`);
root.dependencies = { [codingAgent]: spec(codingAgent) };

mkdirSync(directory, { recursive: true });
const { name, version, engines, overrides } = manifest;
const rootManifest = { name, version, private: true, dependencies: root.dependencies, overrides, engines };
writeFileSync(join(directory, "package.json"), `${JSON.stringify(rootManifest, null, "\t")}\n`);
writeFileSync(join(directory, "package-lock.json"), `${JSON.stringify(lock, null, "\t")}\n`);

const args = ["ci", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"];
console.log(`$ npm ${args.join(" ")}`);
const install = spawnSync("npm", args, { cwd: directory, encoding: "utf8", timeout: 600_000 });
if (install.status !== 0) fail(`npm ci failed, nothing else is tried:\n${install.stdout}${install.stderr}`);

// The installed tree is the lock's.
const installed = new Map();
const walk = (base) => {
	const modules = join(directory, base, "node_modules");
	if (!existsSync(modules)) return;
	for (const entry of readdirSync(modules)) {
		if (entry.startsWith(".")) continue;
		const names = entry.startsWith("@") ? readdirSync(join(modules, entry)).map((n) => `${entry}/${n}`) : [entry];
		for (const n of names) {
			const path = base ? `${base}/node_modules/${n}` : `node_modules/${n}`;
			const json = join(directory, path, "package.json");
			if (!existsSync(json)) continue;
			installed.set(path, JSON.parse(readFileSync(json, "utf8")).version);
			walk(path);
		}
	}
};
walk("");
const hidden = JSON.parse(readFileSync(join(directory, "node_modules/.package-lock.json"), "utf8")).packages;
const problems = [];
let skipped = 0;
for (const [path, entry] of Object.entries(lock.packages)) {
	if (!path) continue;
	if (!installed.has(path)) {
		if (entry.optional && !forThisPlatform(entry)) skipped++;
		else problems.push(`missing ${path}@${entry.version}`);
		continue;
	}
	if (installed.get(path) !== entry.version) problems.push(`${path} is ${installed.get(path)}, locked ${entry.version}`);
	if (hidden[path]?.integrity !== entry.integrity) problems.push(`${path} was not installed with the locked integrity`);
	if (hidden[path]?.resolved !== entry.resolved) problems.push(`${path} came from ${hidden[path]?.resolved}`);
}
for (const path of installed.keys()) if (!lock.packages[path]) problems.push(`not in the install lock: ${path}`);
if (problems.length) fail(`the installed tree is not the install lock:\n${problems.join("\n")}`);
const internal = [...installed.keys()].filter((path) => tarballs.has(nameOf(path))).length;
console.log(
	`installed tree = install lock: ${installed.size} packages (${internal} from local tarballs), ${skipped} optional packages for other platforms skipped`,
);

smokeTestCodingAgentConsumer(directory);
