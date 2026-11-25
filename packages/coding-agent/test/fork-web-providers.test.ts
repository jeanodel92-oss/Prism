// fork: provider requests, isolated configuration, and secrets kept out of tool results.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { type Component, Container, type SettingItem, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME, ENV_AGENT_DIR } from "../src/config.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createSettingsDomainExtras } from "../src/fork/settings-domain-extras.ts";
import { groupSettingsByDomain, type SettingsModel } from "../src/fork/settings-domains.ts";
import { SettingsView } from "../src/fork/settings-view.ts";
import webExtension from "../src/fork/web.ts";
import {
	WEB_SEARCH_KEY_ENV,
	WEB_SEARCH_NAMES,
	WEB_SEARCH_PROVIDERS,
	type WebSearchProvider,
} from "../src/fork/web-search-config.ts";
import { parseSearchResults } from "../src/fork/web-search-providers.ts";
import type { SettingsSelectorComponent } from "../src/modes/interactive/components/settings-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, createTestUiContext, getMessageText, getToolResult, type Harness } from "./suite/harness.ts";

// fork: keep transport mocked now that directFetch uses undici's matching dispatcher API.
vi.mock("undici", async (original) => ({
	...(await original<Record<string, unknown>>()),
	fetch: (url: string, options: RequestInit) => fetch(url, options),
}));

const KEY = "fc-test-web-secret+/=token";

/** The web search settings of the Network & web domain. */
const webSearchItems = (model: SettingsModel) =>
	model
		.domains()
		.find((d) => d.id === "network")!
		.items()
		.filter((item) => item.id.startsWith("web-search-"));

function open(item: SettingItem): SettingItem[] {
	const component = item.submenu!(item.currentValue, () => {}) as unknown as {
		settingsList: { items: SettingItem[] };
	};
	return component.settingsList.items;
}

