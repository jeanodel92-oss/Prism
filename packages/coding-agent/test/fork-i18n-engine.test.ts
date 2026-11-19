// Engine interface translations preserve command syntax, paths and model-facing results.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { createSessionAutocompleteProvider } from "../src/fork/autocomplete.ts";
import * as backgroundModule from "../src/fork/background.ts";
import background, { endReport, tail } from "../src/fork/background.ts";
import checkpoints, { checkpointPanel } from "../src/fork/checkpoints.ts";
import { FR, FR_PATTERNS } from "../src/fork/i18n/fr.ts";
import { fill, setLanguage, t } from "../src/fork/i18n/index.ts";
import { serversFor, suggestionNotice } from "../src/fork/lsp-setup.ts";
import { readModelCorrection } from "../src/fork/model-settings.ts";
import { buildSteps } from "../src/fork/onboarding.ts";
import permissions, { decidePermission } from "../src/fork/permissions.ts";
import { handleBuiltinCommand } from "../src/fork/rpc-builtins.ts";
import { describeGitCopies, writeKept, writeOrigin } from "../src/fork/sandbox/git-orphans.ts";
import { readSandboxSettings } from "../src/fork/sandbox/layout.ts";
import {
	describeSandbox,
	networkRefusalNote,
	sandboxPromptSection,
	sandboxResultNote,
} from "../src/fork/sandbox/notes.ts";
import { NativeShareView } from "../src/fork/share-native.ts";
import { scopeLimits } from "../src/fork/task-scope.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

vi.mock("../src/fork/sandbox/runtime.ts", async (original) => ({
	...(await original<Record<string, unknown>>()),
	startSandbox: vi.fn(() => ({ error: "test sandbox unavailable" })),
}));

