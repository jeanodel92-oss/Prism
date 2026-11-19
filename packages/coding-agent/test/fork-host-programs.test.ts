/**
 * fork: what Prism runs on the host, outside the sandbox, never comes from
 * the project or from what the sandbox can write, and never runs a program the repository names. One table, one row
 * per way Prism runs a host program; the single assertion is that no hostile program left a trace.
 */

import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { execCommand } from "../src/core/exec.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { webAuthorizationUrl } from "../src/extensions/mcp/oauth.ts";
import { firefoxRunning } from "../src/fork/browser/bidi.ts";
import { flatpakPermissionText } from "../src/fork/browser/setup.ts";
import { getExtensionArgs } from "../src/fork/child-invocation.ts";
import { previewDocument } from "../src/fork/document-preview.ts";
import { addSandboxWritable, hostCommand, hostPath, resetHostPrograms } from "../src/fork/host-program.ts";
import { remoteProgram } from "../src/fork/phone-link.ts";
import { handoffFacts, handoffStaleness } from "../src/fork/project-continuity.ts";
import { projectRoot } from "../src/fork/project-permissions.ts";
import { trustedWithoutPrompt } from "../src/fork/project-trust-default.ts";
import { parseGitConfig } from "../src/fork/sandbox/git-validate.ts";
import { buildLayout, DEFAULT_SANDBOX_SETTINGS } from "../src/fork/sandbox/layout.ts";
import { type CommandNetwork, openNetworkChannel } from "../src/fork/sandbox/proxy.ts";
import { readableSet } from "../src/fork/sandbox/read-limit.ts";
import { findBwrap } from "../src/fork/sandbox/runtime.ts";
import { overrideSshFiles, sandboxWrites, sshPlan } from "../src/fork/sandbox/ssh-provenance.ts";
import { type PrismLauncher, realSystemd, unsafeLauncher } from "../src/fork/scheduled-tasks.ts";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import { getToolPath } from "../src/utils/tools-manager.ts";

const root = mkdtempSync(join(tmpdir(), "prism-host-programs-"));
const project = join(root, "project");
const home = join(root, "home");
const trace = join(root, "trace");
/** A folder of the project, first on PATH, as a virtual environment's `bin`. */
const venv = join(project, ".venv", "bin");
const realPath = process.env.PATH ?? "";
const git = (...args: string[]) =>
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: project, stdio: "ignore" });

/** Programs Prism ran by their name alone, as the PATH found them. */
const NAMED = ["rg", "fd", "pgrep", "flatpak", "systemd-analyze", "prism-remote", "sh", "notify-send", "xdg-open"];

const traced = () => (existsSync(trace) ? readFileSync(trace, "utf8") : "");
const plant = (dir: string, name: string) => {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, name), `#!/bin/sh\necho ${name} "$@" >> '${trace}'\nexit 1\n`);
	chmodSync(join(dir, name), 0o755);
};

const pi = {
	exec: (command: string, args: string[], options?: { cwd?: string; timeout?: number }) =>
		execCommand(command, args, options?.cwd ?? project, options),
} as unknown as ExtensionAPI;

beforeAll(() => {
	mkdirSync(home, { recursive: true });
	mkdirSync(join(project, "project"), { recursive: true });
	git("init", "-q");
	writeFileSync(join(project, "a.txt"), "one\n");
	writeFileSync(join(project, "project", "handoff.md"), "# Handoff\n");
	git("add", ".");
	git("commit", "-qm", "init");
	// The repository's own configuration names programs: Git would run them on status and diff.
	const hook = join(project, "hook.sh");
	writeFileSync(hook, `#!/bin/sh\necho repository-program "$@" >> '${trace}'\ncat\n`);
	chmodSync(hook, 0o755);
	git("config", "core.fsmonitor", hook);
	git("config", "filter.evil.clean", hook);
	git("config", "filter.evil.required", "true");
	writeFileSync(join(project, ".gitattributes"), "*.txt filter=evil\n");
	writeFileSync(join(project, "a.txt"), "two\n");
	for (const name of ["git", "bwrap", "which", "pdftotext", "mkfifo", ...NAMED]) plant(venv, name);
	writeFileSync(join(project, "doc.pdf"), "%PDF-1.4\n");
	// What a session's sandbox lets its commands write: the project.
	addSandboxWritable([project]);
});

afterEach(() => {
	process.env.PATH = realPath;
	rmSync(trace, { force: true });
});

afterAll(() => {
	resetHostPrograms();
	rmSync(root, { recursive: true, force: true });
});

