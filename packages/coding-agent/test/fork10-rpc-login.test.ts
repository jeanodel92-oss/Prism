// `/login` and `/logout` in the Prism window, as native screens over the real view transport
// (login-native.ts): the terminal's menus, sign-in prompts and events, the checklist of the provider's models and the
// messages, from the operations the terminal uses too (login-operations.ts). The model runtime's credential calls are
// stubbed: no provider is reached.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { setViewsClient } from "../src/fork/interactive-client.ts";
import { handleBuiltinCommand } from "../src/fork/rpc-builtins.ts";
import { RpcViews } from "../src/fork/rpc-views.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

const opened = vi.hoisted(() => [] as string[]);
vi.mock("../src/utils/open-browser.ts", () => ({ openBrowser: (url: string) => opened.push(url) }));

interface Item {
	id: string;
	label: string;
	description?: string;
	selected?: boolean;
}
interface Menu {
	screenId: string;
	kind: string;
	title: string;
	lines?: string[];
	alerts?: Array<{ text: string; tone: string }>;
	notes?: string[];
	links?: { url: string }[];
	secret?: boolean;
	query?: string;
	doneLabel?: string;
	items?: Item[];
	actions?: Item[];
}
type Record_ = { type: string; id?: string; menu?: Menu };

const ACME = {
	id: "acme",
	name: "Acme",
	auth: { apiKey: { name: "Acme key", login: async () => ({ type: "api_key", key: "x" }) } },
};
const ZETA = { id: "zeta", name: "Zeta", auth: { oauth: { name: "Zeta account", isSubscription: false } } };

