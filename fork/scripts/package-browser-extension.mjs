#!/usr/bin/env node
// builds the browser extension's store packages from packages/coding-agent/browser-extension.
// usage: node fork/scripts/package-browser-extension.mjs [out-dir]   (default: dist/browser-extension)
//
// - prism-chromium-<version>.zip for the Chrome Web Store: no `key` (the store signs with its own), no Firefox keys.
// - prism-firefox-<version>.zip for addons.mozilla.org: no `key`, no `debugger` permission, no service worker.
// The source manifest keeps both, so the unpacked folder loads in either browser for development and tests.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const source = join(root, "packages/coding-agent/browser-extension");
const out = resolve(process.argv[2] ?? join(root, "dist/browser-extension"));
const manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8"));

function chromium(m) {
	const { key: _key, browser_specific_settings: _gecko, ...rest } = m;
	return { ...rest, background: { service_worker: m.background.service_worker } };
}

function firefox(m) {
	const { key: _key, ...rest } = m;
	return {
		...rest,
		background: { scripts: m.background.scripts },
		permissions: m.permissions.filter((permission) => permission !== "debugger"),
	};
}

mkdirSync(out, { recursive: true });
for (const [name, transform] of [
	["chromium", chromium],
	["firefox", firefox],
]) {
	const staging = mkdtempSync(join(tmpdir(), `prism-extension-${name}-`));
	try {
		for (const entry of readdirSync(source)) cpSync(join(source, entry), join(staging, entry), { recursive: true });
		writeFileSync(join(staging, "manifest.json"), `${JSON.stringify(transform(manifest), null, "\t")}\n`);
		const zip = join(out, `prism-${name}-${manifest.version}.zip`);
		rmSync(zip, { force: true });
		// -X: no extra file attributes, so the same sources give the same archive contents.
		execFileSync("zip", ["-q", "-r", "-X", zip, "."], { cwd: staging, stdio: "inherit" });
		process.stdout.write(`${zip}\n`);
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}
