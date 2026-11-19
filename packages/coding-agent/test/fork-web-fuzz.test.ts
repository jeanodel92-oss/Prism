// fork: fuzz targets for the web tools' parsers of untrusted pages and responses. Replay with PI_FUZZ_SEED.
import { describe, expect, it } from "vitest";
import { htmlTitle, htmlToText, parsePublicResults, parseUrlList, readJsonRpc } from "../src/fork/web.ts";
import { WEB_SEARCH_PROVIDERS } from "../src/fork/web-search-config.ts";
import { parseSearchResults } from "../src/fork/web-search-providers.ts";

function makeRandom(seed: number): () => number {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
		return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
	};
}

/** web_fetch reads at most 2 MiB of a page (DIRECT_MAX_BYTES in web.ts). */
const PAGE_BYTES = 2 * 1024 * 1024;

/** CPU time of `run`: a busy machine stretches wall time, not the work. */
function timed<T>(run: () => T): { value: T; ms: number } {
	const started = process.cpuUsage();
	const value = run();
	const used = process.cpuUsage(started);
	return { value, ms: (used.user + used.system) / 1000 };
}

describe("htmlToText", () => {
	it("keeps the readable structure of an ordinary page", () => {
		const html =
			"<html><head><title>T</title><style>p{}</style></head><body><!-- note --><h2 class=x>Title</h2>" +
			"<p>One &amp; two&nbsp;&#x41;&#66;</p><ul><li>a</li><li class=y>b</li></ul>x<br/>y<script>alert(1)</script>" +
			"<link rel=x>z</body></html>";
		expect(htmlToText(html)).toBe("## Title\n One & two AB\n - a\n- b\n x\ny z");
		expect(htmlTitle(html)).toBe("T");
		expect(htmlTitle("<titles>no</titles><title lang=en>yes</title>")).toBe("yes");
	});

	it("matches the previous regex implementation on well-formed pages", () => {
		// The regex chain htmlToText replaced; only safe on small well-formed input.
		const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
		const previous = (html: string) =>
			html
				.replace(/<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1>/gi, " ")
				.replace(/<!--[\s\S]*?-->/g, " ")
				.replace(/<\/(p|div|section|article|li|tr|h[1-6])>/gi, "\n")
				.replace(/<(br|hr)\s*\/?>/gi, "\n")
				.replace(/<li\b[^>]*>/gi, "- ")
				.replace(/<h([1-6])\b[^>]*>/gi, (_m, level) => `\n${"#".repeat(Number(level))} `)
				.replace(/<[^>]+>/g, " ")
				.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, name: string) => {
					const key = name.toLowerCase();
					if (entities[key]) return entities[key];
					const numeric = /^#x/i.test(name)
						? Number.parseInt(name.slice(2), 16)
						: /^#/.test(name)
							? Number.parseInt(name.slice(1), 10)
							: Number.NaN;
					return Number.isFinite(numeric) ? String.fromCodePoint(numeric) : match;
				})
				.replace(/[ \t]+/g, " ")
				.replace(/\n\s*\n\s*\n+/g, "\n\n")
				.trim();
		const parts = ["<p>", "</p>", "<DIV class=a>", "</div>", "<li>", "</LI>", "<h2>", "</h2>", "<br>", "<hr/>"];
		parts.push("<b>", "</b>", "text", " ", "\n", "&amp;", "&#65;", "<script>x</script>", "<Style>y</sTyle>");
		parts.push("<!-- c -->", "<a href='u'>", "</a>", "<head><title>t</title></head>", "<svg><path/></svg>");
		const random = makeRandom(Number(process.env.PI_FUZZ_SEED ?? 4_211));
		for (let index = 0; index < 3_000; index++) {
			const page = Array.from(
				{ length: 1 + Math.floor(random() * 30) },
				() => parts[Math.floor(random() * parts.length)],
			).join("");
			expect(htmlToText(page), JSON.stringify(page)).toBe(previous(page));
		}
	});

	it("keeps out-of-range character references instead of throwing", () => {
		expect(htmlToText("a &#99999999; b &#x110000; c &#x10FFFF;")).toBe("a &#99999999; b &#x110000; c \u{10ffff}");
	});

	it("keeps indexes aligned when lowercasing changes the length of non-ASCII text", () => {
		expect(htmlToText("İİİ<SCRIPT>x</SCRIPT>after")).toBe("İİİ after");
		expect(htmlTitle("İİİ<TITLE>Hello</TITLE>")).toBe("Hello");
	});

	it("keeps the text of an element whose closing tag never comes", () => {
		expect(htmlToText("<script>visible<style>also")).toBe("visible also");
		expect(htmlToText("a <!-- unclosed comment")).toBe("a");
		expect(htmlToText("a < b > c <> d")).toBe("a c <> d");
	});

	it("stays linear on hostile pages of the full fetch size", () => {
		const hostile = {
			lt: "<".repeat(PAGE_BYTES),
			script: "<script>".repeat(PAGE_BYTES / 8),
			comment: "<!--".repeat(PAGE_BYTES / 4),
			li: "<li".repeat(PAGE_BYTES / 3),
			heading: "<h1".repeat(PAGE_BYTES / 3),
			title: "<title>".repeat(PAGE_BYTES / 7),
			titleNoGt: "<titlex".repeat(PAGE_BYTES / 7),
			entities: "&#".repeat(PAGE_BYTES / 2),
			blankLines: "\n \n ".repeat(PAGE_BYTES / 4),
		};
		for (const [name, page] of Object.entries(hostile)) {
			const text = timed(() => htmlToText(page));
			const title = timed(() => htmlTitle(page));
			expect(text.ms + title.ms, name).toBeLessThan(1_500);
		}
	}, 30_000);
});

