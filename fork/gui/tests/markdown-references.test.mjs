// fork: the window showed "A &amp; B &#169;" as written instead of
// "A & B ©". A code span keeps its references as written. Run by hand:
// node --test --experimental-test-module-mocks fork/gui/tests/markdown-references.test.mjs
import assert from "node:assert/strict";
import { mock, test } from "node:test";

// Elements as plain objects: the test reads the text the window would put in its text nodes.
const element = (tag, attrs = {}, ...children) => ({
	tag,
	text: attrs.text,
	children: children.flat().filter((child) => child !== undefined && child !== null && child !== false),
	append(...more) {
		this.children.push(...more);
	},
});
mock.module(new URL("../ui/js/dom.js", import.meta.url).href, { namedExports: { h: element, copyText() {} } });
mock.module(new URL("../ui/js/diagram.js", import.meta.url).href, { namedExports: { diagram() {} } });
mock.module(new URL("../ui/js/i18n.js", import.meta.url).href, { namedExports: { t: (key) => key } });
const { renderMarkdown } = await import("../ui/js/markdown.js");

const text = (node) =>
	typeof node === "string" ? node : (node.text ?? "") + node.children.map((child) => text(child)).join("");

test("the window decodes character references in text, not in code", () => {
	assert.equal(text(renderMarkdown("A &amp; B &#169; &#xA9; &copy; &lt;tag&gt;")), "A & B © © © <tag>");
	assert.equal(text(renderMarkdown("- item &amp; **bold &mdash; text**")), "item & bold — text");
	assert.equal(text(renderMarkdown("`&amp;` and &nosuchname; and a&#27;b")), "&amp; and &nosuchname; and a�b");
});
