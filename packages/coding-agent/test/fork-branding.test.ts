// fork: user-visible harness names come from APP_NAME. The checkout's name is
// "pi", so the config is mocked to the shipped name to tell a built name from a literal.
import { afterEach, describe, expect, test, vi } from "vitest";
import type * as Config from "../src/config.ts";

vi.mock("../src/config.ts", async (importOriginal) => ({
	...(await importOriginal<typeof Config>()),
	APP_NAME: "prism",
	APP_TITLE: "prism",
}));

import { printHelp } from "../src/cli/args.ts";
import { buildSystemPromptSections } from "../src/core/system-prompt.ts";
import { APP_DISPLAY_NAME, BRANDED_RADIUS_LOGIN_INTRO } from "../src/fork/brand.ts";
import { ART_LETTERS, LOGO_LARGE, LOGO_MINI, LOGO_SMALL } from "../src/fork/prism/art.ts";
import { handlePackageCommand } from "../src/package-manager-cli.ts";

function captureLog(run: () => unknown): Promise<string> {
	const lines: string[] = [];
	vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		lines.push(args.join(" "));
	});
	return Promise.resolve(run()).then(() => lines.join("\n"));
}

describe("fork branding", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("capitalizes the configured app name for display", () => {
		expect(APP_DISPLAY_NAME).toBe("Prism");
	});

	test("names the configured app in the default system prompt", () => {
		const { preamble, docs } = buildSystemPromptSections({ cwd: "/tmp" });

		expect(preamble).toContain("inside Prism");
		expect(preamble).not.toMatch(/\bpi\b/);
		expect(docs).toContain("Prism documentation (read only when the user asks about prism itself");
		expect(docs).toContain("Resolve docs/... and examples/... there, not in the working directory");
	});

	test("describes the Prism self-update in the update help", async () => {
		const help = await captureLog(() => printHelp());
		const updateLine = help.split("\n").find((line) => line.includes(" update ["));
		expect(updateLine).toContain("prism update [source|self]");
		expect(updateLine).not.toMatch(/\bpi\b/);

		const updateHelp = await captureLog(() => handlePackageCommand(["update", "--help"]));
		expect(updateHelp).toContain("installed from https://prism.odelserver.space");
		expect(updateHelp).toContain("--rollback");
		expect(updateHelp).not.toMatch(/\bpi\b|--force/);
	});

	test("does not attribute Prism to the makers of Radius", () => {
		expect(BRANDED_RADIUS_LOGIN_INTRO).toContain("on which Prism is built");
		expect(BRANDED_RADIUS_LOGIN_INTRO).not.toContain("crafted for");
	});

	test("draws the logo as rectangular pixel maps", () => {
		for (const map of [LOGO_LARGE, LOGO_SMALL, LOGO_MINI]) {
			expect(map.length % 2).toBe(0);
			expect(new Set(map.map((row) => row.length)).size).toBe(1);
			for (const ch of map.join("")) expect(` ${ART_LETTERS}`).toContain(ch);
		}
	});
});