describe("fork: web search providers", () => {
	let dir: string;
	let settings: SettingsManager;
	const harnesses: Harness[] = [];
	const fetchMock = vi.fn<typeof fetch>();

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "prism-web-providers-"));
		vi.stubEnv(ENV_AGENT_DIR, dir);
		for (const env of Object.values(WEB_SEARCH_KEY_ENV)) vi.stubEnv(env, "");
		vi.stubGlobal("fetch", fetchMock);
		fetchMock.mockReset();
		settings = SettingsManager.create(dir, dir);
		initTheme("dark");
	});

	afterEach(async () => {
		await settings.flush();
		for (const harness of harnesses.splice(0)) harness.cleanup();
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		rmSync(dir, { recursive: true, force: true });
	});

	async function start(provider?: WebSearchProvider, ui: Partial<ExtensionUIContext> = {}) {
		if (provider) settings.setWebSearchProvider(provider);
		await settings.flush();
		const harness = await createHarness({ extensionFactories: [{ name: "web", factory: webExtension }] });
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext(ui) });
		return harness;
	}

	function search(harness: Harness, query = "prism & local", numResults = 2, signal?: AbortSignal) {
		const runner = harness.session.extensionRunner;
		return runner
			.getToolDefinition("web_search")!
			.execute("search", { query, numResults }, signal, undefined, runner.createToolContext("search", signal));
	}

	function publicResponse(_input: string | URL | Request, init?: RequestInit) {
		const request = JSON.parse(String(init?.body)) as { id: string };
		return Response.json({
			id: request.id,
			result: {
				content: [
					{ type: "text", text: "Title: Public page\nURL: https://public.example/\nHighlights:\nkeyless result" },
				],
			},
		});
	}

	it("defaults to Exa's public endpoint without a key", async () => {
		fetchMock.mockImplementation(async (input, init) => publicResponse(input, init));
		const result = await search(await start());
		expect(getMessageText(result)).toContain("[1] Public page\nhttps://public.example/\nkeyless result");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe("https://mcp.exa.ai/mcp?tools=web_search_exa");
		expect(JSON.parse(String(init?.body)).params.arguments).toEqual({ query: "prism & local", numResults: 2 });
		expect(new Headers(init?.headers).has("x-api-key")).toBe(false);
	});

	it.each(["brave", "tavily"] as const)("uses %s's endpoint, auth header and result fields", async (provider) => {
		vi.stubEnv(WEB_SEARCH_KEY_ENV[provider], `  ${KEY}  `);
		fetchMock.mockResolvedValue(
			Response.json(
				provider === "brave"
					? {
							web: {
								results: [
									{
										title: "Brave page",
										url: "https://result.example/",
										description: "Brave excerpt",
										page_age: "2026-10-01",
									},
								],
							},
						}
					: {
							results: [
								{
									title: "Tavily page",
									url: "https://result.example/",
									content: "Tavily excerpt",
									published_date: "2026-10-02",
								},
							],
						},
			),
		);
		const controller = new AbortController();
		const result = await search(await start(provider), "prism & local", 2, controller.signal);
		expect(getMessageText(result)).toContain(
			provider === "brave"
				? "Brave page\nhttps://result.example/\n2026-10-01\nBrave excerpt"
				: "Tavily page\nhttps://result.example/\n2026-10-02\nTavily excerpt",
		);
		expect(result.details).toEqual({ count: 1, urls: ["https://result.example/"] });
		const [rawUrl, init] = fetchMock.mock.calls[0]!;
		const url = new URL(String(rawUrl));
		expect(init?.signal).toBe(controller.signal);
		if (provider === "brave") {
			expect(`${url.origin}${url.pathname}`).toBe("https://api.search.brave.com/res/v1/web/search");
			expect(url.searchParams.get("q")).toBe("prism & local");
			expect(url.searchParams.get("count")).toBe("2");
			expect(init?.method).toBe("GET");
			expect(new Headers(init?.headers).get("X-Subscription-Token")).toBe(KEY);
		} else {
			expect(rawUrl).toBe("https://api.tavily.com/search");
			expect(init?.method).toBe("POST");
			expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${KEY}`);
			expect(JSON.parse(String(init?.body))).toEqual({
				query: "prism & local",
				max_results: 2,
				include_published_date: true,
			});
		}
		expect(String(rawUrl)).not.toContain(KEY);
		expect(JSON.stringify(result)).not.toContain(KEY);
	});

	it.each([
		[2, 2],
		[0, 1],
		[100, 15],
		[2.9, 2],
	])("searches Firecrawl with requested count %s clamped to %s", async (numResults, limit) => {
		vi.stubEnv("FIRECRAWL_API_KEY", ` ${KEY} `);
		const rows = Array.from({ length: 16 }, (_, index) => ({
			title: `Firecrawl page ${index + 1}`,
			url: `https://result.example/${index + 1}`,
			description: "Firecrawl excerpt",
			publishedDate: "invented date",
			metadata: { published_date: "invented date" },
			markdown: "Scraped content",
		}));
		fetchMock.mockResolvedValue(
			Response.json({
				success: true,
				data: { web: rows, images: [{ url: "https://image.example/" }] },
				results: [{ url: "https://wrong.example/" }],
				warning: null,
				creditsUsed: 1,
			}),
		);
		const controller = new AbortController();
		const result = await search(await start("firecrawl"), "prism & local", numResults, controller.signal);
		expect(getMessageText(result)).toContain("Firecrawl page 1\nhttps://result.example/1\nFirecrawl excerpt");
		expect(getMessageText(result)).not.toContain("invented date");
		expect(getMessageText(result)).not.toContain("Scraped content");
		expect(result.details).toEqual({ count: limit, urls: rows.slice(0, limit).map((row) => row.url) });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe("https://api.firecrawl.dev/v2/search");
		expect(init?.method).toBe("POST");
		expect(Object.fromEntries(new Headers(init?.headers))).toEqual({
			authorization: `Bearer ${KEY}`,
			"content-type": "application/json",
		});
		expect(JSON.parse(String(init?.body))).toEqual({ query: "prism & local", limit, sources: ["web"] });
		expect(init?.signal).toBe(controller.signal);
		expect(JSON.stringify(result)).not.toContain(KEY);
	});

	it.each([`Request failed for ${KEY}`, undefined, 123])(
		"treats Firecrawl success: false as an error, including malformed error fields (%s)",
		async (error) => {
			vi.stubEnv("FIRECRAWL_API_KEY", KEY);
			fetchMock.mockResolvedValue(
				Response.json({ success: false, error, data: { web: [{ url: "https://ignored.example/" }] } }),
			);
			const failure = await search(await start("firecrawl")).catch((error: unknown) => error);
			expect(failure).toBeInstanceOf(Error);
			expect((failure as Error).message).toContain("Firecrawl search failed: success: false");
			expect((failure as Error).message).toContain(typeof error === "string" ? "[redacted]" : "unknown error");
			expect((failure as Error).stack).not.toContain(KEY);
		},
	);

	it.each([401, 402, 408, 429, 500])("reports Firecrawl HTTP %s with a short redacted body", async (status) => {
		vi.stubEnv("FIRECRAWL_API_KEY", KEY);
		fetchMock.mockResolvedValue(
			Response.json(
				{ success: false, code: "SEARCH_FAILED", error: `Request failed ${KEY} ${"x".repeat(600)}` },
				{ status },
			),
		);
		const failure = await search(await start("firecrawl")).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toContain(`Firecrawl search failed: HTTP ${status}`);
		expect((failure as Error).message).toContain("[redacted]");
		expect((failure as Error).message.length).toBeLessThan(250);
		expect((failure as Error).stack).not.toContain(KEY);
	});

	it("rejects a Firecrawl query over 500 characters before sending a request", async () => {
		vi.stubEnv("FIRECRAWL_API_KEY", KEY);
		const harness = await start("firecrawl");
		await expect(search(harness, "q".repeat(501))).rejects.toThrow("500 characters or fewer");
		expect(fetchMock).not.toHaveBeenCalled();
		fetchMock.mockResolvedValue(Response.json({ success: true, data: { web: [] } }));
		await search(harness, "q".repeat(500));
		expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)).query).toHaveLength(500);
	});

	it("keeps Firecrawl keys out of empty results and model-visible errors", async () => {
		vi.stubEnv("FIRECRAWL_API_KEY", KEY);
		const harness = await start("firecrawl");
		fetchMock.mockResolvedValue(Response.json({ success: true, data: { web: [] } }));
		const empty = await search(harness, KEY);
		expect(getMessageText(empty)).toContain('No results for "[redacted]"');
		fetchMock.mockResolvedValue(
			Response.json({ success: false, error: `Request failed ${KEY} ${encodeURIComponent(KEY)}` }),
		);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("web_search", { query: "prism" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("search");
		const result = getToolResult(harness, "web_search");
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).toContain("Firecrawl search failed: success: false");
		expect(getMessageText(result)).toContain("[redacted]");
		expect(JSON.stringify(harness.session.messages)).not.toContain(KEY);
		expect(JSON.stringify(harness.session.messages)).not.toContain(encodeURIComponent(KEY));
	});

	it.each(["http://localhost:8080", "https://search.example/searx/"])(
		"searches the SearXNG base URL %s without a key",
		async (base) => {
			settings.setWebSearchUrl(base);
			fetchMock.mockResolvedValue(
				Response.json({
					results: [
						{
							title: "Own instance",
							url: "https://result.example/",
							content: "Local excerpt",
							publishedDate: "2026-10-03",
						},
						{ url: "https://second.example/" },
						{ url: "https://third.example/" },
					],
				}),
			);
			const result = await search(await start("searxng"));
			expect(getMessageText(result)).toContain("Own instance\nhttps://result.example/\n2026-10-03\nLocal excerpt");
			expect(getMessageText(result)).toContain("[2] (untitled)");
			expect(result.details).toEqual({ count: 2, urls: ["https://result.example/", "https://second.example/"] });
			const [url, init] = fetchMock.mock.calls[0]!;
			expect(String(url)).toBe(`${base.replace(/\/+$/, "")}/search?q=prism+%26+local&format=json`);
			expect(init?.method).toBe("GET");
			expect(new Headers(init?.headers).has("Authorization")).toBe(false);
		},
	);

	it.each(["brave", "tavily", "firecrawl", "searxng"] as const)(
		"missing %s configuration is actionable, with no network or fallback",
		async (provider) => {
			vi.stubEnv("EXA_API_KEY", "unused-exa-test-key");
			const result = await search(await start(provider));
			expect(result.isError).toBe(true);
			expect(getMessageText(result)).toContain(
				`${WEB_SEARCH_NAMES[provider]} search needs ${provider === "searxng" ? "an instance URL" : "an API key"}`,
			);
			expect(getMessageText(result)).toContain(`/web-key ${provider}`);
			expect(getMessageText(result)).toContain("/settings > Web search");
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it.each([
		"not a URL",
		"ftp://localhost",
		"https://user:password@example.com",
		"https://example.com?token=secret",
		"https://example.com?",
		"https://example.com#",
	])("rejects an invalid SearXNG base URL without a request: %s", async (url) => {
		settings.setWebSearchUrl(url);
		await expect(search(await start("searxng"))).rejects.toThrow("SearXNG needs an http(s) base URL");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each(["exa", "brave", "tavily", "firecrawl"] as const)(
		"%s redacts HTTP error bodies, headers and encoded URLs before truncating",
		async (provider) => {
			vi.stubEnv(WEB_SEARCH_KEY_ENV[provider], KEY);
			fetchMock.mockResolvedValue(
				new Response(
					`Authorization: Bearer ${KEY}; X-Subscription-Token: ${KEY}; https://echo.example/?key=${encodeURIComponent(KEY)} ${"x".repeat(600)}`,
					{ status: 401 },
				),
			);
			const harness = await start(provider);
			const error = await search(harness).catch((error: unknown) => error);
			expect(error).toBeInstanceOf(Error);
			const message = (error as Error).message;
			expect(message).toContain("401");
			expect(message.toLowerCase()).toContain(provider);
			expect(message).toContain("[redacted]");
			expect(message).not.toContain(KEY);
			expect(message).not.toContain(encodeURIComponent(KEY));
			expect(message.length).toBeLessThan(250);
			expect((error as Error).stack).not.toContain(KEY);
		},
	);

	it.each(["exa", "brave", "tavily", "firecrawl"] as const)(
		"%s redacts thrown network errors and successful results",
		async (provider) => {
			vi.stubEnv(WEB_SEARCH_KEY_ENV[provider], KEY);
			fetchMock.mockRejectedValue(
				new Error(`request https://echo.example/?key=${encodeURIComponent(KEY)} header=${KEY}`),
			);
			const harness = await start(provider);
			await expect(search(harness)).rejects.toThrow("[redacted]");
			await search(harness).catch((error: Error) => {
				expect(error.message).not.toContain(KEY);
				expect(error.message).not.toContain(encodeURIComponent(KEY));
			});
			const row = {
				title: KEY,
				url: `https://echo.example/?key=${encodeURIComponent(KEY)}`,
				text: KEY,
				description: KEY,
				content: KEY,
				publishedDate: KEY,
				page_age: KEY,
				published_date: KEY,
			};
			fetchMock.mockResolvedValue(
				Response.json(
					provider === "brave"
						? { web: { results: [row] } }
						: provider === "firecrawl"
							? { success: true, data: { web: [row] } }
							: { results: [row] },
				),
			);
			const result = await search(harness);
			expect(JSON.stringify(result)).not.toContain(KEY);
			expect(JSON.stringify(result)).not.toContain(encodeURIComponent(KEY));
			expect(getMessageText(result)).toContain("[redacted]");
		},
	);

	it.each(["exa", "brave", "tavily", "firecrawl"] as const)(
		"%s uses a saved key and prefers the environment key",
		async (provider) => {
			await AuthStorage.create().modify(provider, async () => ({ type: "api_key", key: "saved-test-web-key" }));
			fetchMock.mockImplementation(async () =>
				Response.json(provider === "firecrawl" ? { success: true, data: { web: [] } } : { results: [] }),
			);
			await search(await start(provider));
			const header =
				provider === "exa" ? "x-api-key" : provider === "brave" ? "X-Subscription-Token" : "Authorization";
			expect(new Headers(fetchMock.mock.calls.at(-1)![1]?.headers).get(header)).toContain("saved-test-web-key");
			vi.stubEnv(WEB_SEARCH_KEY_ENV[provider], KEY);
			await search(await start(provider));
			expect(new Headers(fetchMock.mock.calls.at(-1)![1]?.headers).get(header)).toContain(KEY);
		},
	);

	it.each(["fc-test-web-secret%2b%2f%3dtoken", "fc-test-web-secret%2B%2f%3Dtoken"])(
		"keeps the encoded key %s out of successful results and model errors",
		async (encoded) => {
			vi.stubEnv("BRAVE_API_KEY", KEY);
			const harness = await start("brave");
			fetchMock.mockResolvedValue(
				Response.json({
					web: { results: [{ url: `https://echo.example/${encoded}`, title: encoded, description: encoded }] },
				}),
			);
			const success = await search(harness);
			expect(JSON.stringify(success)).not.toContain(encoded);
			expect(getMessageText(success)).toContain("[redacted]");
			fetchMock.mockResolvedValue(new Response(`X-Subscription-Token: ${KEY}; URL: ${encoded}`, { status: 403 }));
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("web_search", { query: "prism" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("search");
			const result = getToolResult(harness, "web_search");
			expect(result.isError).toBe(true);
			expect(getMessageText(result)).toContain("Brave search failed: HTTP 403");
			expect(JSON.stringify(harness.session.messages)).not.toContain(KEY);
			expect(JSON.stringify(harness.session.messages)).not.toContain(encoded);
		},
	);

	it("redacts a key crossing the error truncation boundary", async () => {
		vi.stubEnv("TAVILY_API_KEY", KEY);
		fetchMock.mockResolvedValue(new Response(`${"x".repeat(180)} ${KEY}`, { status: 500 }));
		const error = await search(await start("tavily")).catch((error: unknown) => error);
		expect((error as Error).message).not.toContain(KEY.slice(0, 6));
	});

	it.each(["exa", "brave", "tavily", "firecrawl"] as const)(
		"shows missing and saved %s key states without their values",
		async (provider) => {
			settings.setWebSearchProvider(provider);
			const options = { settings, loadedExtensionPaths: [], hasWebKeyCommand: true, onWebSearchKey: vi.fn() };
			expect((await createSettingsDomainExtras(options)).webSearch?.keySource).toBe("none");
			await AuthStorage.create().modify(provider, async () => ({ type: "api_key", key: KEY }));
			const extras = await createSettingsDomainExtras(options);
			expect(extras.webSearch?.keySource).toBe("auth");
			// Exa's key row is in the advanced interface only.
			const grouped = groupSettingsByDomain([], vi.fn(), { ...extras, interfaceMode: "advanced" });
			expect(webSearchItems(grouped)[1]!.currentValue).toBe("saved key");
			expect(JSON.stringify(extras)).not.toContain(KEY);
		},
	);

	it.each(["exa", "firecrawl"] as const)(
		"renders %s Web search and its choices at 64 columns, and makes remove selectable",
		async (provider) => {
			settings.setWebSearchProvider(provider);
			const onWebSearchKey = vi.fn();
			const extras = await createSettingsDomainExtras({
				settings,
				loadedExtensionPaths: [],
				hasWebKeyCommand: true,
				onWebSearchKey,
			});
			// Exa's key row is in the advanced interface only.
			const grouped = groupSettingsByDomain([], vi.fn(), { ...extras, interfaceMode: "advanced" });
			const items = webSearchItems(grouped);
			expect(items[0]!.label).toBe("Provider");
			for (const item of items) {
				const choices = item.submenu!(item.currentValue, () => {});
				for (const line of choices.render(64)) expect(visibleWidth(line)).toBeLessThanOrEqual(64);
			}
			// The key menu, through the settings window at 64 columns: down to "remove", then Enter.
			const view = new SettingsView(grouped, { onClose: vi.fn(), rows: () => 30 });
			view.selectItem("web-search-key");
			for (const line of view.render(64)) expect(visibleWidth(line)).toBeLessThanOrEqual(64);
			view.handleInput("\r");
			for (const line of view.render(64)) expect(visibleWidth(line)).toBeLessThanOrEqual(64);
			view.handleInput("\x1b[B");
			view.handleInput("\r");
			expect(onWebSearchKey).toHaveBeenCalledWith("remove");
		},
	);

	it.each(WEB_SEARCH_PROVIDERS)("persists global provider %s and ignores project overrides", async (provider) => {
		settings.setWebSearchProvider(provider);
		settings.setWebSearchUrl("http://localhost:8080/searx");
		await settings.flush();
		mkdirSync(join(dir, CONFIG_DIR_NAME));
		writeFileSync(
			join(dir, CONFIG_DIR_NAME, "settings.json"),
			JSON.stringify({ webSearchProvider: "tavily", webSearchUrl: "https://other.example" }),
		);
		const reloaded = SettingsManager.create(dir, dir);
		expect(reloaded.getWebSearchProvider()).toBe(provider);
		expect(reloaded.getWebSearchUrl()).toBe("http://localhost:8080/searx");
		settings.setWebSearchUrl(undefined);
		await settings.flush();
		expect(SettingsManager.create(dir, dir).getWebSearchUrl()).toBeUndefined();
	});

	it("reports an unsupported configured provider instead of failing to load or searching elsewhere", async () => {
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ webSearchProvider: "unknown" }));
		settings = SettingsManager.create(dir, dir);
		expect(settings.getWebSearchProvider()).toBeUndefined();
		const result = await search(await start());
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).toContain("unsupported webSearchProvider");
		expect(getMessageText(result)).toContain("choose exa, brave, tavily, firecrawl or searxng");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each(["malformed", "unreadable"])("blocks searches when global settings.json is %s", async (failure) => {
		const path = join(dir, "settings.json");
		if (failure === "malformed") writeFileSync(path, '{"webSearchProvider":"searxng",');
		else mkdirSync(path);
		fetchMock.mockImplementation(async (input, init) => publicResponse(input, init));
		const harness = await start();
		for (let attempt = 0; attempt < 2; attempt++) {
			const result = await search(harness);
			expect(result.isError).toBe(true);
			expect(getMessageText(result)).toContain("settings.json could not be read");
			expect(getMessageText(result)).toContain("/reload");
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("still searches when only compaction.thresholdPercent is invalid", async () => {
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ compaction: { thresholdPercent: "80" } }));
		fetchMock.mockImplementation(async (input, init) => publicResponse(input, init));
		const result = await search(await start());
		expect(result.isError).toBeFalsy();
		expect(getMessageText(result)).toContain("Public page");
	});

	it("reports a failed provider save in /settings without reloading", async () => {
		const onWebSearchReload = vi.fn();
		const onWebSearchNotify = vi.fn();
		const extras = await createSettingsDomainExtras({
			settings,
			loadedExtensionPaths: [],
			hasWebKeyCommand: true,
			onWebSearchKey: vi.fn(),
			onWebSearchReload,
			onWebSearchNotify,
		});
		writeFileSync(join(dir, "settings.json"), "{");
		await extras.onWebSearchProvider!("brave");
		expect(onWebSearchNotify).toHaveBeenCalledWith(
			expect.stringContaining("Could not save web search provider"),
			"error",
		);
		expect(onWebSearchReload).not.toHaveBeenCalled();
	});

	it.each(["streaming", "compacting"])("shows the provider change pending in /settings while %s", async (state) => {
		const harness = await start();
		vi.spyOn(harness.session, "isStreaming", "get").mockReturnValue(state === "streaming");
		vi.spyOn(harness.session, "isCompacting", "get").mockReturnValue(state === "compacting");
		let selector: SettingsSelectorComponent | undefined;
		// The interactive mode's settings are its session's (interactive-mode.ts), which /settings saves through.
		const mode = {
			settingsManager: harness.session.settingsManager,
			session: harness.session,
			ui: { mode: "regular", requestRender: vi.fn() },
			themeController: { getThemeSelection: () => "dark", getTerminalTheme: () => undefined },
			chatContainer: new Container(),
			handleReloadCommand: vi.fn(),
			showSettingsOverlay(create: (done: () => void) => { component: Component; focus: Component }) {
				selector = create(vi.fn()).component as SettingsSelectorComponent;
			},
			showExtensionNotify(message: string, type: "warning" | "error") {
				if (type === "warning") {
					const warn = InteractiveMode.prototype.showWarning as (this: typeof mode, message: string) => void;
					warn.call(this, message);
				}
			},
		};
		const showSettings = Reflect.get(InteractiveMode.prototype, "showSettingsSelector") as (
			this: typeof mode,
		) => Promise<void>;
		await showSettings.call(mode);
		const list = selector!.getSettingsList();
		list.selectItem("web-search-provider");
		list.handleInput("\r");
		list.handleInput("\x1b[B");
		list.handleInput("\r");
		await harness.session.settingsManager.flush();
		expect(harness.session.settingsManager.getWebSearchProvider()).toBe("brave");
		const lines = mode.chatContainer.render(64);
		expect(stripAnsi(lines.join("\n"))).toContain("change pending");
		expect(stripAnsi(lines.join("\n"))).toContain("/reload after the current response");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(64);
		expect(mode.handleReloadCommand).not.toHaveBeenCalled();
	});

	it.each(WEB_SEARCH_PROVIDERS)(
		"shows %s configuration and routes provider and set/remove choices",
		async (provider) => {
			settings.setWebSearchProvider(provider);
			if (provider !== "searxng") vi.stubEnv(WEB_SEARCH_KEY_ENV[provider], KEY);
			else settings.setWebSearchUrl("http://localhost:8080");
			const onWebSearchKey = vi.fn();
			const onWebSearchReload = vi.fn();
			const extras = await createSettingsDomainExtras({
				settings,
				loadedExtensionPaths: [],
				hasWebKeyCommand: true,
				onWebSearchKey,
				onWebSearchReload,
			});
			// Exa's key row is in the advanced interface only.
			const grouped = groupSettingsByDomain([], vi.fn(), { ...extras, interfaceMode: "advanced" });
			const items = webSearchItems(grouped);
			expect(items[0]!.currentValue).toBe(provider);
			expect(open(items[0]!).map((item) => item.id)).toEqual([...WEB_SEARCH_PROVIDERS]);
			expect(items[1]!.currentValue).toBe(
				provider === "searxng" ? "http://localhost:8080" : WEB_SEARCH_KEY_ENV[provider],
			);
			expect(JSON.stringify(extras)).not.toContain(KEY);
			expect(open(items[1]!).map((item) => item.id)).toEqual([
				provider === "searxng" ? "set a URL" : "set a key",
				"remove",
			]);
			grouped.onChange(items[1]!.id, provider === "searxng" ? "set a URL" : "set a key");
			grouped.onChange(items[1]!.id, "remove");
			expect(onWebSearchKey.mock.calls).toEqual([["set"], ["remove"]]);
			grouped.onChange("web-search-provider", "brave");
			await settings.flush();
			expect(settings.getWebSearchProvider()).toBe("brave");
			expect(onWebSearchReload).toHaveBeenCalledOnce();
		},
	);

	it.each(["brave", "tavily", "firecrawl"] as const)(
		"/web-key saves and removes the selected %s key using secret input",
		async (provider) => {
			const input = vi.fn(async () => ` ${KEY} `);
			const notify = vi.fn();
			const harness = await start(provider, { input, notify });
			await harness.session.prompt("/web-key");
			expect(input).toHaveBeenCalledWith(
				`${WEB_SEARCH_NAMES[provider]} API key (saved in auth.json)`,
				`${provider} key`,
				{ secret: true },
			);
			expect(await AuthStorage.create().read(provider)).toEqual({ type: "api_key", key: KEY });
			await harness.session.prompt("/web-key remove");
			expect(await AuthStorage.create().read(provider)).toBeUndefined();
			expect(JSON.stringify(notify.mock.calls)).not.toContain(KEY);
		},
	);

	it.each(["brave", "firecrawl"] as const)(
		"/web-key accepts explicit %s without changing the selected provider",
		async (provider) => {
			const notify = vi.fn();
			const harness = await start("exa", { input: async () => KEY, notify });
			await harness.session.prompt(`/web-key ${provider}`);
			expect(await AuthStorage.create().read(provider)).toEqual({ type: "api_key", key: KEY });
			expect(settings.getWebSearchProvider()).toBe("exa");
			await harness.session.prompt(`/web-key ${provider} remove`);
			expect(await AuthStorage.create().read(provider)).toBeUndefined();
			expect(JSON.stringify(notify.mock.calls)).not.toContain(KEY);
		},
	);

	it.each(["unknown", "brave tavily", "remove remove"])("/web-key rejects invalid arguments: %s", async (args) => {
		const input = vi.fn();
		const notify = vi.fn();
		const harness = await start("exa", { input, notify });
		await harness.session.prompt(`/web-key ${args}`);
		expect(input).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith("Usage: /web-key [exa|brave|tavily|firecrawl|searxng] [remove]", "error");
	});

	it("/web-key saves and removes the selected SearXNG URL", async () => {
		const input = vi.fn(async () => " http://localhost:8080/searx/ ");
		const harness = await start("searxng", { input });
		await harness.session.prompt("/web-key");
		expect(input).toHaveBeenCalledWith("SearXNG instance base URL", "http://localhost:8080", undefined);
		expect(SettingsManager.create(dir, dir).getWebSearchUrl()).toBe("http://localhost:8080/searx");
		await harness.session.prompt("/web-key remove");
		expect(SettingsManager.create(dir, dir).getWebSearchUrl()).toBeUndefined();
	});

	it.each(["save", "remove"])("/web-key searxng reports a failed URL %s without reloading", async (action) => {
		const notify = vi.fn();
		const harness = await start("searxng", {
			notify,
			input: async () => {
				writeFileSync(join(dir, "settings.json"), "{");
				return "http://localhost:8080";
			},
		});
		const reload = vi.spyOn(harness.session, "reload");
		if (action === "remove") writeFileSync(join(dir, "settings.json"), "{");
		await harness.session.prompt(`/web-key searxng${action === "remove" ? " remove" : ""}`);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Could not save SearXNG URL"), "error");
		expect(notify).not.toHaveBeenCalledWith(expect.stringMatching(/SearXNG URL (saved|removed)/), "info");
		expect(reload).not.toHaveBeenCalled();
	});

	it("web_fetch still uses Exa contents while Brave is selected", async () => {
		vi.stubEnv("EXA_API_KEY", "test-exa-fetch-key");
		vi.stubEnv("BRAVE_API_KEY", KEY);
		fetchMock.mockResolvedValue(
			Response.json({ results: [{ title: "Fetched", url: "https://page.example/", text: "Exa content" }] }),
		);
		const harness = await start("brave");
		const runner = harness.session.extensionRunner;
		const result = await runner
			.getToolDefinition("web_fetch")!
			.execute(
				"fetch",
				{ urls: "https://page.example/" },
				undefined,
				undefined,
				runner.createToolContext("fetch", undefined),
			);
		expect(fetchMock.mock.calls[0]![0]).toBe("https://api.exa.ai/contents");
		expect(new Headers(fetchMock.mock.calls[0]![1]?.headers).get("x-api-key")).toBe("test-exa-fetch-key");
		expect(getMessageText(result)).toContain("Exa content");
	});

	it("web_fetch uses direct fetch without an Exa key while Tavily is selected", async () => {
		vi.stubEnv("TAVILY_API_KEY", KEY);
		fetchMock.mockResolvedValue(new Response("Direct content", { headers: { "content-type": "text/plain" } }));
		const harness = await start("tavily");
		const runner = harness.session.extensionRunner;
		const result = await runner
			.getToolDefinition("web_fetch")!
			.execute(
				"fetch",
				{ urls: "http://localhost:8080/page" },
				undefined,
				undefined,
				runner.createToolContext("fetch", undefined),
			);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]![0]).toBe("http://localhost:8080/page");
		expect(getMessageText(result)).toContain("Direct content");
	});

	it.each(WEB_SEARCH_PROVIDERS)("tolerates missing and malformed %s result fields", (provider) => {
		const rows = [
			null,
			5,
			{ title: 8, url: "https://example/", description: 12, content: {}, text: [], page_age: null },
			{ title: "no URL" },
		];
		expect(
			parseSearchResults(
				provider === "brave"
					? { web: { results: rows } }
					: provider === "firecrawl"
						? { data: { web: rows } }
						: { results: rows },
				provider,
			),
		).toEqual([
			{ url: "https://example/", title: undefined, text: undefined, author: undefined, publishedDate: undefined },
		]);
		for (const data of [null, {}, { results: {} }, { web: null }, { data: null }, { data: { web: {} } }])
			expect(parseSearchResults(data, provider)).toEqual([]);
	});
});
