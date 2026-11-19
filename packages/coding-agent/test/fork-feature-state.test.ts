// fork: a feature that does not work says why, in the same words in /settings > Modules,
// /help and when its command is typed: its module is off, something it needs is missing (unavailable), or the
// model cannot call the tools it works through (not supported by this model).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import { capabilitiesPath, recordDetection, writeToolCalls } from "../src/fork/capability-store.ts";
import {
	commandNotice,
	type FeatureState,
	featureStates,
	MODULE_COMMANDS,
	sessionFeatureStates,
	settingsFeatureStates,
} from "../src/fork/feature-state.ts";
import { helpEntries, helpItems } from "../src/fork/help.ts";
import { setLanguage } from "../src/fork/i18n/index.ts";
import { builtinExtensionNames } from "../src/fork/settings-domain-extras.ts";
import { groupSettingsByDomain } from "../src/fork/settings-domains.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const key = (id: string) => `<${id}>`;
const dirs: string[] = [];
const harnesses: Harness[] = [];

/** The Modules row of a module, as /settings draws it: its description and the mark after its switch. */
function modulesRow(name: string, enabled: boolean, stateOf: (module: string) => FeatureState) {
	const model = groupSettingsByDomain([], vi.fn(), {
		builtinExtensions: [{ name, enabled }],
		onBuiltinExtensionChange: vi.fn(),
		featureState: stateOf,
	});
	const item = model
		.domains()
		.find((domain) => domain.id === "modules")!
		.items()
		.find((entry) => entry.id === `builtin:${name}`)!;
	return { description: item.description ?? "", tag: model.stateTag?.(item.id) };
}

/** The /help line of a command: its description, or undefined when /help leaves it out. */
function helpLine(command: string, hasCommand: boolean, stateOf: (module: string) => FeatureState) {
	const entries = helpEntries(key, () => hasCommand, stateOf);
	const index = entries.findIndex((entry) => entry.command === `/${command}`);
	return index < 0 ? undefined : helpItems(entries)[index]!.description;
}

