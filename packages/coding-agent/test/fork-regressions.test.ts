// fork: regression tests for behaviours the fork changes on purpose. Each one
// fails when the change it protects is reverted.
import { execFileSync } from "node:child_process";
import { closeSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Component, Container, setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A branded build (prism) reads its name from package.json at runtime; mock the result.
vi.mock("../src/config.ts", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	APP_NAME: "prism",
}));

import { buildInitialMessage } from "../src/cli/initial-message.ts";
import { ENV_AGENT_DIR, getDocsPath, getExamplesPath, getReadmePath } from "../src/config.ts";
import { executeBashWithOperations } from "../src/core/bash-executor.ts";
import { exportFromFile } from "../src/core/export-html/index.ts";
import { KEYBINDINGS, KeybindingsManager } from "../src/core/keybindings.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { FileSettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";
import { isInstallTelemetryEnabled } from "../src/core/telemetry.ts";
import { createLocalBashOperations } from "../src/core/tools/bash.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import { openAnchored, readAnchored } from "../src/fork/anchored-open.ts";
import { getPrismChangelogPath, unwrapChangelog } from "../src/fork/changelog.ts";
import { pastedCodeDisplay, prismExportCss } from "../src/fork/export-html.ts";
import { saveGlobalSetting } from "../src/fork/global-settings.ts";
import { fill, setLanguage, t } from "../src/fork/i18n/index.ts";
import { interfaceWording, showsToolStatus } from "../src/fork/interface-mode.ts";
import { machineContext } from "../src/fork/machine-context.ts";
import { enabledModules } from "../src/fork/onboarding.ts";
import { pasteTargets } from "../src/fork/paste-hint.ts";
import { BUG_REPORTS_ENABLED, MODEL_CATALOG_REFRESH_SETTING } from "../src/fork/policy.ts";
import { readSandboxSettings } from "../src/fork/sandbox/layout.ts";
import {
	checkForPrismUpdate,
	findReleaseInstall,
	getSelfUpdateRequest,
	isCanaryVersion,
	readReleaseChannel,
	runPrismUpdate,
	updateMode,
} from "../src/fork/self-update.ts";
import { formatSessionState } from "../src/fork/session-state.ts";
import { cloneSharingStrings } from "../src/fork/share-strings-clone.ts";
import { main } from "../src/main.ts";
import { ExtensionInputComponent } from "../src/modes/interactive/components/extension-input.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { runPrintMode } from "../src/modes/print-mode.ts";
import { handlePackageCommand } from "../src/package-manager-cli.ts";
import { checkForNewPiVersion, isNewerPackageVersion } from "../src/utils/version-check.ts";

const brandScript = fileURLToPath(new URL("../../../fork/scripts/brand-binary.sh", import.meta.url));

