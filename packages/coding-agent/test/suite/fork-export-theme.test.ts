// fork: the default theme setting is the pair `prism-light/prism`; /export follows the
// terminal's appearance instead of falling back to the active theme.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, registerFauxProvider, streamSimple } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../../src/core/agent-session.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { convertToLlm } from "../../src/core/messages.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { getResolvedThemeColors, initTheme, setTerminalColorScheme } from "../../src/modes/interactive/theme/theme.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "../model-runtime-test-utils.ts";
import { createTestResourceLoader } from "../utilities.ts";

describe("fork: /export theme with the default light/dark pair", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		while (cleanups.length > 0) {
			cleanups.pop()?.();
		}
		setTerminalColorScheme(undefined);
		initTheme("dark");
	});

	async function exportWith(scheme: "light" | "dark"): Promise<string> {
		const tempDir = mkdtempSync(join(tmpdir(), "prism-export-theme-"));
		const faux = registerFauxProvider({
			models: [{ id: "faux-1", reasoning: false }],
		});
		faux.setResponses([fauxAssistantMessage("hello")]);

		const model = faux.getModel();
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRegistry = await createInMemoryModelRegistry(authStorage);
		modelRegistry.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			models: faux.models.map((registeredModel) => ({
				id: registeredModel.id,
				name: registeredModel.name,
				api: registeredModel.api,
				reasoning: registeredModel.reasoning,
				input: registeredModel.input,
				cost: registeredModel.cost,
				contextWindow: registeredModel.contextWindow,
				maxTokens: registeredModel.maxTokens,
				baseUrl: registeredModel.baseUrl,
			})),
		});

		const settingsManager = SettingsManager.inMemory({});
		const sessionManager = SessionManager.create(tempDir, join(tempDir, "sessions"));
		const agent = new Agent({
			getApiKey: () => "faux-key",
			initialState: {
				model,
				systemPrompt: "You are a test assistant.",
				tools: [],
			},
			convertToLlm,
			streamFn: streamSimple,
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
		});
		cleanups.push(() => {
			session.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		await session.prompt("hi");
		setTerminalColorScheme(scheme);
		const outputPath = join(tempDir, "export.html");
		await session.exportToHtml(outputPath);
		return readFileSync(outputPath, "utf-8");
	}

	it("uses prism on a dark terminal and prism-light on a light one", async () => {
		// The export page backgrounds of prism.json and prism-light.json.
		expect(await exportWith("dark")).toContain("#050505");
		const light = await exportWith("light");
		expect(light).not.toContain("#050505");
		expect(light).toContain("#f2f2f0");
	});

	it("carries the transcript's heading, inline code and link tints into the export", async () => {
		const html = await exportWith("dark");
		const colors = getResolvedThemeColors("prism");
		for (const token of ["mdHeading", "mdBold", "mdCode", "mdLink"]) {
			expect(colors[token]).not.toBe(colors.text);
			expect(html).toContain(`--${token}: ${colors[token]};`);
		}
		// bold, in user and assistant messages alike, in the bold tint.
		expect(html).toContain(".markdown-content strong { color: var(--mdBold, inherit); }");
	});
});
