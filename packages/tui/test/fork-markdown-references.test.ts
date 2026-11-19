/**
 * fork: a paragraph "A &amp; B &#169;" showed the references as written
 * instead of "A & B ©". A code span keeps them as written, and so does an escaped ampersand.
 */
import assert from "node:assert";
import { describe, it } from "node:test";
import { Markdown } from "../src/components/markdown.ts";
import { stripTerminalSequences } from "../src/utils.ts";
import { defaultMarkdownTheme } from "./test-themes.ts";

const shown = (source: string) =>
	new Markdown(source, 0, 0, defaultMarkdownTheme)
		.render(80)
		.map((line) => stripTerminalSequences(line).trimEnd())
		.filter(Boolean)
		.join("\n");

describe("fork: character references in Markdown", () => {
	it("decodes named, decimal and hexadecimal references in text", () => {
		assert.strictEqual(shown("A &amp; B &#169; &#xA9; &copy; &lt;tag&gt;"), "A & B © © © <tag>");
		assert.strictEqual(shown("- item &amp; **bold &mdash; text**"), "- item & bold — text");
	});

	it("keeps code spans, escaped ampersands and unknown or invalid references as written", () => {
		assert.strictEqual(
			shown("`&amp;` and \\&amp; and &nosuchname; and &#;"),
			"&amp; and &amp; and &nosuchname; and &#;",
		);
	});

	it("never decodes a reference into a terminal control", () => {
		const text = shown("a&#27;[31mb &#0; c&#x9B;d");
		assert.ok(!/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(text), JSON.stringify(text));
		assert.strictEqual(text, "a�[31mb � c�d");
	});
});