describe("fork: host programs", () => {
	const hostilePath = () => {
		process.env.PATH = `${venv}:${realPath}`;
	};
	const rows: [string, () => unknown][] = [
		// Prism runs the bubblewrap it finds as the sandbox's own launcher: the project's is never the one.
		["findBwrap (CR-345)", () => expect(findBwrap()?.startsWith(project)).not.toBe(true)],
		["read limit, the repository's root (askGit, CR-345)", () => readableSet({ cwd: project, home, env: {} })],
		[
			"layout, the repository's configuration (CR-345)",
			() => buildLayout({ cwd: project, home, agentDir: join(home, "agent"), settings: DEFAULT_SANDBOX_SETTINGS }),
		],
		[
			"validation, a configuration read by Git (CR-345)",
			() => parseGitConfig(Buffer.from("[core]\n\tbare = false\n")),
		],
		["project permissions, the project's root", () => projectRoot(join(project, "project"))],
		["continuity, the handoff's facts (CR-228)", () => handoffFacts(pi, project)],
		["document preview, a PDF (CR-345)", () => previewDocument(join(project, "doc.pdf"))],
		// fork: run by their name, the PATH chose them. The ones that would touch
		// the user's keyring, screen or browser (secret-tool, notify-send, xdg-open…) are covered by the source check.
		["grep tool, rg (AS-021)", () => expect(getToolPath("rg")?.startsWith(project)).not.toBe(true)],
		["find tool and completion, fd (AS-021)", () => expect(getToolPath("fd")?.startsWith(project)).not.toBe(true)],
		["browser, whether Firefox runs (pgrep, AS-021)", () => firefoxRunning()],
		["browser setup, a Flatpak's permissions (AS-021)", () => flatpakPermissionText("org.example.App", home)],
		["scheduled tasks, systemd-analyze (AS-021)", () => realSystemd.analyze(["calendar", "daily"])],
		[
			"phone link, prism-remote (AS-021)",
			() => expect(remoteProgram(process.env, root)?.startsWith(project)).not.toBe(true),
		],
		// Run at each command, as the keyring's programs and the desktop's bus are.
		[
			"the sandbox network's pipes (mkfifo)",
			() => {
				try {
					openNetworkChannel(mkdtempSync(join(root, "run-")), {} as CommandNetwork).close();
				} catch {}
			},
		],
	];

	for (const [label, run] of rows) {
		it(`${label}: no program from a folder the sandbox writes`, async () => {
			hostilePath();
			await run();
			expect(traced(), label).toBe("");
		});
	}

	it("continuity runs no fsmonitor or filter the repository names", async () => {
		const facts = await handoffFacts(pi, project);
		const staleness = await handoffStaleness(pi, project);
		expect(traced()).toBe("");
		// Git still answers: the change is seen.
		expect(facts.changes ?? staleness?.newer ?? []).toBeDefined();
		expect(facts.branch).toBeTruthy();
	});

	// Review of the modules the Codex review did not read: a submodule's own configuration, which a command
	// can write in a repository it makes, and `.gitmodules` asking Git to look inside it.
	it("continuity runs no filter a submodule names, even with `ignore = none`", async () => {
		const outer = join(root, "outer");
		const nested = join(outer, "nested");
		const run = (cwd: string, ...args: string[]) =>
			execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "ignore" });
		mkdirSync(nested, { recursive: true });
		run(outer, "init", "-q");
		run(outer, "commit", "-q", "--allow-empty", "-m", "init");
		run(nested, "init", "-q");
		writeFileSync(join(nested, "f"), "a\n");
		run(nested, "add", "f");
		run(nested, "commit", "-qm", "n");
		run(nested, "config", "filter.sub.clean", join(project, "hook.sh"));
		writeFileSync(join(nested, ".gitattributes"), "* filter=sub\n");
		run(outer, "add", "nested");
		writeFileSync(
			join(outer, ".gitmodules"),
			'[submodule "nested"]\n\tpath = nested\n\turl = ./nested\n\tignore = none\n',
		);
		// Older than the index: Git would refresh it through the filter.
		execFileSync("touch", ["-d", "2001-01-01", join(nested, "f")]);
		const facts = await handoffFacts(pi, outer);
		await handoffStaleness(pi, outer);
		expect(traced()).toBe("");
		expect(facts.changes).toContain("nested");
	});

	it("names no program from a folder the sandbox writes, nor gives one to the installer's PATH (AS-021)", () => {
		hostilePath();
		for (const name of NAMED) expect(hostCommand(name).startsWith(project), name).toBe(false);
		expect(hostCommand("notify-send")).not.toBe("notify-send");
		expect(hostPath().split(":")).not.toContain(venv);
		expect(hostPath(`${venv}:relative/bin:/usr/bin`)).toBe("/usr/bin");
	});

	// fork: `spawn("rg", …)` lets the PATH choose; the list of such calls is made
	// whole by this check, so it does not grow back. A program goes through hostCommand, hostProgram or a path.
	it("no shipped code passes a bare program name to spawn or execFile (AS-021)", () => {
		const allowed = new Set([
			// The RPC client is a library for programs that embed Prism: their PATH, their choice.
			"src/modes/rpc/rpc-client.ts:node",
			// Looked up only when /bin/bash is missing, to find a shell.
			"src/utils/shell.ts:where",
			"src/utils/shell.ts:which",
		]);
		const found: string[] = [];
		// The TUI library too: Prism runs its terminal probe (`tmux`), through setTmuxProgram.
		for (const src of [join(import.meta.dirname, "..", "src"), join(import.meta.dirname, "..", "..", "tui", "src")]) {
			const files = (readdirSync(src, { recursive: true }) as string[]).filter((file) => file.endsWith(".ts"));
			for (const file of files) {
				const text = readFileSync(join(src, file), "utf8");
				const calls =
					/\b(?:spawn|spawnSync|execFile|execFileSync)\(\s*"([^"/]+)"|\b(?:exec|execSync)\(\s*["'`]([\w-]+)/g;
				for (const match of text.matchAll(calls)) {
					const key = `${relative(join(src, ".."), join(src, file))}:${match[1] ?? match[2]}`;
					if (!allowed.has(key)) found.push(key);
				}
			}
		}
		expect(found).toEqual([]);
	});

	it("a user's PATH folder the sandbox cannot write is still used", () => {
		const own = join(root, "own-bin");
		mkdirSync(own, { recursive: true });
		const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
		writeFileSync(join(own, "bwrap"), "#!/bin/sh\nexit 0\n");
		chmodSync(join(own, "bwrap"), 0o755);
		expect(findBwrap(`${venv}:${own}`)).toBe(join(own, "bwrap"));
		expect(real).toBeTruthy();
	});
});