describe("fork regressions", () => {
	let tempDir: string;
	const savedEnv = { ...process.env };

	it("uses plain or technical queue terms according to the interface mode", () => {
		const steering = (mode: "simple" | "advanced") =>
			interfaceWording(mode, "Messages sent while working", "Steering (messages while working)");
		const followUp = (mode: "simple" | "advanced") =>
			interfaceWording(mode, "Messages sent after the task", "Follow-up (messages after working)");

		expect(steering("simple")).toBe("Messages sent while working");
		expect(followUp("simple")).toBe("Messages sent after the task");
		expect(steering("advanced")).toBe("Steering (messages while working)");
		expect(followUp("advanced")).toBe("Follow-up (messages after working)");
		expect(steering("simple").length).toBeLessThanOrEqual(64);
		expect(steering("advanced").length).toBeLessThanOrEqual(64);
		expect(followUp("simple").length).toBeLessThanOrEqual(64);
		expect(followUp("advanced").length).toBeLessThanOrEqual(64);
	});

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "prism-fork-regressions-"));
		process.env[ENV_AGENT_DIR] = join(tempDir, "agent");
		delete process.env.PI_OFFLINE;
		delete process.env.PI_SKIP_VERSION_CHECK;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		process.env = { ...savedEnv };
		process.exitCode = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("never enables install telemetry, even when the env and the setting ask for it", () => {
		const settings = SettingsManager.inMemory({ enableInstallTelemetry: true });
		expect(isInstallTelemetryEnabled(settings, "1")).toBe(false);
		expect(isInstallTelemetryEnabled(settings, undefined)).toBe(false);
	});

	it("keeps /bug disabled and out of the slash commands", () => {
		expect(BUG_REPORTS_ENABLED).toBe(false);
		expect(BUILTIN_SLASH_COMMANDS.map((command) => command.name)).not.toContain("bug");
	});

	it("disables the startup version check against pi.dev, online too", async () => {
		const fetchMock = vi.fn(async () => Response.json({ version: "999.0.0" }));
		vi.stubGlobal("fetch", fetchMock);
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("process.exit");
		}) as never);

		await expect(main(["--version"])).rejects.toThrow("process.exit");

		expect(process.env.PI_SKIP_VERSION_CHECK).toBe("1");
		expect(await checkForNewPiVersion("1.0.0")).toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("updates a branded build only from the Prism site and does not query pi.dev", async () => {
		const fetchMock = vi.fn(async () => Response.json({ version: "999.0.0" }));
		vi.stubGlobal("fetch", fetchMock);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		// A source checkout is not a site installation: nothing to run, and it says how to get one.
		expect(await handlePackageCommand(["update", "--self"])).toBe(true);

		expect(fetchMock).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
		expect(errorSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
			"was not installed from https://prism.odelserver.space",
		);
		process.exitCode = undefined;
	});

	it("runs the installer shipped in the running release, against its installation", () => {
		const installDir = join(tempDir, "share", "prism");
		const release = join(installDir, "versions", "1.0.0-fork.3-1");
		const packageDir = join(release, "node_modules", "@earendil-works", "pi-coding-agent");
		mkdirSync(packageDir, { recursive: true });
		writeFileSync(join(installDir, ".prism-install"), "");
		const record = join(tempDir, "installer-call");
		writeFileSync(
			join(release, "install.sh"),
			`printf '%s %s' "$1" "$PRISM_INSTALL_DIR" > '${record}'\n[ "$2" != --channel ] || printf ' %s' "$3" >> '${record}'\nexit 3\n`,
		);

		const install = findReleaseInstall(packageDir);
		expect(install).toEqual({ installDir, installer: join(release, "install.sh") });
		expect(runPrismUpdate("rollback", install)).toBe(3);
		expect(readFileSync(record, "utf-8")).toBe(`--rollback ${installDir}`);
		expect(getSelfUpdateRequest(["update", "--check"])).toEqual({ mode: "check" });
		expect(getSelfUpdateRequest(["update", "--check", "--all"])).toBeUndefined();
		expect(getSelfUpdateRequest(["update"])).toBeUndefined();

		// --channel switches, alone or with --check, and is passed to the installer.
		expect(getSelfUpdateRequest(["update", "--channel", "canary"])).toEqual({ mode: "update", channel: "canary" });
		expect(getSelfUpdateRequest(["update", "--channel", "stable", "--check"])).toEqual({
			mode: "check",
			channel: "stable",
		});
		expect(getSelfUpdateRequest(["update", "--channel", "beta"])).toBeUndefined();
		expect(getSelfUpdateRequest(["update", "--channel"])).toBeUndefined();
		expect(getSelfUpdateRequest(["update", "--rollback", "--channel", "stable"])).toBeUndefined();
		expect(runPrismUpdate("update", install, "canary")).toBe(3);
		expect(readFileSync(record, "utf-8")).toBe(`--update ${installDir} canary`);
		expect(readReleaseChannel(install!)).toBe("stable");
		writeFileSync(join(installDir, "channel"), "canary\n");
		expect(readReleaseChannel(install!)).toBe("canary");

		// Without the installation marker it is not a site installation.
		rmSync(join(installDir, ".prism-install"));
		expect(findReleaseInstall(packageDir)).toBeUndefined();
	});

	it("shows Prism's release notes in /changelog, not upstream pi's", () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager({}));
		copyFileSync(
			fileURLToPath(new URL("../../../fork/RELEASE-NOTES.md", import.meta.url)),
			getPrismChangelogPath(tempDir),
		);
		process.env.PI_PACKAGE_DIR = tempDir;
		const chatContainer = new Container();
		// the notes open in a closable reader, newest first, and leave the conversation alone.
		let reader: Component | undefined;
		let closed = false;
		const context = {
			chatContainer,
			ui: { requestRender: vi.fn() },
			getMarkdownThemeWithSettings: () => getMarkdownTheme(),
			showExtensionCustom: (
				factory: (tui: unknown, theme: unknown, keys: unknown, done: () => void) => Component,
			) => {
				reader = factory({ terminal: { rows: 40 }, requestRender: () => {} }, undefined, undefined, () => {
					closed = true;
				});
				return Promise.resolve();
			},
		};
		const show = (InteractiveMode.prototype as unknown as { handleChangelogCommand(this: typeof context): void })
			.handleChangelogCommand;

		show.call(context);

		expect(chatContainer.children).toHaveLength(0);
		const first = reader!.render(120).join("\n");
		expect(first).toContain("What's New");
		expect(first).not.toContain("[Unreleased]");
		// A maintenance release has its own section, first.
		const newest = /\[1\.0\.0-fork\.(\d+)(?:\.\d+)?\]/.exec(first)?.[1];
		expect(newest).toBeDefined();
		expect(Number(newest)).toBeGreaterThan(3);
		for (const key of "sandbox") reader!.handleInput!(key);
		expect(reader!.render(120).join("\n")).toMatch(/match 1\/\d+/);
		reader!.handleInput!("\x1b");
		reader!.handleInput!("\x1b");
		expect(closed).toBe(true);
		expect(
			unwrapChangelog("## [1.0.0-fork.4]\n\nIntro wrapped\nhere.\n\n### Added\n\n- One item\n  wrapped.\n- Two"),
		).toBe("## [1.0.0-fork.4]\n\nIntro wrapped here.\n\n### Added\n\n- One item wrapped.\n- Two");
	});

	it("checks the Prism site at startup only when asked, and only for a site installation", async () => {
		// manual by default.
		vi.stubEnv(ENV_AGENT_DIR, join(tempDir, "no-agent-dir"));
		expect(updateMode()).toBe("manual");
		vi.unstubAllEnvs();

		const install = { installDir: tempDir, installer: join(tempDir, "install.sh") };
		const fetchLatest = vi.fn(async (_url: string | URL | Request) => new Response("1.0.0-fork.10\n"));
		expect(await checkForPrismUpdate("1.0.0-fork.9", install, fetchLatest)).toBe("1.0.0-fork.10");
		expect(String(fetchLatest.mock.calls[0][0])).toBe("https://prism.odelserver.space/releases/LATEST");
		expect(await checkForPrismUpdate("1.0.0-fork.10", install, fetchLatest)).toBeUndefined();
		expect(await checkForPrismUpdate("1.0.0-fork.9", install, async () => new Response("<html>"))).toBeUndefined();

		fetchLatest.mockClear();
		expect(await checkForPrismUpdate("1.0.0-fork.9", undefined, fetchLatest)).toBeUndefined();
		vi.stubEnv("PI_OFFLINE", "1");
		expect(await checkForPrismUpdate("1.0.0-fork.9", install, fetchLatest)).toBeUndefined();
		expect(fetchLatest).not.toHaveBeenCalled();
		vi.stubEnv("PI_OFFLINE", "");

		// stable never offers a canary, even listed in LATEST; canary offers the newer of both lists.
		const lists = (stable: string, canary?: string) =>
			vi.fn(async (url: string | URL | Request) => {
				if (String(url).endsWith("/LATEST")) return new Response(`${stable}\n`);
				return canary ? new Response(`${canary}\n`) : new Response("", { status: 404 });
			});
		expect(await checkForPrismUpdate("1.0.0-fork.9", install, lists("1.0.0-fork.9.canary.1"))).toBeUndefined();
		writeFileSync(join(tempDir, "channel"), "canary\n");
		expect(await checkForPrismUpdate("1.0.0-fork.9", install, lists("1.0.0-fork.9", "1.0.0-fork.9.canary.2"))).toBe(
			"1.0.0-fork.9.canary.2",
		);
		expect(
			await checkForPrismUpdate("1.0.0-fork.9.canary.2", install, lists("1.0.0-fork.10", "1.0.0-fork.9.canary.2")),
		).toBe("1.0.0-fork.10");
		expect(await checkForPrismUpdate("1.0.0-fork.9.canary.2", install, lists("1.0.0-fork.9"))).toBeUndefined();
		expect(isCanaryVersion("1.0.0-fork.9.canary.2")).toBe(true);
		expect(isCanaryVersion("1.0.0-fork.9")).toBe(false);

		// Maintenance releases: stable, after 9 and its earlier fixes, before 9's canaries and 10.
		expect(isCanaryVersion("1.0.0-fork.9.1")).toBe(false);
		const order = [
			"1.0.0-fork.9",
			"1.0.0-fork.9.1",
			"1.0.0-fork.9.2",
			"1.0.0-fork.9.10",
			"1.0.0-fork.9.canary.1",
			"1.0.0-fork.10",
		];
		for (const [index, version] of order.entries()) {
			for (const later of order.slice(index + 1)) {
				expect(isNewerPackageVersion(later, version), `${later} > ${version}`).toBe(true);
				expect(isNewerPackageVersion(version, later), `${version} < ${later}`).toBe(false);
			}
		}
		writeFileSync(join(tempDir, "channel"), "stable\n");
		expect(await checkForPrismUpdate("1.0.0-fork.9", install, lists("1.0.0-fork.9.1", "1.0.0-fork.9.canary.1"))).toBe(
			"1.0.0-fork.9.1",
		);
		expect(await checkForPrismUpdate("1.0.0-fork.9.2", install, lists("1.0.0-fork.9.10"))).toBe("1.0.0-fork.9.10");
		expect(await checkForPrismUpdate("1.0.0-fork.9.1", install, lists("1.0.0-fork.9"))).toBeUndefined();
		expect(await checkForPrismUpdate("1.0.0-fork.9.10", install, lists("1.0.0-fork.10"))).toBe("1.0.0-fork.10");
		writeFileSync(join(tempDir, "channel"), "canary\n");
		expect(
			await checkForPrismUpdate("1.0.0-fork.9.canary.1", install, lists("1.0.0-fork.9.1", "1.0.0-fork.9.canary.1")),
		).toBeUndefined();
		expect(await checkForPrismUpdate("1.0.0-fork.8.canary.3", install, lists("1.0.0-fork.9.1"))).toBe(
			"1.0.0-fork.9.1",
		);
	});

	// on by default; /settings › Network & web turns it off.
	it("refreshes the pi.dev model catalog automatically, unless the setting turns it off", async () => {
		process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
		const agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		const fetchMock = vi.fn(async (_url: string | URL | Request) => Response.json({ models: [] }));
		vi.stubGlobal("fetch", fetchMock);
		const runtime = await ModelRuntime.create({
			authPath: join(tempDir, "auth.json"),
			modelsPath: join(tempDir, "models.json"),
			catalogBaseUrl: "http://catalog.test",
			allowModelNetwork: false,
		});
		const catalogCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith("http://catalog.test"));
		expect(catalogCalls()).toHaveLength(0);
		await runtime.refresh({ providers: ["anthropic"] });
		expect(catalogCalls()).toHaveLength(1);

		saveGlobalSetting([MODEL_CATALOG_REFRESH_SETTING], false, agentDir);
		await runtime.refresh({ providers: ["anthropic"] });
		expect(catalogCalls()).toHaveLength(1);
		await runtime.refresh({ providers: ["anthropic"], allowNetwork: true, force: true });
		expect(catalogCalls()).toHaveLength(2);
		vi.unstubAllEnvs();
	});

	// models the provider retired leave /model without a Prism release.
	it("hides the built-in models a fresh catalog no longer lists, but not the default or models.json's", async () => {
		process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
		const agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ defaultProvider: "anthropic", defaultModel: "claude-opus-4-5" }),
		);
		writeFileSync(
			join(tempDir, "models.json"),
			JSON.stringify({ providers: { anthropic: { modelOverrides: { "claude-sonnet-4-5": { name: "Mine" } } } } }),
		);
		const listed = {
			id: "claude-new-test",
			name: "New",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({ models: [listed] }, { headers: { "last-modified": "Fri, 01 Jan 2100 00:00:00 GMT" } }),
			),
		);
		const runtime = await ModelRuntime.create({
			authPath: join(tempDir, "auth.json"),
			modelsPath: join(tempDir, "models.json"),
			catalogBaseUrl: "http://catalog.test",
			allowModelNetwork: false,
		});
		expect(runtime.getModels("anthropic").map((model) => model.id)).toContain("claude-haiku-4-5");
		await runtime.refresh({ providers: ["anthropic"], allowNetwork: true, force: true });
		expect(
			runtime
				.getModels("anthropic")
				.map((model) => model.id)
				.sort(),
		).toEqual(["claude-new-test", "claude-opus-4-5", "claude-sonnet-4-5"]);
		vi.unstubAllEnvs();
	});

	it("collapses thinking by default; the ctrl+t choice is saved", async () => {
		const agentDir = join(tempDir, "agent");
		expect(SettingsManager.create(tempDir, agentDir).getHideThinkingBlock()).toBe(true);
		const settings = SettingsManager.create(tempDir, agentDir);
		settings.setHideThinkingBlock(false);
		await settings.flush();
		expect(SettingsManager.create(tempDir, agentDir).getHideThinkingBlock()).toBe(false);
	});

	it("uses the prism theme by default, light or dark by terminal; a chosen theme wins", async () => {
		const agentDir = join(tempDir, "agent");
		expect(SettingsManager.create(tempDir, agentDir).getThemeSetting()).toBe("prism-light/prism");
		const settings = SettingsManager.create(tempDir, agentDir);
		settings.setTheme("dark");
		await settings.flush();
		expect(SettingsManager.create(tempDir, agentDir).getTheme()).toBe("dark");
	});

	it("brands a built binary: command prism, config dir .prism, fork version", () => {
		const dir = join(tempDir, "linux-x64");
		mkdirSync(dir);
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({ name: "x", version: "1.0.0", piConfig: { name: "pi" } }),
		);
		writeFileSync(join(dir, "pi"), "binary");

		execFileSync("bash", [brandScript, dir, "3"], { stdio: "pipe" });
		const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
		expect(pkg.piConfig).toEqual({ name: "prism", configDir: ".prism" });
		expect(pkg.version).toBe("1.0.0-fork.3");
		expect(readFileSync(join(dir, "prism"), "utf8")).toBe("binary");

		// Rebranding replaces the fork number instead of appending a second one.
		writeFileSync(join(dir, "pi"), "binary");
		execFileSync("bash", [brandScript, dir, "4"], { stdio: "pipe" });
		expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version).toBe("1.0.0-fork.4");
	});

	// the intermittent "executeBash should persist full output" failure in tools.test.ts.
	it("executeBash returns only once the full output file is written", async () => {
		const result = await executeBashWithOperations("seq 3000", tempDir, createLocalBashOperations());
		expect(result.truncated).toBe(true);
		const fullOutput = readFileSync(result.fullOutputPath!, "utf-8");
		expect(fullOutput.startsWith("1\n2\n3\n")).toBe(true);
		expect(fullOutput.endsWith("2999\n3000\n")).toBe(true);
	});

	it("styles /export with the Prism stylesheet, after upstream's rules", async () => {
		// Opening a session migrates the file in place, so export a copy of the fixture.
		const fixture = join(tempDir, "session.jsonl");
		writeFileSync(fixture, readFileSync(new URL("fixtures/before-compaction.jsonl", import.meta.url)));
		const html = readFileSync(
			await exportFromFile(fixture, { outputPath: join(tempDir, "out.html"), themeName: "prism" }),
			"utf-8",
		);
		const prismAt = html.indexOf(prismExportCss("prism"));
		expect(prismAt).toBeGreaterThan(html.indexOf(".tool-execution.success { background"));
		expect(prismAt).toBeLessThan(html.indexOf("</style>"));
	});

	// the assets went in as replacement strings, so "$$" lost a dollar and "$&" in
	// highlight.js became "{{HIGHLIGHT_JS}}".
	it("embeds the export's scripts byte for byte", async () => {
		const fixture = join(tempDir, "session.jsonl");
		writeFileSync(fixture, readFileSync(new URL("fixtures/before-compaction.jsonl", import.meta.url)));
		const html = readFileSync(await exportFromFile(fixture, { outputPath: join(tempDir, "out.html") }), "utf-8");
		const asset = (name: string) =>
			readFileSync(new URL(`../src/core/export-html/${name}`, import.meta.url), "utf-8");
		for (const name of ["template.js", "vendor/highlight.min.js", "vendor/marked.min.js"]) {
			expect(html.includes(asset(name)), name).toBe(true);
		}
		expect(html).toContain("$${totalCost.toFixed(3)}");
	});

	// the separator between piped text and the prompt.
	it("keeps piped text apart from the prompt and keeps its indentation", () => {
		const parsed = { messages: ["Summarize the text given"], fileArgs: [], unknownFlags: new Map(), diagnostics: [] };
		expect(buildInitialMessage({ parsed, stdinContent: "  indented\nREADME contents" }).initialMessage).toBe(
			"  indented\nREADME contents\nSummarize the text given",
		);
	});

	it("draws /export in the site's art direction, in the colours of the theme it follows", () => {
		const dark = prismExportCss("prism");
		const light = prismExportCss("prism-light");
		const logo = (css: string) => decodeURIComponent(/url\("data:image\/svg\+xml,([^"]+)"\)/.exec(css)![1]!);
		// The site's mark, stroked in the theme's ink.
		expect(logo(dark)).toContain('<path d="M16 5 28 26H4Z"/><path d="M1 19.5h8.4"/>');
		expect(logo(dark)).toContain('stroke="#f0f0ee"');
		expect(logo(light)).toContain('stroke="#111111"');
		// Hairlines and 3px corners instead of cut tiles; no clip-path is left.
		expect(dark).toContain("--prism-line: #2b2b2a");
		expect(dark).toContain("--prism-radius: 3px");
		expect(dark).not.toContain("clip-path");
		expect(dark).not.toContain("{{");
	});

	it("keeps colour in /export for the opening and for states, not for roles", () => {
		const css = prismExportCss("prism");
		// The header line leaves the mark in the dark spectrum, then turns into the neutral line.
		const beam = /linear-gradient\(90deg, (.*? 55%)\)/.exec(css)![1]!;
		expect(beam.split(", ").length).toBe(7);
		expect(beam).toMatch(/^#[0-9a-f]{6} 0%, /);
		expect(beam.endsWith("var(--prism-line) 55%")).toBe(true);
		expect(prismExportCss("prism-light")).not.toContain(beam);
		// The session tree draws roles in the inks, never in the success colour.
		const roles = css.slice(css.indexOf(".tree-role-user"), css.indexOf(".tree-marker"));
		expect(roles).toContain(".tree-role-assistant { color: var(--thinkingText); }");
		expect(roles).not.toContain("--success");
	});
});

