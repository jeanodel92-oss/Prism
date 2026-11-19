/**
 * fork: the inline-bash example passed a command's output to String.replace as a
 * replacement string, so "$$" became "$", "$&" put the "!{…}" back, and "$`" / "$'" copied the prompt around it.
 */
import { describe, expect, it } from "vitest";
import inlineBash from "../examples/extensions/inline-bash.ts";

type Handler = (event: { text: string }, ctx: { hasUI: boolean }) => Promise<{ action: string; text?: string }>;

function expand(outputs: Record<string, string>) {
	let handler: Handler | undefined;
	inlineBash({
		on: (_event: string, fn: Handler) => {
			handler = fn;
		},
		exec: async (_bash: string, args: string[]) => ({ stdout: outputs[args[1]] ?? "", stderr: "", code: 0 }),
	} as never);
	return async (text: string) => (await handler!({ text }, { hasUI: false })).text;
}

describe("inline-bash example: outputs are inserted literally", () => {
	it("keeps $$, $&, $` and $' as the command printed them", async () => {
		const run = expand({ a: "$$", b: "$&", c: "$`", d: "$'" });
		expect(await run("x !{a} y !{b} z !{c} w !{d} v")).toBe("x $$ y $& z $` w $' v");
	});
});
