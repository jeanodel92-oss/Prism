/**
 * fork: externally sized data is never spread into the arguments of one call.
 * V8 throws "Maximum call stack size exceeded" for a spread of about 150 000 elements, so each case passes 200 000.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
import { truncateMiddle } from "../src/core/tools/truncate.ts";
import { createMcpResourceToolDefinitions, type McpResourceServer } from "../src/extensions/mcp/resources.ts";
import { documentLines, type UiDocument } from "../src/fork/generated-ui.ts";
import { fencePastedCode } from "../src/fork/pasted-code.ts";

const MANY = 200_000;
const style = { bold: (text: string) => text, muted: (text: string) => text };

describe("fork: no spread of externally sized data", () => {
	test("a pasted code block of 200 000 lines is fenced", () => {
		const code = Array.from({ length: MANY }, (_, i) => `    const value${i} = call(\`x\`);`);
		const fenced = fencePastedCode(["Here:", ...code].join("\n")).split("\n");
		expect(fenced[1]).toBe("```");
		expect(fenced[2]).toBe(code[0]);
		expect(fenced.at(-1)).toBe("```");
		expect(fenced).toHaveLength(MANY + 3);
	});

	test("a table of 200 000 rows, and one wrapped into more than 400 000 lines, are rendered", () => {
		const tall: UiDocument = {
			version: 1,
			blocks: [
				{ type: "table", columns: ["Id", "Name"], rows: Array.from({ length: MANY }, (_, i) => [`${i}`, "n"]) },
			],
		};
		const lines = documentLines(tall, 80, style);
		expect(lines).toHaveLength(MANY + 1);
		expect(lines.at(-1)).toBe(`${MANY - 1}  n`);
		const cell = "x".repeat(100);
		const narrow: UiDocument = {
			version: 1,
			blocks: [{ type: "table", columns: ["A", "B"], rows: Array.from({ length: 2000 }, () => [cell, cell]) }],
		};
		expect(documentLines(narrow, 1, style).length).toBeGreaterThan(400_000);
	});

	describe("MCP resources from every server", () => {
		let dir: string;
		beforeEach(() => {
			dir = mkdtempSync(join(tmpdir(), "prism-spreads-"));
			vi.stubEnv("TMPDIR", dir);
		});
		afterEach(() => {
			vi.unstubAllEnvs();
			rmSync(dir, { recursive: true, force: true });
		});

		test("200 000 resources of one server are listed", async () => {
			const resources = Array.from({ length: MANY }, (_, i) => ({ uri: `file:///r${i}`, name: `r${i}` }));
			const server = {
				name: "big",
				timeoutMs: 1000,
				allResources: async () => resources,
			} as unknown as McpResourceServer;
			const [list] = createMcpResourceToolDefinitions({ exposure: "direct", servers: () => [server] });
			const result = (await list!.execute(
				"call",
				{},
				undefined,
				undefined,
				{} as ExtensionToolContext,
			)) as unknown as {
				structuredContent: { resources: unknown[] };
			};
			expect(result.structuredContent.resources).toHaveLength(MANY);
		});
	});

	test("the middle truncation counts as before, without an array per removed character", () => {
		const chars = (text: string) => Array.from(text).length;
		for (const content of [
			"",
			"\n",
			"a",
			"a\n",
			"a\nb",
			"a\n\nb\n",
			"é😀\nx€",
			"😀".repeat(40),
			`${"a€b".repeat(30)}\n`,
		]) {
			for (const maxBytes of [1, 3, 7, 16, 1000]) {
				const result = truncateMiddle(content, maxBytes);
				const lines = content === "" ? [] : content.split("\n");
				if (content.endsWith("\n")) lines.pop();
				expect(result.totalLines).toBe(lines.length);
				if (!result.truncated) continue;
				// Head and tail are cut at character boundaries: what is not in them was removed.
				const [head, tail] = result.content.split(`…${result.removedChars} chars truncated…`);
				expect(result.removedChars).toBe(chars(content) - chars(head!) - chars(tail!));
			}
		}
		// A 12 MiB line kept to 20 KiB: the heap grows by far less than an array of 12 million entries (about 96 MB).
		const line = "x".repeat(12 * 1024 * 1024);
		const heapBefore = process.memoryUsage().heapUsed;
		const result = truncateMiddle(line, 20 * 1024);
		const grown = process.memoryUsage().heapUsed - heapBefore;
		expect(result.removedChars).toBe(line.length - 20 * 1024);
		expect(grown).toBeLessThan(32 * 1024 * 1024);
	});
});
