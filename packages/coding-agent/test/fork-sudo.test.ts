// fork.9 (SEC-04): the sudo tool against a fake sudo; real elevation is tested only in a throwaway VM (sudo.md).

import { ChildProcess, execFile, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME, ENV_AGENT_DIR } from "../src/config.ts";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import { setLanguage } from "../src/fork/i18n/index.ts";
import permissionsExtension, { type Mode, permissionsPanel } from "../src/fork/permissions.ts";
import { parseSandboxSettings, readSandboxSettings, saveSandboxSetting } from "../src/fork/sandbox/layout.ts";
import { sandboxPanelState, setSandboxField } from "../src/fork/sandbox-panel.ts";
import { permissionsSection } from "../src/fork/settings-permissions.ts";
import {
	resolveCommand,
	runSudo,
	type SudoSystem,
	showCommand,
	sudoEnv,
	sudoExtension,
	TRUSTED_PATH,
} from "../src/fork/sudo.ts";
import { createHarness, createTestUiContext, getToolResult, type Harness } from "./suite/harness.ts";

const PASSWORD = "fake-pass-Zq81";

vi.mock("node:child_process", { spy: true });

describe("fork: sudo tool", () => {
	let root: string;
	let agentDir: string;
	let project: string;
	let system: SudoSystem;
	const saved = process.env[ENV_AGENT_DIR];
	const harnesses: Harness[] = [];
	const calls = () => (existsSync(join(root, "calls")) ? readFileSync(join(root, "calls"), "utf8") : "");

	/** A sudo that checks the password through SUDO_ASKPASS (three tries, as sudo) and then runs the program. */
	function fakeSudo(body?: string) {
		const path = join(root, "bin", "sudo");
		writeFileSync(
			path,
			body ??
				`#!/bin/sh
echo "$*" >> '${root}/calls'
[ "$1" = "-k" ] && [ $# -eq 1 ] && exit 0
env > '${root}/env'
shift 3
for try in 1 2 3; do
	pw=$("$SUDO_ASKPASS") || { echo "sudo: no password was provided" >&2; exit 1; }
	[ "$pw" = '${PASSWORD}' ] && exec "$@"
	echo "Sorry, try again." >&2
done
exit 1
`,
		);
		chmodSync(path, 0o755);
	}

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "prism-sudo-"));
		agentDir = join(root, "agent");
		project = join(root, "project");
		mkdirSync(join(root, "bin"));
		mkdirSync(join(root, "run"), { mode: 0o700 });
		mkdirSync(agentDir);
		mkdirSync(project);
		process.env[ENV_AGENT_DIR] = agentDir;
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sandbox: { sudo: true } }));
		fakeSudo();
		system = {
			sudo: () => ({ path: join(root, "bin", "sudo") }),
			uid: () => process.getuid?.() ?? 1000,
			runtimeDir: () => join(root, "run"),
		};
		setLanguage("en");
	});
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) {
			await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			harness.cleanup();
		}
		if (saved === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = saved;
		rmSync(root, { recursive: true, force: true });
	});

	it("is off by default and cannot be replaced or turned off as a module", () => {
		expect(parseSandboxSettings({}).sudo).toBe(false);
		expect(parseSandboxSettings({ sudo: "yes" }).sudo).toBe(false);
		expect(parseSandboxSettings({}).sudoRememberPassword).toBe(false);
		expect(parseSandboxSettings({ sudoRememberPassword: "yes" }).sudoRememberPassword).toBe(false);
		const entry = builtInExtensions.find((extension) => extension.name === "sudo");
		expect(entry).toMatchObject({ name: "sudo" });
		expect(entry).not.toHaveProperty("builtin");
		expect(entry).not.toHaveProperty("replaceable");
	});

	describe("the command", () => {
		it("finds programs in the system's folders only, never through the user's PATH", () => {
			const command = resolveCommand(["id", "-u"], project, system);
			expect(command).toMatchObject({ argv: [expect.stringMatching(/\/id$/), "-u"], changeable: [] });
			if ("error" in command) return;
			expect(
				TRUSTED_PATH.some((dir) => command.program.startsWith(`${dir}/`) || command.program.startsWith("/usr/")),
			).toBe(true);
			expect(resolveCommand(["prism-no-such-program"], project, system)).toMatchObject({
				error: expect.stringContaining("was not found"),
			});
			expect(resolveCommand([], project, system)).toMatchObject({ error: expect.stringContaining("empty") });
			expect(resolveCommand(["id", "a\0b"], project, system)).toMatchObject({
				error: expect.stringContaining("NUL"),
			});
		});
		it("refuses a program the project or the user's account can change", () => {
			const script = join(project, "install.sh");
			writeFileSync(script, "#!/bin/sh\nid\n", { mode: 0o755 });
			expect(resolveCommand(["./install.sh"], project, system)).toMatchObject({
				error: expect.stringContaining("can be changed by your user account or the project"),
			});
			const own = join(root, "bin", "tool");
			writeFileSync(own, "#!/bin/sh\nid\n", { mode: 0o755 });
			expect(resolveCommand([own], project, system)).toMatchObject({
				error: expect.stringContaining("can be changed"),
			});
		});
		it("flags arguments naming files the project or the user can change", () => {
			writeFileSync(join(project, "unit.conf"), "x");
			const command = resolveCommand(["cp", "unit.conf", "/etc/unit.conf"], project, system);
			expect(command).toMatchObject({ changeable: ["unit.conf"] });
		});
		it("shows each argument as it runs", () => {
			expect(showCommand(["/usr/bin/dnf", "install", "-y", "git"])).toBe("/usr/bin/dnf install -y git");
			expect(showCommand(["/usr/bin/echo", "a b", "it's"])).toBe("/usr/bin/echo 'a b' 'it'\\''s'");
		});
		it("gives sudo a fixed PATH and nothing from the session", () => {
			process.env.LD_PRELOAD = "/tmp/evil.so";
			try {
				const env = sudoEnv("/run/askpass");
				expect(Object.keys(env).sort()).toEqual(
					[
						"PATH",
						"SUDO_ASKPASS",
						...(process.env.LANG ? ["LANG"] : []),
						...(process.env.LC_ALL ? ["LC_ALL"] : []),
					].sort(),
				);
				expect(env.PATH).toBe(TRUSTED_PATH.join(":"));
			} finally {
				delete process.env.LD_PRELOAD;
			}
		});
	});

	describe("the run", () => {
		const id = () => {
			const command = resolveCommand(["id", "-u"], project, system);
			if ("error" in command) throw new Error(command.error);
			return command;
		};
		it("hands the password to sudo once, through a helper, and clears sudo's credentials after", async () => {
			const run = await runSudo(id(), PASSWORD, project, { system, timeoutMs: 10_000 });
			expect(run).toMatchObject({ exitCode: 0, output: `${process.getuid?.()}\n` });
			expect(calls().trim().split("\n")).toEqual([
				expect.stringMatching(/^-k -A -- \/\S*\/(?:gnu)?timeout --kill-after=5s 10s \/\S*\/id -u$/),
				"-k",
			]);
			const env = readFileSync(join(root, "env"), "utf8");
			expect(env).not.toContain(PASSWORD);
			expect(env).not.toMatch(/^LD_/m);
			expect(env).toMatch(new RegExp(`^PATH=${TRUSTED_PATH.join(":")}$`, "m"));
			// The helper and its channel are gone.
			expect(readdirSync(join(root, "run"))).toEqual([]);
		});
		it("fails at once on a wrong password: sudo's retry gets nothing", async () => {
			const started = Date.now();
			const run = await runSudo(id(), "wrong", project, { system, timeoutMs: 10_000 });
			expect(run).toMatchObject({ exitCode: 1, timedOut: false });
			expect(run).toMatchObject({ passwordRefused: true });
			expect("output" in run && run.output).toContain("no password was provided");
			expect(Date.now() - started).toBeLessThan(5000);
			expect(readdirSync(join(root, "run"))).toEqual([]);
		});
		it("fails at once on a wrong password while Prism is busy", async () => {
			// On the CI runner: the FIFO was removed after its close, so a busy event
			// loop let sudo's retry open it again and wait for a writer until the command's timeout (10 of 10 here).
			const busy = setInterval(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200), 5);
			try {
				for (let round = 0; round < 3; round++) {
					const started = Date.now();
					const run = await runSudo(id(), "wrong", project, { system, timeoutMs: 10_000 });
					expect(run).toMatchObject({ exitCode: 1, timedOut: false, passwordRefused: true });
					expect(Date.now() - started).toBeLessThan(5000);
				}
			} finally {
				clearInterval(busy);
			}
			expect(readdirSync(join(root, "run"))).toEqual([]);
		});
		it("refuses a non-GNU timeout before handing over the password or running sudo", async () => {
			vi.mocked(execFile).mockImplementationOnce((...args) => {
				const callback = args.at(-1);
				if (typeof callback !== "function") throw new Error("Missing execFile callback");
				callback(null, "timeout (uutils coreutils) 0.10.0\n", "");
				return new ChildProcess();
			});
			const run = await runSudo(id(), PASSWORD, project, { system, timeoutMs: 10_000 });
			expect(run).toEqual({ error: expect.stringContaining("GNU coreutils timeout is needed") });
			expect(calls()).toBe("");
			expect(readdirSync(join(root, "run"))).toEqual([]);
		});
		it("does not hang when sudo never asks (a rule without password)", async () => {
			fakeSudo(`#!/bin/sh\n[ "$1" = "-k" ] && [ $# -eq 1 ] && exit 0\nshift 3\nexec "$@"\n`);
			const run = await runSudo(id(), PASSWORD, project, { system, timeoutMs: 10_000 });
			expect(run).toMatchObject({ exitCode: 0 });
			expect(readdirSync(join(root, "run"))).toEqual([]);
		});
		it("stops a command that runs too long", async () => {
			const sleep = resolveCommand(["sleep", "30"], project, system);
			if ("error" in sleep) throw new Error(sleep.error);
			const run = await runSudo(sleep, PASSWORD, project, { system, timeoutMs: 300 });
			expect(run).toMatchObject({ timedOut: true });
		});
		// A command ignoring SIGTERM, with a child that inherits it: the group gets SIGKILL from `timeout`.
		const stubborn = (marker: string) => ({
			program: "/bin/sh",
			argv: ["/bin/sh", "-c", `trap '' TERM; sleep ${marker} & sleep ${marker}`],
			changeable: [],
		});
		const left = (marker: string) =>
			spawnSync("pgrep", ["-f", `sleep ${marker}`])
				.stdout.toString()
				.trim();
		it("kills a command and its children that ignore SIGTERM, at the limit", async () => {
			const run = await runSudo(stubborn("41.25"), PASSWORD, project, { system, timeoutMs: 500 });
			expect(run).toMatchObject({ timedOut: true, aborted: false, unconfirmedStop: false });
			expect(left("41.25")).toBe("");
		}, 20_000);
		// fork: GNU timeout sends SIGKILL only while the command runs. When
		// the command quits on SIGTERM and its child ignores it, the stop is not claimed.
		it("does not claim the group ended when a descendant outlives the command", async () => {
			const marker = "43.25";
			const asymmetric = {
				program: "/bin/sh",
				argv: ["/bin/sh", "-c", `(trap '' TERM; exec sleep ${marker}) & wait`],
				changeable: [],
			};
			try {
				const run = await runSudo(asymmetric, PASSWORD, project, { system, timeoutMs: 500 });
				expect(run).toMatchObject({ timedOut: true, unconfirmedStop: true });
				expect(left(marker)).not.toBe("");
			} finally {
				spawnSync("pkill", ["-KILL", "-f", `sleep ${marker}`]);
			}
		}, 20_000);
		it("kills them on cancel too", async () => {
			const controller = new AbortController();
			setTimeout(() => controller.abort(), 500);
			const run = await runSudo(stubborn("42.25"), PASSWORD, project, {
				system,
				timeoutMs: 60_000,
				signal: controller.signal,
			});
			expect(run).toMatchObject({ timedOut: false, aborted: true, unconfirmedStop: false });
			expect(left("42.25")).toBe("");
		}, 20_000);
	});

	describe("the tool", () => {
		async function start(
			options: {
				mode?: Mode;
				ui?: false;
				input?: ExtensionUIContext["input"];
				sessionApproval?: boolean;
				now?: () => number;
			} = {},
		) {
			const harness = await createHarness({
				extensionFactories: [
					{ name: "permissions", factory: permissionsExtension },
					{ name: "sudo", factory: sudoExtension(system, options.now) },
				],
			});
			harnesses.push(harness);
			const questions: string[] = [];
			const passwords: { title: string; secret?: boolean }[] = [];
			const notices: string[] = [];
			await harness.session.bindExtensions(
				options.ui === false
					? { mode: "print" }
					: {
							mode: "tui",
							uiContext: createTestUiContext({
								select: async (title, choices) => {
									questions.push(title);
									return options.sessionApproval
										? choices.find((choice) => choice === "Allow sudo for this session")
										: choices[0];
								},
								notify: (message) => {
									notices.push(message);
								},
								input: async (title, placeholder, dialog) => {
									passwords.push({ title, secret: dialog?.secret });
									return options.input ? options.input(title, placeholder, dialog) : PASSWORD;
								},
							}),
						},
			);
			harness.session.extensionRunner.setFlagValue("perm-mode", options.mode ?? "ask");
			await harness.session.extensionRunner.emit({ type: "session_start", reason: "startup" });
			return { harness, questions, passwords, notices };
		}
		async function call(harness: Harness, argv: string[] = ["id", "-u"]) {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("sudo", { argv }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("go");
			return getToolResult(harness, "sudo");
		}
		const text = (result: Awaited<ReturnType<typeof call>>) =>
			result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");

		it("is not registered unless the user turned it on", async () => {
			writeFileSync(join(agentDir, "settings.json"), "{}");
			const { harness } = await start();
			expect(harness.session.getAllTools().some((tool) => tool.name === "sudo")).toBe(false);
		});
		it.each(["ask", "broad", "unrestricted"] as const)(
			"in %s, asks for the password on every call, showing the exact command",
			async (mode) => {
				const { harness, passwords } = await start({ mode });
				expect((await call(harness)).isError).not.toBe(true);
				expect((await call(harness)).isError).not.toBe(true);
				expect(passwords).toHaveLength(2);
				expect(passwords[0]).toMatchObject({ secret: true });
				expect(passwords[0]!.title).toMatch(/Run as root, outside the sandbox\?\n\n\/\S+\/id -u\n\nFolder: /);
				expect(calls().match(/^-k -A --/gm)).toHaveLength(2);
			},
		);
		it.each(["ask", "broad", "unrestricted"] as const)(
			"in %s, reuses the accepted password through a fresh askpass, but still asks for approval",
			async (mode) => {
				saveSandboxSetting(["sudoRememberPassword"], true);
				const { harness, questions, passwords } = await start({ mode });
				expect((await call(harness)).isError).not.toBe(true);
				expect((await call(harness, ["id", "-g"])).isError).not.toBe(true);
				expect(passwords).toHaveLength(1);
				expect(questions).toHaveLength(2);
				expect(questions[1]).toContain('"argv":["id","-g"]');
				expect(calls().match(/^-k -A --/gm)).toHaveLength(2);
				expect(calls().match(/^-k$/gm)).toHaveLength(2);
				expect(readFileSync(join(root, "env"), "utf8")).not.toContain(PASSWORD);
				expect(readdirSync(join(root, "run"))).toEqual([]);
			},
		);
		it("expires five minutes after typing, without extending the window on use", async () => {
			saveSandboxSetting(["sudoRememberPassword"], true);
			let now = Date.now();
			const { harness, passwords } = await start({ now: () => now });
			expect((await call(harness)).isError).not.toBe(true);
			now += 4 * 60_000;
			expect((await call(harness)).isError).not.toBe(true);
			expect(passwords).toHaveLength(1);
			now += 60_000;
			expect((await call(harness)).isError).not.toBe(true);
			expect(passwords).toHaveLength(2);
		});
		it("forgets a rejected remembered password and asks again", async () => {
			saveSandboxSetting(["sudoRememberPassword"], true);
			const { harness, passwords } = await start();
			expect((await call(harness)).isError).not.toBe(true);
			// Changing the fake account's password makes sudo refuse the remembered one.
			const path = join(root, "bin", "sudo");
			writeFileSync(path, readFileSync(path, "utf8").replace(PASSWORD, "changed-password"));
			expect((await call(harness)).isError).toBe(true);
			fakeSudo();
			expect((await call(harness)).isError).not.toBe(true);
			expect(passwords).toHaveLength(2);
		});
		it("does not remember a wrong password typed in the field", async () => {
			saveSandboxSetting(["sudoRememberPassword"], true);
			let tries = 0;
			const { harness, passwords } = await start({ input: async () => (tries++ === 0 ? "wrong" : PASSWORD) });
			expect((await call(harness)).isError).toBe(true);
			expect((await call(harness)).isError).not.toBe(true);
			expect(passwords).toHaveLength(2);
		});
		it("forgets a wrong password even when sudo permits only one attempt", async () => {
			saveSandboxSetting(["sudoRememberPassword"], true);
			const path = join(root, "bin", "sudo");
			fakeSudo(
				readFileSync(path, "utf8")
					.replace("for try in 1 2 3", "for try in 1")
					.replace("done\nexit 1", 'done\necho "sudo: 1 incorrect password attempt" >&2\nexit 1'),
			);
			let tries = 0;
			const { harness, passwords } = await start({ input: async () => (tries++ === 0 ? "wrong" : PASSWORD) });
			expect((await call(harness)).isError).toBe(true);
			expect((await call(harness)).isError).not.toBe(true);
			expect(passwords).toHaveLength(2);
		});
		it("keeps an accepted password when the command itself exits nonzero", async () => {
			saveSandboxSetting(["sudoRememberPassword"], true);
			const { harness, passwords } = await start();
			expect((await call(harness, ["false"])).isError).toBe(true);
			expect((await call(harness)).isError).not.toBe(true);
			expect(passwords).toHaveLength(1);
		});
		it("forgets immediately when disabled, even if reenabled before another call", async () => {
			saveSandboxSetting(["sudoRememberPassword"], true);
			const { harness, passwords } = await start();
			expect((await call(harness)).isError).not.toBe(true);
			saveSandboxSetting(["sudoRememberPassword"], false);
			saveSandboxSetting(["sudoRememberPassword"], true);
			expect((await call(harness)).isError).not.toBe(true);
			expect(passwords).toHaveLength(2);
		});
		it.each([false, true])("session approval covers different sudo commands; remember=%s", async (remember) => {
			saveSandboxSetting(["sudoRememberPassword"], remember);
			const { harness, questions, passwords, notices } = await start({ sessionApproval: true });
			expect((await call(harness)).isError).not.toBe(true);
			const result = await call(harness, ["id", "-g"]);
			expect(result.isError).not.toBe(true);
			expect(questions).toHaveLength(1);
			expect(passwords).toHaveLength(remember ? 1 : 2);
			if (remember) expect(text(result)).toContain("Root command: remembered password and session approval.");
			// The user sees it too, in a notice (the result stays in English for the model).
			expect(notices.includes("Root command: remembered password and session approval.")).toBe(remember);
			// The existing guard panel revokes the same grant.
			const panel = permissionsPanel(harness.session.extensionRunner.createContext())!;
			const grant = panel.snapshot().grants.find((grant) => grant.what === "Commands as root (sudo)")!;
			expect(panel.revoke(grant.index, grant.what)).toBe(true);
			expect((await call(harness)).isError).not.toBe(true);
			expect(questions).toHaveLength(2);
		});
		it("session approval and a remembered password still refuse safe mode and a missing UI", async () => {
			saveSandboxSetting(["sudoRememberPassword"], true);
			const { harness, questions, passwords } = await start({ sessionApproval: true });
			expect((await call(harness)).isError).not.toBe(true);
			harness.setResponses([fauxAssistantMessage("ok")]);
			await harness.session.prompt("/perm mode safe");
			expect((await call(harness)).isError).toBe(true);
			harness.setResponses([fauxAssistantMessage("ok")]);
			await harness.session.prompt("/perm mode broad");
			harness.session.extensionRunner.setUIContext(undefined, "print");
			expect((await call(harness)).isError).toBe(true);
			expect(questions).toHaveLength(1);
			expect(passwords).toHaveLength(1);
			expect(calls().match(/^-k -A --/gm)).toHaveLength(1);
		});
		// the mode is read again once the password is typed.
		it("runs nothing when safe mode is chosen while the password is asked", async () => {
			let toSafe = async () => {};
			const { harness, passwords } = await start({
				mode: "broad",
				input: async () => {
					await toSafe();
					return PASSWORD;
				},
			});
			toSafe = async () => {
				expect(
					await permissionsPanel(harness.session.extensionRunner.createContext())!.setMode("safe", false),
				).toBe(true);
			};
			const result = await call(harness);
			expect(result.isError).toBe(true);
			expect(text(result)).toContain("sudo is refused in safe mode, chosen while the password was asked");
			expect(passwords).toHaveLength(1);
			expect(calls()).toBe("");
		});
		it.each(["reload", "new", "resume", "fork", "quit"] as const)(
			"forgets password and approval on %s",
			async (reason) => {
				saveSandboxSetting(["sudoRememberPassword"], true);
				const { harness, questions, passwords } = await start({ sessionApproval: true });
				expect((await call(harness)).isError).not.toBe(true);
				await harness.session.extensionRunner.emit({ type: "session_shutdown", reason });
				await harness.session.extensionRunner.emit({
					type: "session_start",
					reason: reason === "quit" ? "startup" : reason,
				});
				expect((await call(harness)).isError).not.toBe(true);
				expect(questions).toHaveLength(2);
				expect(passwords).toHaveLength(2);
			},
		);
		it("offers the global setting next to sudo in both settings screens, only when sudo is on", async () => {
			const { harness } = await start();
			const deps = permissionsPanel(harness.session.extensionRunner.createContext())!.settings();
			const section = permissionsSection(deps);
			const context = { advanced: () => false, requestRender: () => {} };
			const items = section.items(context);
			expect(items[items.findIndex((item) => item.id === "sandbox-sudo") + 1]).toMatchObject({
				id: "sandbox-sudo-remember-password",
				currentValue: "off",
			});
			section.onChange?.("sandbox-sudo-remember-password", "on");
			expect(readSandboxSettings().sudoRememberPassword).toBe(true);
			setSandboxField(deps, "sudoRememberPassword", false);
			expect(readSandboxSettings().sudoRememberPassword).toBe(false);
			saveSandboxSetting(["sudo"], false);
			expect(section.items(context).some((item) => item.id === "sandbox-sudo-remember-password")).toBe(false);
			expect(
				sandboxPanelState(deps)
					.sections.flatMap((section) => section.fields)
					.some((field) => field.id === "sudoRememberPassword"),
			).toBe(false);
			const config = join(harness.tempDir, CONFIG_DIR_NAME);
			mkdirSync(config, { recursive: true });
			writeFileSync(join(config, "settings.json"), JSON.stringify({ sandbox: { sudoRememberPassword: true } }));
			expect(readSandboxSettings().sudoRememberPassword).toBe(false);
		});
		it("refuses in safe mode, without a user and when the user does not answer, running nothing", async () => {
			const safe = await start({ mode: "safe" });
			expect((await call(safe.harness)).isError).toBe(true);
			// unrestricted: the permission gate lets the call through, the tool itself refuses.
			const headless = await start({ ui: false, mode: "unrestricted" });
			expect(text(await call(headless.harness))).toContain("non-interactive");
			const refused = await start({ input: async () => undefined });
			expect(text(await call(refused.harness))).toContain("did not allow");
			expect(calls()).toBe("");
		});
		it("never puts the password in the session, the result or the model's context", async () => {
			// A sudo that leaks what it read: the result still masks it.
			fakeSudo(
				`#!/bin/sh\n[ "$1" = "-k" ] && [ $# -eq 1 ] && exit 0\nshift 3\necho "read $("$SUDO_ASKPASS")"\nexec "$@"\n`,
			);
			saveSandboxSetting(["sudoRememberPassword"], true);
			const { harness } = await start({ sessionApproval: true });
			await call(harness);
			const result = await call(harness);
			expect(text(result)).toContain("***");
			expect(JSON.stringify(result)).not.toContain(PASSWORD);
			const entries = JSON.stringify(harness.session.sessionManager.getEntries());
			expect(entries).not.toContain(PASSWORD);
			expect(JSON.stringify(harness.session.messages)).not.toContain(PASSWORD);
			expect(JSON.stringify(harness.events)).not.toContain(PASSWORD);
		});
	});
});