describe("fork: paste hint on Linux", () => {
	it("mentions pasting files only on macOS", () => {
		expect(pasteTargets("linux")).toBe("images or text");
		expect(pasteTargets("darwin")).toBe("files on macOS, images, or text");
		expect(KEYBINDINGS["app.clipboard.pasteImage"].description).toBe(
			`Paste ${pasteTargets(process.platform)} from clipboard`,
		);
	});
});

describe("fork: interface mode", () => {
	it("announces helper downloads in the advanced interface only, and failures always", () => {
		const download = { type: "info", message: "Downloading fd (file search)..." } as const;
		const failure = { type: "warning", message: "Failed to download fd: fetch failed" } as const;
		expect(showsToolStatus(download, "simple")).toBe(false);
		expect(showsToolStatus(download, "advanced")).toBe(true);
		expect(showsToolStatus(failure, "simple")).toBe(true);
	});

	it("saves the interface mode globally, simple by default", () => {
		const settings = SettingsManager.inMemory();
		expect(settings.getInterfaceMode()).toBe("simple");
		settings.setInterfaceMode("advanced");
		expect(settings.getInterfaceMode()).toBe("advanced");
	});
});

// a sandbox that does not work calls ctx.shutdown() at session_start; in -p mode
// that used to do nothing, so the prompt still ran and the answer was printed.
describe("print mode and ctx.shutdown()", () => {
	it("sends no prompt and exits non-zero when an extension shuts down at start", async () => {
		const prompt = vi.fn(async () => {});
		const session = {
			sessionManager: { getHeader: () => undefined },
			agent: { subscribe: vi.fn(() => () => {}) },
			state: { messages: [] },
			bindExtensions: vi.fn(async (bindings: { shutdownHandler?: () => void }) => bindings.shutdownHandler?.()),
			subscribe: vi.fn(() => () => {}),
			prompt,
		};
		const runtimeHost = { session, dispose: vi.fn(async () => {}), setRebindSession: vi.fn() };
		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "hello",
			messages: ["again"],
		});
		expect(exitCode).toBe(1);
		expect(prompt).not.toHaveBeenCalled();
		expect(runtimeHost.dispose).toHaveBeenCalledTimes(1);
	});
});

