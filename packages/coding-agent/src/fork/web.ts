/**
 * Web search through a configured provider; page reading via Exa or direct fetch.
 *
 * Two tools: `web_search` (search the web) and `web_fetch` (read a URL).
 * Descriptions are deliberately terse — every tool definition is sent to the
 * model on every request.
 *
 * `web_fetch` tries Exa first, then falls back to fetching the URL directly for
 * anything Exa cannot reach. Exa is a crawler over a public index: private
 * hosts, localhost, and sites that block crawlers come back as
 * `UNSUPPORTED_URL` / `CRAWL_NOT_FOUND` with an empty result set. Exa reports
 * that in a `statuses` array, which is surfaced here rather than swallowed —
 * silently returning nothing is worse than returning the reason.
 *
 * Keys: EXA_API_KEY / BRAVE_API_KEY / TAVILY_API_KEY / FIRECRAWL_API_KEY take precedence over auth.json
 * entries exa / brave / tavily / firecrawl, saved by `/web-key [provider]`. SearXNG uses a global base URL.
 *
 * With no key, `web_search` goes through Exa's public MCP endpoint, which needs no key but is
 * rate limited, and `web_fetch` works in direct mode.
 *
 * fork: copy of fork/reference/extensions/web.ts, shipped as the built-in extension
 * `builtin:web`. Changes from the reference: the key is stored in auth.json like provider keys
 * instead of ~/.pi/agent/exa.json, and `/web-key` saves or removes it.
 *
 * fork: `web_search` works without a key, like oh-my-pi: JSON-RPC `tools/call` of
 * `web_search_exa` on https://mcp.exa.ai/mcp, whose text results are parsed back into results.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";
import { AuthStorage } from "../core/auth-storage.ts";
import type { ExtensionAPI } from "../core/extensions/types.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { CompactionThresholdError } from "./compaction-threshold.ts";
import { errorExcerpt, readLimited, readLimitedJson, SEARCH_MAX_BYTES } from "./http-body-limit.ts";
import { fill, t } from "./i18n/index.ts";
import { hasNativeMenus } from "./interactive-client.ts";
import { DnsGuard, DnsRebindingError, PinnedLookup, UncheckedAddressError } from "./sandbox/dns-guard.ts";
import { parseUrlList, type ToolNetworkGate, toolNetworkGate, webFetchUrls } from "./sandbox/tool-network.ts";
import { chooseWebSearchKey } from "./web-key-native.ts";
import {
	isWebSearchProvider,
	redactWebSecrets,
	resolveWebSearchKey,
	validateWebSearchUrl,
	WEB_SEARCH_KEY_ENV,
	WEB_SEARCH_NAMES,
} from "./web-search-config.ts";
import { parseSearchResults, SEARCH_ENDPOINTS, searchProvider, type WebSearchResult } from "./web-search-providers.ts";

export { parseUrlList };

const EXA_ENDPOINT = "https://api.exa.ai";
/** Exa's public MCP server: search without an API key, rate limited. */
const EXA_PUBLIC_ENDPOINT = "https://mcp.exa.ai/mcp";
const DEFAULT_RESULTS = 5;
const SEARCH_CHARS = 1200;
const FETCH_CHARS = 20000;
const DIRECT_TIMEOUT_MS = 20000;
const DIRECT_MAX_BYTES = 2 * 1024 * 1024;
/** Redirects a direct fetch follows, each one checked like the first URL. */
const MAX_REDIRECTS = 10;
const USER_AGENT =
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

type ExaResult = WebSearchResult;
type ExaStatus = { id?: string; status?: string; error?: { tag?: string; httpStatusCode?: number } };
type ExaResponse = { results?: ExaResult[]; statuses?: ExaStatus[] };
type SearchDetails = { count: number; urls?: (string | undefined)[] };
type FetchDetails = { fetched?: number; failed?: number; failures?: string[]; urls?: string[] };

