// fork: an unclosed "$" followed by something math-like ($APP_CONFIG, because
// of the "_") opened a pending formula that swallowed the rest of the paragraph raw, Markdown and all, even once
// the reply was finished.
import assert from "node:assert";
import { describe, it } from "node:test";
import { Markdown } from "../src/components/markdown.ts";
import { defaultMarkdownTheme } from "./test-themes.ts";

const plain = (source: string) =>
	new Markdown(source, 0, 0, defaultMarkdownTheme)
		.render(80)
		.map((line) => line.replace(/\x1b\[[0-9;]*m|\x1b\]8;[^\x07]*\x07/g, "").trimEnd());

describe("fork: unclosed dollar in Markdown", () => {
	it("keeps the Markdown after a lone $APP_CONFIG", () => {
		assert.deepStrictEqual(plain("Set $APP_CONFIG to **bold** and `code`."), ["Set $APP_CONFIG to bold and code."]);
	});

	it("keeps the Markdown after a lone $HOME path", () => {
		assert.deepStrictEqual(plain("Edit $HOME/.config/x_y.toml, then **restart**."), [
			"Edit $HOME/.config/x_y.toml, then restart.",
		]);
	});

	it("still holds a formula being written as it is", () => {
		assert.deepStrictEqual(plain("Streaming $x^2 + *y"), ["Streaming $x^2 + *y"]);
	});
});