// the model reads the docs on demand, from a short permanent pointer.
describe("fork: docs section of the system prompt", () => {
	it("points to the docs folder in a few lines, without a topic index", () => {
		const prompt = buildSystemPrompt({ contextFiles: [], skills: [], cwd: "/work" });
		const docs = /<docs>\n([\s\S]*?)\n<\/docs>/.exec(prompt)?.[1] ?? "";
		expect(docs).toContain(`Docs: ${getDocsPath()}`);
		expect(docs).toContain("only when the user asks");
		expect(docs).toContain("not in the working directory");
		// Without its three paths, which depend on the install: 1,103 characters before, 384 after.
		const text = [getDocsPath(), getReadmePath(), getExamplesPath()].reduce(
			(rest, path) => rest.replaceAll(path, ""),
			docs,
		);
		expect(text.length).toBeLessThan(450);
	});
});

describe("fork: /settings window", () => {
	it("hides the input box while /settings is open, so its border never shows on the window's edges", () => {
		const editor: Component = { render: () => ["▗▄▄▖", "▌  ▐", "▝▀▀▘"], invalidate: () => {} };
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		let hidden = false;
		const context = {
			editorContainer,
			ui: {
				terminal: { columns: 100 },
				requestRender: vi.fn(),
				showOverlay: vi.fn(() => ({
					hide: () => {
						hidden = true;
					},
				})),
			},
		};
		const show = (
			InteractiveMode.prototype as unknown as {
				showSettingsOverlay(
					this: typeof context,
					create: (done: () => void) => { component: Component; focus: Component },
				): void;
			}
		).showSettingsOverlay;
		let close: (() => void) | undefined;
		const window: Component = { render: () => ["settings"], invalidate: () => {} };

		show.call(context, (done) => {
			close = done;
			return { component: window, focus: window };
		});

		expect(context.ui.showOverlay).toHaveBeenCalledOnce();
		expect(editorContainer.render(100)).toEqual([]);
		close!();
		expect(hidden).toBe(true);
		expect(editorContainer.children).toEqual([editor]);
	});
});

