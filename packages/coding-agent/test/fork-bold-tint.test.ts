// fork: markdown bold keeps its weight and takes the theme's optional bold tint (mdBold).
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Markdown } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createState } from "../src/fork/prism/lib/state.ts";
import { transcriptHooks } from "../src/fork/prism/transcript.ts";
import { setRenderHooks } from "../src/fork/render-hooks.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { getMarkdownTheme, getResolvedThemeColors, initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

function assistant(text: string, thinking?: string): AssistantMessage {
	return {
		role: "assistant",
		content: [...(thinking ? [{ type: "thinking" as const, thinking }] : []), { type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

const fgCode = (c: string) => c === "39" || c.startsWith("38;");

/** WCAG relative luminance of a #rrggbb color. */
function luminance(hex: string): number {
	const [r, g, b] = [1, 3, 5].map((i) => {
		const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** The SGR codes in force where `word` starts. */
function sgrAt(lines: string[], word: string): string[] {
	const line = lines.find((l) => l.includes(word));
	if (!line) throw new Error(`no line with ${word}`);
	const before = line.slice(0, line.indexOf(word));
	return [...before.matchAll(/\x1b\[([\d;]*)m/g)].map((m) => m[1]!);
}

const renders = {
	markdown: () => new Markdown("plain **strong** after", 0, 0, getMarkdownTheme()).render(60),
	user: () => new UserMessageComponent("plain **strong** after").render(60),
	assistant: () => new AssistantMessageComponent(assistant("plain **strong** after")).render(60),
};

describe("fork: markdown bold tint", () => {
	// Bold comes from chalk, which writes nothing without a terminal.
	const level = chalk.level;
	beforeAll(() => {
		chalk.level = 3;
	});
	afterAll(() => {
		chalk.level = level;
	});

	for (const name of ["prism", "prism-light"]) {
		it(`draws bold in ${name}'s mdBold tint and in bold, in user and assistant messages`, () => {
			initTheme(name);
			const tint = /\x1b\[([\d;]*)m/.exec(theme.fg("mdBold", "x"))![1]!;
			expect(getResolvedThemeColors(name).mdBold).not.toBe(getResolvedThemeColors(name).text);
			for (const [where, render] of Object.entries(renders)) {
				const lines = render();
				const codes = sgrAt(lines, "strong");
				expect(codes, where).toContain("1");
				// The tint is the color in force, not covered by the message's text color.
				expect(codes.filter(fgCode).at(-1), where).toBe(tint);
				// The tint ends with the bold text.
				const after = sgrAt(lines, " after");
				expect(after.filter(fgCode).at(-1), where).not.toBe(tint);
			}
		});
	}

	for (const name of ["prism", "prism-light"]) {
		it(`keeps bold in ${name}'s thinking italic, on its rail, and quieter than the answer`, () => {
			initTheme(name);
			const state = createState();
			state.theme = theme;
			setRenderHooks(transcriptHooks(state));
			try {
				const tint = /\x1b\[([\d;]*)m/.exec(theme.fg("mdBold", "x"))![1]!;
				const ink = /\x1b\[([\d;]*)m/.exec(theme.fg("thinkingText", "x"))![1]!;
				const lines = new AssistantMessageComponent(assistant("answer", "plain **strong** after")).render(60);
				const codes = sgrAt(lines, "strong");
				expect(codes).toContain("3");
				expect(codes).toContain("1");
				expect(codes.filter(fgCode).at(-1)).toBe(tint);
				expect(sgrAt(lines, " after").filter(fgCode).at(-1)).toBe(ink);
				expect(lines.find((l) => l.includes("strong"))).toContain("▏");
				// Thinking bold stands out from thinking, never more than the answer's ink does.
				const colors = getResolvedThemeColors(name);
				const page = name === "prism" ? "#050505" : "#f2f2f0";
				const contrast = (hex: string) => {
					const [hi, lo] = [luminance(hex), luminance(page)].sort((a, b) => b - a);
					return (hi! + 0.05) / (lo! + 0.05);
				};
				expect(contrast(colors.mdBold!)).toBeLessThan(contrast(colors.text!) * 0.8);
			} finally {
				setRenderHooks({});
			}
		});
	}

	it("keeps plain bold in a theme without the token", () => {
		initTheme("dark");
		expect(getResolvedThemeColors("dark").mdBold).toBeUndefined();
		const codes = sgrAt(renders.markdown(), "strong");
		expect(codes).toContain("1");
		expect(codes.filter(fgCode)).toEqual([]);
	});
});
