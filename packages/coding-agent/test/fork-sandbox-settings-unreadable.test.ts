// settings.json is there but its sandbox rules cannot be known. Prism must not fall
// back on the defaults, which would drop the user's hidden paths, blocked hosts and disabled modes: with no rules
// read before, every tool call and command is refused until the file is fixed. A missing file is a new install.
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type JsonObject, type ToolResultMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import permissionsExtension from "../src/fork/permissions.ts";
import { opensWholeHome } from "../src/fork/sandbox/home-start.ts";
import { readSandboxSettings, SandboxSettingsError, sandboxSettingsProblem } from "../src/fork/sandbox/layout.ts";
import { findBwrap } from "../src/fork/sandbox/runtime.ts";
import { prepareScheduledRun, writeScheduledTask } from "../src/fork/scheduled-tasks.ts";
import { sudoExtension } from "../src/fork/sudo.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

const CANARY = "sk-settings-canary-0123456789";
const RULES = { hide: ["~/private"], network: { deny: ["tracker.example"] }, modes: { broad: false } };

describe("fork: sandbox settings that cannot be read", () => {
	let agentDir: string;
	const settingsFile = () => join(agentDir, "settings.json");
	const write = (text: string) => writeFileSync(settingsFile(), text);

	beforeEach(() => {
		// A new folder each time: no rules were read from it before, as at Prism's first start.
		agentDir = mkdtempSync(join(tmpdir(), "prism-settings-unreadable-"));
	});
	afterEach(() => {
		chmodSync(agentDir, 0o700);
		rmSync(agentDir, { recursive: true, force: true });
	});

	describe("reading", () => {
		it("refuses corrupt JSON at start, says where, and never quotes the file", () => {
			write(`{\n  "apiKey": "${CANARY}",\n  "sandbox": { "hide": ["~/private"], }\n}`);
			expect(() => readSandboxSettings(agentDir)).toThrow(SandboxSettingsError);
			const problem = sandboxSettingsProblem(agentDir)!;
			expect(problem).toContain(settingsFile());
			expect(problem).toContain("line 3, column");
			expect(problem).toContain("every tool call and command is refused");
			expect(problem).not.toContain(CANARY);
			expect(problem).not.toContain("private");
		});

		it.each([
			["a list where one is expected", { sandbox: { hide: "~/private" } }, "hide"],
			["a host list of the wrong type", { sandbox: { network: { deny: "tracker.example" } } }, "network.deny"],
			["a network that is not an object", { sandbox: { network: ["tracker.example"] } }, "network"],
			["a mode that is not a boolean", { sandbox: { modes: { broad: "false" } } }, "modes.broad"],
			["a sandbox that is not an object", { sandbox: "strict" }, "sandbox"],
		])("refuses %s rather than its default", (_name, file, field) => {
			write(JSON.stringify(file));
			expect(sandboxSettingsProblem(agentDir)).toContain(`"${field}" has the wrong type`);
		});

		it("refuses a file that is not a JSON object", () => {
			for (const text of ["null", "[]", '"sandbox"']) {
				write(text);
				expect(sandboxSettingsProblem(agentDir), text).toContain("not a JSON object");
			}
		});

		it.skipIf(process.getuid?.() === 0)("refuses a file it cannot read", () => {
			write(JSON.stringify({ sandbox: RULES }));
			chmodSync(settingsFile(), 0o000);
			expect(sandboxSettingsProblem(agentDir)).toContain("cannot be read (EACCES)");
		});

		it("keeps the rules read before when the file breaks during a session, the defaults once it is removed, and the new rules once it is fixed", () => {
			write(JSON.stringify({ sandbox: RULES }));
			expect(readSandboxSettings(agentDir).hide).toEqual(["~/private"]);
			for (const broken of ["", '{"sandbox": {"hide": ["~/priv', JSON.stringify({ sandbox: { hide: "x" } })]) {
				write(broken);
				const settings = readSandboxSettings(agentDir);
				expect(settings.hide, broken).toEqual(["~/private"]);
				expect(settings.network.deny, broken).toEqual(["tracker.example"]);
				expect(settings.modes.broad, broken).toBe(false);
			}
			// Removed on purpose: a new install, with the defaults.
			rmSync(settingsFile());
			expect(readSandboxSettings(agentDir).hide).toEqual([]);
			// Broken again with nothing read since the removal: refused, not the defaults nor the old rules.
			write("{");
			expect(sandboxSettingsProblem(agentDir)).toBeDefined();
			write(JSON.stringify({ sandbox: { hide: ["~/other"] } }));
			expect(sandboxSettingsProblem(agentDir)).toBeUndefined();
			expect(readSandboxSettings(agentDir).hide).toEqual(["~/other"]);
		});

		it("uses the defaults when there is no file", () => {
			expect(readSandboxSettings(agentDir).hide).toEqual([]);
			expect(sandboxSettingsProblem(agentDir)).toBeUndefined();
		});
	});

	describe("what depends on them", () => {
		it("leaves the sudo tool off, refuses a scheduled run and asks nothing about the home folder", () => {
			write(`{ "sandbox": { "sudo": true, } }`);
			vi.stubEnv(ENV_AGENT_DIR, agentDir);
			try {
				const registerTool = vi.fn();
				sudoExtension()({ registerTool } as unknown as ExtensionAPI);
				expect(registerTool).not.toHaveBeenCalled();
				writeScheduledTask(
					{
						version: 1,
						id: "nightly",
						prompt: "p",
						cwd: agentDir,
						onCalendar: "*-*-* 03:00",
						operations: [],
						budget: { minutes: 1, tools: 1 },
						catchUp: "report",
						createdAt: "2026-10-29T00:00:00.000Z",
					},
					agentDir,
				);
				expect(prepareScheduledRun(["--scheduled", "nightly"], { agentDir, chdir: () => {} })).toMatchObject({
					exit: 1,
					message: expect.stringContaining("Prism cannot use the sandbox settings"),
				});
				expect(opensWholeHome(agentDir, agentDir)).toBe(false);
			} finally {
				vi.unstubAllEnvs();
			}
		});
	});

	describe("a session", () => {
		let harness: Harness;
		let home: string;

		async function start(mode: "ask" | "broad" | "unrestricted", ui: boolean): Promise<void> {
			writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode, unrestrictedAccepted: true }));
			harness = await createHarness({
				extensionFactories: [{ name: "permissions", factory: permissionsExtension }],
			});
			await harness.session.bindExtensions(
				ui ? { uiContext: createTestUiContext({ select: async () => undefined }) } : {},
			);
		}

		async function call(calls: [string, JsonObject][]): Promise<ToolResultMessage[]> {
			const before = harness.session.messages.length;
			harness.setResponses([
				...calls.map(([tool, args]) => fauxAssistantMessage(fauxToolCall(tool, args), { stopReason: "toolUse" })),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("go");
			return harness.session.messages
				.slice(before)
				.filter((message): message is ToolResultMessage => message.role === "toolResult");
		}
		const text = (result: ToolResultMessage | undefined) =>
			(result?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");

		beforeEach(() => {
			home = mkdtempSync(join(tmpdir(), "prism-settings-unreadable-home-"));
			vi.stubEnv("HOME", home);
			vi.stubEnv(ENV_AGENT_DIR, agentDir);
		});
		afterEach(() => {
			harness?.cleanup();
			vi.unstubAllEnvs();
			rmSync(home, { recursive: true, force: true });
		});

		it.skipIf(!findBwrap()).each([
			["broad", true],
			["unrestricted", true],
			["ask", false],
		] as const)(
			"refuses every tool in %s mode (interface: %s), then works once the file is fixed",
			async (mode, ui) => {
				write(`{ "sandbox": ${JSON.stringify(RULES).slice(0, -1)}, }`);
				await start(mode, ui);
				const results = await call([
					["bash", { command: "echo written > out.txt" }],
					["write", { path: "other.txt", content: "x" }],
					["read", { path: "settings.json" }],
				]);
				expect(results).toHaveLength(3);
				for (const result of results) {
					expect(result.isError).toBe(true);
					expect(text(result)).toContain("Prism cannot use the sandbox settings");
				}
				expect(existsSync(join(harness.tempDir, "out.txt"))).toBe(false);
				expect(existsSync(join(harness.tempDir, "other.txt"))).toBe(false);
				// The user's own `!` commands too.
				const own = await harness.session.extensionRunner.emitUserBash({
					type: "user_bash",
					command: "echo hi",
					excludeFromContext: false,
					cwd: harness.tempDir,
				});
				expect(own?.result?.output).toContain("Prism cannot use the sandbox settings");

				write(JSON.stringify({ sandbox: RULES }));
				writeFileSync(join(harness.tempDir, "hello.txt"), "hello from the project");
				const fixed = await call([["read", { path: "hello.txt" }]]);
				expect(fixed[0]?.isError).toBe(false);
				expect(text(fixed[0])).toContain("hello from the project");
			},
		);
	});
});