describe("fork: settings written by two sessions at once", () => {
	it("merges into a settings file another session created before the lock, instead of overwriting it", () => {
		const root = mkdtempSync(join(tmpdir(), "prism-settings-race-"));
		try {
			const path = join(root, "agent", "settings.json");
			const storage = new FileSettingsStorage(root, join(root, "agent"));
			let calls = 0;
			storage.withLock("global", (current) => {
				// The other session writes the file between this session's read and its lock.
				if (calls++ === 0) {
					mkdirSync(join(root, "agent"), { recursive: true });
					writeFileSync(path, JSON.stringify({ language: "fr" }));
				}
				return JSON.stringify({ ...(current ? JSON.parse(current) : {}), theme: "session-a" });
			});
			expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ language: "fr", theme: "session-a" });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("status lines", () => {
	it("keeps an older status line's own text when the chat is re-rendered", () => {
		initTheme("dark");
		const fakeThis: any = { chatContainer: new Container(), ui: { requestRender: vi.fn() } };
		const showStatus = (InteractiveMode as any).prototype.showStatus;
		showStatus.call(fakeThis, "STATUS_ONE");
		fakeThis.chatContainer.addChild({ render: () => ["OTHER"], invalidate: () => {} });
		showStatus.call(fakeThis, "STATUS_TWO");
		// A theme change or a resize invalidates every line before the next render.
		for (const child of fakeThis.chatContainer.children) child.invalidate();
		const text = fakeThis.chatContainer.children.flatMap((child: Component) => child.render(80)).join("\n");
		expect(text).toContain("STATUS_ONE");
		expect(text.match(/STATUS_TWO/g)).toHaveLength(1);
	});
});

describe("input placeholders", () => {
	it("shows the placeholder of an empty input, and hides it once something is typed", () => {
		initTheme("dark");
		const input = new ExtensionInputComponent(
			"Source of the skill package",
			"npm:name, git:…",
			() => {},
			() => {},
		);
		input.focused = true;
		const shown = () =>
			input
				.render(60)
				.join("\n")
				.replace(/\x1b\[[0-9;]*m|\x1b_[^\x07]*\x07/g, "");
		expect(shown()).toContain("npm:name, git:…");
		input.handleInput("x");
		expect(shown()).not.toContain("npm:name");
	});
});

// fork.9 QA: `/export` rendered a pasted C program as Markdown: `/* **x** */` turned bold, indentation lost.
describe("fork: pasted code in /export", () => {
	const code = "#include <stdio.h>\n/* **not bold** */\nint main(void) {\n    return 0;\n}";
	const entry = (id: string, role: "user" | "assistant", content: unknown) =>
		({ type: "message", id, parentId: null, timestamp: "", message: { role, content } }) as unknown as SessionEntry;

	it("fences pasted code in user messages only, keyed by entry id", () => {
		const display = pastedCodeDisplay([
			entry("a", "user", code),
			entry("b", "user", [{ type: "text", text: code }]),
			entry("c", "user", "plain **prose**"),
			entry("d", "assistant", [{ type: "text", text: code }]),
		]);
		expect(Object.keys(display)).toEqual(["a", "b"]);
		expect(display.a).toBe(`\`\`\`\n${code}\n\`\`\``);
	});

	it("renders a user message from that display text", () => {
		const templateJs = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf-8");
		expect(templateJs).toContain("safeMarkedParse(userDisplay?.[entry.id] ?? text)");
	});
});

// fork.9 QA: in French, `--safe` showed upstream's startup help half in English, and an extension that failed to
// load stopped the start with an English error and hint.
describe("fork: French safe-mode start and extension failure", () => {
	afterEach(() => setLanguage("en"));

	it("translates the startup help lines and the extension failure", () => {
		setLanguage("fr");
		expect(
			[
				"to save a message for after the current task",
				"to edit waiting messages",
				"to paste images or text",
				"drop files",
				fill("{0} twice", "ctrl+c"),
				"Prism can explain its own features and look up its docs. Ask it how to use or extend Prism.",
				`${t("Error: ")}${t('Failed to load extension "/x/broken.ts": Failed to load extension: boom')}`,
				t('Hint: Start in safe mode using "prism --safe", or without extensions only using "prism -ne".'),
			].map((text) => t(text)),
		).toEqual([
			"pour garder un message pour après la tâche en cours",
			"pour modifier les messages en attente",
			"pour coller des images ou du texte",
			"glisser des fichiers",
			"ctrl+c deux fois",
			"Prism peut expliquer ses propres fonctions et chercher dans sa documentation. Demandez-lui comment l'utiliser ou l'étendre.",
			"Erreur : Impossible de charger l'extension « /x/broken.ts » : Failed to load extension: boom",
			"Conseil : démarrez en mode de secours avec « prism --safe », ou seulement sans extensions avec « prism -ne ».",
		]);
	});
});

// review, point 7: an unreadable settings.json (a typo, or a read while another session rewrites it) must
// not silently drop the sandbox rules the user set.
describe("fork: sandbox settings when settings.json cannot be read", () => {
	let agentDir: string;
	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-sandbox-settings-"));
	});
	afterEach(() => rmSync(agentDir, { recursive: true, force: true }));

	it("keeps the last rules it read rather than the defaults", () => {
		const sandbox = { hide: ["~/private"], network: { deny: ["tracker.example"] }, modes: { broad: false } };
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sandbox }));
		expect(readSandboxSettings(agentDir).hide).toEqual(["~/private"]);
		for (const broken of ["", '{"sandbox": {"hide": ["~/priv', "{ sandbox: }"]) {
			writeFileSync(join(agentDir, "settings.json"), broken);
			const settings = readSandboxSettings(agentDir);
			expect(settings.hide, broken).toEqual(["~/private"]);
			expect(settings.network.deny, broken).toEqual(["tracker.example"]);
			expect(settings.modes.broad, broken).toBe(false);
		}
		// A file the user removed means the defaults.
		rmSync(join(agentDir, "settings.json"));
		expect(readSandboxSettings(agentDir).hide).toEqual([]);
	});
});

