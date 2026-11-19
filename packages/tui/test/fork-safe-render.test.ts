import assert from "node:assert";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { Markdown } from "../src/components/markdown.ts";
import { Text } from "../src/components/text.ts";
import { hyperlink } from "../src/terminal-image.ts";
import { sanitizeTerminalText } from "../src/utils.ts";
import { defaultMarkdownTheme } from "./test-themes.ts";

const payloads = JSON.parse(
	readFileSync(new URL("../../coding-agent/test/fixtures/hostile-render-payloads.json", import.meta.url), "utf8"),
) as Record<string, string>;

describe("fork: safe rendering", () => {
	it("removes terminal controls in assistant, tool and notification text while preserving SGR", () => {
		for (const value of Object.values(payloads)) {
			const lines = [
				...new Markdown(value, 0, 0, defaultMarkdownTheme).render(100),
				...new Text(value, 0, 0).render(100),
			];
			for (const line of lines) {
				// Link closers (`ESC ]8;;ST`) are harmless and kept; a link opener from the payload is not.
				assert.doesNotMatch(
					line,
					/\x1b\](?:52|0|2|7|9|777);|\x1b\]8;[^;\x07\x1b]*;[^\x07\x1b]|\x1b[P_]|[\u0080-\u009f]|\x1b\[(?:2J|H)/,
				);
				assert.doesNotMatch(line.replace(/\x1b\[[0-9;:]*m|\x1b\]8;;(?:\x07|\x1b\\)/g, ""), /\x1b/);
			}
		}
		assert.ok(new Text(payloads.coloredBash, 0, 0).render(100).some((line) => line.includes("\x1b[31m")));
	});

	it("shows Markdown images as a non-fetching placeholder and displays the target", () => {
		const lines = new Markdown("![secret](https://attacker.example/image.png)", 0, 0, defaultMarkdownTheme).render(
			100,
		);
		assert.match(lines.join(""), /Image: secret/);
		assert.match(lines.join(""), /https:\/\/attacker\.example\/image\.png/);
		assert.doesNotMatch(lines.join(""), /\x1b\]8;/);
	});

	it("does not request a remote Markdown image while rendering", async () => {
		let requests = 0;
		const server = createServer((_request, response) => {
			requests++;
			response.end("unexpected");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address();
			assert.ok(address && typeof address === "object");
			const markdown = `![secret](http://127.0.0.1:${address.port}/leak)`;
			new Markdown(markdown, 0, 0, defaultMarkdownTheme).render(100);
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.strictEqual(requests, 0);
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	});

	it("keeps the links this process creates and drops forged ones", () => {
		const own = new Text(hyperlink("src/a.ts", "file:///tmp/a.ts"), 0, 0).render(80).join("");
		assert.match(own, /\x1b\]8;id=pi-[^;]+;file:\/\/\/tmp\/a\.ts\x1b\\/);
		const forged = new Text("\x1b]8;id=pi-guess;https://attacker.example\x1b\\safe\x1b]8;;\x1b\\", 0, 0)
			.render(80)
			.join("");
		assert.doesNotMatch(forged, /attacker/);
		assert.match(forged, /safe/);
	});

	it("drops an unterminated or incomplete sequence, including its ESC", () => {
		assert.strictEqual(sanitizeTerminalText("ok\x1b["), "ok");
		assert.strictEqual(sanitizeTerminalText("ok\x1b]52;c;c2VjcmV0"), "ok52;c;c2VjcmV0");
		assert.strictEqual(sanitizeTerminalText("a\x1bPq#0;2"), "a");
		assert.strictEqual(sanitizeTerminalText("\x1b[31mred\x1b[0m"), "\x1b[31mred\x1b[0m");
	});

	it("sanitizes in linear time on many unterminated sequences", () => {
		for (const opener of ["\x1bP", "\x1b]", "\x1b_"]) {
			const text = `${opener}x`.repeat(50_000);
			const started = performance.now();
			sanitizeTerminalText(text);
			// A quadratic scan of this input takes seconds; a linear one a few milliseconds.
			assert.ok(performance.now() - started < 500, `${JSON.stringify(opener)} took too long`);
		}
	});
});
