// fork: with the read limit (`sandbox.read.limit: "project"`), commands see only the folder of Prism's code that holds
// the programs the sandbox runs. An import leaving it broke Git over SSH and signing (ERR_MODULE_NOT_FOUND) when
// Prism is installed under the home folder, as a release is.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const folder = resolve(dirname(fileURLToPath(import.meta.url)), "../src/fork/sandbox");

function localImports(file: string): string[] {
	const source = readFileSync(file, "utf8");
	// `import type` is erased when Node strips the types: it loads nothing.
	return [...source.matchAll(/^\s*(import|export)\b(\s+type\b)?[^;]*?\bfrom\s+"(\.{1,2}\/[^"]+)"/gms)]
		.filter((match) => !(match[1] === "import" && match[2]))
		.map((match) => resolve(dirname(file), match[3]!));
}

describe("fork: the programs the sandbox runs import only their own folder", () => {
	it.each(["relay.ts", "git-ssh-client.ts", "git-sign-client.ts"])("%s", (entry) => {
		const seen = new Set<string>();
		const outside: string[] = [];
		const visit = (file: string) => {
			if (seen.has(file)) return;
			seen.add(file);
			for (const target of localImports(file)) {
				if (dirname(target) !== folder) outside.push(`${file} -> ${target}`);
				else visit(target);
			}
		};
		visit(join(folder, entry));
		expect(outside).toEqual([]);
	});
});
