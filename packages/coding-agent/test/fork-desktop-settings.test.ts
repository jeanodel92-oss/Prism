/**
 * the shortcut that takes the user's desktop back is changed in
 * `/settings` > Permissions & sandbox while the desktop module runs. Throwaway agent dir.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { emitSessionShutdownEvent } from "../src/core/extensions/runner.ts";
import { DEFAULT_TAKE_BACK_KEY, takeBackKey } from "../src/fork/desktop/index.ts";
import { TAKE_BACK_SETTING } from "../src/fork/desktop/settings.ts";
// fork: the shortcut belongs to the user's desktop, a module of its own.
import userDesktopModule from "../src/fork/desktop/user-tool.ts";
import { pageOf } from "../src/fork/settings-pages.ts";
import { settingsSections } from "../src/fork/settings-sections.ts";
import { createHarness, createTestUiContext } from "./suite/harness.ts";

describe("desktop take-back shortcut in /settings", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-desktop-settings-"));
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(agentDir, { recursive: true, force: true });
	});

	const row = () =>
		settingsSections()
			.filter((section) => section.domain === "computer-use")
			.flatMap((section) => section.items({ advanced: () => false, requestRender: () => {} }))
			.find((item) => item.id === TAKE_BACK_SETTING);

	it("shows the shortcut in effect, saves a valid one, refuses a wrong one, and leaves with the module", async () => {
		const harness = await createHarness({
			extensionFactories: [{ name: "user-desktop", factory: userDesktopModule }],
		});
		try {
			await harness.session.bindExtensions({ uiContext: createTestUiContext() });
			expect(row()?.currentValue).toBe(DEFAULT_TAKE_BACK_KEY);

			const closed: (string | undefined)[] = [];
			const page = pageOf(row()!)!(DEFAULT_TAKE_BACK_KEY, (value) => closed.push(value));
			if (page.kind !== "input") throw new Error(`Expected an input page, got ${page.kind}`);
			expect(page.input.parse("q")).toBeInstanceOf(Error);
			expect(page.input.parse("ctrl+foo+q")).toBeInstanceOf(Error);
			const value = page.input.parse("Super + Alt + F5");
			expect(value).toBe("super+alt+f5");
			await page.input.save(value as string);
			page.input.done(true);
			expect(closed).toEqual(["changed"]);
			expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).desktopTakeBackKey).toBe(
				"super+alt+f5",
			);
			expect(takeBackKey()).toBe("super+alt+f5");
			expect(row()?.currentValue).toBe("super+alt+f5");

			// An empty field removes it: back to the default.
			await page.input.save(undefined);
			expect(takeBackKey()).toBe(DEFAULT_TAKE_BACK_KEY);

			await emitSessionShutdownEvent(harness.session.extensionRunner, { type: "session_shutdown", reason: "quit" });
			expect(row()).toBeUndefined();
		} finally {
			harness.cleanup();
		}
	});
});