describe("fork: session state on resume (RAM pass, gui-fork10.md § 56)", () => {
	const entry = (id: string, message: unknown) =>
		({ type: "message", id, parentId: null, timestamp: "", message }) as unknown as SessionEntry;
	const call = (id: string, name: string, args: unknown) =>
		entry(`a-${id}`, { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] });

	it("masks and shows only the calls left without a result", () => {
		const entries = [
			entry("u", { role: "user", content: "go" }),
			call("c1", "finished_tool", { path: "a.ts" }),
			entry("r1", { role: "toolResult", toolCallId: "c1", toolName: "finished_tool", content: [] }),
			call("c2", "cut_tool", { apiKey: "kept-out-of-the-view-123" }),
		];
		const view = formatSessionState(entries, [], 80).join("\n");
		expect(view).toContain("cut_tool");
		expect(view).toContain("[REDACTED]");
		expect(view).not.toContain("kept-out-of-the-view-123");
		expect(view).not.toContain("finished_tool");
	});
});

describe("fork: the context copy for extensions (RAM pass, gui-fork10.md § 56)", () => {
	it("isolates arrays and objects like structuredClone, keeping shared and circular references", () => {
		const shared = { text: "x".repeat(1000) };
		const original: Record<string, unknown> = { list: [shared, shared], when: new Date(5), nested: { n: 1 } };
		original.self = original;
		const copy = cloneSharingStrings(original);
		(copy.nested as { n: number }).n = 2;
		(copy.list as unknown[]).push("added");
		expect(original.nested).toEqual({ n: 1 });
		expect(original.list).toHaveLength(2);
		const list = copy.list as unknown[];
		expect(list[0]).not.toBe(shared);
		expect(list[0]).toBe(list[1]);
		expect(list[0]).toEqual(shared);
		expect(copy.self).toBe(copy);
		expect(copy.when).not.toBe(original.when);
		expect((copy.when as Date).getTime()).toBe(5);
	});
});

