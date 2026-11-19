// fork: shared provider names and credential resolution for web tools and /settings.
import { AuthStorage } from "../core/auth-storage.ts";

export const WEB_SEARCH_PROVIDERS = ["exa", "brave", "tavily", "firecrawl", "searxng"] as const;
export type WebSearchProvider = (typeof WEB_SEARCH_PROVIDERS)[number];
export type WebSearchKeyProvider = Exclude<WebSearchProvider, "searxng">;

export const WEB_SEARCH_NAMES: Record<WebSearchProvider, string> = {
	exa: "Exa",
	brave: "Brave",
	tavily: "Tavily",
	firecrawl: "Firecrawl",
	searxng: "SearXNG",
};
export const WEB_SEARCH_KEY_ENV: Record<WebSearchKeyProvider, string> = {
	exa: "EXA_API_KEY",
	brave: "BRAVE_API_KEY",
	tavily: "TAVILY_API_KEY",
	firecrawl: "FIRECRAWL_API_KEY",
};

export function isWebSearchProvider(value: unknown): value is WebSearchProvider {
	return WEB_SEARCH_PROVIDERS.some((provider) => provider === value);
}

export async function resolveWebSearchKey(
	provider: WebSearchKeyProvider,
): Promise<{ key?: string; source: "env" | "auth" | "none" }> {
	const key = process.env[WEB_SEARCH_KEY_ENV[provider]]?.trim();
	if (key) return { key, source: "env" };
	try {
		const credential = await AuthStorage.create().read(provider);
		const saved = credential?.type === "api_key" ? credential.key?.trim() : undefined;
		if (saved) return { key: saved, source: "auth" };
	} catch {}
	return { source: "none" };
}

export function validateWebSearchUrl(value: string): string {
	try {
		const url = new URL(value.trim());
		if (
			(url.protocol === "http:" || url.protocol === "https:") &&
			!url.username &&
			!url.password &&
			!/[?#]/.test(value)
		) {
			return url.toString().replace(/\/+$/, "");
		}
	} catch {}
	throw new Error("SearXNG needs an http(s) base URL without credentials, a query or a fragment: /web-key searxng.");
}

/** Redact before truncation, including keys echoed in URLs or JSON error bodies. */
export function redactWebSecrets(text: string, keys: readonly (string | undefined)[]): string {
	for (const key of keys) {
		if (!key) continue;
		for (const value of new Set([key, JSON.stringify(key).slice(1, -1)])) {
			text = text.split(value).join("[redacted]");
		}
		for (const value of new Set([encodeURIComponent(key), encodeURI(key)])) {
			const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			text = text.replace(new RegExp(escaped, "gi"), "[redacted]");
		}
	}
	return text;
}
