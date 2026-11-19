// fork.9 QA: the command list and the module descriptions.
import { afterEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { SourceInfo } from "../src/core/source-info.ts";
import { getAutocompleteSourceTag } from "../src/fork/autocomplete.ts";
import { byCommandOrder } from "../src/fork/command-aliases.ts";
import { setLanguage, t } from "../src/fork/i18n/index.ts";
import { EXTENSION_DESCRIPTIONS, SETTINGS_SHORTCUTS } from "../src/fork/settings-descriptions.ts";
import { builtinExtensionNames } from "../src/fork/settings-domain-extras.ts";

describe("fork.9 QA", () => {
	afterEach(() => setLanguage("en"));

	it("reads every message sent during the work at the next turn, and leaves follow-ups one at a time", () => {
		const settings = SettingsManager.inMemory();
		expect(settings.getSteeringMode()).toBe("all");
		expect(settings.getFollowUpMode()).toBe("one-at-a-time");
	});

	it("lists the most used commands first and keeps the others in their order", () => {
		const names = ["zeta", "resume", "alpha", "new", "budget"];
		expect(byCommandOrder(names.map((name) => ({ name }))).map(({ name }) => name)).toEqual([
			"new",
			"resume",
			"budget",
			"zeta",
			"alpha",
		]);
	});

	it("does not tag the commands of Prism's own modules with a [t] of their inline path", () => {
		const source = (path: string, scope: SourceInfo["scope"], origin: SourceInfo["origin"]): SourceInfo => ({
			path,
			source: "local",
			scope,
			origin,
		});
		expect(getAutocompleteSourceTag(source("<inline:perm>", "temporary", "top-level"))).toBeUndefined();
		expect(getAutocompleteSourceTag(source("/x/ext.ts", "temporary", "top-level"))).toBe("t");
	});

	it("describes every module of /settings, in French too", () => {
		setLanguage("fr");
		const missing = builtinExtensionNames().filter((name) => {
			const description = EXTENSION_DESCRIPTIONS[name];
			return !description || t(description) === description;
		});
		expect(missing).toEqual([]);
	});

	it("puts signing in with the models", () => {
		expect(SETTINGS_SHORTCUTS.find((entry) => entry.command === "login")?.domain).toBe("models");
	});
});