async function exa(path: string, body: unknown, apiKey: string, signal?: AbortSignal): Promise<ExaResponse> {
	try {
		const response = await fetch(`${EXA_ENDPOINT}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-api-key": apiKey },
			body: JSON.stringify(body),
			signal,
			// fork: only the endpoint was checked, so a redirect is not followed.
			redirect: "error",
		});
		// fork: the body is read up to a limit, an error's only as an excerpt.
		if (!response.ok) throw new Error(`HTTP ${response.status} ${await errorExcerpt(response)}`);
		return (await readLimitedJson(response, SEARCH_MAX_BYTES)) as ExaResponse;
	} catch (error) {
		const detail = redactWebSecrets(error instanceof Error ? error.message : String(error), [apiKey]);
		throw new Error(`Exa ${path} failed: ${detail.slice(0, 200)}`);
	}
}

type JsonRpcMessage = {
	id?: unknown;
	result?: { content?: { type?: string; text?: string }[]; isError?: boolean };
	error?: { message?: string };
};

/** Body of a JSON-RPC response sent either as plain JSON or as server-sent events. */
export function readJsonRpc(body: string, id: string): JsonRpcMessage | undefined {
	const payloads = /^\s*[{[]/.test(body)
		? [body]
		: body
				.split("\n")
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trim());
	for (const payload of payloads) {
		try {
			const message = JSON.parse(payload) as JsonRpcMessage;
			if (message.id === id || message.result || message.error) return message;
		} catch {}
	}
	return undefined;
}

/** Parse the public endpoint's text results: blocks of `Title:`, `URL:`, `Published:`, `Author:`, then text. */
export function parsePublicResults(text: string): ExaResult[] {
	const results: ExaResult[] = [];
	// Blocks start at lines beginning with "Title:". Grouping lines keeps this linear; splitting on
	// /\n+(?=Title:)/ was quadratic on long runs of newlines.
	const blocks: string[][] = [];
	for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
		if (line.startsWith("Title:")) blocks.push([line]);
		else blocks.at(-1)?.push(line);
	}
	for (const block of blocks.map((lines) => lines.join("\n"))) {
		const field = (label: string) => {
			const value = new RegExp(`^${label}:[ \\t]*(.*)$`, "m").exec(block)?.[1]?.trim();
			return value && value !== "N/A" ? value : undefined;
		};
		const body = /^(?:Highlights|Text):[ \t]*\n?([\s\S]*)$/m.exec(block)?.[1]?.trim();
		results.push({
			title: field("Title"),
			url: field("URL"),
			publishedDate: field("Published(?: Date)?"),
			author: field("Author"),
			text: body,
		});
	}
	return results.filter((result) => result.url);
}

/** Search through Exa's public MCP endpoint, without an API key. */
async function exaPublicSearch(query: string, numResults: number, signal?: AbortSignal): Promise<ExaResult[]> {
	const id = Math.random().toString(36).slice(2);
	const response = await fetch(`${EXA_PUBLIC_ENDPOINT}?tools=web_search_exa`, {
		// fork: only the endpoint was checked, so a redirect is not followed.
		redirect: "error",
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id,
			method: "tools/call",
			params: { name: "web_search_exa", arguments: { query, numResults } },
		}),
		signal,
	});
	if (response.status === 429) {
		throw new Error(
			"Exa public search rate limit reached (HTTP 429). Save an Exa API key with /web-key for higher limits.",
		);
	}
	// fork: the body is read up to a limit, an error's only as an excerpt.
	if (!response.ok)
		throw new Error(`Exa public search failed: ${response.status} ${(await errorExcerpt(response)).slice(0, 200)}`);
	const body = new TextDecoder().decode(await readLimited(response, SEARCH_MAX_BYTES));
	const message = readJsonRpc(body, id);
	if (!message) throw new Error("Exa public search returned an unexpected response.");
	if (message.error) throw new Error(`Exa public search failed: ${message.error.message ?? "unknown error"}`);
	const text = (message.result?.content ?? [])
		.map((part) => part.text ?? "")
		.join("\n\n")
		.trim();
	if (message.result?.isError) throw new Error(`Exa public search failed: ${text.slice(0, 200)}`);
	return parsePublicResults(text);
}

function clip(text: string | undefined, max: number): string {
	if (!text) return "";
	const trimmed = text.trim();
	return trimmed.length > max ? `${trimmed.slice(0, max)}\n[...truncated]` : trimmed;
}

const ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	"#39": "'",
	"#x27": "'",
};

/** Lowercases ASCII only, so indexes stay aligned with the original (toLowerCase can change lengths). */
function asciiLower(text: string): string {
	return text.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
}

const SKIPPED_ELEMENTS = new Set(["script", "style", "noscript", "svg", "head"]);
const LINE_END_TAGS = /^\/(p|div|section|article|li|tr|h[1-6])$/i;

/** Text replacing one tag: line breaks for block ends, bullets and headings, a space otherwise. */
function tagText(tag: string): string {
	if (LINE_END_TAGS.test(tag) || /^(br|hr)\s*\/?$/i.test(tag)) return "\n";
	if (/^li\b/i.test(tag)) return "- ";
	const heading = /^h([1-6])\b/i.exec(tag);
	return heading ? `\n${"#".repeat(Number(heading[1]))} ` : " ";
}

/**
 * Minimal HTML -> text. Good enough for a fallback; no dependency worth adding.
 * One left-to-right pass with indexOf: web pages are untrusted, and the earlier
 * regex chain was quadratic on unclosed tags (2 MiB of "<" blocked the event loop
 * for minutes) and threw on out-of-range character references.
 */
export function htmlToText(html: string): string {
	const lower = asciiLower(html);
	const unclosed = new Set<string>();
	let out = "";
	let index = 0;
	while (index < html.length) {
		const open = html.indexOf("<", index);
		if (open === -1) break;
		out += html.slice(index, open);
		if (html.startsWith("<!--", open)) {
			// An unclosed comment runs to the end of the page, as in browsers.
			const end = html.indexOf("-->", open + 4);
			out += " ";
			index = end === -1 ? html.length : end + 3;
			continue;
		}
		const close = html.indexOf(">", open + 1);
		if (close === -1) break;
		if (close === open + 1) {
			out += "<";
			index = open + 1;
			continue;
		}
		const tag = html.slice(open + 1, close);
		const name = /^[a-z][a-z0-9]*(?!\w)/i.exec(tag)?.[0].toLowerCase();
		if (name && SKIPPED_ELEMENTS.has(name) && !unclosed.has(name)) {
			const end = lower.indexOf(`</${name}>`, close + 1);
			if (end !== -1) {
				out += " ";
				index = end + name.length + 3;
				continue;
			}
			// No closing tag later in the page: drop the tag, keep its text, never search again.
			unclosed.add(name);
		}
		out += tagText(tag);
		index = close + 1;
	}
	out += html.slice(index);
	return out
		.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, name: string) => {
			const key = name.toLowerCase();
			if (ENTITIES[key]) return ENTITIES[key];
			const numeric = /^#x/i.test(name)
				? Number.parseInt(name.slice(2), 16)
				: /^#/.test(name)
					? Number.parseInt(name.slice(1), 10)
					: Number.NaN;
			return Number.isFinite(numeric) && numeric <= 0x10ffff ? String.fromCodePoint(numeric) : match;
		})
		.replace(/[ \t]+/g, " ")
		.replace(/\n\s*\n\s*\n+/g, "\n\n")
		.trim();
}

/** Page title, found with indexOf for the same reason as htmlToText. */
export function htmlTitle(html: string): string | undefined {
	const lower = asciiLower(html);
	let start = lower.indexOf("<title");
	while (start !== -1) {
		if (!/[\w-]/.test(lower[start + 6] ?? "")) {
			const close = lower.indexOf(">", start + 6);
			const end = close === -1 ? -1 : lower.indexOf("</title>", close + 1);
			return end === -1 ? undefined : html.slice(close + 1, end).trim();
		}
		start = lower.indexOf("<title", start + 6);
	}
	return undefined;
}

type Fetched = { url: string; title?: string; text: string; source: string };

/** Fetch a URL ourselves — reaches private hosts and crawler-blocked sites Exa cannot. */
export async function directFetch(
	url: string,
	signal?: AbortSignal,
	dnsGuard = new DnsGuard(),
	gate?: ToolNetworkGate,
): Promise<Fetched> {
	// fork: an "abort" listener added to a signal already aborted never runs.
	signal?.throwIfAborted();
	const controller = new AbortController();
	// fork: each hop connects to the addresses its check resolved, not to a new answer.
	const pins = new PinnedLookup(dnsGuard);
	// fork: the lookup hook also checks redirect destinations, preserving Host and TLS SNI. The user's
	// HTTP(S)_PROXY still applies, as with the global dispatcher; through a proxy, the proxy resolves the name.
	const dispatcher = new EnvHttpProxyAgent({ connect: { lookup: pins.lookup } });
	const timer = setTimeout(() => controller.abort(), DIRECT_TIMEOUT_MS);
	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		// fork (SEC-03): redirects are followed here, so that a new host or port is checked before it is contacted.
		let current = new URL(url);
		let response: Awaited<ReturnType<typeof undiciFetch>>;
		for (let hops = 0; ; hops++) {
			const refused = await gate?.destination(current, pins.resolve);
			if (refused) throw new Error(hops === 0 ? refused : `redirected to ${current.href}: ${refused}`);
			response = await undiciFetch(current.href, {
				headers: { "user-agent": USER_AGENT, accept: "text/html,text/plain,application/json,*/*" },
				redirect: "manual",
				signal: controller.signal,
				dispatcher,
			});
			const location = response.headers.get("location");
			if (response.status < 300 || response.status >= 400 || !location) break;
			await response.body?.cancel().catch(() => {});
			if (hops === MAX_REDIRECTS) throw new Error(`more than ${MAX_REDIRECTS} redirects`);
			current = new URL(location, current);
		}
		const type = response.headers.get("content-type") ?? "";
		const reader = response.body?.getReader();
		const decoder = new TextDecoder();
		let raw = "";
		let received = 0;
		if (reader) {
			try {
				while (received < DIRECT_MAX_BYTES) {
					const { done, value } = await reader.read();
					if (done) break;
					const chunk = value.subarray(0, DIRECT_MAX_BYTES - received);
					received += chunk.byteLength;
					raw += decoder.decode(chunk, { stream: received < DIRECT_MAX_BYTES });
					if (received === DIRECT_MAX_BYTES) {
						void reader.cancel().catch(() => {});
						break;
					}
				}
				raw += decoder.decode();
			} finally {
				reader.releaseLock();
			}
		}
		if (!response.ok) {
			throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
		}
		const isHtml = /html|xml/i.test(type) || /^\s*<(!doctype|html)/i.test(raw);
		const text = isHtml ? htmlToText(raw) : raw.trim();
		const title = isHtml ? htmlTitle(raw) : undefined;
		return { url, title, text, source: `direct (${response.status})` };
	} catch (error) {
		// fork: fetch wraps lookup failures; expose the refusal in the tool's error result.
		if (
			error instanceof Error &&
			(error.cause instanceof DnsRebindingError || error.cause instanceof UncheckedAddressError)
		)
			throw error.cause;
		throw error;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
		await dispatcher.destroy();
	}
}

function describeStatus(status: ExaStatus): string {
	const tag = status.error?.tag ?? status.status ?? "unknown";
	const code = status.error?.httpStatusCode;
	return code ? `${tag} (HTTP ${code})` : tag;
}

function formatResult(result: ExaResult, index: number, chars: number): string {
	const head = `[${index + 1}] ${result.title ?? "(untitled)"}\n${result.url ?? ""}`;
	const meta = [result.author, result.publishedDate].filter(Boolean).join(" · ");
	return [head, meta, clip(result.text, chars)].filter(Boolean).join("\n");
}

export default async function (pi: ExtensionAPI) {
	// fork: pins belong to this extension/session, shared by all web_fetch calls.
	const dnsGuard = new DnsGuard();
	// Global only: a project's settings must not redirect searches to another instance.
	const settings = SettingsManager.create(process.cwd(), undefined, { projectTrusted: false });
	// An invalid compaction threshold is reported elsewhere and does not affect web search.
	const settingsLoadFailed = settings
		.drainErrors()
		.some(({ scope, error }) => scope === "global" && !(error instanceof CompactionThresholdError));
	const provider = settings.getWebSearchProvider();
	const apiKey = (await resolveWebSearchKey("exa")).key;
	const searchKey =
		provider === "exa"
			? apiKey
			: provider === "brave" || provider === "tavily" || provider === "firecrawl"
				? (await resolveWebSearchKey(provider)).key
				: undefined;
	const searchUrl = settings.getWebSearchUrl();
	const secrets = [apiKey, searchKey];

	pi.registerCommand("web-key", {
		description: t(
			"Set the selected web search provider's API key or SearXNG URL. Optional provider: /web-key brave; remove: /web-key brave remove. Exa works without a key.",
		),
		handler: async (args, ctx) => {
			await settings.reload();
			const words = args.trim().split(/\s+/).filter(Boolean);
			const requestedProvider = words.find((word) => word !== "remove");
			if (
				(requestedProvider && !isWebSearchProvider(requestedProvider)) ||
				words.length > 2 ||
				words.filter((word) => word !== "remove").length > 1 ||
				words.filter((word) => word === "remove").length > 1
			) {
				ctx.ui.notify(t("Usage: /web-key [exa|brave|tavily|firecrawl|searxng] [remove]"), "error");
				return;
			}
			// without arguments, the Prism window picks the provider and collects the key or URL;
			// saving, removing, warning and reloading stay below.
			const askNative = words.length === 0 && hasNativeMenus(ctx);
			const native = askNative
				? await chooseWebSearchKey(ctx, settings.getWebSearchProvider(), settings.getWebSearchUrl())
				: undefined;
			if (askNative && !native) return;
			const selected =
				native?.provider ??
				(requestedProvider && isWebSearchProvider(requestedProvider)
					? requestedProvider
					: settings.getWebSearchProvider());
			if (!selected) {
				ctx.ui.notify(
					t(
						"settings.json has an unsupported webSearchProvider: choose one in /settings > Web search, or name it: /web-key exa",
					),
					"error",
				);
				return;
			}
			const name = WEB_SEARCH_NAMES[selected];
			const remove = native?.remove ?? words.includes("remove");
			if (selected === "searxng") {
				if (remove) settings.setWebSearchUrl(undefined);
				else {
					const value = (
						native?.value ?? (await ctx.ui.input(t("SearXNG instance base URL"), "http://localhost:8080"))
					)?.trim();
					if (!value) return;
					try {
						settings.setWebSearchUrl(validateWebSearchUrl(value));
					} catch (error) {
						ctx.ui.notify(t((error as Error).message), "error");
						return;
					}
				}
				await settings.flush();
				if (settings.drainErrors().some(({ scope }) => scope === "global")) {
					ctx.ui.notify(t("Could not save SearXNG URL in settings.json. Check the file and try again."), "error");
					return;
				}
				ctx.ui.notify(t(remove ? "SearXNG URL removed." : "SearXNG URL saved."), "info");
				await ctx.reload();
				return;
			}
			const storage = AuthStorage.create();
			if (remove) {
				await storage.delete(selected);
				ctx.ui.notify(fill("{0} key removed from auth.json.", name), "info");
			} else {
				const key = (
					native?.value ??
					(await ctx.ui.input(fill("{0} API key (saved in auth.json)", name), fill("{0} key", selected), {
						secret: true,
					}))
				)?.trim();
				if (!key) {
					ctx.ui.notify(t("No key saved."), "info");
					return;
				}
				await storage.modify(selected, async () => ({ type: "api_key", key }));
				ctx.ui.notify(fill("{0} key saved in auth.json.", name), "info");
			}
			const env = WEB_SEARCH_KEY_ENV[selected];
			if (process.env[env]?.trim()) ctx.ui.notify(fill("{0} is set and takes precedence.", env), "warning");
			// Reload so the tools pick up the new key.
			await ctx.reload();
		},
	});

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		// fork: capabilities for the permission gate.
		permissions: ["network"],
		description:
			"Search the web. Returns ranked results with title, URL and an excerpt. Use for current events, docs, and anything outside the local repo.",
		promptSnippet: "Search the web for current information",
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			numResults: Type.Optional(
				Type.Number({ description: `Results to return (default ${DEFAULT_RESULTS}, max 15)` }),
			),
		}),
		async execute(_id, params, signal): Promise<AgentToolResult<SearchDetails>> {
			const numResults = Math.min(Math.max(params.numResults ?? DEFAULT_RESULTS, 1), 15);
			if (settingsLoadFailed) {
				return {
					content: [
						{
							type: "text",
							text: "Global settings.json could not be read or parsed. No web search request was sent. Fix the file, then run /reload.",
						},
					],
					details: { count: 0 },
					isError: true,
				};
			}
			if (!provider) {
				return {
					content: [
						{
							type: "text",
							text: "settings.json has an unsupported webSearchProvider: choose exa, brave, tavily, firecrawl or searxng in /settings > Web search",
						},
					],
					details: { count: 0 },
					isError: true,
				};
			}
			const name = WEB_SEARCH_NAMES[provider];
			if (
				((provider === "brave" || provider === "tavily" || provider === "firecrawl") && !searchKey) ||
				(provider === "searxng" && !searchUrl)
			) {
				return {
					content: [
						{
							type: "text",
							text: `${name} search needs ${provider === "searxng" ? "an instance URL" : "an API key"}: /web-key ${provider}, or choose another provider in /settings > Web search`,
						},
					],
					details: { count: 0 },
					isError: true,
				};
			}
			// fork (SEC-03): the provider the user configured is not asked about, but a host the user blocked stays blocked.
			const endpoint =
				provider === "searxng"
					? searchUrl
					: provider === "exa"
						? apiKey
							? EXA_ENDPOINT
							: EXA_PUBLIC_ENDPOINT
						: SEARCH_ENDPOINTS[provider];
			const gate = toolNetworkGate(pi.events, _id, `web_search ${params.query}`);
			let refused: string | undefined;
			try {
				refused = endpoint ? gate?.provider(new URL(endpoint)) : undefined;
			} catch {
				// An invalid instance URL: the provider call reports it.
			} finally {
				gate?.close();
			}
			if (refused) {
				return { content: [{ type: "text", text: refused }], details: { count: 0 }, isError: true };
			}
			let results: WebSearchResult[];
			try {
				if (provider !== "exa") {
					results = await searchProvider(provider, params.query, numResults, searchKey, searchUrl, signal);
				} else if (apiKey) {
					results = parseSearchResults(
						await exa(
							"/search",
							{
								query: params.query,
								numResults,
								type: "auto",
								contents: { text: { maxCharacters: SEARCH_CHARS } },
							},
							apiKey,
							signal,
						),
						"exa",
					);
				} else {
					results = (await exaPublicSearch(params.query, numResults, signal)).slice(0, numResults);
				}
				results = results.map((result) =>
					Object.fromEntries(
						Object.entries(result).map(([field, value]) => [
							field,
							typeof value === "string" ? redactWebSecrets(value, secrets) : value,
						]),
					),
				);
			} catch (error) {
				const detail = redactWebSecrets(error instanceof Error ? error.message : String(error), secrets);
				throw new Error(`${name} search failed: ${detail.slice(0, 200)}`);
			}
			if (results.length === 0) {
				return {
					content: [{ type: "text", text: `No results for "${redactWebSecrets(params.query, secrets)}".` }],
					details: { count: 0 },
				};
			}
			const text = results.map((r, i) => formatResult(r, i, SEARCH_CHARS)).join("\n\n---\n\n");
			return {
				content: [{ type: "text", text }],
				details: { count: results.length, urls: results.map((r) => r.url) },
			};
		},
	});

	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		permissions: ["network"],
		description:
			"Fetch URLs and return their main text content. Works on public pages and on private/self-hosted hosts.",
		promptSnippet: "Read the contents of a URL",
		parameters: Type.Object({
			urls: Type.Union([Type.Array(Type.String()), Type.String()], {
				description: "URL, or list of URLs (max 5)",
			}),
		}),
		async execute(_id, params, signal): Promise<AgentToolResult<FetchDetails>> {
			const requested = webFetchUrls(params.urls);

			if (requested.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `No usable http(s) URL in: ${JSON.stringify(params.urls).slice(0, 200)}`,
						},
					],
					details: {},
					isError: true,
				};
			}

			const fetched: Fetched[] = [];
			// fork: each failure keeps the URL it is about; it is dropped only when
			// that same URL was delivered, never because a delivered URL is a prefix of its text.
			const failures: Array<{ url?: string; line: string }> = [];
			const delivered = new Set<string>();
			// fork (SEC-03): each requested destination is checked (asked about when the policy asks) before anything
			// is sent to it, or to Exa, which would fetch it in Prism's place.
			const gate = toolNetworkGate(pi.events, _id, `web_fetch ${requested.join(" ")}`);
			try {
				const allowed: string[] = [];
				for (const url of requested) {
					signal?.throwIfAborted();
					const refused = gate && (await gate.destination(new URL(url), (host) => dnsGuard.resolve(host)));
					if (refused) failures.push({ url, line: `${url}: ${refused}` });
					else allowed.push(url);
				}
				let pendingDirect = new Set(allowed);

				// Exa first: it is cached, fast, and already strips boilerplate.
				const exaRefused = gate?.provider(new URL(EXA_ENDPOINT));
				if (apiKey && allowed.length > 0 && !exaRefused) {
					try {
						const data = await exa("/contents", { urls: allowed, text: true }, apiKey, signal);
						pendingDirect = pendingDirectUrls(allowed, data.statuses ?? [], data.results ?? []);
						for (const url of allowed) if (!pendingDirect.has(url)) delivered.add(url);
						for (const result of data.results ?? []) {
							if (!result.url) continue;
							fetched.push({
								url: result.url,
								title: result.title,
								text: result.text ?? "",
								source: "exa",
							});
						}
						// Remember why Exa skipped the rest, in case the fallback also fails.
						for (const status of data.statuses ?? []) {
							if (status.status !== "success" && status.id) {
								failures.push({ url: status.id, line: `${status.id}: exa ${describeStatus(status)}` });
							}
						}
					} catch (error) {
						failures.push({ line: `exa: ${(error as Error).message}` });
					}
				}

				// Anything Exa could not deliver, fetch ourselves.
				for (const url of pendingDirect) {
					// fork: cancelled, the call ends instead of starting the next URL.
					signal?.throwIfAborted();
					try {
						fetched.push(await directFetch(url, signal, dnsGuard, gate));
						delivered.add(url);
					} catch (error) {
						signal?.throwIfAborted();
						failures.push({ url, line: `${url}: direct ${(error as Error).message}` });
					}
				}

				if (fetched.length === 0) {
					const lines = failures.map((failure) => failure.line);
					const reason = lines.length > 0 ? lines.join("\n") : "no content returned";
					return {
						content: [{ type: "text", text: `Could not fetch any URL.\n${reason}` }],
						details: { failures: lines },
						isError: true,
					};
				}

				const perUrl = Math.floor(FETCH_CHARS / fetched.length);
				const body = fetched
					.map(
						(item) => `# ${item.title ?? item.url}\n${item.url}  [${item.source}]\n\n${clip(item.text, perUrl)}`,
					)
					.join("\n\n---\n\n");
				// Only mention failures that were not later rescued by the fallback.
				const unresolved = failures
					.filter((failure) => failure.url === undefined || !delivered.has(failure.url))
					.map((failure) => failure.line);
				const text = unresolved.length > 0 ? `${body}\n\n---\nSkipped:\n${unresolved.join("\n")}` : body;

				return {
					content: [{ type: "text", text }],
					details: { fetched: fetched.length, failed: unresolved.length, urls: fetched.map((f) => f.url) },
				};
			} finally {
				gate?.close();
			}
		},
	});
}

function normalizedUrl(value: string): string {
	try {
		const url = new URL(value);
		// fork: `host` keeps a port other than the scheme's default; two ports are
		// two services.
		return `${url.host.toLowerCase()}${url.pathname.replace(/\/$/, "")}${url.search}${url.hash}`;
	} catch {
		return value;
	}
}

export function pendingDirectUrls(requested: string[], statuses: ExaStatus[], results: ExaResult[]): Set<string> {
	const delivered = new Set(statuses.filter((status) => status.status === "success").map((status) => status.id));
	const pending = new Set(requested);
	for (const result of results) {
		if (!result.url) continue;
		for (const url of requested) {
			if (delivered.has(url) || normalizedUrl(url) === normalizedUrl(result.url)) pending.delete(url);
		}
	}
	return pending;
}