it("fuzzes page, search and JSON-RPC parsing with a fixed replayable seed", () => {
	const seed = Number(process.env.PI_FUZZ_SEED ?? 4_211);
	const random = makeRandom(seed);
	const corpus = [
		"<html><head><title>x</title></head>",
		"<script>",
		"</script>",
		"<!--",
		"-->",
		"<li class='a'>",
		"<h3>",
		"</p>",
		"<br />",
		"&#99999999;",
		"&#x1F600;",
		"&amp;&lt;&bogus;",
		"<",
		">",
		"İ",
		"\u0000‮​",
		"Title: Result\nURL: https://example.test\nPublished: 2026-01-01\nAuthor: N/A\nText: body\n",
		"Highlights:\n",
		"\n\n\n",
		'data: {"jsonrpc":"2.0","id":"q","result":{"content":[{"type":"text","text":"Title: a"}]}}\n',
		'{"id":"q","error":{"message":"bad"}}',
		'["https://a.test", 1, null]',
		"[broken",
	];
	const fragment = () => {
		const source = corpus[Math.floor(random() * corpus.length)]!;
		const start = Math.floor(random() * (source.length + 1));
		return random() < 0.6 ? source : source.slice(start, start + Math.floor(random() * (source.length + 1)));
	};
	const jsonShapes: unknown[] = [
		null,
		42,
		"text",
		[],
		{ results: "nope" },
		{ results: [null, 1, { url: 5 }, { url: "https://a.test", title: ["x"], content: {} }] },
		{ web: { results: [{ url: "https://b.test", description: "d", page_age: 1 }] } },
		{ data: { web: [{ url: "https://c.test", description: "d" }, "x"] } },
	];
	for (let index = 0; index < 1_500; index++) {
		const label = `seed=${seed} case=${index}`;
		const input = Array.from({ length: 1 + Math.floor(random() * 8) }, fragment).join(random() < 0.5 ? "\n" : "");
		const { value: text, ms } = timed(() => htmlToText(input));
		expect(typeof text, label).toBe("string");
		expect(ms, label).toBeLessThan(200);
		expect(() => htmlTitle(input), label).not.toThrow();
		for (const result of parsePublicResults(input)) expect(typeof result.url, label).toBe("string");
		expect(() => readJsonRpc(input, "q"), label).not.toThrow();
		expect(Array.isArray(parseUrlList(input)), label).toBe(true);
		const shape = jsonShapes[Math.floor(random() * jsonShapes.length)];
		for (const provider of WEB_SEARCH_PROVIDERS) {
			for (const result of parseSearchResults(shape, provider)) {
				expect(typeof result.url, label).toBe("string");
				for (const field of [result.title, result.text, result.author, result.publishedDate]) {
					expect(field === undefined || typeof field === "string", label).toBe(true);
				}
			}
		}
	}
});

it("parses public search results linearly on hostile responses", () => {
	for (const response of [
		"\n".repeat(PAGE_BYTES),
		`Title:${"\nTitle:".repeat(PAGE_BYTES / 7)}`,
		"Text:\n".repeat(PAGE_BYTES / 6),
	]) {
		expect(timed(() => parsePublicResults(response)).ms).toBeLessThan(1_500);
	}
}, 30_000);
