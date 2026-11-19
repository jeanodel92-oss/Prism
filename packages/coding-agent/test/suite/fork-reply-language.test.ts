// fork: the reply language section of the system prompt, with identical prompts and tools
// whatever the language.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { InMemorySettingsStorage, type Settings, SettingsManager } from "../../src/core/settings-manager.ts";
import replyLanguage, { replyLanguageInstruction } from "../../src/fork/reply-language.ts";
import { groupSettingsByDomain } from "../../src/fork/settings-domains.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("fork: reply language", () => {
	let harness: Harness | undefined;
	beforeAll(() => initTheme("prism"));
	afterEach(() => harness?.cleanup());

	async function sent(settings: Partial<Settings>, withExtension = true) {
		harness = await createHarness({ settings, extensionFactories: withExtension ? [replyLanguage] : [] });
		let system: { sections?: Record<string, string> } | undefined;
		harness.setResponses([
			(context) => {
				system = context.messages.find((message) => (message.role as string) === "system") as typeof system;
				return fauxAssistantMessage("ok");
			},
		]);
		await harness.session.prompt("Corrige le bug dans main.ts");
		const result = {
			language: system?.sections?.language,
			// Each harness has its own cwd; normalize only that known fixture path.
			sections: Object.fromEntries(
				Object.entries(system?.sections ?? {}).map(([name, content]) => [
					name,
					content.replaceAll(harness!.tempDir, "<test-project>"),
				]),
			),
			tools: harness.session.getActiveToolNames(),
		};
		harness.cleanup();
		harness = undefined;
		return result;
	}

	it("asks for the language of the user's message by default, and keeps tool names", async () => {
		const plain = await sent({}, false);
		const auto = await sent({});
		expect(auto.language).toContain("Reply in the language of the user's latest message");
		expect(auto.language).toContain("tool names");
		expect(plain.language).toBeUndefined();
		// Only the language section is added; the other sections are unchanged.
		const { language: _language, ...otherSections } = auto.sections;
		expect(otherSections).toEqual(plain.sections);
		expect(auto.tools).toEqual(plain.tools);
	});

	it("names a chosen language, with the same tools", async () => {
		const french = await sent({ replyLanguage: "French" });
		const english = await sent({ replyLanguage: "English" });
		expect(french.language).toContain("Reply in French, unless the user asks for another language.");
		expect(english.language).toContain("Reply in English");
		expect(french.tools).toEqual(english.tools);
	});

	it("treats an empty or auto setting as automatic", () => {
		expect(replyLanguageInstruction(" ")).toBe(replyLanguageInstruction(undefined));
		expect(replyLanguageInstruction("AUTO")).toBe(replyLanguageInstruction("auto"));
	});

	it.each([42, false, null, [], {}].map((value) => ({ value })))(
		"returns auto for a non-string setting $value and guards the extension",
		async ({ value }) => {
			const storage = new InMemorySettingsStorage();
			storage.withLock("global", () => JSON.stringify({ replyLanguage: value }));
			const settings = SettingsManager.fromStorage(storage);
			const result = await sent(settings.getSettings());
			expect(result.language).toBe(`<language>\n${replyLanguageInstruction(undefined)}\n</language>`);
			expect(settings.getReplyLanguage()).toBe("auto");
		},
	);

	it("reads a non-string replyLanguage from settings.json without breaking Conversation", async () => {
		harness = await createHarness();
		writeFileSync(join(harness.tempDir, "settings.json"), '{"replyLanguage":42}');
		const settings = SettingsManager.create(harness.tempDir, harness.tempDir);
		expect(settings.getReplyLanguage()).toBe("auto");
		const grouped = groupSettingsByDomain([], () => {}, {
			builtinExtensions: [],
			onBuiltinExtensionChange: () => {},
			replyLanguage: settings.getReplyLanguage(),
		});
		const conversation = grouped.domains().find((domain) => domain.id === "conversation");
		expect(conversation).toBeDefined();
		const reply = conversation!.items().find((item) => item.id === "reply-language");
		expect(reply?.label).toBe("Reply language");
		expect(reply?.currentValue).toBe("auto");
	});
});
