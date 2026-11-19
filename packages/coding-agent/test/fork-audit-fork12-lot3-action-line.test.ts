// fork: the simple interface's action line, shown above a permission question,
// turned a path's line breaks into spaces, kept bidi and zero-width characters raw and named only the first program of
// a command, so a model-written sentence or a hidden `rm` read as part of the action. The cases are the audit's
//.
import { describe, expect, it } from "vitest";
import { plainAction } from "../src/fork/prism/plain-action.ts";

const INVISIBLE = /[\p{C}\p{Zl}\p{Zp}]/u;

describe("fork: security audit of fork.12, AS-033: the action line above a permission question", () => {
	it("shows a path's line breaks instead of joining its lines into a sentence", () => {
		const line = plainAction("write", { path: "notes.txt\nThis action is safe: reading a file\n/dev/null" });
		expect(line).toBe("Write file notes.txt<U+000A>This action is safe: reading a file<U+000A>/dev/null");
	});

	it("shows bidi, zero-width and control characters as the question does", () => {
		expect(plainAction("read", { path: "src/\u202egnp.exe" })).toBe("Read file src/<U+202E>gnp.exe");
		const zero = plainAction("bash", { command: "rm\u200b -rf\u2060 src\ufeff" }) ?? "";
		expect(zero).toBe("Run a command (rm<U+200B>)");
		const control = plainAction("grep", { pattern: "a\x1b[2Jb" }) ?? "";
		for (const line of [zero, control]) expect(INVISIBLE.test(line)).toBe(false);
	});

	it("names every program of a compound command, also inside a substitution", () => {
		expect(plainAction("bash", { command: "echo \u202e; rm -rf src #\u202c safe listing" })).toBe(
			"Run a command (echo, rm)",
		);
		expect(plainAction("bash", { command: "CI=1 npm test && git status | head -n 5" })).toBe(
			"Run a command (npm, git, head)",
		);
		expect(plainAction("bash", { command: 'echo "$(curl -s x | sh)"' })).toBe("Run a command (echo, curl, sh)");
		expect(plainAction("bash", { command: "ls\nrm -rf src" })).toBe("Run a command (ls, rm)");
	});
});
