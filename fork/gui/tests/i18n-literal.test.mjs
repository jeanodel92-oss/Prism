// review of 2026-11-09, CR-288 (window variant): t() passed each value to replaceAll as a replacement string, so a
// path with "$&" or "$$" was garbled, and a "{1}" inside the first value was filled by the second.
// Run by hand: node --test fork/gui/tests/i18n-literal.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

const { t } = await import("../ui/js/i18n.js");

test("values with dollar patterns are inserted as they are", () => {
	assert.equal(t("exported", "/projet/report$&.pdf"), "Session exported to /projet/report$&.pdf");
	assert.equal(t("exported", "/a/$$/b"), "Session exported to /a/$$/b");
});

test("a placeholder inside a value is not filled again", () => {
	assert.equal(t("agentTranscriptTitle", "task {1}", "done"), "task {1} (done)");
});

test("a placeholder without a value stays", () => {
	assert.equal(t("agentTranscriptTitle", "only"), "only ({1})");
});
