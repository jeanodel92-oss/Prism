// `/web-key` without arguments as native screens over the real view transport; the command keeps
// its validation, saving, removal, warning and reload.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { setViewsClient } from "../src/fork/interactive-client.ts";
import { RpcViews } from "../src/fork/rpc-views.ts";
import webExtension from "../src/fork/web.ts";
import { WEB_SEARCH_KEY_ENV, type WebSearchProvider } from "../src/fork/web-search-config.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

const KEY = "tv-test-web-secret+/=token";

interface Item {
	id: string;
	label: string;
	description?: string;
}
interface Menu {
	screenId: string;
	kind: string;
	title: string;
	lines?: string[];
	errors?: string[];
	notes?: string[];
	items?: Item[];
	actions?: Item[];
	currentItemId?: string;
	hint?: string;
	value?: string;
	secret?: boolean;
	placeholder?: string;
}
type Record_ = { type: string; id?: string; menu?: Menu };

describe("fork: native /web-key", () => {
	let dir: string;
	const harnesses: Harness[] = [];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "prism-web-key-native-"));
		vi.stubEnv(ENV_AGENT_DIR, dir);
		for (const env of Object.values(WEB_SEARCH_KEY_ENV)) vi.stubEnv(env, "");
		initTheme("dark");
	});
	afterEach(() => {
		setViewsClient();
		for (const harness of harnesses.splice(0)) harness.cleanup();
		vi.unstubAllEnvs();
		rmSync(dir, { recursive: true, force: true });
	});

	async function engine(provider: WebSearchProvider, url?: string) {
		const settings = SettingsManager.create(dir, dir);
		settings.setWebSearchProvider(provider);
		if (url) settings.setWebSearchUrl(url);
		await settings.flush();
		const records: Record_[] = [];
		const notes: [string, string | undefined][] = [];
		const input = vi.fn(async () => KEY);
		const views = new RpcViews((record) => records.push(record as Record_));
		views.handleCommand({ type: "set_views", columns: 100, rows: 30, nativeMenus: true });
		const harness = await createHarness({ extensionFactories: [{ name: "web", factory: webExtension }] });
		harnesses.push(harness);
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				custom: (factory, opts) => views.custom(factory, opts),
				notify: (message, type) => notes.push([message, type]),
				input,
			}),
			mode: "rpc",
		});
		// The command's `ctx.reload()`; this harness binds no session actions, so it is observed where the runner calls it.
		const reload = vi.fn(async () => {});
		(harness.session.extensionRunner as unknown as { reloadHandler: () => Promise<void> }).reloadHandler = reload;
		const menu = () => records.filter((record) => record.type === "view_frame").at(-1)?.menu as Menu;
		const viewId = () => records.filter((record) => record.type === "view_open").at(-1)?.id ?? "";
		const act = (action: object) => views.handleCommand({ type: "view_action", viewId: viewId(), action });
		const item = (label: string) => {
			const found = [...(menu().items ?? []), ...(menu().actions ?? [])].find((entry) => entry.label === label);
			if (!found) throw new Error(`No item ${label} in ${menu().title}`);
			return found;
		};
		const activate = (label: string) => act({ kind: "activate", itemId: item(label).id });
		const run = (args = "") => harness.session.prompt(`/web-key${args ? ` ${args}` : ""}`);
		const saved = () => SettingsManager.create(dir, dir);
		return {
			records,
			notes,
			input,
			reload,
			menu,
			act,
			item,
			activate,
			run,
			saved,
			closed: () => records.some((r) => r.type === "view_closed"),
		};
	}

	it("lists every provider with the key in effect, then saves a masked key without changing the provider", async () => {
		vi.stubEnv("BRAVE_API_KEY", "brave-env-test-key");
		await AuthStorage.create().modify("tavily", async () => ({ type: "api_key", key: "saved-test-key" }));
		const e = await engine("exa");
		const done = e.run();
		await vi.waitFor(() => expect(e.menu()?.screenId).toBe("providers"));
		expect(e.menu()).toMatchObject({
			kind: "choice",
			title: "Web search",
			lines: ["Provider in use: Exa"],
			hint: "close",
		});
		expect(e.menu().items?.map((entry) => [entry.label, entry.description])).toEqual([
			["Exa", "none (public endpoint)"],
			["Brave", "BRAVE_API_KEY"],
			["Tavily", "saved key"],
			["Firecrawl", "missing"],
			["SearXNG", "missing"],
		]);
		expect(e.menu().currentItemId).toBe(e.item("Exa").id);

		e.activate("Tavily");
		await vi.waitFor(() => expect(e.menu().screenId).toBe("edit:tavily"));
		expect(e.menu()).toMatchObject({
			kind: "input",
			title: "Tavily API key (saved in auth.json)",
			lines: ["saved key"],
			secret: true,
			placeholder: "tavily key",
			actions: [{ label: "Remove" }],
		});
		expect(e.menu().value).toBeUndefined();
		e.act({ kind: "input", value: ` ${KEY} ` });
		await done;
		expect(await AuthStorage.create().read("tavily")).toEqual({ type: "api_key", key: KEY });
		expect(e.notes).toContainEqual(["Tavily key saved in auth.json.", "info"]);
		expect(e.reload).toHaveBeenCalledOnce();
		expect(e.saved().getWebSearchProvider()).toBe("exa");
		expect(e.input).not.toHaveBeenCalled();
		expect(e.closed()).toBe(true);
		// Neither the saved key nor the new one is ever sent to the window.
		expect(JSON.stringify(e.records)).not.toContain(KEY);
		expect(JSON.stringify(e.records)).not.toContain("saved-test-key");
	});

	it("removes a saved key, goes back, refuses stale clicks and closes without saving", async () => {
		await AuthStorage.create().modify("firecrawl", async () => ({ type: "api_key", key: "saved-test-key" }));
		const e = await engine("firecrawl");
		const done = e.run();
		await vi.waitFor(() => expect(e.menu()?.screenId).toBe("providers"));
		const stale = e.item("Firecrawl").id;
		e.activate("Brave");
		await vi.waitFor(() => expect(e.menu().screenId).toBe("edit:brave"));
		// Nothing saved for Brave: nothing to remove.
		expect(e.menu().actions).toEqual([]);
		expect(e.act({ kind: "activate", itemId: stale })).toMatchObject({ success: false });
		e.act({ kind: "back" });
		await vi.waitFor(() => expect(e.menu().screenId).toBe("providers"));
		e.activate("Firecrawl");
		await vi.waitFor(() => expect(e.menu().screenId).toBe("edit:firecrawl"));
		e.activate("Remove");
		await done;
		expect(await AuthStorage.create().read("firecrawl")).toBeUndefined();
		expect(e.notes).toContainEqual(["Firecrawl key removed from auth.json.", "info"]);
		expect(e.reload).toHaveBeenCalledOnce();

		const again = e.run();
		await vi.waitFor(() => expect(e.menu()?.screenId).toBe("providers"));
		e.act({ kind: "back" });
		await again;
		expect(e.reload).toHaveBeenCalledOnce();
		expect(e.notes).toHaveLength(1);
	});

	it("an empty key saves nothing, and an environment key is shown and still warned about", async () => {
		vi.stubEnv("BRAVE_API_KEY", "brave-env-test-key");
		const e = await engine("brave");
		let done = e.run();
		await vi.waitFor(() => expect(e.menu()?.screenId).toBe("providers"));
		e.activate("Brave");
		await vi.waitFor(() => expect(e.menu().screenId).toBe("edit:brave"));
		expect(e.menu().lines).toEqual(["BRAVE_API_KEY"]);
		expect(e.menu().notes).toEqual(["BRAVE_API_KEY is set and takes precedence."]);
		e.act({ kind: "input", value: "  " });
		await done;
		expect(e.notes).toEqual([["No key saved.", "info"]]);
		expect(e.reload).not.toHaveBeenCalled();

		done = e.run();
		await vi.waitFor(() => expect(e.menu()?.screenId).toBe("providers"));
		e.activate("Brave");
		await vi.waitFor(() => expect(e.menu().screenId).toBe("edit:brave"));
		e.act({ kind: "input", value: KEY });
		await done;
		expect(await AuthStorage.create().read("brave")).toEqual({ type: "api_key", key: KEY });
		expect(e.notes).toContainEqual(["BRAVE_API_KEY is set and takes precedence.", "warning"]);
	});

	it("checks the SearXNG URL on its screen, saves it normalised, shows it again and removes it", async () => {
		const e = await engine("searxng");
		let done = e.run();
		await vi.waitFor(() => expect(e.menu()?.screenId).toBe("providers"));
		e.activate("SearXNG");
		await vi.waitFor(() => expect(e.menu().screenId).toBe("edit:searxng"));
		expect(e.menu()).toMatchObject({
			title: "SearXNG instance base URL",
			value: "",
			placeholder: "http://localhost:8080",
			actions: [],
		});
		expect(e.menu().secret).toBeUndefined();
		e.act({ kind: "input", value: "http://user:pw@localhost:8080" });
		await vi.waitFor(() => expect(e.menu().errors?.[0]).toContain("SearXNG needs an http(s) base URL"));
		expect(e.menu()).toMatchObject({ screenId: "edit:searxng", value: "http://user:pw@localhost:8080" });
		e.act({ kind: "input", value: " http://localhost:8080/searx/ " });
		await done;
		expect(e.saved().getWebSearchUrl()).toBe("http://localhost:8080/searx");
		expect(e.notes).toContainEqual(["SearXNG URL saved.", "info"]);

		done = e.run();
		await vi.waitFor(() => expect(e.menu()?.screenId).toBe("providers"));
		expect(e.item("SearXNG").description).toBe("http://localhost:8080/searx");
		e.activate("SearXNG");
		await vi.waitFor(() => expect(e.menu().screenId).toBe("edit:searxng"));
		expect(e.menu().value).toBe("http://localhost:8080/searx");
		e.activate("Remove");
		await done;
		expect(e.saved().getWebSearchUrl()).toBeUndefined();
		expect(e.notes).toContainEqual(["SearXNG URL removed.", "info"]);
		expect(e.reload).toHaveBeenCalledTimes(2);
	});

	it("keeps the terminal prompt when a provider is named", async () => {
		const e = await engine("exa");
		await e.run("tavily");
		expect(e.input).toHaveBeenCalledWith("Tavily API key (saved in auth.json)", "tavily key", { secret: true });
		expect(e.records.some((record) => record.type === "view_open")).toBe(false);
		expect(await AuthStorage.create().read("tavily")).toEqual({ type: "api_key", key: KEY });
	});
});
