import { parse } from "yaml";
import { stripBom } from "./text.ts";

type ParsedFrontmatter<T extends Record<string, unknown>> = {
	frontmatter: T;
	body: string;
};

const normalizeNewlines = (value: string): string => value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

const extractFrontmatter = (content: string): { yamlString: string | null; body: string } => {
	const normalized = normalizeNewlines(stripBom(content));

	// fork: delimiters are whole lines of exactly three dashes, so a Markdown rule
	// such as "----" or a line like "--- note" is content, not frontmatter.
	const opening = /^---[ \t]*\n/.exec(normalized);
	if (!opening) {
		return { yamlString: null, body: normalized };
	}

	const closing = /\n---[ \t]*(?:\n|$)/g;
	closing.lastIndex = opening[0].length - 1;
	const end = closing.exec(normalized);
	if (!end) {
		return { yamlString: null, body: normalized };
	}

	return {
		yamlString: normalized.slice(opening[0].length, end.index),
		body: normalized.slice(end.index + end[0].length).trim(),
	};
};

export const parseFrontmatter = <T extends Record<string, unknown> = Record<string, unknown>>(
	content: string,
): ParsedFrontmatter<T> => {
	const { yamlString, body } = extractFrontmatter(content);
	if (!yamlString) {
		return { frontmatter: {} as T, body };
	}
	const parsed = parse(yamlString);
	return { frontmatter: (parsed ?? {}) as T, body };
};

export const stripFrontmatter = (content: string): string => parseFrontmatter(content).body;
