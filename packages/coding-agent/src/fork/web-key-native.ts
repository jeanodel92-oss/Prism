// `/web-key` without arguments as native screens in the Prism window: every search provider with
// the key or URL in effect, then the key (masked) or the SearXNG URL to save, or Remove. The command saves, removes,
// warns and reloads as it does after its own prompts; this only collects the answer.
import type { ExtensionCommandContext } from "../core/extensions/types.ts";
import { fill, t } from "./i18n/index.ts";
import { NativeFlow, showNativeFlow } from "./native-flow.ts";
import {
	resolveWebSearchKey,
	validateWebSearchUrl,
	WEB_SEARCH_KEY_ENV,
	WEB_SEARCH_NAMES,
	WEB_SEARCH_PROVIDERS,
	type WebSearchKeyProvider,
	type WebSearchProvider,
} from "./web-search-config.ts";

export type WebKeyChoice = { provider: WebSearchProvider; remove: boolean; value?: string };
type Source = "env" | "auth" | "none";

export class NativeWebKeyView extends NativeFlow {
	constructor(changed: () => void) {
		super(changed, { screenId: "loading", kind: "detail", title: t("Web search"), busy: true });
	}

	private status(provider: WebSearchProvider, sources: Map<WebSearchKeyProvider, Source>, url?: string): string {
		if (provider === "searxng") return url ?? t("missing");
		const source = sources.get(provider);
		if (source === "env") return WEB_SEARCH_KEY_ENV[provider];
		if (source === "auth") return t("saved key");
		return t(provider === "exa" ? "none (public endpoint)" : "missing");
	}

	/** The provider to change; `undefined` on Close. */
	chooseProvider(
		inUse: WebSearchProvider | undefined,
		sources: Map<WebSearchKeyProvider, Source>,
		url: string | undefined,
	): Promise<WebSearchProvider | undefined> {
		const prefix = this.nextPrefix();
		return this.wait<WebSearchProvider>((finish) => {
			this.show(
				{
					screenId: "providers",
					kind: "choice",
					title: t("Web search"),
					lines: inUse ? [fill("Provider in use: {0}", WEB_SEARCH_NAMES[inUse])] : [],
					hint: "close",
					items: WEB_SEARCH_PROVIDERS.map((provider) => ({
						id: prefix + provider,
						label: WEB_SEARCH_NAMES[provider],
						description: this.status(provider, sources, url),
					})),
					...(inUse ? { currentItemId: prefix + inUse, initialItemId: prefix + inUse } : {}),
				},
				(action) => {
					if (action.kind === "back") {
						finish(undefined);
						return true;
					}
					const id = typeof action.itemId === "string" ? action.itemId : "";
					const provider = WEB_SEARCH_PROVIDERS.find((candidate) => prefix + candidate === id);
					if (action.kind !== "activate" || !provider) return false;
					finish(provider);
					return true;
				},
			);
			return () => {};
		});
	}

	/** The key or URL to save, or Remove; `undefined` on Back. */
	edit(
		provider: WebSearchProvider,
		source: Source,
		url: string | undefined,
	): Promise<Omit<WebKeyChoice, "provider"> | undefined> {
		const prefix = this.nextPrefix();
		const name = WEB_SEARCH_NAMES[provider];
		const searxng = provider === "searxng";
		const removable = searxng ? url !== undefined : source === "auth";
		const env = searxng ? undefined : WEB_SEARCH_KEY_ENV[provider];
		return this.wait((finish) => {
			const show = (error?: string, typed?: string) =>
				this.show(
					{
						screenId: `edit:${provider}`,
						kind: "input",
						title: searxng ? t("SearXNG instance base URL") : fill("{0} API key (saved in auth.json)", name),
						lines: [this.status(provider, new Map(searxng ? [] : [[provider, source]]), url)],
						errors: error ? [error] : [],
						notes: source === "env" && env ? [fill("{0} is set and takes precedence.", env)] : [],
						placeholder: searxng ? "http://localhost:8080" : fill("{0} key", provider),
						// The saved key is never sent back to the window; the URL is not a secret.
						...(searxng ? { value: typed ?? url ?? "" } : { secret: true }),
						actions: removable ? [{ id: `${prefix}remove`, label: t("Remove") }] : [],
					},
					(action) => {
						if (action.kind === "back") {
							finish(undefined);
							return true;
						}
						if (action.kind === "activate" && removable && action.itemId === `${prefix}remove`) {
							finish({ remove: true });
							return true;
						}
						if (action.kind !== "input" || typeof action.value !== "string") return false;
						const value = action.value.trim();
						if (searxng) {
							// Checked here too, so a mistake is corrected on this screen instead of after it closed.
							try {
								validateWebSearchUrl(value);
							} catch (error) {
								show(t((error as Error).message), action.value);
								return true;
							}
						}
						finish({ remove: false, value });
						return true;
					},
				);
			show();
			return () => {};
		});
	}
}

/** The provider and what to do with its key or URL, chosen in the window; `undefined` when closed. */
export async function chooseWebSearchKey(
	ctx: ExtensionCommandContext,
	inUse: WebSearchProvider | undefined,
	url: string | undefined,
): Promise<WebKeyChoice | undefined> {
	const sources = new Map<WebSearchKeyProvider, Source>();
	for (const provider of WEB_SEARCH_PROVIDERS)
		if (provider !== "searxng") sources.set(provider, (await resolveWebSearchKey(provider)).source);
	let choice: WebKeyChoice | undefined;
	await showNativeFlow<NativeWebKeyView>(
		ctx,
		(changed) => new NativeWebKeyView(changed),
		async (view) => {
			while (!choice) {
				const provider = await view.chooseProvider(inUse, sources, url);
				if (!provider) return;
				const answer = await view.edit(provider, sources.get(provider as WebSearchKeyProvider) ?? "none", url);
				if (answer) choice = { provider, ...answer };
			}
		},
	);
	return choice;
}
