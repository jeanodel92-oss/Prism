// the window's quoting and Prism's give each hostile name back as one word to sh.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { shellQuote as engineQuote } from "../../../packages/coding-agent/src/fork/sandbox/shell-quote.ts";
import { shellQuote } from "../ui/js/shell-quote.js";

const WORDS = ["report;make", "a|b", "x&y", "out>f", "in<f", "$(id)", "`id`", "it's", 'say "hi"', "two\nlines", "*.ts", "[ab]", "~/x", "a b", "-n", "plain/path.txt", "", "a=b", "#c", "!x", "\\back"];

test("each hostile word reaches sh as one argument, unchanged, from both quotings", () => {
	for (const quote of [shellQuote, engineQuote]) {
		const line = `printf '%s\\0' ${WORDS.map(quote).join(" ")}`;
		const out = execFileSync("sh", ["-c", line], { encoding: "utf8", cwd: "/" });
		assert.deepEqual(out.split("\0").slice(0, -1), WORDS);
	}
	for (const word of WORDS) assert.equal(shellQuote(word), engineQuote(word));
});
