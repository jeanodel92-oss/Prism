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
import { APP_DISPLAY_NAME, BRANDED_RADIUS_LOGIN_INTRO, displayVersion } from "../src/fork/brand.ts";
import { applyBrandedEnvAliases } from "../src/fork/branded-cli.ts";
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

	test("gives --help Prism's identity, not pi's (audit FIN-04)", async () => {
		const help = await captureLog(() => printHelp());
		expect(help.split("\n")[0]).toContain("prism - a free and open source coding agent for Linux");
		expect(help).not.toContain("AI coding assistant");
		expect(help).not.toMatch(/PI_TELEMETRY|PI_OFFLINE|PI_PACKAGE_DIR|PI_SHARE_VIEWER_URL|pi\.dev|powershell/);
		expect(help).toContain("PRISM_OFFLINE");
		expect(help).toContain("same as PRISM_OFFLINE=1");
		expect(help).toContain("https://prism.odelserver.space/session/");
		// The 50 provider key lines are folded into a pointer; the config variables stay.
		expect(help).not.toContain("CEREBRAS_API_KEY");
		expect(help).toContain("/docs providers");
		// ENV_AGENT_DIR comes from the unmocked config here (PI_CODING_AGENT_DIR); prism builds say PRISM_.
		expect(help).toContain("_CODING_AGENT_DIR");
		// Every variable line keeps the description column of its neighbours.
		const columns = help
			.split("\n")
			.filter((line) => /^ {2}[A-Z_]+ +- /.test(line))
			.map((line) => line.indexOf(" - "));
		expect(new Set(columns).size).toBe(1);
		const commandColumns = help
			.split("\n")
			.filter((line) => /^ {2}prism (install|remove|update|list) /.test(line))
			.map((line) => line.search(/ {2}[A-Z]/));
		expect(new Set(commandColumns).size).toBe(1);
	});

	test("reads PRISM_* aliases of the PI_* variables (audit FIN-04)", () => {
		const env: NodeJS.ProcessEnv = {
			PRISM_OFFLINE: "1",
			PRISM_SHARE_VIEWER_URL: "https://x/",
			PI_PACKAGE_DIR: "/a",
			PRISM_PACKAGE_DIR: "/b",
		};
		applyBrandedEnvAliases("prism", env);
		expect(env.PI_OFFLINE).toBe("1");
		expect(env.PI_SHARE_VIEWER_URL).toBe("https://x/");
		expect(env.PI_PACKAGE_DIR).toBe("/a");
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

describe("fork display version (audit FIN-18)", () => {
	test("shortens a release version and names a canary", () => {
		expect(displayVersion("1.0.0-fork.12.1")).toBe("12.1");
		expect(displayVersion("1.0.0-fork.12")).toBe("12");
		expect(displayVersion("1.0.0-fork.12.2.canary.3")).toBe("12.2 canary 3");
		expect(displayVersion("1.0.0")).toBe("1.0.0");
	});
});
