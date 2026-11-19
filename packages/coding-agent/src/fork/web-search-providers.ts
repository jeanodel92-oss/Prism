// fork: keyed Brave/Tavily/Firecrawl search and keyless search on a user's SearXNG instance.
import { errorExcerpt, readLimitedJson, SEARCH_MAX_BYTES } from "./http-body-limit.ts";
import { validateWebSearchUrl, type WebSearchProvider } from "./web-search-config.ts";

export type WebSearchResult = { title?: string; url?: string; publishedDate?: string; author?: string; text?: string };

function object(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

/** Treat response fields as untrusted: absent or malformed fields are omitted. */
export function parseSearchResults(data: unknown, provider: WebSearchProvider): WebSearchResult[] {
	const root = object(data);
	const rows =
		provider === "brave" ? object(root.web).results : provider === "firecrawl" ? object(root.data).web : root.results;
	if (!Array.isArray(rows)) return [];
	return rows.flatMap((row) => {
		const fields = object(row);
		const textField =
			provider === "brave" || provider === "firecrawl" ? "description" : provider === "exa" ? "text" : "content";
		const dateField = provider === "brave" ? "page_age" : provider === "tavily" ? "published_date" : "publishedDate";
		const string = (name: string) => (typeof fields[name] === "string" ? fields[name] : undefined);
		const url = string("url");
		return url
			? [
					{
						title: string("title"),
						url,
						text: string(textField),
						publishedDate: provider === "firecrawl" ? undefined : string(dateField),
						author: string("author"),
					},
				]
			: [];
	});
}

/** fork (SEC-03): where each keyed provider receives the query, checked against the user's blocked hosts. */
export const SEARCH_ENDPOINTS = {
	brave: "https://api.search.brave.com/res/v1/web/search",
	tavily: "https://api.tavily.com/search",
	firecrawl: "https://api.firecrawl.dev/v2/search",
} as const;

export async function searchProvider(
	provider: Exclude<WebSearchProvider, "exa">,
	query: string,
	numResults: number,
	key: string | undefined,
	baseUrl: string | undefined,
	signal?: AbortSignal,
): Promise<WebSearchResult[]> {
	let url: URL;
	let init: RequestInit;
	if (provider === "brave") {
		url = new URL(SEARCH_ENDPOINTS.brave);
		url.searchParams.set("q", query);
		url.searchParams.set("count", String(numResults));
		init = { method: "GET", headers: { "X-Subscription-Token": key!, accept: "application/json" }, signal };
	} else if (provider === "tavily") {
		url = new URL(SEARCH_ENDPOINTS.tavily);
		init = {
			method: "POST",
			headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
			body: JSON.stringify({ query, max_results: numResults, include_published_date: true }),
			signal,
		};
	} else if (provider === "firecrawl") {
		if (query.length > 500) throw new Error("Firecrawl search queries must be 500 characters or fewer.");
		url = new URL(SEARCH_ENDPOINTS.firecrawl);
		init = {
			method: "POST",
			headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
			body: JSON.stringify({ query, limit: Math.floor(numResults), sources: ["web"] }),
			signal,
		};
	} else {
		url = new URL(`${validateWebSearchUrl(baseUrl!)}/search`);
		url.searchParams.set("q", query);
		url.searchParams.set("format", "json");
		init = { method: "GET", headers: { accept: "application/json" }, signal };
	}
	// fork: only the endpoint was checked, so a redirect is not followed.
	const response = await fetch(url.toString(), { ...init, redirect: "manual" });
	if (response.status >= 300 && response.status < 400) {
		await response.body?.cancel().catch(() => {});
		const location = response.headers.get("location");
		throw new Error(
			`the search endpoint redirects${location ? ` to ${new URL(location, url).origin}` : ""}; redirects are not followed: configure the final address`,
		);
	}
	// fork: the body is read up to a limit, an error's only as an excerpt.
	if (!response.ok) throw new Error(`HTTP ${response.status} ${await errorExcerpt(response)}`);
	const data = object(await readLimitedJson(response, SEARCH_MAX_BYTES));
	if (provider === "firecrawl" && data.success === false) {
		throw new Error(`success: false ${typeof data.error === "string" ? data.error : "unknown error"}`);
	}
	return parseSearchResults(data, provider).slice(0, numResults);
}
