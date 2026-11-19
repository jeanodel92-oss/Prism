/**
 * fork: the @ search handed the typed name to fd as a regex, so "@+pa"
 * (SvelteKit's +page.svelte) made fd fail and the list came back empty; "@--rapport" was read as an option.
 */
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { CombinedAutocompleteProvider } from "../src/autocomplete.ts";

const fdPath = spawnSync("which", ["fd"], { encoding: "utf-8" }).stdout?.split("\n")[0]?.trim() || undefined;

describe("fork: the @ search takes the name literally", { skip: !fdPath }, () => {
	const baseDir = mkdtempSync(join(tmpdir(), "pi-fd-literal-"));
	after(() => rmSync(baseDir, { recursive: true, force: true }));
	mkdirSync(join(baseDir, "src", "routes"), { recursive: true });
	for (const name of ["+page.svelte", "price$.ts", "(group).md", "[slug].md", "--rapport.txt", "other.txt"]) {
		writeFileSync(join(baseDir, name), "");
		writeFileSync(join(baseDir, "src", "routes", name), "");
	}
	const provider = new CombinedAutocompleteProvider([], baseDir, fdPath);
	const values = async (line: string) =>
		(
			await provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal, force: false })
		)?.items.map((item) => item.value) ?? [];

	for (const [typed, file] of [
		["+pa", "+page.svelte"],
		["price$", "price$.ts"],
		["(gro", "(group).md"],
		["[slug", "[slug].md"],
		["--rap", "--rapport.txt"],
	]) {
		it(`finds ${file} from "@${typed}", at the root and in an explicit folder`, async () => {
			assert.ok((await values(`@${typed}`)).includes(`@${file}`), typed);
			assert.ok((await values(`@src/routes/${typed}`)).includes(`@src/routes/${file}`), typed);
		});
	}
});