describe("fork: French engine interface", () => {
	let dir: string;
	let harness: Harness | undefined;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "prism-l10n-engine-"));
		vi.stubEnv(ENV_AGENT_DIR, dir);
		vi.stubEnv("HOME", dir);
		vi.stubEnv("PRISM_SECRET_SERVICE", "off");
		setLanguage("fr");
	});
	afterEach(async () => {
		await harness?.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		harness?.cleanup();
		harness = undefined;
		setLanguage("en");
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		rmSync(dir, { recursive: true, force: true });
	});

	it("translates permission notices and rules without translating command arguments", async () => {
		const notify = vi.fn();
		const select = vi.fn(async (_title: string, _options: string[]) => undefined);
		const setStatus = vi.fn();
		harness = await createHarness({ extensionFactories: [permissions] });
		await harness.session.bindExtensions({ uiContext: createTestUiContext({ notify, select, setStatus }) });
		// the footer status is parsed by both footers, which word it themselves; a French
		// status made the window's permission chip unclickable.
		expect(setStatus).toHaveBeenCalledWith("permissions", "perm: broad · sandbox not working");
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("La sandbox est activée pour le mode large"),
			"error",
		);
		const command = async (text: string) => {
			await harness!.session.prompt(text);
			return notify.mock.calls.at(-1)?.[0] as string;
		};
		expect(await command("/perm mode invalid")).toBe("Utilisation : /perm mode <ask|safe|broad|unrestricted>");
		expect(await command("/perm default invalid")).toBe("Utilisation : /perm default <ask|safe|broad|unrestricted>");
		expect(await command("/perm mode safe")).toBe("Mode de permission : prudent (lecture seule)");
		expect(await command("/perm allow bash(echo $&/{0})")).toContain("bash(echo $&/{0})");
		expect(await command("/perm deny write(copy/**)")).toContain("Refuser");
		expect(await command("/perm status")).toContain("session : 1 autorisées, 1 refusées");
		expect(await command("/perm status")).toContain(
			`configuration : ${join(dir, "permissions.json")} (mode par défaut : large)`,
		);
		await command("/perm rules");
		expect(select).toHaveBeenLastCalledWith(
			"Règles de permission",
			expect.arrayContaining(["Mode : prudent", "Fermer"]),
			undefined,
		);
		await command("/perm mode unrestricted");
		expect(select.mock.calls.at(-1)?.[1]).toEqual(["Activer le mode sans limite", "Annuler"]);
		expect(await command("/perm clear")).toBe("Règles de permission de la session effacées");
		expect(await command("/perm missing")).toBe("Sous-commande inconnue : missing (consultez /perm help)");
		expect(decidePermission("write", { path: "x" }, dir, { mode: "safe" }).reason).toContain("Blocked by safe mode");
	});

	it("translates checkpoint dialogs and native validation errors", async () => {
		const notify = vi.fn();
		const confirm = vi.fn(async () => false);
		harness = await createHarness({ extensionFactories: [checkpoints] });
		await harness.session.bindExtensions({ uiContext: createTestUiContext({ notify, confirm }) });
		await harness.session.prompt("/undo");
		expect(notify).toHaveBeenLastCalledWith("Aucun point de restauration à annuler.", "info");
		const panel = checkpointPanel(harness.session.extensionRunner.createContext())!;
		expect(() => panel.preview(99)).toThrow("Tour de restauration inconnu.");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "copy.txt", content: "keep" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("write");
		await harness.session.prompt("/undo");
		expect(confirm).toHaveBeenCalledWith(
			"Annuler le tour 1 ?",
			expect.stringContaining("Les changements faits par les commandes bash ne sont pas suivis."),
			undefined,
		);
		expect(readFileSync(join(harness.tempDir, "copy.txt"), "utf8")).toBe("keep");
	});

	it("translates argument descriptions and preserves completion values and labels", async () => {
		harness = await createHarness({
			extensionFactories: [
				(pi) =>
					pi.registerCommand("plan", {
						description: "Open Plan mode settings",
						getArgumentCompletions: async () => [
							{ value: "start", label: "start", description: "Start Plan mode without sending a prompt" },
						],
						handler: async () => {},
					}),
			],
		});
		const provider = createSessionAutocompleteProvider({
			session: harness.session,
			settingsManager: harness.settingsManager,
			cwd: dir,
			fdPath: undefined,
		});
		const suggestions = await provider.getSuggestions(["/plan "], 0, 6, { signal: new AbortController().signal });
		expect(suggestions?.items).toContainEqual({
			value: "start",
			label: "start",
			description: "Lancer le mode Plan sans envoyer de message",
		});
		setLanguage("en");
		expect(
			(await provider.getSuggestions(["/plan "], 0, 6, { signal: new AbortController().signal }))?.items[0]
				?.description,
		).toBe("Start Plan mode without sending a prompt");
	});

	it("translates sandbox diagnostics while its prompt and result notes stay English", () => {
		const literal = "/tmp/$&/{0}/copy";
		const layout = { cwd: dir, writable: [literal], readOnly: [literal], hidden: [literal] };
		const settings = readSandboxSettings(dir);
		const lines = describeSandbox({ mode: "ask", active: true, settings, layout, settingsPath: literal });
		expect(lines).toContain("Sandbox : activée (mode demander)");
		expect(lines).toContain(`Accessible en écriture : /tmp (privé pour cette session), ${literal}`);
		expect(lines).toContain(`Réglages : "sandbox" dans ${literal}`);
		expect(lines).toContain("Fermer");
		expect(describeGitCopies(join(dir, "missing"))).toEqual(["Copies Git conservées : (aucun)"]);
		const copy = join(dir, "copies", "one");
		mkdirSync(copy, { recursive: true });
		writeOrigin(copy, literal, { cwd: literal, command: "echo $&/{0}", task: false });
		writeKept(copy, ["keep this diagnostic"]);
		const kept = describeGitCopies(join(dir, "copies")).join("\n");
		expect(kept).toContain("conservée, ses changements ont été refusés: keep this diagnostic");
		expect(kept).toContain(`Origine : commande "echo $&/{0}" dans ${literal}`);
		const english = () => [
			sandboxPromptSection(layout),
			sandboxResultNote(`${literal}: Permission denied`, layout),
			networkRefusalNote([{ host: "copy.test", why: "user" }]),
		];
		const french = english();
		setLanguage("en");
		expect(english()).toEqual(french);
	});

	it("translates the language-server notice", () => {
		expect(suggestionNotice(serversFor(new Set([".ts"]), () => false))).toBe(
			"Les serveurs de langage permettent au modèle de vérifier ses changements de code. À installer pour ce projet : biome (JavaScript / TypeScript). /lsp-setup indique comment faire.",
		);
	});

	it("keeps background output literal and translates only interface wrappers", async () => {
		const path = join(dir, "log");
		writeFileSync(path, "");
		expect(tail(path)).toBe("(no output yet)");
		expect(tail(path, 4000, t("(no output yet)"))).toBe("(aucune sortie pour l’instant)");
		writeFileSync(path, "(no output yet)");
		expect(tail(path, 4000, t("(no output yet)"))).toBe("(no output yet)");
		expect(
			endReport({
				id: "bg1",
				status: "done",
				command: "echo copy",
				cwd: dir,
				logPath: path,
				startedAt: 0,
				endedAt: 1000,
			}),
		).toContain("Background task ended: bg1 [done] 1s · echo copy");
		const notify = vi.fn();
		harness = await createHarness({ extensionFactories: [background] });
		await harness.session.bindExtensions({ uiContext: createTestUiContext({ notify }) });
		await harness.session.prompt("/bg-clear");
		expect(notify).toHaveBeenLastCalledWith("0 tâche(s) effacée(s).", "info");
		vi.spyOn(backgroundModule, "backgroundTasks").mockReturnValue([
			{ id: "bg1", command: "echo copy", cwd: dir, status: "done", logPath: path, startedAt: 0 },
		]);
		const log = () =>
			handleBuiltinCommand(
				{ type: "bg_log", task: "bg1" },
				harness!.session,
				{} as never,
				{} as never,
				async () => {},
			);
		await expect(log()).resolves.toMatchObject({ data: { log: "(no output yet)" } });
		writeFileSync(path, "");
		await expect(log()).resolves.toMatchObject({ data: { log: "(aucune sortie pour l’instant)" } });
	});

	it("covers the native screen's direct and data-driven translation keys", () => {
		const texts = buildSteps(undefined, true).flatMap((step) => [
			step.title,
			step.help,
			...step.options.flatMap((option) => [option.label, option.detail, option.note]),
		]);
		texts.push(...scopeLimits(true), ...scopeLimits(false));
		for (const key of texts.filter((text): text is string => !!text)) {
			// Language names stay in their own language.
			if (key === "Français" || key === "English") continue;
			expect(Object.hasOwn(FR, key) || Object.hasOwn(FR_PATTERNS, key), key).toBe(true);
		}
		const share = new NativeShareView(() => {});
		expect(t("English")).toBe("English");
		expect(share.nativeMenu.title).toBe("Partager");
		for (const [message, translated] of [
			["Uploading to Radius...", "Envoi vers Radius…"],
			["Creating gist...", "Création du gist…"],
		]) {
			const loader = share.createLoader(message);
			expect(share.nativeMenu.lines).toEqual([translated]);
			loader.dispose();
		}
		share.close();
		expect(fill("{0} (private to this session)", "/tmp/$&/{0}")).toBe("/tmp/$&/{0} (privé pour cette session)");
		const path = join(dir, "models.json");
		writeFileSync(path, "{");
		expect(() => readModelCorrection(path, "copy", "copy")).toThrow(`Impossible de modifier ${path}`);
		expect(suggestionNotice([])).toBeUndefined();
	});
});
