// fork: "/" lists commands of several words once their first word is typed, and finds
// commands by alias.
import assert from "node:assert";
import { describe, it } from "node:test";
import { CombinedAutocompleteProvider } from "../src/autocomplete.ts";

const provider = () =>
	new CombinedAutocompleteProvider(
		[
			{ name: "quit", description: "Quit", aliases: ["exit", "close"] },
			{ name: "resume", description: "Resume a session", aliases: ["sessions"] },
			{ name: "session", description: "Show session info" },
			{ name: "plugin", description: "A plugin" },
			{ name: "plugin setup", description: "Run the setup wizard" },
			{ name: "plugin status", description: "Show status" },
		],
		process.cwd(),
	);

async function suggest(text: string) {
	const lines = [text];
	const result = await provider().getSuggestions(lines, 0, text.length, { signal: new AbortController().signal });
	return result?.items.map((item) => item.value) ?? [];
}

describe("fork: command discovery", () => {
	it("hides commands of several words from the top list", async () => {
		assert.deepStrictEqual(await suggest("/"), ["quit", "resume", "session", "plugin"]);
	});

	it("lists them once their first word is typed", async () => {
		assert.deepStrictEqual(await suggest("/plugin "), ["plugin setup", "plugin status"]);
		assert.deepStrictEqual(await suggest("/plugin se"), ["plugin setup"]);
	});

	it("finds a command by alias", async () => {
		assert.deepStrictEqual(await suggest("/exit"), ["quit"]);
		assert.deepStrictEqual(await suggest("/clo"), ["quit"]);
	});

	it("keeps a command typed in full ahead of an alias match", async () => {
		assert.deepStrictEqual((await suggest("/session"))[0], "session");
		assert.deepStrictEqual((await suggest("/sessio"))[0], "resume");
	});
});
