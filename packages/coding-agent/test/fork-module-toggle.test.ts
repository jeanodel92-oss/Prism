// fork: a module turned off during a session leaves the next request without its
// tool and prompt section, and the prompt cache of everything before stays valid.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type FauxResponseFactory,
	fauxAssistantMessage,
	getApiProvider,
	registerApiProvider,
} from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import { createSettingsDomainExtras, setBuiltinExtensionEnabled } from "../src/fork/settings-domain-extras.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const harnesses: Harness[] = [];
const dirs: string[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Request {
	/** Tools declared so far: added by each system message, minus the removed ones. */
	tools: string[];
	/** Prompt sections of the last system message that sets them (null: removed). */
	language: string | null | undefined;
	systemMessages: number;
}

describe("fork: modules turned on or off during a session", () => {
	it("applies on closing Settings only when a module ends up changed", async () => {
		const settings = SettingsManager.inMemory({});
		const extras = await createSettingsDomainExtras({
			settings,
			loadedExtensionPaths: ["builtin:session-search"],
			hasWebKeyCommand: false,
			onWebSearchKey: () => {},
		});
		expect(extras.builtinExtensionsChanged?.()).toBe(false);
		// Off then on again: the setting now holds an explicit entry, but nothing to reload.
		extras.onBuiltinExtensionChange("session-search", false);
		extras.onBuiltinExtensionChange("session-search", true);
		expect(settings.getGlobalSettings().extensions).toEqual(["+builtin:session-search"]);
		expect(extras.builtinExtensionsChanged?.()).toBe(false);
		extras.onBuiltinExtensionChange("memory", true);
		expect(extras.builtinExtensionsChanged?.()).toBe(true);
	});

	it("changes the tool list at the next turn and keeps the cached prefix", async () => {
		const root = mkdtempSync(join(tmpdir(), "prism-module-toggle-"));
		dirs.push(root);
		// session-search is off by default: this test turns it on, then off.
		const settings = SettingsManager.inMemory({ extensions: ["+builtin:session-search"] });
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir: join(root, "agent"),
			settingsManager: settings,
			extensionFactories: builtInExtensions.filter(
				(entry) => typeof entry !== "function" && ["session-search", "reply-language"].includes(entry.name),
			),
		});
		await loader.reload();
		const harness = await createHarness({ resourceLoader: loader });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		// The harness agent has no session id, so the faux provider would not simulate the cache.
		harness.session.agent.sessionId = harness.session.sessionId;
		// reload() resets the API providers, the faux one included; the CLI registers its own again.
		const faux = getApiProvider(harness.faux.api);
		if (!faux) throw new Error("faux provider not registered");

		const requests: Request[] = [];
		const record =
			(text: string): FauxResponseFactory =>
			(context) => {
				const tools = new Set<string>();
				let language: string | null | undefined;
				let systemMessages = 0;
				for (const message of context.messages) {
					if (message.role !== "system") continue;
					systemMessages++;
					for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
					for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
					if (message.sections && "language" in message.sections) language = message.sections.language;
				}
				requests.push({ tools: [...tools], language, systemMessages });
				return fauxAssistantMessage(text);
			};
		const turn = async (index: number) => {
			harness.setResponses([record(`answer ${index} ${"x".repeat(400)}`)]);
			await harness.session.prompt(`question ${index} ${"y".repeat(2000)}`);
		};

		await turn(0);
		await turn(1);
		setBuiltinExtensionEnabled(settings, "session-search", false);
		setBuiltinExtensionEnabled(settings, "reply-language", false);
		await harness.session.reload();
		registerApiProvider(faux);
		await turn(2);
		await turn(3);

		expect(requests[1]?.tools).toContain("session_search");
		expect(requests[1]?.language).toMatch(/<language>/);
		// The next turn: tool and section gone, through one more system message at the end.
		expect(requests[2]?.tools).not.toContain("session_search");
		expect(requests[2]?.tools).toEqual(expect.arrayContaining(["read", "bash", "edit", "write"]));
		expect(requests[2]?.language).toBeNull();
		expect(requests[2]?.systemMessages).toBe(2);

		// Cache, as the faux provider estimates it from the common prefix of two requests.
		const usage = harness.session.messages.flatMap((message) =>
			message.role === "assistant" ? [message.usage] : [],
		);
		const [, before, toggled, after] = usage;
		if (!before || !toggled || !after) throw new Error("missing usage");
		// Everything sent before the change is still read from the cache... (the faux provider rounds each
		// part up to a token, so totals split differently can differ by one)
		expect(Math.abs(toggled.cacheRead - (before.cacheRead + before.cacheWrite))).toBeLessThanOrEqual(1);
		// ...and the change itself costs only the small system message written after it.
		expect(toggled.cacheWrite - before.cacheWrite).toBeGreaterThan(0);
		expect(toggled.cacheWrite - before.cacheWrite).toBeLessThan(600);
		expect(Math.abs(after.cacheWrite - before.cacheWrite)).toBeLessThanOrEqual(1);
		console.log(
			`module toggle cache cost (faux estimate): read ${toggled.cacheRead}, written ${toggled.cacheWrite} vs ${before.cacheWrite} for an ordinary turn`,
		);
	});
});
