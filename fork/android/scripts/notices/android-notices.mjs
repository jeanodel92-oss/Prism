#!/usr/bin/env node
// fork: writes the licences and notices of the Java and Kotlin libraries the
// Android app's release build packs (AndroidX, Material, Kotlin, ZXing...), which their licences require with every
// copy. fork/android/scripts/build.sh runs it for a release APK, into the window's interface, hence into the APK.
//
// The library list comes from Gradle (list-dependencies.gradle), their licences from their POM files (or a parent's),
// and their own NOTICE and licence files from inside their aar or jar. A licence this script cannot name, or an MIT
// or BSD licence whose text (with its copyright line) it cannot find, stops the build until the maintainer has looked at it.
//
//   node android-notices.mjs <generated Android project> <out file>
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../../..");
const [projectArg, out] = process.argv.slice(2);
if (!projectArg || !out) throw new Error("usage: android-notices.mjs <generated Android project> <out file>");
const project = resolve(projectArg);

// SPDX id -> the licence names POM files use for it.
const NAMES = {
	"Apache-2.0": [/apache.*2\.0/i],
	MIT: [/^(the )?mit( license)?$/i],
	"BSD-3-Clause": [/bsd.*3-clause/i, /^new bsd/i],
};
// Licences a POM names only vaguely, recognised by their URL, with their text kept beside this script.
// libyuv is built into androidx.camera:camera-core; its aar carries only the Apache licence.
const BY_URL = [{ url: /libyuv/, id: "BSD-3-Clause", text: "libyuv-LICENSE.txt", of: "libyuv (in androidx.camera)" }];

const output = execFileSync(
	join(project, "gradlew"),
	["-q", "--no-configuration-cache", "-I", join(here, "list-dependencies.gradle"), ":app:prismListDependencies"],
	{ cwd: project, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
);
const coordinates = output
	.split("\n")
	.filter((line) => line.startsWith("PRISM-DEP "))
	.map((line) => line.slice("PRISM-DEP ".length).trim());

const cache = join(homedir(), ".gradle/caches/modules-2/files-2.1");
const filesOf = (group, module, version) => {
	const dir = join(cache, group, module, version);
	if (!existsSync(dir)) return [];
	return readdirSync(dir).flatMap((hash) => readdirSync(join(dir, hash)).map((file) => join(dir, hash, file)));
};
const tag = (xml, name) => [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "g"))].map((m) => m[1].trim());

/** The licences of a module's POM, or of its closest parent POM that names some. */
function licencesOf(group, module, version, depth = 0) {
	const pom = filesOf(group, module, version).find((file) => file.endsWith(".pom"));
	if (!pom) return [];
	const xml = readFileSync(pom, "utf8");
	const block = tag(xml, "licenses")[0];
	if (block) return tag(block, "license").map((license) => ({ name: tag(license, "name")[0] ?? "", url: tag(license, "url")[0] ?? "" }));
	const parent = tag(xml, "parent")[0];
	if (!parent || depth > 5) return [];
	return licencesOf(tag(parent, "groupId")[0], tag(parent, "artifactId")[0], tag(parent, "version")[0], depth + 1);
}

const unzip = (...args) =>
	execFileSync("unzip", args, { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
const isNotice = (name) => /(^|\/)(NOTICE|LICENSE|COPYING)[^/]*$/i.test(name) && !name.endsWith("/");
const work = mkdtempSync(join(tmpdir(), "prism-android-notices-"));

/** NOTICE and licence files inside a jar, or inside an aar and its classes.jar. */
function noticesOf(artifact) {
	const found = [];
	const scan = (zip) => {
		for (const name of unzip("-Z1", zip).toString("utf8").split("\n").filter(isNotice)) {
			found.push({ name, text: unzip("-p", zip, name).toString("utf8").trim() });
		}
	};
	scan(artifact);
	if (artifact.endsWith(".aar")) {
		const jar = join(work, "classes.jar");
		try {
			writeFileSync(jar, unzip("-p", artifact, "classes.jar"));
			scan(jar);
		} catch {
			// An aar without classes.jar (resources only).
		}
	}
	return found;
}

const libraries = [];
const refused = [];
const extraTexts = [];
for (const coordinate of coordinates) {
	const [group, module, version] = coordinate.split(":");
	const artifact = filesOf(group, module, version).find((file) => /\.(aar|jar)$/.test(file) && !/-sources\.jar$/.test(file));
	if (!artifact) continue; // A BOM or another POM-only module: nothing of it is in the app.
	const notices = noticesOf(artifact);
	const licences = licencesOf(group, module, version);
	const ids = [];
	for (const licence of licences) {
		const known = BY_URL.find((entry) => entry.url.test(licence.url));
		const id = known?.id ?? Object.keys(NAMES).find((name) => NAMES[name].some((p) => p.test(licence.name)));
		if (!id) {
			refused.push(`${coordinate}: "${licence.name}" (${licence.url})`);
			continue;
		}
		ids.push(id);
		if (known) {
			if (!extraTexts.some((entry) => entry.of === known.of)) extraTexts.push(known);
		} else if (id !== "Apache-2.0" && !notices.some((notice) => /LICENSE|COPYING/i.test(notice.name))) {
			// MIT and BSD texts carry the holders' copyright line: a generic text would not do.
			refused.push(`${coordinate}: ${id} without its licence file`);
		}
	}
	if (licences.length === 0) refused.push(`${coordinate}: no licence in its POM`);
	libraries.push({ coordinate, ids: [...new Set(ids)], notices });
}
rmSync(work, { recursive: true, force: true });
if (refused.length > 0) {
	console.error(`android-notices: licences to look at first:\n  ${refused.join("\n  ")}`);
	process.exit(1);
}

const rule = "=".repeat(80);
const lines = [
	"Prism: third-party licences of the Android app's Java and Kotlin libraries",
	"",
	"Prism's own code is under GPL-3.0-or-later (LICENSE). The libraries below keep their own licences; the Rust",
	"crates of the app are in THIRD-PARTY-RUST.txt.",
	"",
	...libraries.map((library) => `  - ${library.coordinate} (${library.ids.join(" AND ")})`),
];
const seen = new Set();
for (const library of libraries) {
	for (const notice of library.notices) {
		if (!notice.text || seen.has(notice.text)) continue;
		seen.add(notice.text);
		lines.push("", rule, `${notice.name} of ${library.coordinate}`, "", notice.text);
	}
}
for (const extra of extraTexts) {
	lines.push("", rule, `${extra.id}: ${extra.of}`, "", readFileSync(join(here, extra.text), "utf8").trim());
}
if (libraries.some((library) => library.ids.includes("Apache-2.0"))) {
	lines.push("", rule, "Apache-2.0", "", readFileSync(join(root, "LICENSES/Apache-2.0.txt"), "utf8").trim());
}
writeFileSync(out, `${lines.join("\n")}\n`);
console.log(`android-notices: ${libraries.length} libraries, ${seen.size} notice files`);
