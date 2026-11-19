// fork: render hook for markdown tokens. The Prism pack restyles code blocks, rules,
// tables and headings; it used to patch Markdown.prototype.renderToken and read private fields.
// The hook gets what it needs as typed arguments and returns undefined to keep the default.
import type { Token } from "marked";
import type { DefaultTextStyle, MarkdownTheme } from "../components/markdown.ts";

export interface MarkdownTokenHookContext {
	theme: MarkdownTheme;
	defaultTextStyle?: DefaultTextStyle;
	/** The token as Markdown renders it without the hook. */
	renderDefault: () => string[];
}

export type MarkdownTokenHook = (
	token: Token,
	width: number,
	nextTokenType: string | undefined,
	context: MarkdownTokenHookContext,
) => string[] | undefined;

let hook: MarkdownTokenHook | undefined;

export function setMarkdownTokenHook(next: MarkdownTokenHook | undefined): void {
	hook = next;
}

export function getMarkdownTokenHook(): MarkdownTokenHook | undefined {
	return hook;
}
