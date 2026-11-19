// fork: low-severity findings of the 2026-11-01 review; synthetic data only.
import childProcess, { spawnSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import { setLanguage } from "../src/fork/i18n/index.ts";
import permissionsExtension, { decidePermission } from "../src/fork/permissions.ts";
import { createState } from "../src/fork/prism/lib/state.ts";
import { capturePreparedRequest, serializeRequestExport } from "../src/fork/request-inspector.ts";
import { reportGitCopies, writeKept, writeOrigin } from "../src/fork/sandbox/git-orphans.ts";
import { DEFAULT_SANDBOX_SETTINGS } from "../src/fork/sandbox/layout.ts";
import { HostPolicy } from "../src/fork/sandbox/proxy.ts";
import {
	openSandboxNetwork,
	removeSessionTmpDir,
	type SandboxRuntime,
	sandboxTask,
	sessionTmpDir,
} from "../src/fork/sandbox/runtime.ts";
import { type ScheduledTask, scheduledUnits } from "../src/fork/scheduled-tasks.ts";
import { runSudo } from "../src/fork/sudo.ts";
import { installTutorial } from "../src/fork/tutorial.ts";
import { createHarness, createTestUiContext, getToolResult, type Harness } from "./suite/harness.ts";

const repo = resolve(import.meta.dirname, "../../..");
let root: string;
let agent: string;
const harnesses: Harness[] = [];

beforeEach(() => {
	root = fs.mkdtempSync(join(tmpdir(), "prism-low-review-"));
	agent = join(root, ".pi", "agent");
	fs.mkdirSync(agent, { recursive: true });
	vi.stubEnv("HOME", root);
	vi.stubEnv(ENV_AGENT_DIR, agent);
	fs.writeFileSync(join(agent, "auth.json"), "{}");
	setLanguage("en");
});

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	vi.restoreAllMocks();
	syncBuiltinESMExports();
	removeSessionTmpDir("low-review");
	vi.unstubAllEnvs();
	fs.rmSync(root, { recursive: true, force: true });
});