describe("fork: readable feature state", () => {
	beforeAll(() => initTheme("dark"));
	let agentDir = "";
	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-feature-state-"));
		dirs.push(agentDir);
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		setLanguage("en");
		for (const harness of harnesses.splice(0)) harness.cleanup();
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("off: the module's commands stay in /help and say where to turn it on, instead of going to the model", () => {
		const stateOf = featureStates({ enabled: new Set(), withTools: new Set(), cwd: agentDir });
		expect(stateOf("checkpoints")).toEqual({ state: "off" });

		// /settings: the switch says off; the description names the commands, so searching "undo" finds it.
		const row = modulesRow("checkpoints", false, stateOf);
		expect(row.tag).toBeUndefined();
		expect(row.description).toContain("Commands: /undo, /checkpoints.");

		// /help: listed, with the state in place of the usual detail; without states, left out as before.
		expect(helpLine("undo", false, stateOf)).toBe(
			"off · Undo the last turn's file changes (turn it on in /settings › Modules)",
		);
		expect(helpEntries(key, () => false).some((entry) => entry.command === "/undo")).toBe(false);

		// Typed: stopped with the reason, unless something else answers to that name.
		expect(commandNotice("undo", false, stateOf)).toEqual({
			text: "/undo: the checkpoints module is off. Turn it on in /settings › Modules.",
			stop: true,
		});
		expect(commandNotice("undo", true, stateOf)).toBeUndefined();
		expect(commandNotice("hello", false, stateOf)).toBeUndefined();

		setLanguage("fr");
		expect(helpLine("undo", false, stateOf)).toBe(
			"désactivé · Annuler les modifications de fichiers du dernier tour (activez son module dans /settings › Modules)",
		);
		expect(commandNotice("undo", false, stateOf)?.text).toBe(
			"/undo : le module checkpoints est désactivé. Activez-le dans /settings › Modules.",
		);
		// fork.9 QA: named as /settings › Modules names it.
		expect(commandNotice("files", false, () => ({ state: "off" }))?.text).toBe(
			"/files : le module fichiers est désactivé. Activez-le dans /settings › Modules.",
		);
	});

	it("unavailable: pi-lsp in a project whose language servers are not installed", () => {
		const project = join(agentDir, "project");
		mkdirSync(project);
		writeFileSync(join(project, "main.py"), "print(1)\n");
		const states = (path: string) => {
			vi.stubEnv("PATH", path);
			return featureStates({ enabled: new Set(["pi-lsp"]), withTools: new Set(["pi-lsp"]), cwd: project });
		};
		const stateOf = states(join(agentDir, "empty-bin"));
		const why = "no language server for this project's languages is installed; /lsp-setup shows how";
		expect(stateOf("pi-lsp")).toEqual({ state: "unavailable", why });

		const row = modulesRow("pi-lsp", true, stateOf);
		expect(row.tag).toBe("unavailable");
		expect(row.description.startsWith(`Unavailable: ${why}.`)).toBe(true);
		expect(helpLine("lsp", true, stateOf)).toBeUndefined(); // /help has no /lsp entry
		expect(commandNotice("lsp", true, stateOf)).toEqual({ text: `/lsp is unavailable: ${why}.`, stop: false });

		// A server on PATH makes it available; a project without code has nothing to miss.
		const bin = join(agentDir, "bin");
		mkdirSync(bin);
		writeFileSync(join(bin, "ruff"), "#!/bin/sh\n", { mode: 0o755 });
		expect(states(bin)("pi-lsp")).toEqual({ state: "on" });
		rmSync(join(project, "main.py"));
		expect(states(join(agentDir, "empty-bin"))("pi-lsp")).toEqual({ state: "on" });

		setLanguage("fr");
		writeFileSync(join(project, "main.py"), "print(1)\n");
		expect(modulesRow("pi-lsp", true, states(join(agentDir, "empty-bin"))).tag).toBe("indisponible");
	});

	// the agent's desktop without labwc showed "unavailable" only at the second
	// opening of /settings, once turned on and loaded; "your desktop" could be turned on under X11 without a word.
	it("unavailable before it is turned on: /settings marks a module off whose needs are missing", () => {
		vi.stubEnv("PATH", agentDir);
		vi.stubEnv("WAYLAND_DISPLAY", "");
		vi.stubEnv("XDG_SESSION_TYPE", "x11");
		vi.stubEnv("HYPRLAND_INSTANCE_SIGNATURE", "");
		const session = {
			extensionRunner: { getExtensionPaths: () => [], getAllRegisteredTools: () => [] },
			model: undefined,
			sessionManager: { getCwd: () => agentDir },
		};
		const stateOf = settingsFeatureStates(session);
		expect(stateOf("desktop").state).toBe("unavailable");
		expect(stateOf("user-desktop")).toEqual({
			state: "unavailable",
			why: "needs a Wayland session (Hyprland, GNOME or KDE)",
		});
		const model = groupSettingsByDomain([], vi.fn(), {
			builtinExtensions: [{ name: "desktop", enabled: false }],
			onBuiltinExtensionChange: vi.fn(),
			featureState: stateOf,
		});
		expect(model.stateTag?.("builtin:desktop")).toBe("unavailable");
		// Nothing missing: off stays off. /help and typed commands still say off first.
		expect(stateOf("checkpoints")).toEqual({ state: "off" });
		expect(sessionFeatureStates(session)("desktop")).toEqual({ state: "off" });
	});

	it("not supported by this model: a module that works through tools, with a model that cannot call them", async () => {
		const model = (id: string) => ({ provider: "box", id }) as unknown as Model<Api>;
		await recordDetection(capabilitiesPath(agentDir), "box", [
			{ id: "no-tools", vision: "no", tools: "no", reasoning: "no" },
			{ id: "tools", vision: "no", tools: "yes", reasoning: "no" },
		]);
		const session = (modules: string[], id: string) => ({
			extensionRunner: {
				getExtensionPaths: () => modules.map((name) => `builtin:${name}`),
				getAllRegisteredTools: () => [{ sourceInfo: { path: "builtin:pi-goal" } }],
			},
			model: model(id),
			sessionManager: { getCwd: () => agentDir },
		});
		const loaded = ["pi-goal", "files", "capability-gates"];
		const stateOf = sessionFeatureStates(session(loaded, "no-tools"));
		const why = "no-tools cannot call tools (its server says so), and this module works through tools";
		expect(stateOf("pi-goal")).toEqual({ state: "unsupported", why });
		// No tools of its own: not affected. Another model, or the capability gates off: tools are given.
		expect(stateOf("files")).toEqual({ state: "on" });
		expect(sessionFeatureStates(session(loaded, "tools"))("pi-goal")).toEqual({ state: "on" });
		expect(sessionFeatureStates(session(["pi-goal"], "no-tools"))("pi-goal")).toEqual({ state: "on" });

		const row = modulesRow("pi-goal", true, stateOf);
		expect(row.tag).toBe("not for this model");
		expect(row.description.startsWith(`Not supported by this model: ${why}.`)).toBe(true);
		expect(helpLine("goal", true, stateOf)).toBe(
			"not for this model · Goal: let the agent work until a goal is done (/settings › Modules says why)",
		);
		expect(commandNotice("goal", true, stateOf)).toEqual({
			text: `/goal is not supported by this model: ${why}.`,
			stop: false,
		});

		// Turned off by the user in /model-settings: the reason says so.
		await writeToolCalls(capabilitiesPath(agentDir), "box", "tools", false);
		const off = sessionFeatureStates(session(loaded, "tools"))("pi-goal");
		expect(off).toEqual({
			state: "unsupported",
			why: "tool calls are turned off for tools in /model-settings, and this module works through tools",
		});
	});

	it("knows the commands each module registers, and which modules give the model tools", async () => {
		const root = mkdtempSync(join(tmpdir(), "prism-feature-state-all-"));
		dirs.push(root);
		// Every module on, the ones off by default included.
		const settings = SettingsManager.inMemory({
			extensions: builtinExtensionNames().map((name) => `+builtin:${name}`),
		});
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir: join(root, "agent"),
			settingsManager: settings,
			extensionFactories: builtInExtensions,
		});
		await loader.reload();
		const harness = await createHarness({ resourceLoader: loader });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const runner = harness.session.extensionRunner;
		const registered = new Map<string, string[]>();
		for (const command of runner.getRegisteredCommands()) {
			const path = command.sourceInfo.path;
			if (!path.startsWith("builtin:")) continue;
			// A command may name subcommands ("name config" and the like): what is typed first is the name.
			const name = command.name.split(" ")[0]!;
			const known = registered.get(path.slice(8)) ?? [];
			if (!known.includes(name)) registered.set(path.slice(8), [...known, name]);
		}
		for (const name of builtinExtensionNames()) expect(runner.getExtensionPaths()).toContain(`builtin:${name}`);
		for (const [module, commands] of Object.entries(MODULE_COMMANDS)) {
			expect([module, [...(registered.get(module) ?? [])].sort()]).toEqual([module, [...commands].sort()]);
		}
		for (const [module, commands] of registered) {
			expect([module, MODULE_COMMANDS[module] ? "listed" : commands]).toEqual([module, "listed"]);
		}
		// session-search gives the model a tool, files does not.
		const stateOf = featureStates({
			enabled: new Set(["session-search", "files", "capability-gates"]),
			withTools: new Set(
				runner.getAllRegisteredTools().flatMap((tool) => {
					const path = tool.sourceInfo.path;
					return path.startsWith("builtin:") ? [path.slice(8)] : [];
				}),
			),
			model: { id: "m", tools: { state: "no", source: "server" } },
			cwd: root,
		});
		expect(stateOf("session-search").state).toBe("unsupported");
		expect(stateOf("files").state).toBe("on");
	});
});