describe("fork.10: native /login and /logout", () => {
	let dir: string;
	const harnesses: Harness[] = [];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "prism-login-native-"));
		vi.stubEnv(ENV_AGENT_DIR, dir);
		initTheme("dark");
		opened.length = 0;
	});
	afterEach(() => {
		setViewsClient();
		for (const harness of harnesses.splice(0)) harness.cleanup();
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		rmSync(dir, { recursive: true, force: true });
	});

	async function engine(
		login: (providerId: string, interaction: AuthInteraction) => Promise<unknown>,
		nativeMenus = true,
	) {
		const records: Record_[] = [];
		const notes: string[] = [];
		const views = new RpcViews((record) => records.push(record as Record_));
		views.handleCommand({ type: "set_views", columns: 100, rows: 30, nativeMenus });
		const harness = await createHarness();
		harnesses.push(harness);
		const runtime = harness.session.modelRuntime;
		vi.spyOn(runtime, "getProviders").mockReturnValue([ACME, ZETA] as never);
		vi.spyOn(runtime, "getProvider").mockImplementation((id) => [ACME, ZETA].find((p) => p.id === id) as never);
		vi.spyOn(runtime, "getProviderAuthStatus").mockReturnValue({ configured: false });
		vi.spyOn(runtime, "isUsingOAuth").mockReturnValue(false);
		vi.spyOn(runtime, "refresh").mockResolvedValue({ aborted: false, errors: new Map() });
		const loginSpy = vi
			.spyOn(runtime, "login")
			.mockImplementation((providerId, _type, interaction) => login(providerId, interaction) as never);
		// Two Acme models: a recent one, checked, and an old one, not.
		const models = [
			{ provider: "acme", id: "acme-new", name: "Acme New", releaseDate: "2026-10-01" },
			{ provider: "acme", id: "acme-old", name: "Acme Old", releaseDate: "2024-01-01" },
		];
		vi.spyOn(runtime, "getAvailableSnapshot").mockReturnValue(models as never);
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				custom: (factory, opts) => views.custom(factory, opts),
				notify: (message) => notes.push(message),
			}),
			mode: "rpc",
		});
		const run = (type: "login" | "logout", provider?: string, away = false) =>
			handleBuiltinCommand(
				{ type, id: type, ...(provider ? { provider } : {}), ...(away ? { away: true } : {}) },
				harness.session,
				{} as never,
				views,
				async () => {},
			) as Promise<{ success: boolean; error?: string }>;
		const menu = () => records.filter((record) => record.type === "view_frame").at(-1)?.menu as Menu;
		const viewId = () => records.filter((record) => record.type === "view_open").at(-1)?.id ?? "";
		const act = (action: object) => views.handleCommand({ type: "view_action", viewId: viewId(), action });
		const find = (label: string) => {
			const found = [...(menu().items ?? []), ...(menu().actions ?? [])].find((item) =>
				item.label.startsWith(label),
			);
			if (!found) throw new Error(`No ${label} in ${menu().screenId}`);
			return found;
		};
		return { harness, runtime, notes, run, menu, act, find, loginSpy, settings: harness.settingsManager };
	}

	it("saves an API key from the method menu, then offers the provider's models", async () => {
		const e = await engine(async (_id, interaction) => {
			const key = await interaction.prompt({ type: "secret", message: "Enter API key:", placeholder: "sk-..." });
			expect(key).toBe("sk-test");
			return { type: "api_key", key };
		});
		const done = e.run("login");
		await vi.waitFor(() => expect(e.menu()?.screenId).toBe("methods"));
		expect(e.menu().title).toBe("How would you like to connect?");
		expect(e.menu().items?.map((item) => item.label)).toEqual([
			"Connect a compatible server (URL)",
			"Sign in with an account",
			"Use an API key (an access key from the service)",
		]);
		e.act({ kind: "activate", itemId: e.find("Use an API key").id });
		await vi.waitFor(() => expect(e.menu().screenId).toBe("providers"));
		expect(e.menu().items).toEqual([expect.objectContaining({ label: "Acme", description: "not configured" })]);

		e.act({ kind: "activate", itemId: e.find("Acme").id });
		await vi.waitFor(() => expect(e.menu().screenId).toBe("prompt"));
		expect(e.menu()).toMatchObject({ kind: "input", title: "Login to Acme", secret: true, doneLabel: "Cancel" });
		expect(e.menu().notes).toEqual(["Enter API key:"]);
		e.act({ kind: "input", value: "sk-test" });

		await vi.waitFor(() => expect(e.menu().screenId).toBe("models"));
		expect(e.notes).toEqual([expect.stringMatching(/^Saved API key for Acme\. Credentials saved to /)]);
		expect(e.menu()).toMatchObject({ kind: "multiSelect", title: "Models from Acme", doneLabel: "Keep all models" });
		expect(e.menu().items?.map((item) => [item.label, item.selected])).toEqual([
			["acme-new", true],
			["acme-old", false],
		]);
		expect(e.find("Save").label).toBe("Save (1 of 2 models)");
		e.act({ kind: "multiSelect", itemId: e.find("acme-old").id, selected: true });
		await vi.waitFor(() => expect(e.find("Save").label).toBe("Save (2 of 2 models)"));
		e.act({ kind: "activate", itemId: e.find("Save").id });
		expect(await done).toMatchObject({ success: true });
		// The catalog stubbed here has only Acme's models: no other provider keeps a pattern.
		expect(e.settings.getEnabledModels()).toEqual(["acme/acme-new", "acme/acme-old"]);
	});

	it("opens the provider named after /login, and Back cancels the sign-in", async () => {
		let signal: AbortSignal | undefined;
		const e = await engine(async (_id, interaction) => {
			signal = interaction.signal;
			await interaction.prompt({ type: "secret", message: "Enter API key:" });
			return {};
		});
		const done = e.run("login", "ACME");
		await vi.waitFor(() => expect(e.menu()?.screenId).toBe("prompt"));
		e.act({ kind: "back" });
		expect(await done).toMatchObject({ success: true });
		expect(signal?.aborted).toBe(true);
		expect(e.notes).toEqual([]);
		expect(e.settings.getEnabledModels()).toBeUndefined();
	});

	async function withAnthropic() {
		const e = await engine(async () => ({}));
		const anthropic = {
			id: "anthropic",
			name: "Anthropic (Claude Pro/Max)",
			auth: { oauth: { name: "Anthropic (Claude Pro/Max)", isSubscription: true } },
		};
		vi.spyOn(e.runtime, "getProviders").mockReturnValue([ACME, ZETA, anthropic] as never);
		vi.spyOn(e.runtime, "getProvider").mockImplementation(
			(id) => [ACME, ZETA, anthropic].find((p) => p.id === id) as never,
		);
		const done = e.run("login", "anthropic");
		await vi.waitFor(() => expect(e.menu()?.screenId).toBe("anthropic-subscription"));
		return { e, done };
	}

	it("warns before a Claude subscription sign-in; Back signs in to nothing", async () => {
		const { e, done } = await withAnthropic();
		// the warning in bold red.
		expect(e.menu().alerts).toEqual([{ text: expect.stringContaining("may be suspended or banned"), tone: "error" }]);
		e.act({ kind: "activate", itemId: e.find("Back").id });
		expect(await done).toMatchObject({ success: true });
		expect(e.loginSpy).not.toHaveBeenCalled();
	});

	it("signs in with a Claude subscription once the risk is accepted", async () => {
		const { e, done } = await withAnthropic();
		e.act({ kind: "activate", itemId: e.find("Sign in anyway").id });
		await vi.waitFor(() => expect(e.loginSpy.mock.calls[0]?.slice(0, 2)).toEqual(["anthropic", "oauth"]));
		await done;
	});

	it("filters the providers with a name that matches none exactly", async () => {
		const e = await engine(async () => ({}));
		const done = e.run("login", "ze");
		await vi.waitFor(() => expect(e.menu()?.screenId).toBe("providers"));
		expect(e.menu().query).toBe("ze");
		expect(e.menu().items?.map((item) => [item.label, item.description])).toEqual([
			["Acme", "API key · not configured"],
			["Zeta", "account · not configured"],
		]);
		e.act({ kind: "back" });
		await done;
	});

	it("shows the sign-in page and opens it; a device code with its page; Back stops the wait", async () => {
		const e = await engine(
			(_id, interaction) =>
				new Promise((_resolve, reject) => {
					interaction.notify({ type: "auth_url", url: "https://zeta.example/auth", instructions: "Sign in" });
					interaction.notify({
						type: "device_code",
						userCode: "ABCD-1234",
						verificationUri: "https://zeta.example/device",
					});
					interaction.signal?.addEventListener("abort", () => reject(new Error("Login cancelled")));
				}),
		);
		const done = e.run("login", "zeta");
		await vi.waitFor(() => expect(e.menu()?.screenId).toBe("dialog"));
		expect(opened).toEqual(["https://zeta.example/auth"]);
		expect(e.menu()).toMatchObject({
			kind: "detail",
			title: "Login to Zeta",
			links: [{ url: "https://zeta.example/device" }],
			notes: ["On the web page above, enter this code: ABCD-1234", "Waiting for authentication..."],
		});
		e.act({ kind: "back" });
		expect(await done).toMatchObject({ success: true });
		expect(e.notes).toEqual([]);
	});

	// Owner, 2026-11-13: from the phone app, a sign-in whose page comes back to this computer cannot end.
	it("from the phone, a sign-in page is not opened: the sign-in stops and says to do it at the computer", async () => {
		let aborted = false;
		const e = await engine(
			(_id, interaction) =>
				new Promise((_resolve, reject) => {
					interaction.signal?.addEventListener("abort", () => {
						aborted = true;
						reject(new Error("Login cancelled"));
					});
					interaction.notify({ type: "auth_url", url: "https://zeta.example/auth", instructions: "Sign in" });
				}),
		);
		const done = e.run("login", "zeta", true);
		await vi.waitFor(() => expect(e.menu()?.screenId).toBe("info"));
		expect(opened).toEqual([]);
		expect(aborted).toBe(true);
		expect(e.menu()).toMatchObject({ kind: "detail", title: "Login to Zeta" });
		expect(e.menu().lines).toEqual([
			"This sign-in goes through a web browser on the computer. Run /login there; an API key can be saved from here.",
		]);
		expect(e.menu().links ?? []).toEqual([]);
		e.act({ kind: "back" });
		expect(await done).toMatchObject({ success: true });
		expect(e.notes).toEqual([]);
	});

	it("from the phone, a device code signs in as in the window", async () => {
		const e = await engine(
			(_id, interaction) =>
				new Promise((_resolve, reject) => {
					interaction.notify({
						type: "device_code",
						userCode: "ABCD-1234",
						verificationUri: "https://zeta.example/device",
					});
					interaction.signal?.addEventListener("abort", () => reject(new Error("Login cancelled")));
				}),
		);
		const done = e.run("login", "zeta", true);
		await vi.waitFor(() => expect(e.menu()?.screenId).toBe("dialog"));
		expect(e.menu()).toMatchObject({ title: "Login to Zeta", links: [{ url: "https://zeta.example/device" }] });
		e.act({ kind: "back" });
		expect(await done).toMatchObject({ success: true });
	});

	it("reports a failed sign-in", async () => {
		const e = await engine(async () => {
			throw new Error("bad key");
		});
		expect(await e.run("login", "acme")).toMatchObject({ success: true });
		expect(e.notes).toEqual(["Failed to save API key for Acme: bad key"]);
	});

	it("removes a stored credential", async () => {
		const e = await engine(async () => ({}));
		vi.spyOn(e.runtime, "listCredentials").mockResolvedValue([{ providerId: "acme", type: "api_key" }] as never);
		const logout = vi.spyOn(e.runtime, "logout").mockResolvedValue();
		const done = e.run("logout");
		await vi.waitFor(() => expect(e.menu()?.screenId).toBe("logout"));
		expect(e.menu().title).toBe("Select provider to logout:");
		e.act({ kind: "activate", itemId: e.find("Acme").id });
		expect(await done).toMatchObject({ success: true });
		expect(logout).toHaveBeenCalledWith("acme", expect.anything());
		expect(e.notes).toEqual([
			"Removed stored API key for Acme. Environment variables and models.json config are unchanged.",
		]);
	});

	it("says when there is nothing to log out of", async () => {
		const e = await engine(async () => ({}));
		vi.spyOn(e.runtime, "listCredentials").mockResolvedValue([]);
		expect(await e.run("logout")).toMatchObject({ success: true });
		expect(e.notes).toEqual([
			"No stored credentials to remove. /logout only removes credentials saved by /login; environment variables and models.json config are unchanged.",
		]);
	});

	it("is refused without native screens", async () => {
		const e = await engine(async () => ({}), false);
		await expect(e.run("login")).rejects.toThrow("/login opens in the terminal or the Prism window.");
		await expect(e.run("logout")).rejects.toThrow("/logout opens in the terminal or the Prism window.");
	});
});
