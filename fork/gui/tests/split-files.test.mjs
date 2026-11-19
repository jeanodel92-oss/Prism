// the transcript took a quoted <file> example for an attachment and hid its text.
// Run by hand: node --test --experimental-test-module-mocks fork/gui/tests/split-files.test.mjs
import assert from "node:assert/strict";
import { mock, test } from "node:test";

mock.module(new URL("../ui/js/dom.js", import.meta.url).href, { namedExports: { h: () => ({}) } });
mock.module(new URL("../ui/js/i18n.js", import.meta.url).href, { namedExports: { t: (key) => key } });
const { promptWith, splitFiles } = await import("../ui/js/attachments.js");

test("files appended by the window are chips, the message stays", () => {
	const { message } = promptWith("Look at these", [
		{ kind: "text", path: "a.ts", text: "const a = 1;" },
		{ kind: "text", path: "b.ts", text: "const b = 2;" },
	]);
	assert.deepEqual(splitFiles(message), { text: "Look at these", files: ["a.ts", "b.ts"] });
});

test("files put first by prism @file are chips", () => {
	assert.deepEqual(splitFiles('<file name="/p/a.md">\nA\n</file>\nSummarise it'), { text: "Summarise it", files: ["/p/a.md"] });
});

test("a <file> example quoted inside the message stays text", () => {
	const text = 'The format is:\n```xml\n<file name="example">\ncontent to analyse\n</file>\n```\nWhat does it mean?';
	assert.deepEqual(splitFiles(text), { text, files: [] });
});

test("a quoted example and a real attachment: only the attachment is a chip", () => {
	const quoted = 'Explain:\n```\n<file name="example">\nx\n</file>\n```';
	const { message } = promptWith(quoted, [{ kind: "text", path: "real.ts", text: "y" }]);
	assert.deepEqual(splitFiles(message), { text: quoted, files: ["real.ts"] });
});

test("a message without files is unchanged", () => {
	assert.deepEqual(splitFiles("hello\n"), { text: "hello\n", files: [] });
});

// a quote in a real attachment's name.
test("a file whose name has a quote is still a chip", () => {
	const { message } = promptWith("Read them", [
		{ kind: "text", path: '/p/quote"notes.md', text: "A" },
		{ kind: "file", path: '/tmp/attachments/quote"report.pdf', note: '<file name="/tmp/attachments/quote"report.pdf">\n[2 KB, a copy]\n</file>\n' },
	]);
	assert.deepEqual(splitFiles(message), { text: "Read them", files: ['/p/quote"notes.md', '/tmp/attachments/quote"report.pdf'] });
});