describe("fork: an anchored open names the file, not its /proc/self/fd path", () => {
	it("says the requested path when the file or a folder is missing", () => {
		const dir = mkdtempSync(join(tmpdir(), "prism-anchored-"));
		try {
			for (const physical of [join(dir, "missing.txt"), join(dir, "no-folder", "file.txt")]) {
				let message = "";
				let code: string | undefined;
				try {
					openAnchored(physical, "read");
				} catch (error) {
					message = (error as Error).message;
					code = (error as NodeJS.ErrnoException).code;
				}
				expect(message).toContain(physical);
				expect(message).not.toContain("/proc/self/fd");
				expect(code).toBe("ENOENT");
			}
			writeFileSync(join(dir, "kept.txt"), "kept");
			const { fd } = openAnchored(join(dir, "kept.txt"), "read");
			try {
				expect(readAnchored(fd).toString()).toBe("kept");
			} finally {
				closeSync(fd);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("fork: remote-pi is gone, and settings that still name it are ignored", () => {
	it("starts with a stale `+builtin:remote-pi` entry and an old data folder, with no error or warning", async () => {
		const dir = mkdtempSync(join(tmpdir(), "prism-no-remote-pi-"));
		try {
			const settings = JSON.stringify({ extensions: ["+builtin:remote-pi", "-builtin:mcp"] });
			writeFileSync(join(dir, "settings.json"), settings);
			mkdirSync(join(dir, "remote"));
			writeFileSync(join(dir, "remote", "peers.json"), "[]");

			const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, extensionFactories: builtInExtensions });
			await loader.reload();
			const loaded = loader.getExtensions();
			expect(loaded.errors).toEqual([]);
			const paths = loaded.extensions.map((extension) => extension.path);
			expect(paths).not.toContain("builtin:remote-pi");
			expect(paths).not.toContain("builtin:mcp");
			expect(paths).toContain("builtin:web");
			const commands = loaded.extensions.flatMap((extension) => [...extension.commands.keys()]);
			expect(commands.some((name) => name.startsWith("remote-pi"))).toBe(false);

			// The module list of the onboarding and /settings does not offer it, and the old entries stay untouched.
			expect(enabledModules(["+builtin:remote-pi"])).not.toContain("remote-pi");
			expect(
				builtInExtensions.some((extension) => typeof extension !== "function" && extension.name === "remote-pi"),
			).toBe(false);
			expect(readFileSync(join(dir, "settings.json"), "utf-8")).toBe(settings);
			expect(readFileSync(join(dir, "remote", "peers.json"), "utf-8")).toBe("[]");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// fork.11 CI: remembering a model's thinking level saves the settings on a prompt, and a save dropped the overrides
// applied at run time (`--theme`, the retry settings of a test).
describe("fork: run-time setting overrides survive a save", () => {
	it("keeps an applied override after another setting is saved", () => {
		const settings = SettingsManager.inMemory({ theme: "dark" });
		settings.applyOverrides({ theme: "light" });
		settings.setModelThinkingLevel("p", "m", "high");
		expect(settings.getTheme()).toBe("light");
		expect(settings.getModelThinkingLevel("p", "m")).toBe("high");
	});
});

// On the CI runner: a session started while another was saving waited 10 × 20 ms for the lock of
// settings.json, then took that for an unreadable file: it ran without the global settings and saved none.
describe("fork: a session started while another saves its settings", () => {
	it("loads the global settings without waiting for the lock, and saves its own afterwards", async () => {
		const dir = mkdtempSync(join(tmpdir(), "prism-settings-lock-"));
		try {
			const file = join(dir, "settings.json");
			writeFileSync(file, JSON.stringify({ language: "fr" }));
			// Another session's save in progress: proper-lockfile's lock folder, just taken.
			mkdirSync(`${file}.lock`);
			const settings = SettingsManager.create(dir, dir);
			expect(settings.drainErrors()).toEqual([]);
			expect(settings.getLanguage()).toBe("fr");
			rmSync(`${file}.lock`, { recursive: true });
			settings.setTheme("session-a");
			await settings.flush();
			expect(settings.drainErrors()).toEqual([]);
			expect(JSON.parse(readFileSync(file, "utf-8"))).toMatchObject({ language: "fr", theme: "session-a" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// fork.11 CI: a catch-all "{0}: {1}." pattern translated any "Label: text." sentence, French text included
// ("En vigueur  :", an English "Privacy :").
describe("fork: no catch-all label pattern", () => {
	afterEach(() => setLanguage("en"));

	it("leaves an untranslated label sentence and an already French one as they are", () => {
		setLanguage("fr");
		expect(t("Unknown label: some text.")).toBe("Unknown label: some text.");
		expect(t("En vigueur : Par défaut.")).toBe("En vigueur : Par défaut.");
	});
});

describe("fork: the system prompt's identity and the user's machine", () => {
	it("introduces a general assistant, not an expert coding one", () => {
		const prompt = buildSystemPrompt({ cwd: "/tmp", selectedTools: ["read", "bash"], contextFiles: [], skills: [] });
		expect(prompt).not.toMatch(/expert coding|coding agent harness/);
		expect(prompt).toMatch(/^You are an assistant operating inside \S+, an agent harness on the user's computer\./);
	});

	it("names the user's shell and keeps the bash tool's syntax apart", () => {
		const env = { XDG_CURRENT_DESKTOP: "KDE", XDG_SESSION_TYPE: "wayland" };
		const fish = machineContext({ ...env, SHELL: "/usr/bin/fish" });
		expect(fish).toMatch(/^System: .*KDE \(wayland\)$/m);
		expect(fish).toMatch(/^Hardware: .*RAM \d+ GB/m);
		expect(fish).toContain("User's shell: fish. Write fish syntax for commands the user types");
		expect(fish).toContain("your bash tool still runs bash");
		expect(machineContext({ SHELL: "/bin/bash" })).toMatch(/User's shell: bash\.$/);
		expect(machineContext({})).not.toContain("shell");
	});

	it("is a built-in the extensions setting can turn off", () => {
		const entry = builtInExtensions.find(
			(extension) => typeof extension !== "function" && extension.name === "machine-context",
		);
		expect(typeof entry !== "function" && entry?.builtin).toBe(true);
	});
});

describe("fork: pi's leftovers are gone", () => {
	const source = (path: string) => readFileSync(fileURLToPath(new URL(`../src/${path}`, import.meta.url)), "utf8");

	it("has no logo click animation, /arminsayshi, /dementedelves or daxnuts easter egg", () => {
		const interactive = source("modes/interactive/interactive-mode.ts");
		for (const name of ["arminsayshi", "dementedelves", "Daxnuts", "playPiLogoAnimation", "onLogoClick"]) {
			expect(interactive).not.toContain(name);
		}
	});

	it("has no analytics setting and no first-time analytics prompt", () => {
		const settings = SettingsManager.inMemory({});
		expect("getEnableAnalytics" in settings).toBe(false);
		expect(source("core/settings-manager.ts")).not.toContain("enableAnalytics");
		expect(source("cli/startup-ui.ts")).not.toContain("FirstTimeSetup");
		expect(source("main.ts")).not.toContain("showFirstTimeSetup");
	});
});