describe("L1", () => {
	it("refuses a credential read with the credential reason in a real faux session", async () => {
		fs.writeFileSync(join(agent, "auth.json"), '{"faux":{"key":"prism-credential-canary"}}');
		fs.writeFileSync(join(agent, "permissions.json"), '{"mode":"safe"}');
		const harness = await createHarness({
			extensionFactories: [{ name: "permissions", factory: permissionsExtension }],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "less ~/.pi/agent/auth.json" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		const result = JSON.stringify(getToolResult(harness, "bash"));
		expect(result).toMatch(/credential/);
		expect(result).not.toContain("can change Prism");
		expect(result).not.toContain("prism-credential-canary");
	});
});

describe("L3", () => {
	it.each(["EACCES", "EPERM"])("skips another uid's orphan instead of trying rm (%s)", (code) => {
		const orphan = join(root, "prism-tmp-4194399-foreign");
		fs.mkdirSync(orphan);
		vi.stubEnv("TMPDIR", root);
		const lstat = fs.lstatSync;
		vi.spyOn(fs, "lstatSync").mockImplementation(((path, options) => {
			const stat = lstat(path, options);
			if (String(path) === orphan && stat) return Object.assign(stat, { uid: (process.getuid?.() ?? 0) + 1 });
			return stat;
		}) as typeof fs.lstatSync);
		const rm = fs.rmSync;
		const remove = vi.spyOn(fs, "rmSync").mockImplementation((path, options) => {
			if (String(path) === orphan) throw Object.assign(new Error(code), { code });
			return rm(path, options);
		});
		syncBuiltinESMExports();
		expect(() => sessionTmpDir("low-review")).not.toThrow();
		expect(remove.mock.calls.some(([path]) => String(path) === orphan)).toBe(false);
		expect(fs.existsSync(orphan)).toBe(true);
	});
});

describe("L4", () => {
	it("delivers through askpass when XDG_RUNTIME_DIR contains an apostrophe", async () => {
		const runtime = join(root, "it's runtime");
		fs.mkdirSync(runtime);
		vi.stubEnv("XDG_RUNTIME_DIR", runtime);
		const sudo = join(root, "fake-sudo");
		fs.writeFileSync(
			sudo,
			'#!/bin/sh\n[ "$#" = 1 ] && exit 0\npw=$("$SUDO_ASKPASS") || exit 1\n[ "$pw" = "prism-password-canary" ]\n',
			{ mode: 0o700 },
		);
		const result = await runSudo(
			{ program: "/usr/bin/true", argv: ["/usr/bin/true"], changeable: [] },
			"prism-password-canary",
			root,
			{
				system: {
					sudo: () => ({ path: sudo }),
					uid: () => process.getuid?.() ?? 1000,
					runtimeDir: () => process.env.XDG_RUNTIME_DIR!,
				},
				timeoutMs: 5000,
			},
		);
		expect(result).toMatchObject({ exitCode: 0 });
		expect(fs.readdirSync(runtime)).toEqual([]);
	});
});

describe("L5", () => {
	it.each(["\n", "\r", "\0", "\t", "\x1b", "\x7f", "\u0085"])(
		"rejects a calendar containing control %j",
		(control) => {
			const task: ScheduledTask = {
				version: 1,
				id: "check",
				prompt: "go",
				cwd: root,
				onCalendar: `daily${control}Unit=other.service`,
				operations: [],
				budget: { minutes: 1, tools: 1 },
				catchUp: "report",
				createdAt: "2026-11-01",
			};
			expect(() => scheduledUnits(task, { command: "/usr/bin/prism", args: [] })).toThrow(/line break|control/);
			expect(
				scheduledUnits({ ...task, onCalendar: "Mon *-*-* 10:00:00" }, { command: "/usr/bin/prism", args: [] })
					.timer,
			).toContain("OnCalendar=Mon *-*-* 10:00:00");
		},
	);
});

describe("L6", () => {
	it("deny wildcards cover the bare domain; allow wildcards still only cover subdomains", async () => {
		for (const host of ["example.com", "EXAMPLE.COM.", "sub.example.com", "ssh://example.com"]) {
			const policy = new HostPolicy(
				() => ({ askNewHosts: false, allow: ["example.com"], deny: ["*.example.com"] }),
				undefined,
			);
			const network = policy.open({ command: "test" });
			expect(await network.allows(host), host).toBe(false);
			network.close();
		}
		const policy = new HostPolicy(() => ({ askNewHosts: true, allow: ["*.example.com"], deny: [] }), undefined);
		const network = policy.open({ command: "test" });
		expect(await network.allows("example.com")).toBe(false);
		expect(await network.allows("a.example.com")).toBe(true);
		expect(await network.allows("evilexample.com")).toBe(false);
		network.close();
	});
});

describe("L10", () => {
	it("protects .agents/skills with exactly the .pi/skills refusal", () => {
		for (const tool of ["write", "edit"]) {
			const reference = decidePermission(tool, { path: ".pi/skills/x/SKILL.md" }, root, { mode: "broad" });
			expect(reference.effect).toBe("block");
			expect(decidePermission(tool, { path: ".agents/skills/x/SKILL.md" }, root, { mode: "broad" })).toEqual(
				reference,
			);
		}
		expect(
			decidePermission("bash", { command: "echo x > .agents/skills/x/SKILL.md" }, root, { mode: "broad" }).effect,
		).toBe("block");
	});
});

describe("L12", () => {
	it.each(["count", "bytes"])("reports excess kept %s once per session without removing copies", (limit) => {
		const folder = join(agent, "sandbox", "git-copies");
		const count = limit === "count" ? 11 : 1;
		for (let n = 0; n < count; n++) {
			const copy = join(folder, String(n));
			fs.mkdirSync(copy, { recursive: true });
			writeOrigin(copy, join(root, "repo", ".git"), { cwd: root, command: "test", task: false });
			writeKept(copy, ["refused"]);
			if (limit === "bytes") {
				const file = join(copy, "sparse");
				fs.writeFileSync(file, "");
				fs.truncateSync(file, 1024 ** 3 + 1);
			}
		}
		const session = {};
		// The session argument lets the existing gitReport path suppress repeats, including mode changes.
		const text = reportGitCopies(folder, session).join("\n");
		expect(text).toContain("Kept Git copies exceed");
		expect(text).toContain(folder);
		expect(text).toMatch(/rm -r/);
		expect(reportGitCopies(folder, session)).toEqual([]);
		expect(reportGitCopies(folder, session, "next-session").join("\n")).toContain("Kept Git copies exceed");
		expect(reportGitCopies(folder, {}).join("\n")).toContain("Kept Git copies exceed");
		expect(fs.readdirSync(folder)).toHaveLength(count);
	});

	it("warns in the command's notes as soon as a refused task copy crosses the limit", async () => {
		// Only Git's config parser is stubbed: this test exercises keeping/reporting, without starting bubblewrap.
		const exec = childProcess.execFileSync;
		vi.spyOn(childProcess, "execFileSync").mockImplementation(((file, args, options) => {
			if (file === "git" && args?.[0] === "config" && args[2] === "-")
				return "core.repositoryformatversion\n0\0core.bare\nfalse\0";
			return exec(file, args, options);
		}) as typeof childProcess.execFileSync);
		syncBuiltinESMExports();
		const project = join(root, "project");
		fs.mkdirSync(project);
		expect(
			spawnSync("git", ["init", "-q", project], {
				env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
			}).status,
		).toBe(0);
		const folder = join(agent, "sandbox", "git-copies");
		for (let n = 0; n < 10; n++) {
			const copy = join(folder, String(n));
			fs.mkdirSync(copy, { recursive: true });
			writeOrigin(copy, join(project, ".git"), { cwd: project, command: "test", task: false });
			writeKept(copy, ["refused"]);
		}
		const settings = DEFAULT_SANDBOX_SETTINGS;
		const runtime: SandboxRuntime = {
			bwrap: "/bin/false",
			settings,
			agentDir: agent,
			seccomp: join(root, "filter"),
			policy: new HostPolicy(() => settings.network, undefined),
			tmp: sessionTmpDir("low-review"),
		};
		expect(reportGitCopies(folder, runtime.policy, runtime.tmp)).toEqual([]);
		const channel = openSandboxNetwork(runtime, { command: "test" });
		try {
			const task = sandboxTask(runtime, project, channel, ["true"], "test", { PATH: process.env.PATH, HOME: root });
			const made = fs.readdirSync(folder).find((name) => !/^\d+$/.test(name))!;
			fs.unlinkSync(join(folder, made, "metadata", "objects", "info", "alternates"));
			const notes = await task.finish();
			expect(notes.join("\n")).toContain("Kept Git copies exceed 10 copies");
			expect(reportGitCopies(folder, runtime.policy, runtime.tmp)).toEqual([]);
			expect(fs.readdirSync(folder)).toHaveLength(11);
		} finally {
			channel.close();
		}
	});
});

describe("L14", () => {
	it("masks Cookie, Set-Cookie and known environment/auth values in the real /sent export", () => {
		vi.stubEnv("PRISM_TEST_TOKEN", "opaque-env-canary-1101");
		fs.writeFileSync(join(agent, "auth.json"), '{"faux":{"key":"opaque-auth-canary-1101"}}');
		capturePreparedRequest(
			{ provider: "faux", id: "test" },
			{
				headers: { Cookie: "session=opaque-cookie-canary", "set-cookie": ["opaque-set-cookie-canary"] },
				body: "opaque-env-canary-1101 opaque-auth-canary-1101",
				ordinary: "visible",
			},
		);
		const context = { sessionManager: { getEntries: () => [] } } as unknown as ExtensionContext;
		const text = serializeRequestExport(context);
		for (const secret of [
			"opaque-cookie-canary",
			"opaque-set-cookie-canary",
			"opaque-env-canary-1101",
			"opaque-auth-canary-1101",
		])
			expect(text).not.toContain(secret);
		expect(text).toContain("visible");
	});
});

describe("L15", () => {
	it.each(["/tree", "/docs sandbox"])(
		"never sends built-in %s to the model without the Prism editor",
		async (chosen) => {
			let open: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
			const sendUserMessage = vi.fn();
			const pi = {
				registerCommand: (_name: string, options: { handler: typeof open }) => {
					open = options.handler;
				},
				on: vi.fn(),
				events: { on: vi.fn() },
				getCommands: () => [{ name: "docs", source: "extension" }],
				sendUserMessage,
			} as unknown as ExtensionAPI;
			installTutorial(pi, createState());
			const notify = vi.fn();
			const context = {
				hasUI: true,
				ui: createTestUiContext({ custom: async () => chosen as never, notify }),
			} as unknown as ExtensionContext;
			await open!("", context);
			if (chosen === "/tree") {
				expect(sendUserMessage).not.toHaveBeenCalled();
				expect(notify).toHaveBeenCalledWith(expect.stringContaining("/tree"), "info");
			} else expect(sendUserMessage).toHaveBeenCalledWith(chosen, { expandPromptTemplates: true });
		},
	);
});

describe("W2", () => {
	// The public export has no GitHub workflow.
	it.skipIf(!fs.existsSync(join(repo, ".github/workflows/ci.yml")))("CI token is read-only at workflow scope", () => {
		expect(fs.readFileSync(join(repo, ".github/workflows/ci.yml"), "utf8")).toMatch(
			/^permissions:\n {2}contents: read$/m,
		);
	});
});

describe("T1", () => {
	it.each(["missing", "blocked", "working"])("warns at exit only when bwrap is %s", (state) => {
		const script = fs.readFileSync(join(repo, "test.sh"), "utf8");
		expect(script).toMatch(/WARNING:.*real-sandbox suites.*skipped/);
		expect(script).toMatch(/bwrap --unshare-all/);
		expect(script.indexOf("real-sandbox suites")).toBeLessThan(script.indexOf('exit "$status"'));
		expect(spawnSync("bash", ["-n", join(repo, "test.sh")]).status).toBe(0);
		// Run only the exit warning, never test.sh or its test runner.
		const warning = script.match(/\tif ! command -v bwrap[\s\S]*?\tfi\n/)?.[0];
		expect(warning).toBeDefined();
		if (state !== "missing")
			fs.writeFileSync(join(root, "bwrap"), `#!/bin/sh\nexit ${state === "working" ? 0 : 1}\n`, { mode: 0o700 });
		const probe = join(root, "warning.sh");
		fs.writeFileSync(probe, `${warning}\nexit 7\n`);
		const result = spawnSync("/bin/bash", [probe], { env: { PATH: root }, encoding: "utf8" });
		expect(result.status).toBe(7);
		if (state === "working") expect(result.stderr).toBe("");
		else expect(result.stderr).toContain("WARNING: real-sandbox suites were skipped");
	});
});
