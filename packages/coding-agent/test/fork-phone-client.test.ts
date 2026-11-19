// fork: on the phone (the engine started by prism-remote, PRISM_REMOTE_CLIENT=phone), the
// browser's setup assistant is not offered in the settings; on the PC it is.
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { isPhoneClient, setViewsClient } from "../src/fork/interactive-client.ts";
import { SETTINGS_SHORTCUTS } from "../src/fork/settings-descriptions.ts";
import { createSettingsDomainExtras } from "../src/fork/settings-domain-extras.ts";
import { groupSettingsByDomain } from "../src/fork/settings-domains.ts";

async function shortcuts(): Promise<string[]> {
	const extras = await createSettingsDomainExtras({
		settings: SettingsManager.inMemory({}),
		loadedExtensionPaths: [],
		hasWebKeyCommand: false,
		onWebSearchKey: vi.fn(),
		hasCommand: () => true,
	});
	return (extras.commands ?? []).map((entry) => entry.command);
}

describe("phone client", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("offers the browser setup on the PC, not on the phone", async () => {
		vi.stubEnv("PRISM_REMOTE_CLIENT", "");
		expect(isPhoneClient()).toBe(false);
		expect(await shortcuts()).toContain("browser setup");

		vi.stubEnv("PRISM_REMOTE_CLIENT", "phone");
		expect(isPhoneClient()).toBe(true);
		const onPhone = await shortcuts();
		expect(onPhone).not.toContain("browser setup");
		expect(onPhone.length).toBeGreaterThan(0);
	});

	// /phone in the terminal's /settings, under Other; not in the
	// window, which has its own entry (Window > Link a phone), nor on the phone.
	it("offers /phone under Other in the terminal only", async () => {
		vi.stubEnv("PRISM_REMOTE_CLIENT", "");
		expect(await shortcuts()).toContain("phone");
		const model = groupSettingsByDomain([], vi.fn(), {
			builtinExtensions: [],
			onBuiltinExtensionChange: vi.fn(),
			commands: SETTINGS_SHORTCUTS.filter((entry) => entry.command === "phone"),
			sections: () => [],
		});
		const other = model.domains().find((domain) => domain.id === "other");
		expect(other?.items().map((item) => item.id)).toContain("command:phone");

		vi.stubEnv("PRISM_REMOTE_CLIENT", "phone");
		expect(await shortcuts()).not.toContain("phone");

		// Last: the window's flag cannot be turned off again in this process.
		vi.stubEnv("PRISM_REMOTE_CLIENT", "");
		setViewsClient(true);
		const inWindow = await shortcuts();
		expect(inWindow).not.toContain("phone");
		expect(inWindow).toContain("browser setup");
	});
});
