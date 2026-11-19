// fork: configuration changes through the real session gate and faux provider only.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME, ENV_AGENT_DIR } from "../src/config.ts";
import type { ExtensionUIContext, InlineExtension } from "../src/core/extensions/types.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import { readAgents } from "../src/fork/agents.ts";
import {
	configPathKind,
	SECURITY_CONFIG_NAMES,
	SECURITY_SETTING_KEYS,
	shellConfigWrite,
} from "../src/fork/config-policy.ts";
import configTool, { CONFIG_CONFIRM_TIMEOUT_MS } from "../src/fork/config-tool.ts";
import { setLanguage, t } from "../src/fork/i18n/index.ts";
import { setViewsClient } from "../src/fork/interactive-client.ts";
import permissionsExtension, { decidePermission, type Mode } from "../src/fork/permissions.ts";
import { createHarness, createTestUiContext, getMessageText, getToolResult, type Harness } from "./suite/harness.ts";

describe("fork: configure_prism", () => {
	let agentDir: string;
	const saved = process.env[ENV_AGENT_DIR];
	const harnesses: Harness[] = [];
	const settingsFile = () => join(agentDir, "settings.json");
	const setting = { action: "setting", key: "theme", value: "light" };

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-config-tool-"));
		process.env[ENV_AGENT_DIR] = agentDir;
		writeFileSync(settingsFile(), '{"theme":"dark","sandbox":{"modes":{"ask":false,"broad":false,"safe":false}}}\n');
		setLanguage("en");
	});
	afterEach(() => {
		vi.useRealTimers();
		setLanguage("en");
		for (const harness of harnesses.splice(0)) harness.cleanup();
		if (saved === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = saved;
		rmSync(agentDir, { recursive: true, force: true });
	});

	async function start(
		options: {
			mode?: Mode;
			noUI?: boolean;
			rpc?: boolean;
			select?: ExtensionUIContext["select"];
			custom?: ExtensionUIContext["custom"];
			extensions?: InlineExtension[];
		} = {},
	) {
		const harness = await createHarness({
			extensionFactories: [
				{ name: "permissions", factory: permissionsExtension },
				{ name: "config-tool", factory: configTool },
				...(options.extensions ?? []),
			],
		});
		harnesses.push(harness);
		const questions: { title: string; choices: string[]; timeout?: number }[] = [];
		await harness.session.bindExtensions(
			options.noUI
				? { mode: "print" }
				: {
						mode: options.rpc ? "rpc" : "tui",
						uiContext: createTestUiContext({
							...(options.custom ? { custom: options.custom } : {}),
							select: async (title, choices, dialog) => {
								questions.push({ title, choices, timeout: dialog?.timeout });
								return options.select ? options.select(title, choices, dialog) : choices[0];
							},
						}),
					},
		);
		if (options.mode) {
			harness.session.extensionRunner.setFlagValue("perm-mode", options.mode);
			await harness.session.extensionRunner.emit({ type: "session_start", reason: "startup" });
		}
		return { harness, questions };
	}
	async function call(
		harness: Harness,
		tool = "configure_prism",
		input: Parameters<typeof fauxToolCall>[1] = setting,
	) {
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall(tool, input), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		return getToolResult(harness, tool);
	}

	it("is an opt-in built-in module", () => {
		expect(builtInExtensions).toContainEqual({
			name: "config-tool",
			factory: configTool,
			builtin: true,
			disabledByDefault: true,
		});
	});
	it("changes an ordinary setting only after confirmation, showing old -> new", async () => {
		const { harness, questions } = await start({
			select: async (_title, choices) => {
				expect(JSON.parse(readFileSync(settingsFile(), "utf8")).theme).toBe("dark");
				return choices[0];
			},
		});
		expect((await call(harness)).isError).not.toBe(true);
		expect(JSON.parse(readFileSync(settingsFile(), "utf8")).theme).toBe("light");
		expect(questions).toHaveLength(1);
		expect(questions[0]).toMatchObject({
			timeout: CONFIG_CONFIRM_TIMEOUT_MS,
			choices: ["Allow this change once", "Refuse this change"],
		});
		expect(questions[0]!.title).toContain('theme: "dark" -> "light"');
	});
	it("keeps the original value after refusal", async () => {
		const { harness } = await start({ select: async (_title, choices) => choices[1] });
		expect((await call(harness)).isError).toBe(true);
		expect(JSON.parse(readFileSync(settingsFile(), "utf8")).theme).toBe("dark");
	});
	it.each(["ask", "broad", "unrestricted"] as const)(
		"asks every time in %s, even with an allow rule",
		async (mode) => {
			writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ allow: ["configure_prism"] }));
			const { harness, questions } = await start({ mode });
			await call(harness);
			await call(harness, "configure_prism", { ...setting, value: "dark" });
			expect(questions).toHaveLength(2);
		},
	);
	it("asks for configuration even inside a user-approved task scope", async () => {
		const { harness, questions } = await start({
			custom: async <T>() =>
				({
					operations: [{ what: "Change files", commands: [], writes: ["**"], hosts: [] }],
					minutes: 60,
					away: false,
				}) as T,
		});
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("propose_scope", { operations: [{ what: "Change files", writes: ["**"] }] }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("configure_prism", setting), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		expect(questions).toHaveLength(1);
		expect(questions[0]!.choices).toEqual(["Allow this change once", "Refuse this change"]);
		expect(JSON.parse(readFileSync(settingsFile(), "utf8")).theme).toBe("light");
	});
	it.each(SECURITY_SETTING_KEYS)("refuses security setting %s even if the user would say yes", async (key) => {
		const before = readFileSync(settingsFile(), "utf8");
		const { harness, questions } = await start({ mode: "unrestricted" });
		const result = await call(harness, "configure_prism", { action: "setting", key, value: {} });
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).toContain("Only the user");
		expect(questions).toHaveLength(0);
		expect(readFileSync(settingsFile(), "utf8")).toBe(before);
	});
	it.each(["write", "edit", "bash"])(
		"blocks %s on configuration files before unrestricted and allow rules",
		async (tool) => {
			const { harness, questions } = await start({ mode: "unrestricted" });
			const before = readFileSync(settingsFile(), "utf8");
			const input: Parameters<typeof fauxToolCall>[1] =
				tool === "bash"
					? { command: `echo '{}' > '${settingsFile()}'` }
					: tool === "edit"
						? { path: settingsFile(), edits: [{ oldText: '"dark"', newText: '"light"' }] }
						: { path: settingsFile(), content: "{}" };
			const result = await call(harness, tool, input);
			expect(result.isError).toBe(true);
			expect(getMessageText(result)).toContain("Use configure_prism");
			expect(questions).toHaveLength(0);
			expect(readFileSync(settingsFile(), "utf8")).toBe(before);
		},
	);
	it.each(SECURITY_CONFIG_NAMES)("blocks direct writes to %s, including project grants", async (name) => {
		const { harness } = await start({ mode: "unrestricted" });
		const result = await call(harness, "write", { path: join(agentDir, name), content: "{}" });
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).toContain("Only the user");
		expect(existsSync(join(agentDir, name))).toBe(false);
	});
	it.each([
		"echo '{}' > FILE",
		"echo '{}' >>FILE",
		"sed -i 's/dark/light/' FILE",
		"cp source FILE",
		"mv source FILE",
		"printf '{}' | tee FILE",
		"dd if=source of=FILE",
		"sort --output=FILE source",
		"yq -i '.x = 1' FILE",
		"bash -c 'echo x > FILE'",
		'python3 -c \'open("FILE","w").write("x")\'',
	])("blocks literal shell config writes: %s", async (command) => {
		const { harness } = await start({ mode: "unrestricted" });
		const path = join(harness.tempDir, CONFIG_DIR_NAME, "settings.json");
		mkdirSync(join(harness.tempDir, CONFIG_DIR_NAME));
		writeFileSync(path, "{}");
		const result = await call(harness, "bash", { command: command.replaceAll("FILE", path) });
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).toContain("Use configure_prism");
		expect(readFileSync(path, "utf8")).toBe("{}");
	});
	it("blocks configuration aliases and agent files", async () => {
		const { harness } = await start({ mode: "unrestricted" });
		symlinkSync(settingsFile(), join(harness.tempDir, "innocent"));
		for (const path of [
			"innocent",
			join(agentDir, "agents", "reader.md"),
			join(harness.tempDir, CONFIG_DIR_NAME, "extensions", "x.ts"),
		]) {
			expect(getMessageText(await call(harness, "write", { path, content: "x" }))).toContain("Use configure_prism");
		}
	});
	it("also blocks other tools that declare a configuration file write", async () => {
		const { harness } = await start({
			mode: "unrestricted",
			extensions: [
				{
					name: "writer",
					factory: (pi) => {
						pi.registerTool({
							name: "other_writer",
							label: "Writer",
							description: "Test writer",
							parameters: Type.Object({ path: Type.String() }),
							permissions: (input) => [{ capability: "fs.write", path: String(input.path) }],
							execute: async (_id, params) => {
								writeFileSync(params.path, "changed");
								return { content: [{ type: "text", text: "ran" }], details: {} };
							},
						});
					},
				},
			],
		});
		const before = readFileSync(settingsFile(), "utf8");
		const result = await call(harness, "other_writer", { path: settingsFile() });
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).toContain("Use configure_prism");
		expect(readFileSync(settingsFile(), "utf8")).toBe(before);
	});
	it("detects quoted paths with spaces and simple cd prefixes", async () => {
		const { harness } = await start({ mode: "unrestricted" });
		const dir = join(agentDir, "agents");
		mkdirSync(dir);
		for (const command of [
			`echo x > '${dir}/with space.md'`,
			`cd '${agentDir}' && echo '{}' > settings.json`,
			`cd '${dir}' && cp source helper.md`,
		]) {
			expect(getMessageText(await call(harness, "bash", { command }))).toContain("Use configure_prism");
		}
	});
	it("leaves configuration reads in compound commands to the normal gate", () => {
		expect(shellConfigWrite(`echo ok > ordinary.txt; cat '${settingsFile()}'; true`, agentDir)).toBeUndefined();
		// A read command still writes when its output is redirected into the configuration.
		expect(shellConfigWrite(`cat source.json > '${settingsFile()}'`, agentDir)).toBe("configuration");
	});
	it("leaves reads of configuration files as they were before the tool", () => {
		const cwd = mkdtempSync(join(tmpdir(), "prism-config-read-"));
		for (const name of ["keybindings.json", "mcp.json", "consult-models.json"]) {
			writeFileSync(join(agentDir, name), "{}");
			expect(decidePermission("read", { path: join(agentDir, name) }, cwd, { mode: "broad" }).effect).toBe("allow");
		}
		const settings = decidePermission("read", { path: settingsFile() }, cwd, { mode: "broad" });
		expect([settings.effect, settings.tier]).toEqual(["prompt", "danger"]);
		rmSync(cwd, { recursive: true, force: true });
	});
	it("finds the configuration through links, also below an entry that does not exist yet", () => {
		const real = mkdtempSync(join(tmpdir(), "prism-config-real-"));
		const linked = join(mkdtempSync(join(tmpdir(), "prism-config-link-")), "agent");
		symlinkSync(real, linked);
		process.env[ENV_AGENT_DIR] = linked;
		expect(configPathKind(join(real, "skills", "new", "SKILL.md"), real)).toBe("configuration");
		expect(configPathKind(join(real, "auth.json"), real)).toBe("security");
		const elsewhere = mkdtempSync(join(tmpdir(), "prism-config-elsewhere-"));
		symlinkSync(join(elsewhere, "missing"), join(real, "themes"));
		expect(configPathKind(join(elsewhere, "missing", "mine.json"), real)).toBe("configuration");
		expect(configPathKind(join(elsewhere, "other.json"), real)).toBeUndefined();
		for (const dir of [real, linked, elsewhere]) rmSync(dir, { recursive: true, force: true });
	});
	it("blocks removing a configuration directory or its parent", () => {
		expect(shellConfigWrite(`rm -rf '${agentDir}'`, agentDir)).toBe("configuration");
		expect(shellConfigWrite("mv .. moved-parent", agentDir)).toBe("configuration");
		expect(shellConfigWrite("rm 'ordinary.txt'", agentDir)).toBeUndefined();
		expect(shellConfigWrite("cd .. && rm -rf .", agentDir)).toBe("configuration");
		expect(shellConfigWrite(`cd /tmp; rm -rf '${agentDir}'`, agentDir)).toBe("configuration");
	});
	it("does not take the folder of a cd for the target of a later rm", () => {
		expect(
			shellConfigWrite(`cd '${agentDir}' && python3 check_tmp.py; rm -f check_tmp.py`, agentDir),
		).toBeUndefined();
		expect(shellConfigWrite(`cd '${agentDir}/..' && make; rm -f out.o`, agentDir)).toBeUndefined();
	});
	it("refuses in safe mode even with an allow rule", async () => {
		writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ allow: ["configure_prism"] }));
		const { harness, questions } = await start({ mode: "safe" });
		expect(getMessageText(await call(harness))).toContain("refused in safe mode");
		expect(questions).toHaveLength(0);
		expect(JSON.parse(readFileSync(settingsFile(), "utf8")).theme).toBe("dark");
	});
	it("refuses in read-only Plan mode even if its tool picker admitted it", async () => {
		const { harness, questions } = await start({ mode: "unrestricted" });
		harness.sessionManager.appendCustomEntry("plan-mode-state", { enabled: true });
		expect(getMessageText(await call(harness))).toContain("refused in read-only mode");
		expect(questions).toHaveLength(0);
	});
	it("rechecks safe mode after the question, before writing", async () => {
		const { harness } = await start({
			select: async (_title, choices) => {
				harness.session.extensionRunner.setFlagValue("perm-mode", "safe");
				await harness.session.extensionRunner.emit({ type: "session_start", reason: "startup" });
				return choices[0];
			},
		});
		expect(getMessageText(await call(harness))).toContain("refused in safe mode");
		expect(JSON.parse(readFileSync(settingsFile(), "utf8")).theme).toBe("dark");
	});
	it("expires an unanswered question into refusal and ignores a late yes", async () => {
		let answer: ((choice: string) => void) | undefined;
		let opened: (() => void) | undefined;
		const ready = new Promise<void>((resolve) => {
			opened = resolve;
		});
		const { harness } = await start({
			select: async () => {
				opened?.();
				return new Promise<string>((resolve) => {
					answer = resolve;
				});
			},
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const pending = call(harness);
		await ready;
		await vi.advanceTimersByTimeAsync(CONFIG_CONFIRM_TIMEOUT_MS);
		vi.useRealTimers();
		expect((await pending).isError).toBe(true);
		answer?.("Allow this change once");
		await Promise.resolve();
		expect(JSON.parse(readFileSync(settingsFile(), "utf8")).theme).toBe("dark");
	});
	it("refuses without UI even in unrestricted mode", async () => {
		const { harness } = await start({ mode: "unrestricted", noUI: true });
		const result = await call(harness);
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).toContain("at the terminal or the Prism window");
		expect(JSON.parse(readFileSync(settingsFile(), "utf8")).theme).toBe("dark");
	});
	it("refuses RPC even when its transport advertises a UI without a client", async () => {
		const { harness, questions } = await start({ mode: "unrestricted", rpc: true });
		expect(getMessageText(await call(harness))).toContain("RPC clients without dialogs are refused");
		expect(questions).toHaveLength(0);
	});
	// fork: after the refusal above, since a client that shows views stays declared for the process.
	it("asks an RPC client that declared it shows views, like the terminal", async () => {
		setViewsClient();
		const { harness, questions } = await start({ mode: "unrestricted", rpc: true });
		expect((await call(harness)).isError).not.toBe(true);
		expect(questions).toHaveLength(1);
		expect(JSON.parse(readFileSync(settingsFile(), "utf8")).theme).toBe("light");
	});
	it("saves module toggles and custom agents, showing code risks", async () => {
		const { harness, questions } = await start();
		expect(
			(await call(harness, "configure_prism", { action: "module", name: "memory", enabled: true })).isError,
		).not.toBe(true);
		expect(JSON.parse(readFileSync(settingsFile(), "utf8")).extensions).toEqual(["+builtin:memory"]);
		expect(
			(
				await call(harness, "configure_prism", {
					action: "agent",
					name: "helper",
					description: "Help",
					tools: ["bash"],
					instructions: "Review files.",
				})
			).isError,
		).not.toBe(true);
		expect(readAgents(agentDir)[0]?.name).toBe("helper");
		for (const question of questions) expect(question.title).toContain("Risk:");
	});
	it("refuses modules that are not optional built-ins, without a question", async () => {
		const { harness, questions } = await start();
		for (const name of ["module-cost-probe", "permissions", "secrets"]) {
			const result = await call(harness, "configure_prism", { action: "module", name, enabled: false });
			expect(getMessageText(result)).toContain("Unknown optional module");
		}
		expect(questions).toHaveLength(0);
		expect(JSON.parse(readFileSync(settingsFile(), "utf8")).extensions).toBeUndefined();
	});
	// Owner's decision, 2026-11-05.
	it("sets the extensions list to built-in modules only, refusing packages and files without a question", async () => {
		const { harness, questions } = await start();
		for (const value of [["npm:some-package"], ["./x.ts"], ["+builtin:memory", "/tmp/x.ts"], ["builtin:secrets"]]) {
			const result = await call(harness, "configure_prism", { action: "setting", key: "extensions", value });
			expect(getMessageText(result), JSON.stringify(value)).toContain("Only Prism's built-in modules");
		}
		expect(questions).toHaveLength(0);
		expect(
			(
				await call(harness, "configure_prism", {
					action: "setting",
					key: "extensions",
					value: ["+builtin:memory", "-builtin:web"],
				})
			).isError,
		).not.toBe(true);
		expect(JSON.parse(readFileSync(settingsFile(), "utf8")).extensions).toEqual(["+builtin:memory", "-builtin:web"]);
	});
	it("warns for shell settings and refuses changed files and security aliases", async () => {
		const { harness, questions } = await start({
			select: async (_title, choices) => {
				writeFileSync(settingsFile(), '{"theme":"other"}');
				return choices[0];
			},
		});
		expect(
			getMessageText(
				await call(harness, "configure_prism", { action: "setting", key: "shellPath", value: "/bin/sh" }),
			),
		).toContain("changed while waiting");
		expect(questions[0]!.title).toContain("Risk:");
		rmSync(settingsFile());
		writeFileSync(join(agentDir, "permissions.json"), "{}");
		symlinkSync(join(agentDir, "permissions.json"), settingsFile());
		expect(getMessageText(await call(harness))).toContain("Only the user");
	});
	it("has French texts for the question and refusals", async () => {
		setLanguage("fr");
		const { harness, questions } = await start();
		await call(harness);
		expect(questions[0]!.title).toContain("Modifier la configuration de Prism");
		expect(t("Configuration changes are refused in safe mode.")).not.toContain("Configuration changes");
	});
});
