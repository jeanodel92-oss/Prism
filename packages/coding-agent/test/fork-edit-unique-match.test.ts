/**
 * fork: the edit tool's search for the text to replace.
 * - an oldText that the fuzzy normalization reduces to nothing (a tab) "matched" at offset 0 of a file that
 *   does not contain it, and a single space was counted once per character boundary, so a unique space was refused.
 * - the uniqueness check missed overlapping occurrences: "aba" in "ababa" was taken as unique and replaced
 *   at the first position.
 */
import { describe, expect, it } from "vitest";
import { applyEditsToNormalizedContent } from "../src/core/tools/edit-diff.ts";

const apply = (content: string, oldText: string, newText: string) =>
	applyEditsToNormalizedContent(content, [{ oldText, newText }], "f.txt").newContent;

describe("fork: the edit tool's match", () => {
	it("does not insert anything when the text is not in the file, even after normalization", () => {
		expect(() => apply("x", "\t", "Z")).toThrow(/Could not find/);
		expect(() => apply("x", "   ", "Z")).toThrow(/Could not find/);
	});

	it("replaces a single space or tab that is in the file once", () => {
		expect(apply("a b", " ", "_")).toBe("a_b");
		expect(apply("a\tb", "\t", "_")).toBe("a_b");
		expect(() => apply("a b c", " ", "_")).toThrow(/Found 2 occurrences/);
	});

	it("refuses a text found at two overlapping places", () => {
		expect(() => apply("ababa", "aba", "X")).toThrow(/Found 2 occurrences/);
		expect(() => apply("---", "--", "+")).toThrow(/Found 2 occurrences/);
		expect(() => apply("x\n\n\ny", "\n\n", "\n")).toThrow(/Found 2 occurrences/);
		// Non-overlapping duplicates and a unique text behave as before.
		expect(() => apply("ab ab", "ab", "X")).toThrow(/Found 2 occurrences/);
		expect(apply("abcab", "bc", "X")).toBe("aXab");
	});
});