describe("fork: what ssh would run from the user's configuration", () => {
	const work = join(root, "work");
	const a = join(work, "a");
	const spaced = join(root, "my project");
	const sshHome = join(root, "ssh-home");
	const bin = join(root, "ssh-bin");
	const writes = () => sandboxWrites({ writable: [a, spaced], readOnly: [], hidden: [] });
	const env = {
		PATH: `${bin}:/usr/bin`,
		SHELL: "/bin/sh",
		SSH_PROXY_SCRIPT: join(a, "proxy"),
		SKLIB: join(a, "sk.so"),
	};
	const plan = (config: string) => {
		writeFileSync(join(sshHome, ".ssh", "config"), `${config}\n`);
		return sshPlan(writes(), "ssh", env);
	};

	beforeAll(() => {
		for (const dir of [join(sshHome, ".ssh"), a, spaced, bin]) mkdirSync(dir, { recursive: true });
		writeFileSync(join(bin, "ssh"), "#!/bin/sh\n", { mode: 0o755 });
		writeFileSync(join(a, "ssh.conf"), "Match exec /bin/true\n");
		writeFileSync(join(a, "proxy"), "#!/bin/sh\n", { mode: 0o755 });
		writeFileSync(join(spaced, "proxy"), "#!/bin/sh\n", { mode: 0o755 });
		symlinkSync("/bin/true", join(a, "linked"));
		overrideSshFiles({ home: sshHome, system: join(root, "no-system-config") });
	});
	afterAll(() => overrideSshFiles(undefined));

	it("keeps an ordinary configuration", () => {
		expect(plan("Host gh\n  ProxyCommand /usr/bin/nc %h %p\n  ControlPath ~/.ssh/cm-%C")).toMatchObject({
			options: [],
		});
	});

	const refused: [string, string][] = [
		["an Include pattern a project's file can match, before it exists (CR-342)", `Include ${work}/*/new.conf`],
		["an Include with a POSIX class (CR-342)", `Include ${work}/[[:alpha:]]/ssh.conf`],
		["a quoted ProxyCommand path with a space (CR-343)", `Host x\n  ProxyCommand "${spaced}/proxy" %h %p`],
		["a ProxyCommand pattern (CR-343)", `Host x\n  ProxyCommand ${work}/*/proxy %h %p`],
		["a ProxyCommand variable (CR-343)", 'Host x\n  ProxyCommand "$SSH_PROXY_SCRIPT" %h %p'],
		["a link in the project to a protected program (CR-344)", `Host x\n  ProxyCommand ${a}/linked %h %p`],
		["an Include whose folder is a token of the destination (CR-354)", `Include ${work}/%n/ssh.conf`],
		["a ProxyCommand whose folder is a token (CR-354)", `Host x\n  ProxyCommand ${work}/%n/proxy %h %p`],
		["a provider named by a variable without braces (CR-354)", "Host x\n  SecurityKeyProvider $SKLIB"],
	];
	for (const [label, config] of refused) {
		it(`refuses ${label}`, () => {
			expect(typeof plan(config), label).toBe("string");
		});
	}
});

