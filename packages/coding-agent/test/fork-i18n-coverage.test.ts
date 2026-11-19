// fork: inventory built-in notices and dialog text from syntax, including template literals.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Node } from "@oxc-project/types";
import { parseAst } from "rolldown/parseAst";
import { describe, expect, it } from "vitest";
import { FR, FR_PATTERNS } from "../src/fork/i18n/fr.ts";
import { escapeRegex } from "../src/fork/i18n/index.ts";

// Command syntax stays literal, like commands in --help. No prose may be added to this list.
const KEEP_ENGLISH = new Set([
	"Usage: /sessions [all] <keywords>",
	"Usage: /web-key [exa|brave|tavily|firecrawl|searxng] [remove]",
]);

interface Notice {
	file: string;
	text: string;
}

function textLiterals(node: Node): string[] {
	if (node.type === "Literal" && typeof node.value === "string") return [node.value];
	if (node.type === "TemplateLiteral") {
		const pattern = node.quasis
			.map((part, i) => `${i ? `{${i - 1}}` : ""}${part.value.cooked ?? part.value.raw}`)
			.join("");
		// Variables alone (paths, model names, tool output) are not interface prose.
		return [
			...(/[A-Za-z]{2}/.test(pattern.replace(/\{\d+\}/g, "")) ? [pattern] : []),
			...node.expressions.filter((expression) => expression.type === "CallExpression").flatMap(textLiterals),
		];
	}
	if (node.type === "ConditionalExpression")
		return [...textLiterals(node.consequent), ...textLiterals(node.alternate)];
	if (node.type === "ArrayExpression")
		return node.elements.flatMap((element) => (element ? textLiterals(element) : []));
	if (node.type === "BinaryExpression" && node.operator === "+")
		return [...textLiterals(node.left), ...textLiterals(node.right)];
	if (node.type === "CallExpression") {
		if (node.callee.type === "Identifier" && node.callee.name === "t") return node.arguments.flatMap(textLiterals);
		// t("Agent created: {0}").replace(...) still checks the catalog key, not the replacement value.
		if (node.callee.type === "MemberExpression") return textLiterals(node.callee.object);
	}
	return [];
}

function inventory(code: string, file: string): Notice[] {
	const notices: Notice[] = [];
	const visit = (value: unknown): void => {
		if (!value || typeof value !== "object") return;
		if (Array.isArray(value)) {
			for (const child of value) visit(child);
			return;
		}
		const node = value as Node;
		if (node.type === "CallExpression") {
			const callee = node.callee;
			if (
				/(?:native[^/]*|[^/]*-native)\.ts$/.test(file) &&
				callee.type === "Identifier" &&
				/^(t|fill|labelled)$/.test(callee.name)
			) {
				for (const text of textLiterals(node.arguments[0])) notices.push({ file, text });
			}
			const member =
				callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier"
					? callee.property.name
					: "";
			const receiver = callee.type === "MemberExpression" ? code.slice(callee.object.start, callee.object.end) : "";
			const dialog = /(?:^|\.)ui$/.test(receiver) && /^(notify|select|confirm|input|editor)$/.test(member);
			const status = /^(showStatus|showWarning|showError|showInfo)$/.test(member);
			const desktop =
				/(?:^|\/)(?:notify|background)\.ts$/.test(file) &&
				callee.type === "Identifier" &&
				/^(send|notify)$/.test(callee.name);
			const helper = callee.type === "Identifier" && /^(notify|report)$/.test(callee.name);
			if (dialog || status || desktop || helper) {
				const args = member === "confirm" || desktop ? node.arguments.slice(0, 2) : node.arguments.slice(0, 1);
				for (const arg of args) for (const text of textLiterals(arg)) notices.push({ file, text });
			}
		}
		for (const child of Object.values(value)) visit(child);
	};
	visit(parseAst(code, { lang: "ts" }, file));
	return notices;
}

describe("fork: French notification coverage", () => {
	it("finds raw, translated, multiline and conditional literals without reading tool descriptions", () => {
		const code = `ctx.ui.notify("A"); ctx.ui.notify(t("B")); ctx.ui.confirm(\`Title \${name}\`, "Body");
ctx.ui.notify(ok ? "Yes" : "No"); ctx.ui.notify(t("Long").replace("{0}", name));
const tool = { description: "For the model" };`;
		expect(inventory(code, "fixture.ts").map(({ text }) => text)).toEqual([
			"A",
			"B",
			"Title {0}",
			"Body",
			"Yes",
			"No",
			"Long",
		]);
	});

	it("has a French catalog entry for every built-in notice and dialog literal", () => {
		const root = join(__dirname, "../src/fork");
		const notices: Notice[] = [];
		const walk = (dir: string): void => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const file = join(dir, entry.name);
				if (entry.isDirectory()) walk(file);
				else if (file.endsWith(".ts")) notices.push(...inventory(readFileSync(file, "utf8"), relative(root, file)));
			}
		};
		walk(root);
		const patterns = Object.keys(FR_PATTERNS).map(
			(key) =>
				new RegExp(
					`^${key
						.split(/\{\d\}/)
						.map(escapeRegex)
						.join("[\\s\\S]*?")}$`,
				),
		);
		const missing = notices.filter(
			({ text }) =>
				/[A-Za-z]/.test(text) &&
				!KEEP_ENGLISH.has(text) &&
				!Object.hasOwn(FR, text) &&
				!patterns.some((pattern) => pattern.test(text)),
		);
		expect(notices.length).toBeGreaterThan(70);
		expect(missing).toEqual([]);
	});
});
