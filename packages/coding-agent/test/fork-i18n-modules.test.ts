// fork: built-in modules translate their UI copies, preserving model-facing text and ids.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { type Component, Container, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { ExtensionFactory, ExtensionUIContext } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { detectCapabilities } from "../src/fork/capabilities.ts";
import {
	connectCompatibleServer,
	listCompatibleServerModels,
	writeCompatibleServer,
} from "../src/fork/compatible-server.ts";
import fileBrowser, { FileBrowser } from "../src/fork/file-browser.ts";
import { setLanguage } from "../src/fork/i18n/index.ts";
import memory from "../src/fork/memory.ts";
import sessionSearch from "../src/fork/session-search.ts";
import web from "../src/fork/web.ts";
import { WEB_SEARCH_KEY_ENV } from "../src/fork/web-search-config.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, createTestUiContext, getMessageText, getUserTexts, type Harness } from "./suite/harness.ts";

vi.mock("../src/fork/capabilities.ts", async (original) => ({
	...(await original<Record<string, unknown>>()),
	detectCapabilities: vi.fn(),
}));

const shown = (component: Component, width = 64) => stripAnsi(component.render(width).join("\n"));

describe("fork: French module displays", () => {
	let dir: string;
	let harness: Harness | undefined;
	const fetchMock = vi.fn<typeof fetch>();

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "prism-i18n-modules-"));
		vi.stubEnv(ENV_AGENT_DIR, dir);
		for (const env of Object.values(WEB_SEARCH_KEY_ENV)) vi.stubEnv(env, "");
		fetchMock.mockReset().mockRejectedValue(new Error("Unexpected network request"));
		vi.stubGlobal("fetch", fetchMock);
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		setLanguage("fr");
	});

	afterEach(async () => {
		harness?.cleanup();
		harness = undefined;
		setLanguage("en");
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		rmSync(dir, { recursive: true, force: true });
	});

	async function start(factory: ExtensionFactory, ui: Partial<ExtensionUIContext> = {}) {
		harness = await createHarness({ extensionFactories: [factory] });
		await harness.session.bindExtensions({ mode: "tui", uiContext: createTestUiContext(ui) });
		return harness;
	}

	it("translates memory notices and editor title, leaving the update instruction in English", async () => {
		const notify = vi.fn();
		const editor = vi.fn(async (_title: string, _content?: string) => "# Keep this English memory");
		const h = await start(memory, { notify, editor });
		await h.session.prompt("/memory");
		expect(notify).toHaveBeenLastCalledWith(
			expect.stringContaining("est vide. Utilisez /memory <instruction>"),
			"info",
		);
		await h.session.prompt("/memory-edit");
		expect(editor.mock.calls[0]![0]).toBe(`Mémoire globale (${join(dir, "MEMORY.md")})`);
		expect(notify).toHaveBeenLastCalledWith("Mémoire globale enregistrée.", "info");
		expect(readFileSync(join(dir, "MEMORY.md"), "utf8")).toBe("# Keep this English memory\n");
		h.setResponses([fauxAssistantMessage("done")]);
		await h.session.prompt("/memory Keep preferences");
		await vi.waitFor(() =>
			expect(getUserTexts(h).some((text) => text.startsWith("Update the global memory file at"))).toBe(true),
		);
		expect(notify).toHaveBeenCalledWith("Mise à jour de la mémoire globale…", "info");
		expect(getUserTexts(h).join("\n")).toContain("Review this session against that instruction");
		await vi.waitFor(() => expect(h.session.isStreaming).toBe(false));
		vi.spyOn(h.settingsManager, "isProjectTrusted").mockReturnValue(false);
		await h.session.prompt("/memory-project");
		expect(notify).toHaveBeenLastCalledWith("Le projet n’est pas approuvé — sa mémoire est désactivée.", "warning");
	});

	it("translates /sessions labels and counts while the search tool returns English", async () => {
		const notify = vi.fn();
		const select = vi.fn(async () => undefined);
		const h = await start(sessionSearch, { notify, select });
		const sessions = join(dir, "sessions", "project");
		mkdirSync(sessions, { recursive: true });
		writeFileSync(
			join(sessions, "example.jsonl"),
			[
				JSON.stringify({ type: "session", cwd: h.tempDir, timestamp: "2026-10-22T12:00:00Z" }),
				JSON.stringify({ type: "message", message: { role: "user", content: "Keep this English keyword" } }),
			].join("\n"),
		);
		await h.session.prompt("/sessions");
		expect(notify).toHaveBeenLastCalledWith("Utilisation : /sessions [all] <keywords>", "info");
		await h.session.prompt("/sessions all keyword");
		expect(notify).toHaveBeenLastCalledWith("1 résultat(s) dans 1 session(s)", "info");
		expect((select.mock.calls.at(-1) as unknown as [string, string[]])[1][0]).toContain("utilisateur");
		expect((select.mock.calls.at(-1) as unknown as [string, string[]])[1][0]).toContain("Keep this English keyword");
		const runner = h.session.extensionRunner;
		const tool = runner.getToolDefinition("session_search")!;
		expect(tool.description).toContain("other pi sessions, not the current one");
		const result = await tool.execute(
			"search",
			{ query: "missing" },
			undefined,
			undefined,
			runner.createToolContext("search", undefined),
		);
		expect(getMessageText(result)).toBe("No matches (searched 1 session(s)).");
	});

	it("translates /web-key dialogs, saves, removals and validation without changing tools", async () => {
		vi.stubEnv("BRAVE_API_KEY", "test-env-key");
		const notify = vi.fn();
		const input = vi.fn(async () => "test-key");
		const h = await start(web, { notify, input });
		await h.session.prompt("/web-key brave");
		expect(input).toHaveBeenCalledWith("Clé d’API Brave (enregistrée dans auth.json)", "clé brave", { secret: true });
		expect(notify).toHaveBeenCalledWith("Clé Brave enregistrée dans auth.json.", "info");
		expect(notify).toHaveBeenCalledWith("BRAVE_API_KEY est définie et prioritaire.", "warning");
		await h.session.prompt("/web-key brave remove");
		expect(notify).toHaveBeenCalledWith("Clé Brave retirée de auth.json.", "info");
		input.mockResolvedValue("ftp://example.test");
		await h.session.prompt("/web-key searxng");
		expect(input).toHaveBeenLastCalledWith("URL de base de l’instance SearXNG", "http://localhost:8080", undefined);
		expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("SearXNG demande une URL de base"), "error");
		input.mockResolvedValue("http://example.test");
		await h.session.prompt("/web-key searxng");
		expect(notify).toHaveBeenLastCalledWith("URL SearXNG enregistrée.", "info");
		await h.session.prompt("/web-key searxng remove");
		expect(notify).toHaveBeenLastCalledWith("URL SearXNG retirée.", "info");
		await h.session.prompt("/web-key invalid");
		expect(notify).toHaveBeenLastCalledWith(
			"Utilisation : /web-key [exa|brave|tavily|firecrawl|searxng] [remove]",
			"error",
		);
		expect(h.session.extensionRunner.getToolDefinition("web_search")!.description).toContain(
			"Search the web. Returns ranked results",
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("renders the file browser in French, keeping file names and attached paths", async () => {
		writeFileSync(join(dir, "copy"), "");
		const attach = vi.fn();
		const browser = new FileBrowser({
			root: dir,
			height: () => 20,
			onAttach: attach,
			onClose: vi.fn(),
			requestRender: vi.fn(),
		});
		browser.handleInput("\t");
		const screen = shown(browser);
		expect(screen).toContain("Fichiers · Produits  1 sélectionné(s)");
		expect(screen).toContain("copy");
		expect(screen).toContain("Entrée ajouter au message · Tab sélectionner");
		expect(screen).toContain("← retour · Échap fermer");
		browser.handleInput("\r");
		expect(attach).toHaveBeenCalledWith(["copy"]);
		for (const line of browser.render(64)) expect(visibleWidth(line)).toBeLessThanOrEqual(64);
		const notify = vi.fn();
		const h = await start(fileBrowser, { notify });
		await h.session.bindExtensions({ uiContext: undefined, mode: "print" });
		// A context without a UI also uses the translated notice.
		const context = h.session.extensionRunner.createCommandContext();
		Object.defineProperty(context, "hasUI", { value: false });
		await h.session.extensionRunner.getRegisteredCommands()[0]!.handler("", context);
		expect(notify).toHaveBeenLastCalledWith("L’explorateur de fichiers demande le terminal interactif.", "warning");
	});

	it("translates compatible-server prompts and progress, preserving model ids and API values", async () => {
		const h = await start(fileBrowser);
		vi.spyOn(h.session.modelRuntime, "refresh").mockResolvedValue({ aborted: false, errors: new Map() });
		fetchMock.mockResolvedValue(Response.json({ data: [{ id: "copy" }] }));
		vi.mocked(detectCapabilities).mockResolvedValue({
			kind: "llama.cpp",
			slots: 2,
			models: [
				{
					id: "copy",
					contextWindow: 8192,
					maxContextWindow: 16384,
					vision: "no",
					tools: "yes",
					reasoning: "unknown",
				},
			],
		});
		const prompts: AuthPrompt[] = [];
		const notifications: Parameters<AuthInteraction["notify"]>[0][] = [];
		const interaction: AuthInteraction = {
			prompt: async (prompt) => {
				prompts.push(prompt);
				return prompt.type === "select"
					? "openai-completions"
					: prompt.type === "secret"
						? ""
						: prompt.message === "URL du serveur"
							? "http://server.test/v1"
							: "test-server";
			},
			notify: (event) => {
				notifications.push(event);
			},
		};
		await connectCompatibleServer(h.session.modelRuntime, join(dir, "models.json"), interaction);
		expect(prompts[0]!.message).toContain("Quel format d'API votre serveur accepte-t-il ?");
		expect(prompts[2]!.message).toContain("laissez vide");
		expect(prompts[3]!.message).toBe("Nom de ce serveur (par défaut server.test-80)");
		expect(notifications.map((event) => ("message" in event ? event.message : ""))).toEqual([
			"Lecture de la liste des modèles du serveur…",
			"Lecture des capacités indiquées par le serveur…",
			"llama.cpp, 2 emplacements",
			"copy : contexte 8192 (max 16384), vision non, outils oui, réflexion inconnu",
		]);
		expect(JSON.parse(readFileSync(join(dir, "models.json"), "utf8")).providers["test-server"].api).toBe(
			"openai-completions",
		);
	});

	it("keeps compatible-server exceptions English and translates their display", async () => {
		fetchMock.mockResolvedValue(new Response("", { status: 503 }));
		const error = await listCompatibleServerModels("http://server.test/v1", undefined).catch(
			(error: unknown) => error,
		);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe(
			"Could not list models: the server returned HTTP 503 for GET http://server.test/v1/models.",
		);
		const chatContainer = new Container();
		const display = { chatContainer, outputPad: 0, ui: { requestRender: vi.fn() } };
		InteractiveMode.prototype.showError.call(display as unknown as InteractiveMode, (error as Error).message);
		expect(shown(chatContainer)).toContain("Impossible de lister les modèles");
		writeFileSync(join(dir, "models.json"), "{");
		await expect(
			writeCompatibleServer(
				join(dir, "models.json"),
				{ providerId: "test-server", baseUrl: "http://server.test/v1", models: ["copy"] },
				"openai-completions",
				false,
			),
		).rejects.toThrow("must contain valid JSON");
	});
});