describe("fork: arguments of the programs Prism starts", () => {
	it("passes a sub-agent the parsed extensions, never words of the prompt", () => {
		const argv = process.argv;
		process.argv = [argv[0]!, argv[1]!, "--", "--extension=./payload.ts", "-e", "x.ts"];
		try {
			expect(getExtensionArgs()).toEqual([]);
		} finally {
			process.argv = argv;
		}
	});

	it("gives a scheduled prompt that starts with a dash as the prompt", () => {
		for (const prompt of ["- Inspect changes\n- Report failures", "--version"]) {
			const parsed = parseArgs(["--perm-mode", "ask", "-p", "--", prompt]);
			expect(parsed.messages).toEqual([prompt]);
			expect(parsed.version ?? false).toBe(false);
			expect(parsed.print).toBe(true);
		}
	});

	it("refuses to schedule a Prism that Node starts with a project's module, `--import=` included", () => {
		const installed = join(root, "installed");
		const cli = join(installed, "cli.js");
		mkdirSync(installed, { recursive: true });
		writeFileSync(cli, "");
		writeFileSync(join(project, "bootstrap.mjs"), "");
		for (const loader of [
			`--import=${join(project, "bootstrap.mjs")}`,
			"--import=./bootstrap.mjs",
			"--require=tsx",
		]) {
			const launcher: PrismLauncher = {
				invocation: (id) => ({ command: process.execPath, args: [loader, cli, "--scheduled", id] }),
				packageDir: () => installed,
			};
			expect(unsafeLauncher(launcher, project, home), loader).toBeTruthy();
		}
	});

	it("keeps a refused folder refused while it has no project resources yet", () => {
		expect(trustedWithoutPrompt(false, false)).toBe(false);
		expect(trustedWithoutPrompt(null, false)).toBe(true);
		expect(trustedWithoutPrompt(null, true)).toBe(false);
		expect(trustedWithoutPrompt(true, true)).toBe(true);
	});

	it("installs no package of the settings in safe mode", async () => {
		const agentDir = join(root, "safe-agent");
		mkdirSync(agentDir, { recursive: true });
		const installs = vi
			.spyOn(
				DefaultPackageManager.prototype as unknown as { installParsedSource: () => Promise<void> },
				"installParsedSource",
			)
			.mockRejectedValue(new Error("installed in safe mode"));
		// The suite runs offline, where nothing is installed at all; the install is mocked, nothing is fetched.
		const offline = process.env.PI_OFFLINE;
		delete process.env.PI_OFFLINE;
		try {
			const loader = new DefaultResourceLoader({
				cwd: project,
				agentDir,
				settingsManager: SettingsManager.inMemory({ packages: ["npm:prism-missing-package@1.0.0"] }),
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			});
			await loader.reload();
			expect(installs).not.toHaveBeenCalled();
			// Without --safe, the same settings do install it: the row measures the install.
			const normal = new DefaultResourceLoader({
				cwd: project,
				agentDir,
				settingsManager: SettingsManager.inMemory({ packages: ["npm:prism-missing-package@1.0.0"] }),
			});
			await normal.reload().catch(() => undefined);
			expect(installs).toHaveBeenCalled();
		} finally {
			installs.mockRestore();
			if (offline !== undefined) process.env.PI_OFFLINE = offline;
		}
	});

	it("starts the RPC client's own package, never the opened folder's dist/cli.js", async () => {
		const pkg = join(root, "rpc-package");
		for (const [dir, who] of [
			[pkg, "package"],
			[project, "project"],
		] as const) {
			mkdirSync(join(dir, "dist"), { recursive: true });
			writeFileSync(
				join(dir, "dist", "cli.js"),
				`require("node:fs").appendFileSync(${JSON.stringify(trace)}, "${who}\\n");\n`,
			);
		}
		const previous = process.env.PI_PACKAGE_DIR;
		process.env.PI_PACKAGE_DIR = pkg;
		const client = new RpcClient({ cwd: project });
		try {
			await client.start().catch(() => undefined);
			// Node may take longer than the client's first wait to start under load.
			await vi.waitFor(() => expect(traced()).not.toBe(""), { timeout: 10_000 });
		} finally {
			await client.stop().catch(() => undefined);
			if (previous === undefined) delete process.env.PI_PACKAGE_DIR;
			else process.env.PI_PACKAGE_DIR = previous;
		}
		expect(traced()).toBe("package\n");
	});

	it("opens only a web page to sign in to an MCP server", () => {
		for (const url of [
			"https://auth.example/authorize",
			"http://127.0.0.1:8080/a",
			"http://localhost/a",
			"http://[::1]/a",
		])
			expect(webAuthorizationUrl(new URL(url)).href).toBe(new URL(url).href);
		for (const url of ["file:///etc/passwd", "vscode://x/y", "http://auth.example/authorize"])
			expect(() => webAuthorizationUrl(new URL(url)), url).toThrow();
	});
});
