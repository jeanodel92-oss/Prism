// fork: the sandbox for shell commands. The layout tests are pure; the
// others run real commands in a real bubblewrap sandbox and are skipped, with a note, on a machine without it.
import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import {
	createServer as createNetServer,
	type Server as NetServer,
	connect as netConnect,
	type Socket,
} from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { type Duplex, PassThrough } from "node:stream";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME, ENV_AGENT_DIR } from "../src/config.ts";
import { emitSessionShutdownEvent } from "../src/core/extensions/runner.ts";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";
import backgroundExtension from "../src/fork/background.ts";
import { setLanguage, t } from "../src/fork/i18n/index.ts";
import type { PermView } from "../src/fork/perm-view.ts";
import permissionsExtension from "../src/fork/permissions.ts";
import { addProjectHost, readProjectGrants, removeProjectHost } from "../src/fork/project-permissions.ts";
import type * as DnsGuardModule from "../src/fork/sandbox/dns-guard.ts";
import { type GitSshRequest, gitSshCommand, serveGitSsh } from "../src/fork/sandbox/git-ssh.ts";
import {
	buildLayout,
	bwrapArgs,
	DEFAULT_SANDBOX_SETTINGS,
	isExcludedCommand,
	parseSandboxSettings,
	pinnedFolders,
	type SandboxSettings,
} from "../src/fork/sandbox/layout.ts";
import { likelyHosts } from "../src/fork/sandbox/likely-hosts.ts";
import { Mux } from "../src/fork/sandbox/mux.ts";
import {
	describeSandbox,
	networkRefusalNote,
	sandboxPromptSection,
	sandboxResultNote,
} from "../src/fork/sandbox/notes.ts";
import {
	type CommandNetwork,
	DEFAULT_NETWORK_SETTINGS,
	type HostAnswer,
	HostPolicy,
	matchesHost,
	type NetworkSettings,
	serveProxyStream,
} from "../src/fork/sandbox/proxy.ts";
import { findBwrap, removeSessionTmpDir, sessionSandbox, sessionTmpDir } from "../src/fork/sandbox/runtime.ts";
import { seccompFilter } from "../src/fork/sandbox/seccomp.ts";
import { closeSessionNet, sessionNetReport } from "../src/fork/sandbox/session-net.ts";
import { includedSshFiles, sshConfigCopies } from "../src/fork/sandbox/ssh-config.ts";
import { overrideSshFiles } from "../src/fork/sandbox/ssh-provenance.ts";
import { settingsSections } from "../src/fork/settings-sections.ts";
import type { ScopeApproval, ScopeView } from "../src/fork/task-scope.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, createTestUiContext, getToolResult, type Harness } from "./suite/harness.ts";

// fork: 127.0.0.2 stands for a host of the network in these tests; every other loopback address stays
// this machine, allowed port by port, and the sandbox's own loopback through the proxy (SEC-07).
vi.mock("../src/fork/sandbox/dns-guard.ts", async (importOriginal) => {
	const original = await importOriginal<typeof DnsGuardModule>();
	const isMachineAddress: typeof original.isMachineAddress = (address, ...rest) =>
		address !== "127.0.0.2" && original.isMachineAddress(address, ...rest);
	const isSandboxLoopback: typeof original.isSandboxLoopback = (host) =>
		host !== "127.0.0.2" && original.isSandboxLoopback(host);
	return { ...original, isMachineAddress, isSandboxLoopback };
});

describe("fork: sandbox layout", () => {
	// The layout that reads everything; the limited one has its own tests (fork-read-limit.test.ts).
	const settings = (extra: Partial<SandboxSettings> = {}): SandboxSettings => ({
		...DEFAULT_SANDBOX_SETTINGS,
		read: { ...DEFAULT_SANDBOX_SETTINGS.read, limit: "all" },
		...extra,
	});

	it("reads the settings, keeping defaults for wrong types; on in every mode but unrestricted by default", () => {
		expect(parseSandboxSettings(undefined)).toEqual(DEFAULT_SANDBOX_SETTINGS);
		expect(parseSandboxSettings({ modes: { ask: true, broad: "no" }, allowWrite: [1], hide: ["~/x"] })).toEqual({
			...DEFAULT_SANDBOX_SETTINGS,
			modes: { broad: true, ask: true, safe: true, unrestricted: false },
			hide: ["~/x"],
		});
		// The removed system bus setting is dropped when read.
		expect(parseSandboxSettings({ allowSystemBus: true })).toEqual(DEFAULT_SANDBOX_SETTINGS);
	});

	it("writes the project, /tmp and caches; hides credentials, the agent dir and the session sockets", () => {
		const present = new Set([
			"/p",
			"/tmp",
			"/h/.npm",
			"/h/.ssh",
			"/h/.netrc",
			"/agent",
			"/run/user/1000",
			"/run/dbus",
			"/p/.git",
			"/p/.git/hooks",
			`/p/${CONFIG_DIR_NAME}`,
			"/h/extra",
			// fork: the phone link's folder, beside the agent folder.
			"/h/.prism/remote",
		]);
		const layout = buildLayout({
			cwd: "/p",
			home: "/h",
			agentDir: "/agent",
			uid: 1000,
			settings: settings({ allowWrite: ["~/extra"] }),
			exists: (path) => present.has(path),
		});
		expect(layout.writable).toEqual(["/p", "/h/.npm", "/h/extra"]);
		expect(layout.readOnly).toEqual(expect.arrayContaining([`/p/${CONFIG_DIR_NAME}`, "/p/.git"]));
		expect(layout.hidden).toEqual([
			"/agent",
			"/h/.prism/remote",
			"/run/user/1000",
			"/run/dbus",
			"/h/.ssh",
			"/h/.netrc",
		]);
		const open = buildLayout({
			cwd: "/p",
			home: "/h",
			agentDir: "/agent",
			uid: 1000,
			// The removed setting, still in an old settings.json, opens nothing.
			settings: parseSandboxSettings({ allowSystemBus: true, read: { limit: "all" } }),
			exists: (path) => present.has(path),
		});
		expect(open.hidden).toContain("/run/dbus");
	});

	it("mounts on real paths: Ubuntu's /var/run is an absolute link that bubblewrap cannot mount through", () => {
		const present = new Set(["/p", "/tmp", "/run/dbus", "/var/run/dbus", "/h/.ssh", "/h/link"]);
		const real: Record<string, string> = { "/var/run/dbus": "/run/dbus", "/h/link": "/data/shared" };
		const layout = buildLayout({
			cwd: "/p",
			home: "/h",
			agentDir: "/agent",
			uid: 1000,
			settings: settings({ allowWrite: ["~/link"] }),
			exists: (path) => present.has(path),
			realpath: (path) => real[path] ?? path,
		});
		expect(layout.hidden).toEqual(["/run/dbus", "/h/.ssh"]);
		expect(layout.writable).toEqual(["/p", "/data/shared"]);
	});

	// fork: the journal, crash dumps and local mail held the user's secrets.
	it("hides the journal, crash dumps and local mail, unless read.allow shows one again", () => {
		const present = new Set([
			"/p",
			"/var/log/journal",
			"/run/log/journal",
			"/var/lib/systemd/coredump",
			"/var/mail",
			"/var/spool/mail",
		]);
		const real: Record<string, string> = { "/var/mail": "/var/spool/mail" };
		const layout = (read: string[] = []) =>
			buildLayout({
				cwd: "/p",
				home: "/h",
				agentDir: "/agent",
				uid: 1000,
				settings: settings({ read: { ...DEFAULT_SANDBOX_SETTINGS.read, limit: "all", allow: read } }),
				exists: (path) => present.has(path),
				realpath: (path) => real[path] ?? path,
			}).hidden;
		expect(layout()).toEqual(
			expect.arrayContaining([
				"/var/log/journal",
				"/run/log/journal",
				"/var/lib/systemd/coredump",
				"/var/spool/mail",
			]),
		);
		const allowed = layout(["/var/log"]);
		expect(allowed).not.toContain("/var/log/journal");
		expect(allowed).toContain("/var/lib/systemd/coredump");
	});

	it("mounts in order: system read-only, writable, read-only again, hidden last", () => {
		const args = bwrapArgs(
			{ cwd: "/p", writable: ["/p"], readOnly: ["/p/.git/hooks"], hidden: ["/h/.ssh", "/h/.netrc"] },
			(path) => path === "/h/.ssh",
			"/agent/sandbox/unreadable",
		);
		const at = (...needle: string[]) =>
			args.findIndex((_, index) => needle.every((part, offset) => args[index + offset] === part));
		expect(at("--ro-bind", "/", "/")).toBeLessThan(at("--bind", "/p", "/p"));
		// The private /tmp comes before the writable paths, so a project under /tmp stays reachable.
		const withTmp = bwrapArgs(
			{ cwd: "/tmp/p", tmp: "/tmp/prism-tmp-x", writable: ["/tmp/p"], readOnly: [], hidden: [] },
			() => false,
			"/u",
		);
		expect(withTmp.join(" ")).toContain("--bind /tmp/prism-tmp-x /tmp --bind /tmp/p /tmp/p");
		expect(at("--bind", "/p", "/p")).toBeLessThan(at("--ro-bind", "/p/.git/hooks", "/p/.git/hooks"));
		expect(at("--ro-bind", "/p/.git/hooks")).toBeLessThan(at("--perms", "0000", "--tmpfs", "/h/.ssh"));
		expect(at("--ro-bind", "/agent/sandbox/unreadable", "/h/.netrc")).toBeGreaterThan(0);
		expect(args).toContain("--unshare-all");
		expect(args).toContain("--die-with-parent");
		expect(args).toContain("--new-session");
		expect(args.slice(-2)).toEqual(["--chdir", "/p"]);
	});

	// fork: a read-only mount did not stop the folder holding it from being renamed.
	it("mounts each folder holding a read-only path on itself, so it cannot be renamed or removed", () => {
		const layout = {
			cwd: "/p",
			writable: ["/p", "/h/.cache"],
			readOnly: ["/p/.pi", "/p/.git/hooks", "/p/.git/config", "/p/a/b/hooks", "/elsewhere/x"],
			hidden: [],
		};
		// Parents first: a folder is mounted before the folders inside it.
		expect(pinnedFolders(layout)).toEqual(["/p/a", "/p/a/b", "/p/.git"]);
		expect(pinnedFolders({ writable: ["/"], readOnly: ["/p/a/hooks"], hidden: ["/q/private/agent"] })).toEqual([
			"/p",
			"/q",
			"/p/a",
			"/q/private",
		]);
		const args = bwrapArgs(layout, () => false, "/u");
		const at = (...needle: string[]) =>
			args.findIndex((_, index) => needle.every((part, offset) => args[index + offset] === part));
		expect(at("--bind", "/p", "/p")).toBeLessThan(at("--bind", "/p/.git", "/p/.git"));
		expect(at("--bind", "/p/.git", "/p/.git")).toBeLessThan(at("--ro-bind", "/p/.git/hooks", "/p/.git/hooks"));
	});

	it("keeps a linked worktree's .git file and a hooks folder set in Git's configuration read-only", () => {
		const input = {
			cwd: "/p",
			home: "/h",
			agentDir: "/agent",
			uid: 1000,
			settings: settings({}),
			exists: (path: string) =>
				new Set([
					"/p",
					"/p/.git",
					"/p/.git/HEAD",
					"/p/.git/config",
					"/p/.git/hooks",
					"/p/.husky/_",
					"/h/hooks",
					"/git",
					"/git/worktrees/p",
					"/git/worktrees/p/HEAD",
					"/git/worktrees/p/commondir",
				]).has(path),
			realpath: (path: string) => path,
			readFile: (path: string) => (path === "/p/.git" ? "gitdir: /git/worktrees/p\n" : "../..\n"),
		};
		const worktree = buildLayout({ ...input, isFile: (path) => path === "/p/.git", hooksPath: () => "/p/.husky/_" });
		expect(worktree.readOnly).toContain("/p/.git");
		expect(worktree.readOnly).toContain("/p/.husky/_");
		const plain = buildLayout({ ...input, isFile: () => false, hooksPath: () => "/h/hooks" });
		expect(plain.readOnly).not.toContain("/p/.git");
		expect(plain.readOnly).toContain("/h/hooks");
		// A hooks directory equal to a writable root restricts writes without blocking reads or disabling isolation.
		expect(buildLayout({ ...input, isFile: () => false, hooksPath: () => "/p" }).restrictions).toEqual([
			{ path: "/p", reason: expect.stringContaining("core.hooksPath=/p") },
		]);
	});

	it("keeps node and the relay reachable when they run from under /tmp, which the private /tmp hides", () => {
		const input = {
			cwd: "/p",
			home: "/h",
			agentDir: "/agent",
			uid: 1000,
			settings: settings({}),
			runFrom: ["/tmp/x/package/src/fork/sandbox", "/usr/bin"],
			exists: (path: string) => !path.endsWith("/.git"),
			realpath: (path: string) => path,
		};
		expect(buildLayout({ ...input, tmp: "/tmp/prism-tmp-x" }).readOnly).toContain("/tmp/x/package/src/fork/sandbox");
		expect(buildLayout({ ...input, tmp: "/tmp/prism-tmp-x" }).readOnly).not.toContain("/usr/bin");
		expect(buildLayout(input).readOnly).not.toContain("/tmp/x/package/src/fork/sandbox");
	});

	it("runs outside only a single command starting with an excluded entry", () => {
		const excluded = ["docker", "docker compose", "make deploy"];
		expect(isExcludedCommand("docker ps", excluded)).toBe(true);
		expect(isExcludedCommand("  docker   compose up ", excluded)).toBe(true);
		expect(isExcludedCommand("make deploy", excluded)).toBe(true);
		expect(isExcludedCommand("make", excluded)).toBe(false);
		expect(isExcludedCommand("dockerd", excluded)).toBe(false);
		for (const command of [
			"docker ps; rm -rf ~",
			"docker ps && curl x",
			"docker ps || true",
			"docker ps | sh",
			"docker ps > ~/.bashrc",
			"docker $(rm -rf ~)",
			"docker `id`",
			"docker ps\nrm -rf ~",
			"docker ps &",
		]) {
			expect(isExcludedCommand(command, excluded), command).toBe(false);
		}
		expect(isExcludedCommand("docker ps", [])).toBe(false);
		expect(parseSandboxSettings({ excludedCommands: [" docker ", ""], userCommands: true })).toMatchObject({
			excludedCommands: ["docker"],
			userCommands: true,
		});
	});

	it("tells the model when a command failed on a hidden path or D-Bus, and only then", () => {
		const layout = { cwd: "/p", writable: ["/p"], readOnly: [], hidden: ["/agent", "/h/.ssh"] };
		expect(sandboxResultNote("cat /h/.ssh/id_ed25519\ncat: /h/.ssh/id_ed25519: Permission denied", layout)).toMatch(
			/\/h\/\.ssh is hidden by the sandbox/,
		);
		expect(sandboxResultNote("ls /agent\nls: cannot open directory '/agent': Permission denied", layout)).toMatch(
			/\/agent is hidden/,
		);
		expect(sandboxResultNote("cat /h/.ssh/config\nok", layout)).toBeUndefined();
		expect(sandboxResultNote("touch /etc/x\ntouch: /etc/x: Permission denied", layout)).toBeUndefined();
		expect(sandboxResultNote("systemctl --user status\nFailed to connect to bus: Permission denied", layout)).toMatch(
			/Unix sockets \(D-Bus, the Docker or Podman service\) are blocked/,
		);
		// systemd 25x's wording, measured in the sandbox.
		expect(
			sandboxResultNote(
				"systemctl status sshd\nFailed to connect to system scope bus via local transport: Operation not permitted (consider using --machine=<user>@.host --user to connect to bus of other user)",
				layout,
			),
		).toMatch(/Unix sockets \(D-Bus, the Docker or Podman service\) are blocked/);
	});

	// R3.15 point 7: a write refused outside the writable folders names the setting that opens one; inside them,
	// the protected paths say why they stay read-only.
	it("tells the model why a write was refused, outside the writable folders or on a protected path", () => {
		const layout = {
			cwd: "/p",
			writable: ["/p", "/second"],
			readOnly: ["/p/.git/hooks", "/p/.git/config", "/second/.git/hooks", "/second/.pi"],
			hidden: [],
		};
		const outside = sandboxResultNote("touch /etc/x\ntouch: cannot touch '/etc/x': Read-only file system", layout);
		expect(outside).toContain("/etc/x is outside the folders commands may change (/tmp, /p, /second)");
		expect(outside).toContain("Writable paths");
		for (const output of [
			"error: could not lock config file .git/config: Read-only file system",
			"sh: /second/.git/hooks/pre-commit: Read-only file system",
			"cp: cannot create regular file '/second/.pi/settings.json': Read-only file system",
			"/bin/bash: line 1: /second/.git/hooks/pre-commit: Read-only file system",
		]) {
			expect(sandboxResultNote(`git config x y\n${output}`, layout), output).toContain("is protected");
		}
		// Writable paths, and refusals that are not about the file system, get no such line.
		expect(
			sandboxResultNote("touch /p/a\ntouch: cannot touch '/p/a': Read-only file system", layout),
		).toBeUndefined();
		expect(sandboxResultNote("touch /tmp/a\ntouch: '/tmp/a': Read-only file system", layout)).toBeUndefined();
		expect(sandboxResultNote("cat /etc/x\ncat: /etc/x: Permission denied", layout)).toBeUndefined();
	});

	// R3.15 point 6: the prompt and the notes follow the settings for containers and the state of services.
	it("names the settings for containers and services while they are off, and describes them while on", () => {
		const layout = { cwd: "/p", writable: ["/p"], readOnly: [], hidden: [] };
		const off = sandboxPromptSection(layout);
		expect(off).toContain("D-Bus is blocked");
		expect(off).toMatch(/Containers and new namespaces \(podman, docker, unshare\) cannot run\.$/m);
		const on = sandboxPromptSection(layout, { containers: true, serviceState: true });
		expect(on).toContain("read the state of services (systemctl status");
		expect(on).toContain("docker ps, docker images, podman ps and podman images list the user's containers");
		expect(on).not.toContain("D-Bus is blocked");
		const ps = "podman ps -a\nError: mkdir /run/user/1000/libpod: permission denied";
		expect(sandboxResultNote(ps, layout)).toContain("« Commands see my containers »");
		expect(sandboxResultNote(ps, layout, { containers: true })).not.toContain("Commands see my containers");
		expect(sandboxResultNote("podman run x\nError: cannot clone: Operation not permitted", layout)).not.toContain(
			"Commands see my containers",
		);
		const bus = "systemctl --user status\nFailed to connect to bus: Permission denied";
		expect(sandboxResultNote(bus, layout)).toContain("« Commands read the state of services »");
		expect(sandboxResultNote(bus, layout, { serviceState: true })).not.toContain("Commands read the state");
	});

	// outputs measured in the sandbox; each note says it is intended
	// and how the user lifts it.
	it("explains containers, sockets, the network outside the proxy and localhost", () => {
		const layout = { cwd: "/p", writable: ["/p"], readOnly: [], hidden: ["/agent", "/run/user/1000"] };
		const note = (command: string, output: string) => sandboxResultNote(`${command}\n${output}`, layout) ?? "";
		const containers = /containers and new namespaces \(podman, docker, unshare\) cannot run/;
		expect(note("unshare -U true", "unshare: unshare failed: Operation not permitted")).toMatch(containers);
		expect(note("podman ps -a", "cannot clone: Operation not permitted\nError: cannot re-exec process")).toMatch(
			containers,
		);
		// Before the hidden path line: podman's runtime folder is in /run/user.
		expect(
			note("podman ps -a", "Failed to obtain podman configuration: mkdir /run/user/1000/libpod: permission denied"),
		).toMatch(containers);
		expect(
			note(
				"curl --unix-socket /run/podman/podman.sock http://d/_ping",
				"curl: (7) failed to open socket: Operation not permitted",
			),
		).toMatch(/Unix sockets .* are blocked.*run the command outside the sandbox/);
		const network = /only HTTP and HTTPS through Prism's proxy, and Git over SSH .*, reach the network/;
		expect(note("ssh -T git@github.com", "ssh: connect to host github.com port 22: Connection refused")).toMatch(
			/Git over SSH to the hosts the user allows \(ssh:\/\/<host>\).*ask the user to allow ssh:\/\/<host>/,
		);
		// Git over SSH goes through Prism; its failure is the remote's, or comes with Prism's refusal line.
		expect(
			sandboxResultNote(
				"git ls-remote git@github.com:o/r.git\nHost key verification failed.\nfatal: Could not read from remote repository.",
				layout,
			),
		).toBeUndefined();
		expect(note("ping -c1 1.1.1.1", "ping: socket: Operation not permitted")).toMatch(network);
		expect(note("python3 x.py", "socket.gaierror: [Errno -3] Temporary failure in name resolution")).toMatch(network);
		const localhost =
			/localhost here is the sandbox's own, not the machine's.*Do not conclude that the service is down/;
		expect(
			note(
				"curl -sS http://127.0.0.1:18731/health",
				"curl: (7) Failed to connect to 127.0.0.1 port 18731 after 0 ms",
			),
		).toMatch(localhost);
		expect(
			note("python3 check.py", "ConnectionRefusedError: [Errno 111] Connection refused (localhost:5432)"),
		).toMatch(localhost);
		// the note says how to open that one port.
		expect(
			note("psql -h localhost", 'connection to server at "localhost" (::1), port 5432 failed: Connection refused'),
		).toContain("localhost:<port> in Allowed hosts");
		// Nothing when it worked, or failed for another reason.
		expect(sandboxResultNote("ssh -V\nOpenSSH_10.0p2", layout)).toBeUndefined();
		expect(
			sandboxResultNote("curl https://example.com\ncurl: (22) The requested URL returned error: 404", layout),
		).toBeUndefined();
		expect(sandboxResultNote("git status\nOn branch main", layout)).toBeUndefined();
		expect(sandboxResultNote("npm test\nError: expected 1 to be 2", layout)).toBeUndefined();
	});

	it("names the hosts the proxy refused, with the reason", () => {
		expect(networkRefusalNote([])).toBeUndefined();
		const note = networkRefusalNote([
			{ host: "pypi.org", why: "unanswered" },
			{ host: "pypi.org", why: "unanswered" },
			{ host: "evil.example", why: "blocked" },
			{ host: "example.com", why: "user" },
		]);
		expect(note).toContain(
			"connections refused while this command ran: pypi.org (nobody answered; the user may be away), evil.example (it is in the blocked hosts), example.com (the user blocked it).",
		);
		expect(note).toContain("Do not retry or reach these hosts another way");
		expect(note).toContain("Allowed hosts, /settings › Permissions & sandbox");
	});

	it("describes the sandbox for /sandbox", () => {
		const lines = describeSandbox({
			mode: "broad",
			active: true,
			settings: { ...DEFAULT_SANDBOX_SETTINGS, excludedCommands: ["docker"] },
			layout: { cwd: "/p", writable: ["/p"], readOnly: ["/p/.git/hooks"], hidden: ["/agent"] },
			settingsPath: "/agent/settings.json",
		});
		expect(lines).toContain("Sandbox: on (broad mode)");
		expect(lines).toContain("Hidden: /agent");
		expect(lines).toContain("Commands run outside: docker");
		expect(lines.join("\n")).toContain("asks for each new host");
		expect(
			describeSandbox({
				mode: "ask",
				active: false,
				error: "no bwrap",
				settings: DEFAULT_SANDBOX_SETTINGS,
				settingsPath: "x",
			})[0],
		).toBe("Sandbox: broken: no bwrap");
	});

	it("matches hosts exactly or by a *. wildcard, ignoring case and a final dot", () => {
		expect(matchesHost("registry.npmjs.org", ["registry.npmjs.org"])).toBe(true);
		expect(matchesHost("Registry.NPMjs.org.", ["registry.npmjs.org"])).toBe(true);
		expect(matchesHost("api.github.com", ["*.github.com"])).toBe(true);
		expect(matchesHost("github.com", ["*.github.com"])).toBe(false);
		expect(matchesHost("evilgithub.com", ["*.github.com"])).toBe(false);
		expect(matchesHost("npmjs.org", ["registry.npmjs.org"])).toBe(false);
	});

	describe("network answers per command", () => {
		const tick = () => new Promise((resolve) => setImmediate(resolve));
		const npmHost = "registry.npmjs.org";

		/** A policy whose questions wait until the test answers them, in order. */
		function questioned(settings: NetworkSettings = { ...DEFAULT_NETWORK_SETTINGS }) {
			const asked: string[] = [];
			const answers: ((answer: HostAnswer) => void)[] = [];
			const policy = new HostPolicy(
				() => settings,
				(host, command) => {
					asked.push(`${command.command} -> ${host}`);
					return new Promise((resolve) => answers.push(resolve));
				},
			);
			return { policy, asked, answer: (answer: HostAnswer) => answers.shift()?.(answer), settings };
		}

		it("keeps an answer for this command to that command, and asks again for another one", async () => {
			const { policy, asked, answer } = questioned();
			const npm = policy.open({ toolCallId: "npm", command: "npm install" });
			const curl = policy.open({ toolCallId: "curl", command: `curl https://${npmHost}` });
			// Two connections of npm share one question; curl, in parallel, waits for it without taking its answer.
			const first = npm.allows(npmHost);
			const second = npm.allows(npmHost);
			const other = curl.allows(npmHost);
			await tick();
			expect(asked).toEqual([`npm install -> ${npmHost}`]);
			answer("command");
			expect([await first, await second]).toEqual([true, true]);
			await tick();
			expect(asked).toEqual([`npm install -> ${npmHost}`, `curl https://${npmHost} -> ${npmHost}`]);
			answer("deny");
			expect(await other).toBe(false);
			// Later connections: npm passes, curl stays refused, neither asks again.
			expect(await npm.allows(npmHost)).toBe(true);
			expect(await curl.allows(npmHost)).toBe(false);
			expect(asked).toHaveLength(2);
			expect(policy.refusalsOf("curl")).toEqual([
				{ host: npmHost, why: "user", toolCallId: "curl" },
				{ host: npmHost, why: "user", toolCallId: "curl" },
			]);
			expect(policy.refusalsOf("npm")).toEqual([]);
			// The next npm command asks again.
			npm.close();
			const next = policy.open({ toolCallId: "npm2", command: "npm install" }).allows(npmHost);
			await tick();
			expect(asked).toHaveLength(3);
			answer("command");
			expect(await next).toBe(true);
		});

		it("keeps a session answer to its command, asking a waiting different command again", async () => {
			const { policy, asked, answer } = questioned();
			const first = policy.open({ command: "npm install" }).allows(npmHost);
			const waiting = policy.open({ command: "npm ci" }).allows(npmHost);
			await tick();
			answer("session");
			expect(await first).toBe(true);
			await tick();
			expect(asked).toHaveLength(2);
			answer("deny");
			expect(await waiting).toBe(false);
			expect(await policy.open({ command: "npm install" }).allows(npmHost)).toBe(true);
			expect(asked).toHaveLength(2);
		});

		it("does not wait twice for a host nobody answered in one command", async () => {
			const { policy, asked, answer } = questioned();
			const npm = policy.open({ toolCallId: "npm", command: "npm install" });
			const first = npm.allows(npmHost);
			await tick();
			answer("unanswered");
			expect(await first).toBe(false);
			expect(await npm.allows(npmHost)).toBe(false);
			expect(asked).toHaveLength(1);
			expect(policy.refusalsOf("npm").map((refusal) => refusal.why)).toEqual(["unanswered", "unanswered"]);
		});

		it("suggests the hosts of a few package managers and of a Git https or ssh URL, nothing else", () => {
			const split = (command: string) => likelyHosts(command.split(/&&|\|\||;|\n/));
			expect(split("cd web && npm install")).toEqual(["registry.npmjs.org"]);
			expect(split("PIP_NO_CACHE=1 python3 -m pip install requests")).toEqual([
				"pypi.org",
				"files.pythonhosted.org",
			]);
			expect(split("cargo test; go mod download")).toEqual([
				"index.crates.io",
				"static.crates.io",
				"proxy.golang.org",
				"sum.golang.org",
			]);
			expect(split("git clone https://user@GitHub.com/a/b.git")).toEqual(["github.com"]);
			expect(split("git clone git@github.com:a/b.git")).toEqual(["ssh://github.com"]);
			expect(split("npm test && cargo fmt && ls")).toEqual([]);
		});

		it("lets a tool call reach the hosts its question showed, and no other call", async () => {
			const { policy, asked, answer } = questioned();
			policy.grantForCall("npm", [npmHost]);
			policy.grantForCall("dropped", [npmHost]);
			policy.forgetCall("dropped");
			expect(await policy.open({ toolCallId: "npm", command: "npm install" }).allows(npmHost)).toBe(true);
			expect(asked).toEqual([]);
			// Taken by the call's command: a second command of the same id, or a forgotten call, asks.
			for (const toolCallId of ["npm", "dropped"]) {
				const allowed = policy.open({ toolCallId, command: "npm install" }).allows(npmHost);
				await tick();
				answer("command");
				expect(await allowed).toBe(true);
			}
			expect(asked).toHaveLength(2);
		});

		// fork: a block is the newer decision, so it wins over the answer to a question asked before it.
		it.each([
			["HTTPS", npmHost],
			["Git over SSH", "ssh://git.example"],
		])("refuses %s when the host is blocked while the user is asked, whatever the answer", async (_kind, host) => {
			for (const choice of ["session", "command"] as const) {
				const { policy, answer, settings } = questioned({ ...DEFAULT_NETWORK_SETTINGS, deny: [] });
				const asking = policy.open({ toolCallId: "a", command: "git push" }).allows(host);
				// Another command waits for that question: the block holds for it too.
				const waiting = policy.open({ toolCallId: "b", command: "git fetch" }).allows(host);
				await tick();
				settings.deny = [host];
				answer(choice);
				expect([await asking, await waiting]).toEqual([false, false]);
				expect(policy.refusalsOf("a")).toEqual([{ host, why: "blocked", toolCallId: "a" }]);
				// The session answer is kept, and the block still wins at the next command.
				expect(await policy.open({ command: "git pull" }).allows(host)).toBe(false);
			}
		});

		it("closes at once a connection tracked after its host was blocked", () => {
			const { policy, settings } = questioned({ ...DEFAULT_NETWORK_SETTINGS, allow: [npmHost] });
			const network = policy.open({ command: "npm install" });
			let closed = 0;
			network.track(npmHost, () => closed++);
			expect(closed).toBe(0);
			// Blocked during the proxy's DNS lookup, after `allows` said yes: no recheck comes later.
			settings.deny = [npmHost];
			network.track(npmHost, () => closed++);
			expect(closed).toBe(1);
		});

		it("closes a command's open connections to a host it no longer may reach, and only those", async () => {
			const { policy, answer, settings } = questioned({ ...DEFAULT_NETWORK_SETTINGS, allow: ["127.0.0.2"] });
			const servers: NetServer[] = [];
			const listen = (server: NetServer, address = "127.0.0.1") =>
				new Promise<number>((resolve) => {
					servers.push(server);
					server.listen(0, address, () => resolve((server.address() as { port: number }).port));
				});
			const target = await listen(
				createNetServer((socket) => socket.pipe(socket)),
				"127.0.0.2",
			);
			const proxyFor = async (command: string) => {
				const network = policy.open({ command });
				return listen(createNetServer((socket) => serveProxyStream(socket, network)));
			};
			const opened: Socket[] = [];
			const tunnel = async (proxy: number) => {
				const socket = netConnect(proxy, "127.0.0.1");
				opened.push(socket);
				const head = new Promise<string>((resolve) => socket.once("data", (data) => resolve(String(data))));
				socket.write(`CONNECT 127.0.0.2:${target} HTTP/1.1\r\n\r\n`);
				return { socket, head: await head };
			};
			const echo = (socket: Socket, text: string) =>
				new Promise<string>((resolve) => {
					socket.once("data", (data) => resolve(String(data)));
					socket.write(text);
				});
			try {
				// Allowed by the settings: open, and still open after a recheck that changes nothing.
				const bySettings = await tunnel(await proxyFor("curl a"));
				expect(bySettings.head).toContain("200 Connection Established");
				policy.recheck();
				expect(await echo(bySettings.socket, "ping")).toBe("ping");
				// Allowed for its command only: a change of the settings does not take that away.
				settings.allow = ["other.example"];
				const forCommand = tunnel(await proxyFor("curl b"));
				await new Promise((resolve) => setTimeout(resolve, 50));
				answer("command");
				const own = await forCommand;
				expect(own.head).toContain("200 Connection Established");
				// The host left the allowed list: the settings tunnel closes, the command's own stays.
				const closed = new Promise<void>((resolve) => bySettings.socket.once("close", () => resolve()));
				policy.recheck();
				await closed;
				expect(await echo(own.socket, "still")).toBe("still");
				// A host added to the blocked list closes that one too.
				const ownClosed = new Promise<void>((resolve) => own.socket.once("close", () => resolve()));
				settings.deny = ["127.0.0.2"];
				policy.recheck();
				await ownClosed;
			} finally {
				for (const socket of opened) socket.destroy();
				for (const server of servers) server.close();
			}
		});
	});

	// fork: a port of this machine opens alone, and never without an answer.
	describe("ports of this machine", () => {
		const tick = () => new Promise((resolve) => setImmediate(resolve));

		it("opens a port only when allowed, questions on or off, and lists the ports the relay serves", async () => {
			const asked: string[] = [];
			const answers: ((answer: HostAnswer) => void)[] = [];
			const settings: NetworkSettings = {
				askNewHosts: true,
				allow: ["localhost", "127.0.0.1", "localhost:5432"],
				deny: [],
			};
			const policy = new HostPolicy(
				() => settings,
				(host, command) => {
					asked.push(`${command.command} -> ${host}`);
					return new Promise((resolve) => answers.push(resolve));
				},
			);
			const psql = policy.open({ toolCallId: "psql", command: "psql" });
			expect(await psql.allows("localhost:5432")).toBe(true);
			const redis = psql.allows("localhost:6379");
			await tick();
			expect(asked).toEqual(["psql -> localhost:6379"]);
			answers.shift()?.("session");
			expect(await redis).toBe(true);
			// Questions off: other hosts pass without one, a port of this machine does not.
			settings.askNewHosts = false;
			expect(policy.wouldAsk("localhost:8080", { command: "curl" })).toBe(true);
			expect(policy.wouldAsk("example.com", { command: "curl" })).toBe(false);
			const quiet = policy.open({ toolCallId: "quiet", command: "curl" });
			expect(await quiet.allows("example.com")).toBe(true);
			expect(await quiet.allows("localhost:8080")).toBe(false);
			expect(policy.refusalsOf("quiet")).toEqual([{ host: "localhost:8080", why: "port", toolCallId: "quiet" }]);
			expect(networkRefusalNote(policy.refusalsOf("quiet"))).toContain(
				"localhost:8080 (a port of this machine opens only when the user allows it, and questions are off)",
			);
			// The relay serves the ports allowed when the command starts: settings, session, its tool call.
			policy.grantForCall("dev", ["localhost:3000", "registry.npmjs.org"]);
			expect(policy.open({ toolCallId: "dev", command: "npm run dev" }).localPorts()).toEqual([3000, 5432]);
			expect(policy.open({ command: "psql" }).localPorts()).toEqual([5432, 6379]);
			expect(policy.open({ command: "ls" }).localPorts()).toEqual([5432]);
			// `localhost` blocked blocks every port.
			settings.deny = ["localhost"];
			expect(policy.open({ command: "ls" }).localPorts()).toEqual([]);
			expect(await policy.open({ command: "psql" }).allows("localhost:5432")).toBe(false);
		});

		it("serves a port kept for a project or a task to the commands it was given to, no other", () => {
			const policy = new HostPolicy(
				() => DEFAULT_NETWORK_SETTINGS,
				undefined,
				(host, command) => host === "localhost:5432" && command.command.startsWith("psql"),
				undefined,
				() => ["localhost:5432", "localhost:6379", "example.com"],
			);
			expect(policy.open({ command: "psql -h localhost" }).localPorts()).toEqual([5432]);
			expect(policy.open({ command: "curl localhost:5432" }).localPorts()).toEqual([]);
		});

		it("suggests a port of this machine written in the command, not one of the sandbox's own localhost", () => {
			const split = (command: string) => likelyHosts(command.split(/&&|\|\||;|\n/));
			// fork (SEC-07): localhost, 127.x and ::1 are the sandbox's own; this machine is host.prism.internal.
			expect(split("curl -sS http://localhost:3000/health && curl http://127.0.0.1:5432")).toEqual([]);
			expect(split("curl 'http://[::1]:8080/x'; redis-cli -u redis://user@127.1.1.1:06379")).toEqual([]);
			expect(
				split("curl http://host.prism.internal:3000/x && psql -h x postgres://HOST.prism.internal:05432"),
			).toEqual(["localhost:3000", "localhost:5432"]);
			expect(split("curl http://example.com:3000 http://mylocalhost:4000 localhost:99999 localhost")).toEqual([]);
		});

		// fork (SEC-07): the relay is told each change of the ports it serves, while its command runs.
		it("tells a running command's relay of a port allowed or taken back", async () => {
			const answers: ((answer: HostAnswer) => void)[] = [];
			const settings: NetworkSettings = { askNewHosts: true, allow: [], deny: [] };
			const policy = new HostPolicy(
				() => settings,
				() => new Promise((resolve) => answers.push(resolve)),
			);
			const server = policy.open({ command: "npm run dev" });
			const other = policy.open({ command: "sleep 60" });
			const seen: string[] = [];
			const unwatch = server.watchPorts((ports) => seen.push(`server ${ports.join(",")}`));
			other.watchPorts((ports) => seen.push(`other ${ports.join(",")}`));
			const asked = server.allows("localhost:3000");
			await tick();
			answers.shift()?.("session");
			expect(await asked).toBe(true);
			const only = server.allows("localhost:4000");
			await tick();
			answers.shift()?.("command");
			expect(await only).toBe(true);
			policy.sessionAllowed.clear();
			policy.recheck();
			unwatch();
			settings.allow = ["localhost:5000"];
			policy.recheck();
			expect(seen).toEqual(["server ", "other ", "server 3000", "server 3000,4000", "server 4000", "other 5000"]);
		});
	});

	describe("Git over SSH", () => {
		const request = (overrides: Partial<GitSshRequest>): GitSshRequest => ({
			destination: "git@github.com",
			command: "git-upload-pack '/o/r.git'",
			...overrides,
		});

		it("builds the whole ssh command line itself, for Git's own commands alone", () => {
			// Quoted as Git quotes it (sq_quote_buf), and quoted again the same way for the remote shell.
			expect(
				gitSshCommand(
					request({ port: 2222, protocol: "version=2", command: "git-receive-pack '/o/it'\\''s'\\!'.git'" }),
				),
			).toEqual({
				host: "github.com",
				args: [
					"-o",
					"BatchMode=yes",
					"-o",
					"SendEnv=GIT_PROTOCOL",
					"-p",
					"2222",
					"--",
					"git@github.com",
					"git-receive-pack '/o/it'\\''s'\\!'.git'",
				],
				protocol: "version=2",
			});
			const refused: Partial<GitSshRequest>[] = [
				{ destination: "-oProxyCommand=touch /tmp/x" },
				{ destination: "git@github.com -oProxyCommand=x" },
				{ destination: "git@[::1]" },
				{ family: "oProxyCommand=touch /tmp/x" as unknown as 4 },
				{ port: 0 },
				{ protocol: "version=2 -oX" },
				{ command: "sh -c id" },
				{ command: "git-upload-pack '/o/r.git'; id" },
				{ command: "git-upload-pack /o/r.git" },
				{ command: "git-upload-pack '/o/r\n.git'" },
				{ command: "git-lfs-authenticate o/r download" },
				{ command: "git-shell '/o/r.git'" },
			];
			for (const overrides of refused) expect(typeof gitSshCommand(request(overrides))).toBe("string");
			// Any JSON comes from the sandbox: a wrong type is refused, never thrown.
			for (const bad of [{ destination: { toString: 1 } }, { command: ["git-upload-pack"] }, { port: "22" }]) {
				expect(gitSshCommand(request(bad as unknown as Partial<GitSshRequest>))).toBe("malformed request");
			}
			expect(gitSshCommand(null as unknown as GitSshRequest)).toBe("malformed request");
		});

		it("runs no ssh for a command that ended while the user was asked", async () => {
			const dir = mkdtempSync(join(tmpdir(), "prism-git-ssh-"));
			const marker = join(dir, "ran");
			const ssh = join(dir, "ssh");
			writeFileSync(ssh, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
			let answer: (allowed: boolean) => void = () => {};
			const network = {
				allows: () =>
					new Promise<boolean>((resolve) => {
						answer = resolve;
					}),
				track: () => () => {},
				sandboxWrites: () => false,
			} as unknown as CommandNetwork;
			const stream = new PassThrough();
			const target = Buffer.from(JSON.stringify(request({}))).toString("base64url");
			const served = serveGitSsh(stream, target, Buffer.alloc(0), network, ssh);
			stream.destroy();
			answer(true);
			await served;
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(existsSync(marker)).toBe(false);
			rmSync(dir, { recursive: true, force: true });
		});

		it("opens only to a host allowed for SSH, never by its HTTPS rule or because questions are off", async () => {
			const settings: NetworkSettings = {
				askNewHosts: false,
				allow: ["github.com", "*.github.com", "ssh://gitlab.com"],
				deny: ["blocked.example"],
			};
			const policy = new HostPolicy(() => settings, undefined);
			const network = policy.open({ toolCallId: "git", command: "git push" });
			expect(await network.allows("github.com")).toBe(true);
			expect(await network.allows("ssh://github.com")).toBe(false);
			expect(await network.allows("ssh://api.github.com")).toBe(false);
			expect(await network.allows("ssh://GitLab.com")).toBe(true);
			expect(await network.allows("ssh://other.example")).toBe(false);
			expect(policy.wouldAsk("ssh://other.example", { command: "git push" })).toBe(true);
			expect(policy.refusalsOf("git")).toContainEqual({ host: "ssh://github.com", why: "ssh", toolCallId: "git" });
			expect(networkRefusalNote(policy.refusalsOf("git"))).toContain(
				"Git over SSH to a host opens only when the user allows it, and questions are off",
			);
			// A blocked host is blocked over SSH too, even listed for it.
			settings.allow.push("ssh://blocked.example");
			expect(await network.allows("ssh://blocked.example")).toBe(false);
			expect(matchesHost("ssh://a.github.com", ["*.github.com"])).toBe(false);
			expect(matchesHost("github.com", ["ssh://github.com"])).toBe(false);
		});

		it("suggests the host of a Git ssh URL, not a refspec", () => {
			const split = (command: string) => likelyHosts(command.split(/&&|\|\||;|\n/));
			expect(split("git clone git@github.com:o/r.git && git push origin main:main HEAD:refs/heads/x")).toEqual([
				"ssh://github.com",
			]);
			expect(split("git fetch ssh://git@GitLab.com:2222/o/r; git ls-remote git+ssh://host.example/r")).toEqual([
				"ssh://gitlab.com",
				"ssh://host.example",
			]);
			expect(split("scp git@github.com:o/r .; git log main:src")).toEqual([]);
		});
	});

	it("carries streams both ways over one pipe pair, with half-close, large writes and a refused bad frame", async () => {
		const relayToPrism = new PassThrough();
		const prismToRelay = new PassThrough();
		const opened: Duplex[] = [];
		new Mux(relayToPrism, prismToRelay, (stream) => opened.push(stream));
		const relay = new Mux(prismToRelay, relayToPrism);
		const stream = relay.open();
		const big = Buffer.alloc(3 * 1024 * 1024 + 7, 7);
		stream.end(big);
		await new Promise((resolve) => setImmediate(resolve));
		expect(opened).toHaveLength(1);
		const received: Buffer[] = [];
		opened[0]!.on("data", (chunk: Buffer) => received.push(chunk));
		await new Promise((resolve) => opened[0]!.on("end", resolve));
		expect(Buffer.concat(received).equals(big)).toBe(true);
		opened[0]!.end("reply");
		// fork: a normal close must leave the peer's unread response buffered.
		await new Promise((resolve) => setImmediate(resolve));
		expect(stream.destroyed).toBe(false);
		const back: Buffer[] = [];
		stream.on("data", (chunk: Buffer) => back.push(chunk));
		await new Promise((resolve) => stream.on("end", resolve));
		expect(Buffer.concat(back).toString()).toBe("reply");
		// A frame claiming a huge payload closes the whole channel.
		const other = relay.open();
		const closed = new Promise((resolve) => other.on("close", resolve));
		prismToRelay.write(Buffer.from([2, 0, 0, 0, 2, 0xff, 0xff, 0xff, 0xff]));
		await closed;
	});

	it("finds the files ssh's system configuration includes, as ssh does; copies only root's", () => {
		const dir = mkdtempSync(join(tmpdir(), "prism-ssh-config-"));
		try {
			mkdirSync(join(dir, "conf.d"));
			mkdirSync(join(dir, "policy"));
			writeFileSync(join(dir, "conf.d", "50-b.conf"), "Match final all\n\tInclude policy/*.config\n");
			writeFileSync(join(dir, "conf.d", "20-a.conf"), "Host x\n");
			writeFileSync(join(dir, "conf.d", ".hidden.conf"), "");
			writeFileSync(join(dir, "conf.d", "a.txt"), "");
			writeFileSync(join(dir, "policy", "openssh.config"), `include=${join(dir, "conf.d", "20-a.conf")}\n`);
			writeFileSync(
				join(dir, "ssh_config"),
				`# Include ${join(dir, "commented")}\nInclude "conf.d/*.conf" ~/.ssh/extra %d/x # tail\nINCLUDE ${join(dir, "missing", "*")}\n`,
			);
			const files = includedSshFiles(join(dir, "ssh_config"));
			// Relative paths are read from the configuration's folder; the second level's from there too.
			expect(files).toEqual([
				join(dir, "conf.d", "20-a.conf"),
				join(dir, "conf.d", "50-b.conf"),
				join(dir, "policy", "openssh.config"),
			]);
			// The user owns these: ssh accepts them as they are, so no copy.
			expect(sshConfigCopies(dir, files)).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("splits Include words and reads glob brackets as ssh does", () => {
		const dir = mkdtempSync(join(tmpdir(), "prism-ssh-config-"));
		try {
			for (const name of ["sp ace.conf", "q'uote.conf", "h#sh.conf", "[x.conf", "a.conf", "b.conf", "c.conf"])
				writeFileSync(join(dir, name), "");
			const lines = [
				// Measured with OpenSSH 10.2 (`ssh -G`): each line includes these files.
				`Include "${dir}/sp ace.conf" ${dir}/a.conf`,
				`Include '${dir}/q'"'"'uote.conf'`,
				`Include ${dir}/h#sh.conf #${dir}/b.conf`,
				`Include ${dir}/[x*.conf ${dir}/[z-a].conf`,
				`Include ${dir}/[!a-b].conf`,
				// An unclosed quote: ssh refuses the line.
				`Include "${dir}/b.conf`,
			];
			writeFileSync(join(dir, "ssh_config"), `${lines.join("\n")}\n`);
			expect(includedSshFiles(join(dir, "ssh_config"))).toEqual(
				["sp ace.conf", "a.conf", "q'uote.conf", "h#sh.conf", "[x.conf", "c.conf"].map((name) => join(dir, name)),
			);
			writeFileSync(join(dir, "ssh_config"), `Include ${dir}/sp\\ ace.conf\n`);
			expect(includedSshFiles(join(dir, "ssh_config"))).toEqual([join(dir, "sp ace.conf")]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it.skipIf(!includedSshFiles().some((file) => statSync(file).uid === 0))(
		"gives each of root's included files its own copy, with the same content",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "prism-ssh-copies-"));
			try {
				const copies = sshConfigCopies(dir);
				// Each copy's name maps back to one original only: /etc/a_b and /etc/a/b get different copies.
				for (const [copy, original] of copies) {
					expect(decodeURIComponent(copy.slice(join(dir, "ssh-").length))).toBe(original);
					expect(readFileSync(copy)).toEqual(readFileSync(original));
				}
				expect(new Set(copies.map(([copy]) => copy)).size).toBe(copies.length);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);

	it("builds a seccomp filter whose jumps stay inside it", () => {
		for (const arch of ["x64", "arm64"] as const) {
			const filter = seccompFilter(arch);
			const count = filter.length / 8;
			expect(Number.isInteger(count)).toBe(true);
			for (let index = 0; index < count; index++) {
				const code = filter.readUInt16LE(index * 8);
				if (code === 0x06) continue; // return
				expect(index + 1 + filter.readUInt8(index * 8 + 2), `${arch} jt ${index}`).toBeLessThan(count);
				expect(index + 1 + filter.readUInt8(index * 8 + 3), `${arch} jf ${index}`).toBeLessThan(count);
			}
			expect(filter.readUInt16LE((count - 1) * 8)).toBe(0x06);
		}
	});
});

const RAW_CLONE = `import ctypes, os, struct
libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long
def run(nr, *args):
    pid = libc.syscall(nr, *args)
    if pid == 0:
        os._exit(0)
    if pid > 0:
        os.waitpid(pid, 0)
        return "allowed"
    return "errno%d" % ctypes.get_errno()
CLONE_NEWUSER, SIGCHLD = 0x10000000, 17
print("clone:" + run(56, ctypes.c_ulong(CLONE_NEWUSER | SIGCHLD), None, None, None, None))
args = ctypes.create_string_buffer(struct.pack("<11Q", CLONE_NEWUSER, 0, 0, 0, SIGCHLD, 0, 0, 0, 0, 0, 0))
print("clone3:" + run(435, args, ctypes.c_size_t(88)))`;

const bwrap = findBwrap();
const podman = spawnSync("podman", ["--version"], { stdio: "ignore" }).status === 0;
const systemBus =
	existsSync("/run/dbus/system_bus_socket") && spawnSync("systemctl", ["--version"], { stdio: "ignore" }).status === 0;
const writer = resolve(__dirname, "fixtures/project-permissions-writer.ts");
if (!bwrap) console.warn("fork-sandbox: bubblewrap is not installed; the real sandbox tests are skipped.");

describe.skipIf(!bwrap)("fork: real sandbox", () => {
	let agentDir: string;
	let outside: string;
	const savedAgentDir = process.env[ENV_AGENT_DIR];
	const harnesses: Harness[] = [];

	beforeAll(() => {
		// Writable on the host, outside every writable path of the sandbox.
		outside = mkdtempSync(join("/var/tmp", "prism-sandbox-test-"));
	});
	afterAll(() => rmSync(outside, { recursive: true, force: true }));

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-sandbox-agent-"));
		process.env[ENV_AGENT_DIR] = agentDir;
		writeFileSync(join(agentDir, "auth.json"), '{"fake":{"type":"api_key","key":"canary-auth"}}');
		writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode: "broad" }));
	});

	afterEach(() => {
		for (const harness of harnesses.splice(0)) {
			// dispose() does not end the session as quitting does, so its private /tmp is removed here.
			removeSessionTmpDir(harness.sessionManager.getSessionId());
			harness.cleanup();
		}
		if (savedAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = savedAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	});

	type Select = (title: string, options: string[]) => Promise<string | undefined>;
	// The gate's questions are accepted, so what stops a command here is the sandbox.
	const allowAll: Select = async (_title, options) => options.find((option) => option.startsWith("Allow"));

	async function start(
		select: Select = allowAll,
		custom?: ExtensionUIContext["custom"],
	): Promise<{ harness: Harness; shutdowns: number[]; notices: string[] }> {
		const harness = await createHarness({
			extensionFactories: [
				{ name: "permissions", factory: permissionsExtension },
				{ name: "background", factory: backgroundExtension },
			],
		});
		harnesses.push(harness);
		const shutdowns: number[] = [];
		const notices: string[] = [];
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({ notify: (message) => notices.push(message), select, custom }),
			shutdownHandler: () => shutdowns.push(Date.now()),
		});
		return { harness, shutdowns, notices };
	}

	async function bash(harness: Harness, command: string) {
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		return getToolResult(harness, "bash");
	}

	async function background(harness: Harness, command: string) {
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("background", { action: "run", command }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
	}

	// Tasks outlive the session by design (background.ts), so a test stops the ones that would never end.
	async function stopBackground(harness: Harness, id = "bg1") {
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("background", { action: "kill", id }), { stopReason: "toolUse" }),
			fauxAssistantMessage("stopped"),
		]);
		await harness.session.prompt("stop");
	}

	async function waitFor(condition: () => boolean, ms = 8_000) {
		const deadline = Date.now() + ms;
		while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
		expect(condition()).toBe(true);
	}

	const text = (result: Awaited<ReturnType<typeof bash>>) =>
		result.content.map((part) => (part.type === "text" ? part.text : "")).join("");

	// fork (SEC-03): the sandbox's network namespace does not cover Unix sockets, and through systemd-resolved's a
	// command would resolve any name (a DNS query that carries data out). The seccomp filter refuses them all.
	it("a command reaches no Unix socket of the host: a service's, the resolver's (DNS), Tailscale's", async () => {
		const path = join(outside, "service.sock");
		let connections = 0;
		const service = createNetServer(() => connections++);
		await new Promise<void>((done) => service.listen(path, () => done()));
		try {
			const { harness } = await start();
			const script = (target: string) =>
				`require("net").connect(${JSON.stringify(target)}).on("connect", () => console.log("CONNECTED")).on("error", (e) => console.log("REFUSED " + e.code))`;
			const resolver = "/run/systemd/resolve/io.systemd.Resolve";
			const result = text(
				await bash(
					harness,
					`node -e '${script(path)}'; node -e '${script(resolver)}'; getent ahosts prism-canary.invalid; echo getent=$?`,
				),
			);
			expect(result).not.toContain("CONNECTED");
			expect(result.match(/REFUSED EPERM/g)?.length ?? 0).toBeGreaterThanOrEqual(existsSync(resolver) ? 2 : 1);
			expect(result).toContain("getent=2");
			expect(connections).toBe(0);
		} finally {
			await new Promise((done) => service.close(done));
		}
	});

	it("in broad mode: writes in the project, not outside; cannot read Prism's credentials", async () => {
		const { harness, shutdowns } = await start();
		expect(shutdowns).toEqual([]);
		const result = await bash(
			harness,
			`echo in > inside.txt; echo out > ${outside}/escaped.txt; cat ${agentDir}/auth.json; cat ${agentDir}/permissions.json; true`,
		);
		expect(readFileSync(join(harness.tempDir, "inside.txt"), "utf8")).toBe("in\n");
		expect(existsSync(join(outside, "escaped.txt"))).toBe(false);
		expect(text(result)).not.toContain("canary-auth");
		expect(text(result)).toMatch(/Permission denied/);
	});

	// Owner, 2026-10-23 (Q-G8): no automatic Git maintenance in the sandbox, set by the environment only.
	it("turns Git's automatic maintenance off through the environment, never in a configuration file", async () => {
		vi.stubEnv("GIT_CONFIG_COUNT", "1");
		vi.stubEnv("GIT_CONFIG_KEY_0", "user.name");
		vi.stubEnv("GIT_CONFIG_VALUE_0", "From The Environment");
		try {
			const { harness } = await start();
			execFileSync("git", ["init", "-q", harness.tempDir]);
			const config = readFileSync(join(harness.tempDir, ".git", "config"), "utf8");
			const result = await bash(
				harness,
				"git config maintenance.auto; git config gc.auto; git config user.name; git -c user.email=t@example.invalid commit -q --allow-empty -m one && git maintenance run --auto; ls .git/objects | grep -c lock",
			);
			expect(text(result)).toMatch(/^false\n0\nFrom The Environment\n0\n/);
			expect(readFileSync(join(harness.tempDir, ".git", "config"), "utf8")).toBe(config);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	// R3.15 point 7 (sandbox.md § 8.4 item 8): a second folder is writable with the project's protections, and the
	// model is told why a write was refused, outside it or on a protected path in it.
	it("opens a second folder with the project's protections, and says why a write is refused", async () => {
		const second = mkdtempSync(join(outside, "second-"));
		execFileSync("git", ["init", "-q", second]);
		mkdirSync(join(second, ".pi"));
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sandbox: { allowWrite: [second] } }));
		const { harness } = await start();
		const source = await bash(harness, `echo ok > ${second}/source.txt && echo WROTE`);
		expect(text(source)).toContain("WROTE");
		// Its repository works in a private copy: the hook is written there, then not published.
		const hook = await bash(harness, `echo 'touch /tmp/x' > ${second}/.git/hooks/pre-commit`);
		expect(text(hook)).toContain(`this command's Git changes were not applied to ${join(second, ".git")}`);
		const settings = await bash(harness, `echo '{}' > ${second}/.pi/settings.json`);
		expect(text(settings)).toContain("is protected");
		const elsewhere = await bash(harness, `echo out > ${outside}/escaped.txt`);
		expect(text(elsewhere)).toContain("is outside the folders commands may change");
		expect(text(elsewhere)).toContain("Writable paths");
		expect(existsSync(join(second, ".git/hooks/pre-commit"))).toBe(false);
		expect(existsSync(join(second, ".pi/settings.json"))).toBe(false);
		expect(existsSync(join(outside, "escaped.txt"))).toBe(false);
	});

	// R3.15 point 6: the line added to a result follows the current settings (the outputs are the measured ones).
	it("names the settings for containers and services in the notes only while they are off", async () => {
		const failures = [
			'podman ps 2>/dev/null; echo "Error: mkdir /run/user/1000/libpod: permission denied"',
			'systemctl --user status 2>/dev/null; echo "Failed to connect to bus: Permission denied"',
		];
		const { harness } = await start();
		for (const [command, setting] of [
			[failures[0]!, "Commands see my containers"],
			[failures[1]!, "Commands read the state of services"],
		]) {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sandbox: {} }));
			expect(text(await bash(harness, command!))).toContain(`« ${setting} »`);
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ sandbox: { containers: true, serviceState: true } }),
			);
			expect(text(await bash(harness, command!))).not.toContain(`« ${setting} »`);
		}
	});

	it("gives each session a private /tmp, shared by its own commands only", async () => {
		// Another session's full output, in the host's /tmp.
		const hostFile = join("/tmp", `pi-bash-prism-test-${process.pid}.log`);
		writeFileSync(hostFile, "other-session-output");
		try {
			const { harness: first } = await start();
			let result = await bash(first, `cat ${hostFile} 2>&1; echo kept > /tmp/shared.txt; true`);
			expect(text(result)).not.toContain("other-session-output");
			expect(text(result)).toMatch(/No such file/);
			expect(existsSync("/tmp/shared.txt")).toBe(false);
			result = await bash(first, "cat /tmp/shared.txt");
			expect(text(result)).toContain("kept");
			const { harness: second } = await start();
			result = await bash(second, "cat /tmp/shared.txt 2>&1; true");
			expect(text(result)).not.toContain("kept");
		} finally {
			rmSync(hostFile, { force: true });
		}
	});

	// with the sandbox, the file tools and the commands share the
	// session's private /tmp, and writing there counts as writing in the project.
	async function call(harness: Harness, tool: string, input: Parameters<typeof fauxToolCall>[1]) {
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall(tool, input), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		return getToolResult(harness, tool);
	}

	it("writes the agent's scratch files in the session's private /tmp, without a question in broad mode", async () => {
		const titles: string[] = [];
		const { harness } = await start(async (title, options) => {
			titles.push(title.split("\n")[0]!);
			return allowAll(title, options);
		});
		const name = `prism-scratch-${process.pid}.txt`;
		try {
			const written = await call(harness, "write", { path: `/tmp/${name}`, content: "from write" });
			expect(written.isError).toBe(false);
			expect(existsSync(join("/tmp", name))).toBe(false);
			// The model reads back the path it wrote, the one its commands see.
			expect(JSON.stringify(written.content)).toContain(`/tmp/${name}`);
			expect(JSON.stringify(written.content)).not.toContain("prism-tmp-");
			expect(JSON.stringify(harness.session.messages)).not.toContain("prism-tmp-");
			expect(text(await bash(harness, `cat /tmp/${name}; echo from bash > /tmp/redirected.txt`))).toContain(
				"from write",
			);
			const read = await call(harness, "read", { path: "/tmp/redirected.txt" });
			expect(JSON.stringify(read.content)).toContain("from bash");
			expect(titles).toEqual([]);
		} finally {
			rmSync(join("/tmp", name), { force: true });
		}
	});

	it("asks in ask mode for a write to the private /tmp, as for one in the project", async () => {
		writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode: "ask" }));
		const prompts: { title: string; options: string[] }[] = [];
		const { harness } = await start(async (title, options) => {
			prompts.push({ title, options });
			return (
				options.find((option) => option === 'Allow "change /tmp/**" in this session') ?? allowAll(title, options)
			);
		});
		await call(harness, "write", { path: "/tmp/asked.txt", content: "x" });
		await bash(harness, "echo x > /tmp/asked-too.txt");
		expect(prompts.map(({ title }) => title.split("\n")[0])).toEqual([
			"Allow this action? write",
			"Allow this action? bash",
		]);
		// The user sees /tmp, as the commands do, and a rule that still holds in the next session.
		expect(prompts[0]!.title).toContain("/tmp/asked.txt");
		expect(prompts[0]!.title).not.toContain("prism-tmp-");
		expect(prompts[0]!.options).toContain('Allow "change /tmp/**" in this project');
		await call(harness, "write", { path: "/tmp/asked-again.txt", content: "x" });
		expect(prompts).toHaveLength(2);
	});

	it("refuses a write through a link out of the private /tmp", async () => {
		const titles: string[] = [];
		const { harness } = await start(async (title, options) => {
			titles.push(title.split("\n")[0]!);
			return allowAll(title, options);
		});
		await bash(harness, `ln -s ${outside}/target.txt /tmp/out-link`);
		const result = await call(harness, "write", { path: "/tmp/out-link", content: "escaped" });
		expect(result.isError).toBe(true);
		expect(existsSync(join(outside, "target.txt"))).toBe(false);
		expect(titles).toEqual([]);
	});

	// fork.9 QA: unrestricted mode has no sandbox unless it is turned on for it.
	it("runs unrestricted mode's commands in the sandbox only when turned on", async () => {
		writeFileSync(
			join(agentDir, "permissions.json"),
			JSON.stringify({ mode: "unrestricted", unrestrictedAccepted: true }),
		);
		const outside = join(agentDir, "written-by-unrestricted");
		const { harness: plain } = await start();
		expect(sessionSandbox(plain.sessionManager)).toBeUndefined();
		await bash(plain, `touch ${outside}`);
		expect(existsSync(outside)).toBe(true);
		rmSync(outside);

		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sandbox: { modes: { unrestricted: true } } }));
		const { harness: sandboxed } = await start();
		expect(sessionSandbox(sandboxed.sessionManager)).toBeDefined();
		await bash(sandboxed, `touch ${outside}`);
		expect(existsSync(outside)).toBe(false);
	});

	// Owner, 2026-11-18: broad mode writes the real /tmp without asking when the sandbox is off (it used to ask);
	// ask mode still asks (fork-broad-tmp-writes.test.ts).
	it("writes the real /tmp without a question in broad mode without the sandbox", async () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sandbox: { modes: { broad: false } } }));
		const titles: string[] = [];
		const { harness } = await start(async (title) => {
			titles.push(title.split("\n")[0]!);
			return "Block this action once";
		});
		const file = `/tmp/prism-unsandboxed-${process.pid}.txt`;
		try {
			await call(harness, "write", { path: file, content: "x" });
			expect(titles).toEqual([]);
			expect(readFileSync(file, "utf8")).toBe("x");
		} finally {
			rmSync(file, { force: true });
		}
	});

	it("keeps two live sessions' /tmp apart, even by the folder's real path", async () => {
		const { harness: first } = await start();
		const { harness: second } = await start();
		const firstTmp = sessionTmpDir(first.sessionManager.getSessionId());
		// The first session keeps writing while the second looks.
		await background(first, "for i in $(seq 1 50); do echo secret-a > /tmp/a.txt; sleep 0.1; done");
		await waitFor(() => existsSync(join(firstTmp, "a.txt")));
		const result = await bash(
			second,
			`cat /tmp/a.txt 2>&1; cat ${firstTmp}/a.txt 2>&1; ls -a /tmp; find / -maxdepth 3 -name 'prism-tmp-*' -printf 'found:%p\\n' 2>/dev/null; true`,
		);
		expect(text(result)).not.toContain("secret-a");
		expect(text(result)).toContain(`cat: ${firstTmp}/a.txt: No such file or directory`);
		expect(text(result)).not.toContain("found:");
		expect(readFileSync(join(firstTmp, "a.txt"), "utf8")).toBe("secret-a\n");
	});

	it("keeps the /tmp of a session a background task still uses, then removes it when the task ends", async () => {
		const { harness } = await start();
		const dir = sessionTmpDir(harness.sessionManager.getSessionId());
		await background(
			harness,
			"echo early > /tmp/a; sleep 1.5; echo late > /tmp/b; cat /tmp/a /tmp/b > result.tmp 2>&1; mv result.tmp result.txt; sleep 0.5",
		);
		await waitFor(() => existsSync(join(dir, "a")));
		// /new: the session ends while its task runs.
		await emitSessionShutdownEvent(harness.session.extensionRunner, { type: "session_shutdown", reason: "new" });
		expect(existsSync(dir)).toBe(true);
		// Written then renamed: the shell creates a redirection's file before the command writes to it.
		await waitFor(() => existsSync(join(harness.tempDir, "result.txt")));
		expect(readFileSync(join(harness.tempDir, "result.txt"), "utf8")).toBe("early\nlate\n");
		await waitFor(() => !existsSync(dir));
		expect(readdirSync(tmpdir()).filter((name) => name.startsWith(`${basename(dir)}.`))).toEqual([]);
	});

	it("cannot reach the session bus nor the network", async () => {
		const { harness } = await start();
		const uid = process.getuid?.() ?? 0;
		const result = await bash(
			harness,
			`ls /run/user/${uid} 2>&1; (exec 3<>/dev/tcp/1.1.1.1/53) 2>&1 && echo NET-OPEN; true`,
		);
		expect(text(result)).toMatch(/Permission denied/);
		expect(text(result)).not.toContain("NET-OPEN");
	});

	it("refuses Unix sockets and new namespaces; ordinary programs still run", async () => {
		let { harness } = await start();
		const unixSocket = `node -e "require('net').connect('/nonexistent-prism').on('error', (e) => console.log('unix:' + e.code))"`;
		let result = await bash(
			harness,
			`${unixSocket}; unshare -U true 2>/dev/null && echo NEW-NAMESPACE; node -e "require('child_process').execSync('true'); console.log('spawn-ok')"; git --version >/dev/null && echo git-ok; true`,
		);
		expect(text(result)).toContain("unix:EPERM");
		expect(text(result)).not.toContain("NEW-NAMESPACE");
		expect(text(result)).toContain("spawn-ok");
		expect(text(result)).toContain("git-ok");
		if (process.arch === "x64") {
			// Raw clone and clone3 asking for a user namespace (x86_64 numbers): EPERM and ENOSYS.
			result = await bash(harness, `python3 - <<'PY'\n${RAW_CLONE}\nPY\ntrue`);
			expect(text(result)).toContain("clone:errno1");
			expect(text(result)).toContain("clone3:errno38");
		}
		// The removed system bus setting, left in settings.json, no longer reopens Unix sockets:
		// a socket listening in the project, which the sandbox shows, gets no connection, and the system bus is hidden.
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sandbox: { allowSystemBus: true } }));
		({ harness } = await start());
		let connections = 0;
		const listener = createNetServer(() => connections++);
		await new Promise<void>((done) => listener.listen(join(harness.tempDir, "listening.sock"), done));
		try {
			result = await bash(
				harness,
				`ls -l listening.sock; node -e "const s = require('net').connect('listening.sock'); s.on('connect', () => { console.log('unix:connected'); s.destroy(); }).on('error', (e) => console.log('unix:' + e.code))"; python3 -c "import socket; s = socket.socket(socket.AF_UNIX); s.connect('listening.sock'); print('py:connected')" 2>&1 | tail -1; ls /run/dbus 2>&1; true`,
			);
		} finally {
			await new Promise((done) => listener.close(done));
		}
		expect(text(result)).toMatch(/^s.* listening\.sock$/m);
		expect(text(result)).toContain("unix:EPERM");
		expect(text(result)).not.toContain("unix:connected");
		expect(text(result)).not.toContain("py:connected");
		expect(text(result)).toMatch(/PermissionError|Operation not permitted/);
		expect(text(result)).not.toContain("system_bus_socket");
		expect(connections).toBe(0);
	});

	// a datagram socketpair end could be connected again to a host datagram socket on a path
	// the sandbox shows; stream and seqpacket pairs, which Node and Python use internally, still work.
	it("refuses datagram socketpairs and keeps stream and seqpacket pairs", async () => {
		const { harness } = await start();
		const script = [
			"import socket",
			"for name in ('SOCK_STREAM', 'SOCK_SEQPACKET', 'SOCK_DGRAM', 'SOCK_RAW'):",
			"    try:",
			"        a, b = socket.socketpair(socket.AF_UNIX, getattr(socket, name) | socket.SOCK_CLOEXEC)",
			"        a.close(); b.close(); print(name + ':ok')",
			"    except OSError as e:",
			"        print(name + ':errno' + str(e.errno))",
		].join("\n");
		const result = await bash(
			harness,
			`python3 - <<'PY'\n${script}\nPY\nnode -e "require('child_process').execSync('true'); console.log('spawn-ok')"; true`,
		);
		expect(text(result)).toContain("SOCK_STREAM:ok");
		expect(text(result)).toContain("SOCK_SEQPACKET:ok");
		expect(text(result)).toContain("SOCK_DGRAM:errno1");
		expect(text(result)).toContain("SOCK_RAW:errno1");
		expect(text(result)).toContain("spawn-ok");
	});

	describe("network through Prism's proxy", () => {
		// On 127.0.0.2: the relay sends 127.0.0.1 and localhost straight to the sandbox's own loopback.
		let server: Server;
		let base: string;
		beforeAll(async () => {
			server = createServer((request, response) => {
				if (request.url === "/echo") {
					// Counts what it is sent, then answers 8 MiB (windows of the relay's channel).
					let uploaded = 0;
					request.on("data", (chunk: Buffer) => {
						uploaded += chunk.length;
					});
					request.on("end", () => response.end(`uploaded ${uploaded}\n${"b".repeat(8 * 1024 * 1024)}`));
					return;
				}
				if (!request.url?.startsWith("/slow")) return response.end(`hello ${request.url}\n`);
				// Starts, then finishes 4 seconds later: long enough to be cut while it runs.
				response.write("started\n");
				slowRequests.push(Date.now());
				const timer = setTimeout(() => response.end("finished\n"), 4_000);
				response.on("close", () => clearTimeout(timer));
			});
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.2", resolve));
			base = `http://127.0.0.2:${(server.address() as { port: number }).port}`;
		});
		afterAll(() => server.close());

		const slowRequests: number[] = [];
		const hostQuestions = (titles: string[]) => titles.filter((title) => title.includes("wants to connect"));
		const recording = (titles: string[], pick: (options: string[]) => string | undefined): Select => {
			return async (title, options) => {
				titles.push(title);
				return title.includes("wants to connect") ? pick(options) : allowAll(title, options);
			};
		};

		// fork: either peer may send EOF first, without losing the other direction's buffered data.
		it.each(["client", "server"] as const)(
			"drains the CONNECT tunnel when the %s half-closes first",
			async (first) => {
				const { harness } = await start();
				const received: Buffer[] = [];
				const sockets = new Set<Socket>();
				const request = first === "client" ? Buffer.from("hello") : Buffer.alloc(3 * 1024 * 1024 + 7, 121);
				const reply = Buffer.concat([Buffer.from("reply:hello\n"), Buffer.alloc(3 * 1024 * 1024 + 7, 120)]);
				const target = createNetServer({ allowHalfOpen: true }, (socket) => {
					sockets.add(socket);
					socket.on("error", () => {});
					socket.on("close", () => sockets.delete(socket));
					socket.on("data", (chunk: Buffer) => received.push(chunk));
					socket.on("end", () => {
						writeFileSync(join(harness.tempDir, "request-ended"), "done");
						if (first === "client") setImmediate(() => socket.end(reply));
					});
					if (first === "server") socket.end(reply);
				});
				await new Promise<void>((resolve) => target.listen(0, "127.0.0.2", resolve));
				try {
					const port = (target.address() as { port: number }).port;
					writeFileSync(
						join(harness.tempDir, "half-close.py"),
						`import os, socket, time, urllib.parse
proxy = urllib.parse.urlsplit(os.environ["HTTPS_PROXY"])
with socket.create_connection((proxy.hostname, proxy.port), timeout=5) as client:
    client.sendall(b"CONNECT 127.0.0.2:${port} HTTP/1.1\\r\\n\\r\\n")
    header = b""
    while not header.endswith(b"\\r\\n\\r\\n"):
        part = client.recv(1)
        assert part, header
        header += part
    assert b"200 Connection Established" in header, header
    request = b"hello" if "${first}" == "client" else b"y" * (3 * 1024 * 1024 + 7)
    if "${first}" == "client":
        client.sendall(request)
        client.shutdown(socket.SHUT_WR)
    time.sleep(0.1)
    chunks = []
    while True:
        part = client.recv(65536)
        if not part:
            break
        chunks.append(part)
    response = b"".join(chunks)
    expected = b"reply:hello\\n" + b"x" * (3 * 1024 * 1024 + 7)
    assert response == expected, (len(response), len(expected))
    if "${first}" == "server":
        client.sendall(request)
        client.shutdown(socket.SHUT_WR)
    deadline = time.monotonic() + 5
    while not os.path.exists("request-ended") and time.monotonic() < deadline:
        time.sleep(0.01)
    assert os.path.exists("request-ended"), "upstream did not receive request EOF"
    print("half-close reply complete")
`,
					);
					const result = await bash(harness, "python3 half-close.py");
					expect(text(result)).toContain("half-close reply complete");
					expect(result.isError).toBe(false);
					expect(Buffer.concat(received).equals(request)).toBe(true);
				} finally {
					for (const socket of sockets) socket.destroy();
					await new Promise<void>((resolve) => target.close(() => resolve()));
				}
			},
		);

		it("asks at the first connection to a host, saying the question can be turned off; HTTP and HTTPS tunnels pass", async () => {
			const titles: string[] = [];
			const { harness } = await start(
				recording(titles, (options) => options.find((o) => o.includes("this session"))),
			);
			const result = await bash(
				harness,
				`curl -sS ${base}/plain; curl -sS -p ${base}/tunnel; curl -sS --noproxy '*' --max-time 2 ${base}/direct >/dev/null 2>&1 || echo DIRECT-FAILED; true`,
			);
			expect(text(result)).toContain("hello /plain");
			expect(text(result)).toContain("hello /tunnel");
			expect(text(result)).toContain("DIRECT-FAILED");
			expect(hostQuestions(titles)).toHaveLength(1);
			// the question names the command asking.
			expect(hostQuestions(titles)[0]).toContain("The command curl -sS");
			expect(hostQuestions(titles)[0]).toContain("127.0.0.2");
			expect(hostQuestions(titles)[0]).toMatch(
				/can be turned off: "sandbox": \{ "network": \{ "askNewHosts": false/,
			);
		});

		it("carries several MiB both ways through the relay's channel, a window at a time", async () => {
			const { harness } = await start();
			const result = await bash(
				harness,
				`head -c 8388608 /dev/zero > up.bin && curl -sS --data-binary @up.bin -o down.bin ${base}/echo && head -n 1 down.bin && wc -c < down.bin; rm -f up.bin down.bin`,
			);
			expect(text(result)).toContain("uploaded 8388608");
			expect(text(result)).toContain(String("uploaded 8388608\n".length + 8 * 1024 * 1024));
		});

		it("asks once for all connections of a command allowed for this command, and again for the next one", async () => {
			const titles: string[] = [];
			const { harness } = await start(
				recording(titles, (options) => options.find((o) => o.includes("for this command"))),
			);
			const result = await bash(harness, `curl -sS ${base}/one; curl -sS -p ${base}/two; true`);
			expect(text(result)).toContain("hello /one");
			expect(text(result)).toContain("hello /two");
			expect(hostQuestions(titles)).toHaveLength(1);
			expect(text(await bash(harness, `curl -sS ${base}/three; true`))).toContain("hello /three");
			expect(hostQuestions(titles)).toHaveLength(2);
		});

		it("shows the host of a command in its permission question, and the answer covers it for that run only", async () => {
			writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode: "ask" }));
			const titles: string[] = [];
			const { harness } = await start(
				recording(titles, (options) => options.find((o) => o.includes("for this command"))),
			);
			const url = `https://${base.slice("http://".length)}/repo`;
			await bash(harness, `git clone ${url} cloned 2>&1; true`);
			const asked = titles.filter((title) => title.includes("git clone"));
			expect(asked[0]).toContain("Will probably connect to: 127.0.0.2");
			expect(hostQuestions(titles)).toEqual([]);
			// The next command is asked about: the answer was for the clone.
			await bash(harness, `curl -sS ${base}/after; true`);
			expect(hostQuestions(titles)).toHaveLength(1);
		});

		it("refuses a host when the user blocks it, and tells the command why", async () => {
			const titles: string[] = [];
			const { harness } = await start(
				recording(titles, (options) => options.find((o) => o === "Block for this command")),
			);
			const result = await bash(harness, `curl -sS ${base}/x; true`);
			expect(text(result)).toContain("refused the connection to 127.0.0.2");
			expect(text(result)).not.toContain("hello");
			// the result says so even when the program hides the proxy's answer (pip, urllib: "403").
			expect(text(result)).toContain("connections refused while this command ran: 127.0.0.2 (the user blocked it)");
		});

		it("says when nobody answered the question for a host, and only for the command that ran then", async () => {
			const { harness } = await start(recording([], () => undefined));
			const refused = await bash(harness, `curl -sS -p -o /dev/null ${base}/x 2>&1; true`);
			expect(text(refused)).toContain("CONNECT tunnel failed, response 403");
			expect(text(refused)).toContain("127.0.0.2 (nobody answered; the user may be away)");
			expect(text(await bash(harness, "echo next"))).not.toContain("connections refused");
		});

		it("does not blame the user for a host refused without an interface", async () => {
			const harness = await createHarness({
				extensionFactories: [{ name: "permissions", factory: permissionsExtension }],
			});
			harnesses.push(harness);
			await harness.session.bindExtensions({});
			const refused = await bash(harness, `curl -sS -p -o /dev/null ${base}/x 2>&1; true`);
			expect(text(refused)).toContain("127.0.0.2 (nobody answered; the user may be away)");
			expect(text(refused)).not.toContain("the user blocked it");
		});

		it("keeps a host allowed for this project to that project and that command; without questions unlisted hosts pass and denied ones stay blocked", async () => {
			let titles: string[] = [];
			const shown: string[][] = [];
			const project = (options: string[]) => {
				shown.push(options);
				return options.find((o) => o.endsWith("in this project"));
			};
			let { harness } = await start(recording(titles, project));
			expect(text(await bash(harness, `curl -sS ${base}/a; true`))).toContain("hello /a");
			expect(hostQuestions(titles)).toHaveLength(1);
			expect(shown[0]).toEqual([
				"Allow 127.0.0.2 for this command",
				"Allow 127.0.0.2 in this session",
				'Allow 127.0.0.2 for "run curl" in this project',
				"Block for this command",
			]);
			const grant = { host: "127.0.0.2", rule: "bash(curl*)" };
			expect(readProjectGrants(harness.tempDir, agentDir).hosts).toEqual([grant]);
			expect(existsSync(join(agentDir, "settings.json"))).toBe(false);
			expect(text(await bash(harness, `cd . && curl -sS ${base}/a2; true`))).toContain("hello /a2");
			expect(hostQuestions(titles)).toHaveLength(1);
			// Given to curl, not to another command of the project.
			expect(text(await bash(harness, `bash -c 'curl -sS ${base}/a3'; true`))).toContain("hello /a3");
			expect(hostQuestions(titles)).toHaveLength(2);
			// Taken back for the project, it is asked about again in this session too.
			await removeProjectHost(harness.tempDir, grant, agentDir);
			await removeProjectHost(harness.tempDir, { host: "127.0.0.2", rule: "bash(bash*)" }, agentDir);
			expect(text(await bash(harness, `curl -sS ${base}/a4; true`))).toContain("hello /a4");
			expect(hostQuestions(titles)).toHaveLength(3);
			await removeProjectHost(harness.tempDir, grant, agentDir);
			// Another folder is another project: it asks again.
			titles = [];
			({ harness } = await start(recording(titles, () => "Block for this command")));
			expect(text(await bash(harness, `curl -sS ${base}/b; true`))).toContain("refused the connection");
			expect(hostQuestions(titles)).toHaveLength(1);
			// Given to this project from elsewhere (another session on it), it is allowed without a question.
			await addProjectHost(harness.tempDir, { host: "127.0.0.2", rule: "bash(curl*)" }, agentDir);
			expect(text(await bash(harness, `curl -sS ${base}/b; true`))).toContain("hello /b");
			expect(hostQuestions(titles)).toHaveLength(1);
			titles = [];

			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ sandbox: { network: { askNewHosts: false } } }),
			);
			({ harness } = await start(recording(titles, () => "Block")));
			expect(text(await bash(harness, `curl -sS ${base}/c; true`))).toContain("hello /c");
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ sandbox: { network: { askNewHosts: false, deny: ["127.0.0.2"] } } }),
			);
			({ harness } = await start(recording(titles, () => "Block")));
			expect(text(await bash(harness, `curl -sS ${base}/d; true`))).toContain("refused the connection");
			expect(hostQuestions(titles)).toEqual([]);
		});

		it("closes a project host's open connections when another Prism process takes it back", async () => {
			const titles: string[] = [];
			const { harness } = await start(
				recording(titles, (options) => options.find((o) => o.endsWith("in this project"))),
			);
			const grant = { host: "127.0.0.2", rule: "bash(curl*)" };
			const started = slowRequests.length;
			const running = bash(harness, `curl -sS -p ${base}/slow 2>&1; echo "curl exit $?"`);
			const deadline = Date.now() + 10_000;
			while (slowRequests.length === started && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
			expect(readProjectGrants(harness.tempDir, agentDir).hosts).toEqual([grant]);
			// Another process, as /settings in another session on this project does.
			execFileSync(process.execPath, [writer, agentDir, harness.tempDir, "remove-host", grant.host, grant.rule]);
			const output = text(await running);
			expect(Date.now() - slowRequests.at(-1)!).toBeLessThan(3_500);
			expect(output).toContain("started");
			expect(output).not.toContain("finished");
			expect(output).not.toContain("curl exit 0");
		});

		it("says when a host cannot be kept for the project, and asks again", async () => {
			const titles: string[] = [];
			const picks = ["in this project", "for this command"];
			const { harness } = await start(
				recording(titles, (options) => {
					const pick = picks.shift() ?? "for this command";
					return options.find((o) => o.endsWith(pick));
				}),
			);
			writeFileSync(join(agentDir, "project-permissions.json"), "{ not json");
			expect(text(await bash(harness, `curl -sS ${base}/kept; true`))).toContain("hello /kept");
			const questions = hostQuestions(titles);
			expect(questions).toHaveLength(2);
			expect(questions[1]).toContain("Could not keep it for this project:");
			expect(questions[1]).toContain("Nothing was allowed. Choose again.");
			expect(readFileSync(join(agentDir, "project-permissions.json"), "utf8")).toBe("{ not json");
			// Allowed for that command only: the next one asks.
			expect(text(await bash(harness, `curl -sS ${base}/next; true`))).toContain("hello /next");
			expect(hostQuestions(titles)).toHaveLength(3);
		});

		it("takes a host allowed in this session back from the permissions window", async () => {
			initTheme("dark");
			const titles: string[] = [];
			let shown = "";
			const window = async (factory: (...args: never[]) => unknown) => {
				const tui = { terminal: { rows: 40, columns: 100 }, requestRender: () => {} };
				const view = (factory as (...args: unknown[]) => PermView)(tui, undefined, undefined, () => {});
				shown = view
					.render(100)
					.map((line) => line.replace(/\x1b\[[0-9;:]*m|\x1b_[^\x07]*\x07/g, ""))
					.join("\n");
				// The grants row, then Enter on the first one.
				view.handleInput("\x1b[B");
				view.handleInput("\r");
				return undefined as never;
			};
			const { harness } = await start(
				recording(titles, (options) => options.find((o) => o.endsWith("in this session"))),
				window as never,
			);
			expect(text(await bash(harness, `curl -sS ${base}/s1; true`))).toContain("hello /s1");
			expect(text(await bash(harness, `curl -sS ${base}/s2; true`))).toContain("hello /s2");
			expect(hostQuestions(titles)).toHaveLength(1);
			harness.setResponses([fauxAssistantMessage("ok")]);
			await harness.session.prompt("/perm window");
			expect(shown).toContain("Connect to 127.0.0.2");
			expect(text(await bash(harness, `curl -sS ${base}/s3; true`))).toContain("hello /s3");
			expect(hostQuestions(titles)).toHaveLength(2);
		});

		it("gives background tasks the network too", async () => {
			const { harness } = await start(recording([], (options) => options[0]));
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("background", { action: "run", command: `curl -sS ${base}/bg > bg-net.txt` }),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("go");
			const file = join(harness.tempDir, "bg-net.txt");
			const deadline = Date.now() + 5_000;
			while (!(existsSync(file) && readFileSync(file, "utf8")) && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			expect(readFileSync(file, "utf8")).toBe("hello /bg\n");
		});
		// R3.14 lot 4: the task scope's hosts, while the user is away.
		// fork: a service of this machine, port by port, for programs with or without the proxy.
		describe("ports of this machine", () => {
			const services: Server[] = [];
			const serve = (host: string, name: string) =>
				new Promise<number>((resolve) => {
					const service = createServer((request, response) => response.end(`${name} ${request.url}\n`));
					services.push(service);
					service.listen(0, host, () => resolve((service.address() as { port: number }).port));
				});
			afterEach(() => {
				for (const service of services.splice(0)) service.close();
			});

			it("reaches an allowed port at host.prism.internal, with or without the proxy; another port stays closed", async () => {
				const v4 = await serve("127.0.0.1", "v4");
				const v6 = await serve("::1", "v6");
				const closed = await serve("127.0.0.1", "closed");
				writeFileSync(
					join(agentDir, "settings.json"),
					JSON.stringify({ sandbox: { network: { allow: [`localhost:${v4}`, `localhost:${v6}`, "127.0.0.1"] } } }),
				);
				const titles: string[] = [];
				const { harness } = await start(
					recording(titles, (options) => options.find((o) => o === "Block for this command")),
				);
				const direct = `--noproxy '*'`;
				const result = await bash(
					harness,
					[
						`curl -sS --max-time 5 ${direct} http://host.prism.internal:${v4}/a`,
						`curl -sS --max-time 5 http://host.prism.internal:${v4}/b`,
						`curl -sS --max-time 5 ${direct} http://host.prism.internal:${v6}/d`,
						`curl -sS --max-time 5 --noproxy '' -x "$HTTP_PROXY" http://127.0.0.1:${v4}/e`,
						// fork (SEC-07): localhost is the sandbox's own, where nothing listens on that port.
						`curl -sS --max-time 2 http://127.0.0.1:${v4}/own || echo OWN-LOOPBACK`,
						`curl -sS --max-time 2 ${direct} http://host.prism.internal:${closed}/f || echo CLOSED-DIRECT`,
						`curl -sS --max-time 5 http://host.prism.internal:${closed}/g; echo`,
						"true",
					].join("; "),
				);
				for (const line of ["v4 /a", "v4 /b", "v6 /d", "OWN-LOOPBACK", "CLOSED-DIRECT"]) {
					expect(text(result)).toContain(line);
				}
				// Forced through the proxy, the sandbox's localhost is refused, not led to this machine.
				expect(text(result)).not.toContain("v4 /e");
				expect(text(result)).toContain("Prism's sandbox refused to proxy 127.0.0.1");
				expect(text(result)).not.toContain("v4 /own");
				expect(text(result)).not.toContain("closed /");
				expect(text(result)).toContain(`refused the connection to port ${closed} of this machine`);
				// The question names that port alone, and says no other opens with it.
				const asked = hostQuestions(titles);
				expect(asked).toHaveLength(1);
				expect(asked[0]).toContain(`wants to connect to localhost:${closed}`);
				expect(asked[0]).toContain("only this port opens");
				expect(text(result)).toContain(`localhost:${closed} (the user blocked it)`);
			});

			it("refuses the sandbox's localhost through a forced proxy, in every form, and asks nothing", async () => {
				const port = await serve("127.0.0.1", "machine");
				const v6 = await serve("::1", "machine6");
				writeFileSync(
					join(agentDir, "settings.json"),
					JSON.stringify({
						sandbox: { network: { allow: [`localhost:${port}`, `localhost:${v6}`, "localhost", "127.0.0.1"] } },
					}),
				);
				const titles: string[] = [];
				const { harness } = await start(recording(titles, () => undefined));
				const forms = [
					`localhost:${port}`,
					`LOCALHOST.:${port}`,
					`app.localhost:${port}`,
					`127.0.0.1:${port}`,
					`127.1:${port}`,
					`2130706433:${port}`,
					`0x7f.1:${port}`,
					`0.0.0.0:${port}`,
					`[::1]:${v6}`,
					`[0:0:0:0:0:0:0:1]:${v6}`,
					`[::ffff:127.0.0.1]:${port}`,
				];
				const forced = `--noproxy '' -x "$HTTP_PROXY"`;
				// Raw requests, as a client that does not canonicalize the address sends them (curl does).
				const raw = ["127.1", "2130706433", "0x7f.1", "0177.0.0.1", "[0:0::1]", "[::ffff:7f00:1]", "LocalHost"];
				writeFileSync(
					join(harness.tempDir, "raw-proxy.py"),
					`import os, socket, urllib.parse
proxy = urllib.parse.urlsplit(os.environ["HTTP_PROXY"])
for host in ${JSON.stringify(raw)}:
    port = ${v6} if host.startswith("[") else ${port}
    for request in (f"CONNECT {host}:{port} HTTP/1.1\\r\\n\\r\\n", f"GET http://{host}:{port}/raw HTTP/1.1\\r\\nHost: {host}\\r\\n\\r\\n"):
        with socket.create_connection((proxy.hostname, proxy.port), timeout=5) as client:
            client.sendall(request.encode())
            answer = b""
            while True:
                part = client.recv(65536)
                if not part:
                    break
                answer += part
            print(f"<raw {host} {request.split()[0]}>", answer.decode(errors="replace").splitlines()[0])
`,
				);
				const result = await bash(
					harness,
					[
						...forms.map((form) => `curl -sS --max-time 5 ${forced} http://${form}/plain; echo "<${form}>"`),
						// CONNECT, as HTTPS clients ask.
						`curl -sS --max-time 5 ${forced} -p http://127.0.0.1:${port}/tunnel; echo "<tunnel>"`,
						`curl -sS --max-time 5 ${forced} -p http://localhost:${port}/tunnel; echo "<tunnel-name>"`,
						// The machine stays reachable through the proxy by its explicit name.
						`curl -sS --max-time 5 ${forced} http://host.prism.internal:${port}/alias; echo "<alias>"`,
						"python3 raw-proxy.py",
						"true",
					].join("; "),
				);
				const output = text(result);
				expect(output).toContain("machine /alias");
				expect(output.match(/this is the sandbox's own localhost, which the proxy does not reach/g)).toHaveLength(
					forms.length,
				);
				// curl keeps the body of a refused tunnel to itself.
				expect(output.match(/CONNECT tunnel failed, response 403/g)).toHaveLength(2);
				expect(output).toContain("host.prism.internal:<port>");
				expect(output).not.toMatch(/machine6? \/(plain|tunnel|raw)/);
				for (const host of raw) {
					for (const method of ["CONNECT", "GET"])
						expect(output).toContain(`<raw ${host} ${method}> HTTP/1.1 403`);
				}
				expect(hostQuestions(titles)).toEqual([]);
			});

			it("opens a port written in the command for that run when the user allows the command", async () => {
				writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode: "ask" }));
				const port = await serve("127.0.0.1", "dev");
				const titles: string[] = [];
				const { harness } = await start(recording(titles, () => undefined));
				expect(
					text(
						await bash(harness, `curl -sS --max-time 5 --noproxy '*' http://host.prism.internal:${port}/x; true`),
					),
				).toContain("dev /x");
				expect(titles.find((title) => title.includes("curl -sS"))).toContain(
					`Will probably connect to: localhost:${port}`,
				);
				// The next command does not name it: the port stays closed, and the note says how to open it.
				const next = await bash(
					harness,
					`P=${port}; curl -sS --max-time 2 --noproxy '*' http://host.prism.internal:$P/y; true`,
				);
				expect(text(next)).not.toContain("dev /y");
				expect(text(next)).toContain("localhost:<port> in Allowed hosts");
			});

			// fork: said at the start, never silent.
			it("says when the session's commands cannot share localhost, and why", async () => {
				const sessions = ["prism-net-shared", "prism-net-refused", "prism-net-no-nsenter"];
				try {
					expect(await sessionNetReport(sessions[0]!, bwrap!)).toBeUndefined();
					expect(await sessionNetReport(sessions[1]!, "/bin/false")).toContain(
						"refused the session's network namespace, so the commands of this session do not share localhost",
					);
					expect(await sessionNetReport(sessions[2]!, bwrap!, null)).toContain(
						"nsenter (util-linux) was not found",
					);
					// Shown in the user's language.
					setLanguage("fr");
					expect(t((await sessionNetReport(sessions[1]!, "/bin/false"))!)).toContain(
						"ce système a refusé l'espace réseau de la session",
					);
					expect(t((await sessionNetReport(sessions[2]!, bwrap!, null))!)).toContain(
						"nsenter (util-linux) est introuvable",
					);
				} finally {
					setLanguage("en");
					for (const session of sessions) closeSessionNet(session);
				}
			});

			// fork: the session's commands share the sandbox's localhost.
			it("reaches a server a background task started on localhost, not this machine's on that port", async () => {
				const port = await serve("127.0.0.1", "machine");
				const titles: string[] = [];
				const { harness } = await start(recording(titles, () => undefined));
				writeFileSync(
					join(harness.tempDir, "inner.py"),
					[
						"import http.server, pathlib, sys",
						"class Handler(http.server.BaseHTTPRequestHandler):",
						"    def do_GET(self):",
						"        self.send_response(200); self.end_headers(); self.wfile.write(b'inner ' + self.path.encode() + b'\\n')",
						"server = http.server.HTTPServer(('127.0.0.1', int(sys.argv[1])), Handler)",
						"pathlib.Path('up').touch()",
						"server.serve_forever()",
					].join("\n"),
				);
				await background(harness, `python3 inner.py ${port}`);
				try {
					await waitFor(() => existsSync(join(harness.tempDir, "up")));
					const result = await bash(
						harness,
						[
							`curl -sS --max-time 5 http://localhost:${port}/a`,
							`curl -sS --max-time 5 http://127.0.0.1:${port}/b`,
							// In a variable: written, the port would be asked about before the command (tested below).
							`P=${port}; curl -sS --max-time 2 --noproxy '*' http://host.prism.internal:$P/c || echo MACHINE-CLOSED`,
							"true",
						].join("; "),
					);
					for (const line of ["inner /a", "inner /b", "MACHINE-CLOSED"]) expect(text(result)).toContain(line);
					expect(text(result)).not.toContain("machine /");
					expect(hostQuestions(titles)).toHaveLength(0);
				} finally {
					// The server never ends by itself: left running, it outlived ./test.sh with its sandbox relay.
					await stopBackground(harness);
				}
			});

			// fork (SEC-07): a command that runs without a question still has its written port asked about before it starts.
			it.each([
				["opens", "for this command"],
				["refuses, without running it again,", "Block for this command"],
			])("%s a written port of this machine before a command allowed without a question", async (_verb, pick) => {
				writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode: "broad" }));
				const port = await serve("127.0.0.1", "pre");
				const titles: string[] = [];
				const { harness } = await start(recording(titles, (options) => options.find((o) => o.endsWith(pick))));
				const result = await bash(
					harness,
					`curl -sS --max-time 3 --noproxy '*' http://host.prism.internal:${port}/x || echo REFUSED`,
				);
				const asked = hostQuestions(titles);
				expect(asked).toHaveLength(1);
				expect(asked[0]).toContain(`localhost:${port}`);
				if (pick === "for this command") expect(text(result)).toContain("pre /x");
				else {
					expect(text(result)).toContain("REFUSED");
					expect(text(result)).not.toContain("pre /x");
				}
			});

			it("serves a port allowed while the command runs at once", async () => {
				const port = await serve("127.0.0.1", "late");
				const titles: string[] = [];
				const { harness } = await start(
					recording(titles, (options) => options.find((o) => o.endsWith("in this session"))),
				);
				// The port is in a variable: nothing predicts it, so it opens only with the answer.
				const direct = `curl -sS --max-time 2 --noproxy '*' http://host.prism.internal:$P`;
				const result = await bash(
					harness,
					[
						`P=${port}`,
						`${direct}/before || echo BEFORE-CLOSED`,
						`curl -sS --max-time 5 http://host.prism.internal:$P/asked`,
						`for i in 1 2 3 4 5; do ${direct}/after && break; sleep 0.2; done`,
						"true",
					].join("; "),
				);
				for (const line of ["BEFORE-CLOSED", "late /asked", "late /after"]) expect(text(result)).toContain(line);
				expect(text(result)).not.toContain("late /before");
				expect(hostQuestions(titles)).toHaveLength(1);
			});

			it("keeps a command's ports and proxy from the session's other commands", async () => {
				writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode: "ask" }));
				const port = await serve("127.0.0.1", "guarded");
				const { harness } = await start(recording([], () => undefined));
				// Given to this task alone, from its command; it records its address and its proxy, then waits.
				await background(
					harness,
					[
						`curl -sS --max-time 5 --noproxy '*' http://host.prism.internal:${port}/own > own.txt`,
						"getent hosts host.prism.internal | cut -d' ' -f1 > alias.txt",
						'echo "$HTTP_PROXY" > proxy.txt',
						"sleep 30",
					].join("; "),
				);
				await waitFor(() => existsSync(join(harness.tempDir, "proxy.txt")));
				expect(readFileSync(join(harness.tempDir, "own.txt"), "utf8")).toBe("guarded /own\n");
				const result = await bash(
					harness,
					[
						"A=$(cat alias.txt); H=host.prism.internal",
						`curl -sS --max-time 3 --noproxy '*' http://$A:${port}/port || echo GUARDED-PORT`,
						`curl -sS --max-time 3 --noproxy '' -x "$(cat proxy.txt)" http://$H:${port}/proxy || echo GUARDED-PROXY`,
						"true",
					].join("; "),
				);
				for (const line of ["GUARDED-PORT", "GUARDED-PROXY"]) expect(text(result)).toContain(line);
				expect(text(result)).not.toContain("guarded /port");
				expect(text(result)).not.toContain("guarded /proxy");
			});
		});

		describe("Git over SSH", () => {
			// Prism's ssh is a stand-in on the host: it runs Git's command against a local repository, as a server's
			// shell would, and logs what it was given.
			let bin: string;
			let log: string;
			let bare: string;
			let sshHome: string;
			const savedPath = process.env.PATH;
			beforeEach(() => {
				bin = mkdtempSync(join(outside, "bin-"));
				// Prism reads ssh's configuration (ssh-provenance.ts): a throwaway one, never the user's.
				sshHome = join(bin, "home");
				mkdirSync(join(sshHome, ".ssh"), { recursive: true });
				overrideSshFiles({ home: sshHome });
				log = join(bin, "ssh.log");
				bare = join(bin, "bare.git");
				execFileSync("git", ["init", "-q", "--bare", bare]);
				writeFileSync(
					join(bin, "ssh"),
					`#!/bin/sh\nprintf '%s|' "$@" >> '${log}'; printf 'PROTO=%s\\n' "$GIT_PROTOCOL" >> '${log}'\nfor last; do :; done\nexec sh -c "$last"\n`,
					{ mode: 0o755 },
				);
				process.env.PATH = `${bin}:${savedPath}`;
			});
			afterEach(() => {
				process.env.PATH = savedPath;
				overrideSshFiles(undefined);
			});
			const logged = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
			const git = "git -c user.name=t -c user.email=t@example.com";

			it("pushes and fetches through Prism's ssh, to a host allowed for SSH", async () => {
				writeFileSync(
					join(agentDir, "settings.json"),
					JSON.stringify({ sandbox: { network: { allow: ["ssh://git.test"] } } }),
				);
				const { harness } = await start();
				const result = await bash(
					harness,
					[
						`${git} init -q w && cd w && ${git} commit -q --allow-empty -m one`,
						`${git} push -q git@git.test:${bare} HEAD:refs/heads/main && echo PUSHED`,
						`${git} ls-remote git@git.test:${bare}`,
						`cd .. && ${git} clone -q -b main ssh://git@git.test${bare} c && ${git} -C c log --format=%s`,
					].join(" && "),
				);
				expect(text(result)).toContain("PUSHED");
				expect(text(result)).toContain("refs/heads/main");
				expect(text(result)).toMatch(/\bone\b/);
				// Written on the host, where the sandbox cannot write: the push went through Prism.
				expect(execFileSync("git", ["--git-dir", bare, "log", "main", "--format=%s"], { encoding: "utf8" })).toBe(
					"one\n",
				);
				expect(logged()).toContain(`-o|BatchMode=yes|--|git@git.test|git-receive-pack '${bare}'|`);
				expect(logged()).toContain(
					`SendEnv=GIT_PROTOCOL|--|git@git.test|git-upload-pack '${bare}'|PROTO=version=2`,
				);
			});

			it("refuses another host and any other command; ssh itself has no network", async () => {
				const marker = join(bin, "ran");
				writeFileSync(
					join(agentDir, "settings.json"),
					JSON.stringify({ sandbox: { network: { allow: ["ssh://git.test", "other.test"] } } }),
				);
				const titles: string[] = [];
				const { harness } = await start(
					recording(titles, (options) => options.find((o) => o === "Block for this command")),
				);
				const ssh = ["/usr/bin/ssh", "/bin/ssh"].find((path) => existsSync(path));
				const result = await bash(
					harness,
					[
						`git ls-remote git@other.test:${bare} 2>&1; echo "other exit $?"`,
						`eval "$GIT_SSH_COMMAND git@git.test 'touch ${marker}'" 2>&1; echo "command exit $?"`,
						`eval "$GIT_SSH_COMMAND -oProxyCommand='touch ${marker}' git.test git-upload-pack x" 2>&1; echo "option exit $?"`,
						...(ssh
							? [`${ssh} -o BatchMode=yes -o ConnectTimeout=3 git@127.0.0.2 true 2>&1; echo "ssh exit $?"`]
							: []),
						"true",
					].join("; "),
				);
				expect(text(result)).toContain("other exit 128");
				expect(text(result)).toContain("command exit 255");
				expect(text(result)).toContain("only Git's own commands");
				expect(text(result)).toContain("option exit 255");
				expect(text(result)).toContain("(option -oProxyCommand=touch");
				if (ssh) expect(text(result)).toContain("ssh exit 255");
				expect(existsSync(marker)).toBe(false);
				expect(logged()).toBe("");
				// Its HTTPS rule does not open it over SSH: the question names Git over SSH, then the note says why.
				const asked = hostQuestions(titles);
				expect(asked).toHaveLength(1);
				expect(asked[0]).toContain("wants to connect to ssh://other.test");
				expect(asked[0]).toContain("This is Git over SSH");
				expect(text(result)).toContain("ssh://other.test (the user blocked it)");
			});

			it("keeps the user's ssh configuration, but nothing in it the sandbox can change", async () => {
				writeFileSync(
					join(agentDir, "settings.json"),
					JSON.stringify({ sandbox: { network: { allow: ["ssh://git.test"] } } }),
				);
				const { harness } = await start();
				const marker = join(bin, "pwned");
				const project = harness.tempDir;
				const sshConfig = join(sshHome, ".ssh", "config");
				// An ordinary configuration (alias, key, jump host, the user's own command) and control sockets
				// where the sandbox writes: Git over SSH works, without the sockets.
				writeFileSync(
					sshConfig,
					`Host gh\n  HostName github.com\n  IdentityFile ~/.ssh/id_gh\n  ProxyJump bastion\nHost *\n  ControlMaster auto\n  ControlPath ${project}/.cm-%C\n`,
				);
				const ok = await bash(
					harness,
					`${git} init -q w && cd w && ${git} commit -q --allow-empty -m one && ${git} push -q git@git.test:${bare} HEAD:refs/heads/main && echo PUSHED`,
				);
				expect(text(ok)).toContain("PUSHED");
				expect(logged()).toContain("-S|none|-o|BatchMode=yes|");
				// An include the sandbox can fill: what a command plants there never runs on the host.
				writeFileSync(sshConfig, `Include ${project}/.ssh-extra/*.conf\n`);
				const planted = await bash(
					harness,
					[
						`mkdir -p .ssh-extra && printf 'Match exec "touch ${marker}"\\n' > .ssh-extra/evil.conf`,
						`cd w && git push -q git@git.test:${bare} HEAD:refs/heads/other 2>&1; echo "push exit $?"`,
					].join("; "),
				);
				expect(text(planted)).toContain("push exit 128");
				expect(text(planted)).toContain(`line 1 (Include) names ${project}/.ssh-extra/*.conf`);
				expect(existsSync(marker)).toBe(false);
				expect(logged()).not.toContain("refs/heads/other");
				expect(
					execFileSync("git", ["--git-dir", bare, "branch", "--format=%(refname:short)"], { encoding: "utf8" }),
				).toBe("main\n");
			});
		});

		describe("Git signing", () => {
			// Keys and keyring hidden from the sandbox, as ~/.ssh and ~/.gnupg are; the Git configuration visible.
			let keys: string;
			let config: string;
			const saved = { ...process.env };
			const git = (cwd: string, ...args: string[]) =>
				execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
			const settings = (gitSigning: boolean) =>
				writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sandbox: { gitSigning, hide: [keys] } }));
			beforeEach(() => {
				keys = mkdtempSync(join(outside, "keys-"));
				config = mkdtempSync(join(outside, "config-"));
				process.env.GIT_CONFIG_GLOBAL = join(config, "gitconfig");
				process.env.GIT_CONFIG_NOSYSTEM = "1";
				process.env.GNUPGHOME = join(keys, "gnupg");
				mkdirSync(process.env.GNUPGHOME, { mode: 0o700 });
			});
			afterEach(() => {
				execFileSync("gpgconf", ["--kill", "all"], { stdio: "ignore" });
				for (const name of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GNUPGHOME"]) {
					if (saved[name] === undefined) delete process.env[name];
					else process.env[name] = saved[name];
				}
			});
			const sshKey = () => {
				execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "t", "-f", join(keys, "id")]);
				const pub = readFileSync(join(keys, "id.pub"), "utf8").trim();
				writeFileSync(join(config, "allowed"), `t@example.com ${pub}\n`);
				writeFileSync(
					process.env.GIT_CONFIG_GLOBAL!,
					`[user]\n\tname = t\n\temail = t@example.com\n\tsigningkey = ${join(keys, "id")}\n[gpg]\n\tformat = ssh\n[gpg "ssh"]\n\tallowedSignersFile = ${join(config, "allowed")}\n`,
				);
			};

			it("signs commits and tags with the user's SSH key, which never enters the sandbox", async () => {
				sshKey();
				settings(true);
				const { harness } = await start();
				const result = await bash(
					harness,
					`git init -q w && cd w && git commit -q -S --allow-empty -m signed && git tag -s v1 -m v1 && echo SIGNED; test -e ${join(keys, "id")} || echo NO-KEY`,
				);
				expect(text(result)).toContain("SIGNED");
				// The key folder is empty in the sandbox: Prism signed outside it.
				expect(text(result)).toContain("NO-KEY");
				const repo = join(harness.tempDir, "w");
				expect(
					execFileSync("git", ["-C", repo, "verify-commit", "HEAD"], { encoding: "utf8", stdio: "pipe" }),
				).toBe("");
				expect(git(repo, "cat-file", "commit", "HEAD")).toContain("-----BEGIN SSH SIGNATURE-----");
				git(repo, "verify-tag", "v1");
			});

			it("signs with the user's OpenPGP key, for the committer as Git does without a key set", async () => {
				execFileSync(
					"gpg",
					["--batch", "--passphrase", "", "--quick-gen-key", "T <t@example.com>", "ed25519", "sign", "never"],
					{
						stdio: "ignore",
					},
				);
				writeFileSync(process.env.GIT_CONFIG_GLOBAL!, "[user]\n\tname = T\n\temail = t@example.com\n");
				settings(true);
				const { harness } = await start();
				const result = await bash(
					harness,
					"git init -q w && cd w && git commit -q -S --allow-empty -m signed && echo SIGNED",
				);
				expect(text(result)).toContain("SIGNED");
				const repo = join(harness.tempDir, "w");
				expect(git(repo, "cat-file", "commit", "HEAD")).toContain("-----BEGIN PGP SIGNATURE-----");
				git(repo, "verify-commit", "HEAD");
			});

			it("signs nothing while the setting is off, nothing but Git's objects, and no program the sandbox wrote", async () => {
				sshKey();
				settings(false);
				const { harness } = await start();
				const off = await bash(
					harness,
					'git init -q w && cd w && git commit -q -S --allow-empty -m signed; echo "exit $?"',
				);
				expect(text(off)).toContain("Git signs with my key");
				expect(text(off)).not.toContain("exit 0");
				settings(true);
				const marker = join(outside, `ran-${basename(keys)}`);
				const refused = await bash(
					harness,
					[
						"cd w",
						'signer=$(git config gpg.ssh.program); printf hello > note; "$signer" -Y sign -n git -f k note; echo "data exit $?"',
						'"$signer" -Y sign -n file -f k note; echo "namespace exit $?"',
						'"$signer" --export-secret-keys --armor 2>/dev/null | wc -c',
						// A repository the sandbox made: its configuration could name any program, run on the host.
						`git init -q n && cd n && printf '#!/bin/sh\\ntouch ${marker}\\n' > evil && chmod +x evil`,
						'git config gpg.ssh.program "$PWD/evil" && git commit -q -S --allow-empty -m x; echo "planted exit $?"',
					].join("; "),
				);
				expect(text(refused)).toContain("only Git commits and tags are signed");
				expect(text(refused)).toContain("data exit 1");
				expect(text(refused)).toContain("namespace exit 1");
				expect(text(refused)).toMatch(/namespace exit 1\s+0\s/);
				expect(text(refused)).toContain("sets gpg.ssh.program, and commands in the sandbox can change it");
				expect(text(refused)).not.toContain("planted exit 0");
				expect(existsSync(marker)).toBe(false);
				expect(existsSync(join(harness.tempDir, "w", "note.sig"))).toBe(false);
			});
		});

		describe("the user's containers", () => {
			// A throwaway Podman: its own storage and service, one container with secrets in its environment and labels.
			let store: string;
			let service: ChildProcess | undefined;
			const saved = process.env.DOCKER_HOST;
			const podmanEnv = () => {
				const { DOCKER_HOST: _docker, CONTAINER_HOST: _container, ...env } = process.env;
				return {
					...env,
					HOME: store,
					XDG_DATA_HOME: join(store, "data"),
					XDG_CONFIG_HOME: join(store, "config"),
					XDG_RUNTIME_DIR: join(store, "run"),
					CONTAINERS_CONF: "/dev/null",
				};
			};
			const host = (...args: string[]) =>
				execFileSync("podman", args, { env: podmanEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
			const settings = (containers: boolean) =>
				writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sandbox: { containers } }));
			beforeAll(async () => {
				if (!podman) return;
				store = mkdtempSync(join(outside, "podman-"));
				mkdirSync(join(store, "run"), { mode: 0o700 });
				mkdirSync(join(store, "image"));
				writeFileSync(join(store, "image", "hello"), "hello\n");
				// Owned by root in the image, which is the user outside it: the store stays removable.
				const archive = execFileSync("tar", ["--owner=0", "--group=0", "-C", join(store, "image"), "-c", "."]);
				execFileSync("podman", ["import", "-q", "-", "localhost/prism-test:1"], {
					env: podmanEnv(),
					input: archive,
				});
				host(
					"create",
					"-q",
					"--name",
					"prism-c1",
					"--env",
					"SECRET=env-canary",
					"--label",
					"token=label-canary",
					"localhost/prism-test:1",
					"/hello",
					"--password=cmd-canary",
				);
				const socket = join(store, "run", "podman.sock");
				service = spawn("podman", ["system", "service", "--time=0", `unix://${socket}`], {
					env: podmanEnv(),
					stdio: "ignore",
				});
				for (let tries = 0; !existsSync(socket) && tries < 100; tries++)
					await new Promise((done) => setTimeout(done, 50));
				process.env.DOCKER_HOST = `unix://${socket}`;
			});
			afterAll(() => {
				if (!podman) return;
				service?.kill();
				if (saved === undefined) delete process.env.DOCKER_HOST;
				else process.env.DOCKER_HOST = saved;
				execFileSync("podman", ["system", "reset", "--force"], { env: podmanEnv(), stdio: "ignore" });
			});

			it.skipIf(!podman)("lists them, without what they hold, and changes nothing", async () => {
				settings(true);
				const { harness } = await start();
				const result = await bash(
					harness,
					[
						// ./test.sh puts HOME in the host's /tmp, which the sandbox replaces; Podman's client needs one.
						'test -d "$HOME" || export HOME=$PWD',
						"podman ps -a --format '{{.Names}} {{.Image}} {{.Status}}'",
						"podman images --format 'image {{.Repository}}:{{.Tag}}'",
						"podman ps -a --filter name=prism-c1 --format 'filtered {{.Names}}'",
						// What the listing must not carry: the environment, the labels, the command line.
						'api=$(echo "$DOCKER_HOST" | cut -c7-)',
						'curl -s --noproxy "*" "$api/v1.41/containers/json?all=1" | grep -c canary',
						'podman ps -a --filter label=token=label-canary; echo "label exit $?"',
						'podman inspect prism-c1; echo "inspect exit $?"',
						'podman logs prism-c1; echo "logs exit $?"',
						'podman rm -f prism-c1; echo "rm exit $?"',
						'podman create localhost/prism-test:1 /hello; echo "create exit $?"',
						'curl -s --noproxy "*" -X POST "$api/v1.41/volumes/create" -d "{}"; echo',
					].join("; "),
				);
				const out = text(result);
				expect(out).toContain("prism-c1 localhost/prism-test:1 Created");
				expect(out).toContain("image localhost/prism-test:1");
				expect(out).toContain("filtered prism-c1");
				expect(out).not.toContain("canary");
				expect(out).toMatch(/^0$/m);
				expect(out).toContain("cannot filter on label");
				for (const name of ["label", "inspect", "logs", "rm", "create"]) {
					expect(out).toContain(`${name} exit`);
					expect(out).not.toContain(`${name} exit 0`);
				}
				expect(out).toContain("only see containers, never change them");
				// Nothing changed on the host.
				expect(host("ps", "-a", "--format", "{{.Names}}").trim()).toBe("prism-c1");
				expect(host("volume", "ls", "-q").trim()).toBe("");
			});

			it.skipIf(!podman)("shows nothing while the setting is off", async () => {
				settings(false);
				const { harness } = await start();
				const result = await bash(
					harness,
					[
						'test -d "$HOME" || export HOME=$PWD',
						'api=$(echo "$DOCKER_HOST" | cut -c7-)',
						'curl -s --noproxy "*" "$api/v1.41/containers/json?all=1"; echo',
						'podman ps -a; echo "exit $?"',
					].join("; "),
				);
				expect(text(result)).toContain("Commands see my containers");
				expect(text(result)).not.toContain("prism-c1");
				expect(text(result)).not.toContain("exit 0");
			});
		});

		describe("the system's services", () => {
			// The host's real system bus: reading only, and the one write tried names a unit that does not exist.
			const settings = (serviceState: boolean) =>
				writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sandbox: { serviceState } }));

			it.skipIf(!systemBus)("reads the state of services, and changes none", async () => {
				settings(true);
				const { harness } = await start();
				const result = await bash(
					harness,
					[
						'echo "active: $(systemctl is-active systemd-journald.service)"',
						"systemctl show -p Id systemd-journald.service",
						'systemctl list-units --no-pager --type=service | grep -c "systemd-journald.service"',
						'systemctl stop prism-nonexistent.service; echo "stop exit $?"',
						'busctl --system call org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager CanPowerOff; echo "login1 exit $?"',
					].join("; "),
				);
				const out = text(result);
				expect(out).toContain("active: active");
				expect(out).toContain("Id=systemd-journald.service");
				expect(out).toMatch(/^1$/m);
				expect(out).toContain("StopUnit on org.freedesktop.systemd1 is refused");
				expect(out).toContain("stop exit 1");
				expect(out).not.toContain("login1 exit 0");
			});

			it.skipIf(!systemBus)("reaches no bus while the setting is off, and names the setting", async () => {
				settings(false);
				const { harness } = await start();
				const result = await bash(harness, 'systemctl is-active systemd-journald.service; echo "exit $?"');
				expect(text(result)).toContain("Commands read the state of services");
				expect(text(result)).not.toContain("exit 0");
			});
		});

		describe("in a task scope", () => {
			/** The approval screen, where the user says they go away and approves (one operation line). */
			const approveAway = (async (factory: (...args: unknown[]) => ScopeView) => {
				let result: ScopeApproval | undefined;
				const view = factory(
					{ terminal: { rows: 40, columns: 100 }, requestRender: () => {} },
					undefined,
					undefined,
					(value: ScopeApproval | undefined) => {
						result = value;
					},
				);
				for (const key of ["\x1b[B", "\x1b[B", "\r", "\x1b[B", "\r"]) view.handleInput(key);
				return result;
			}) as unknown as ExtensionUIContext["custom"];
			const propose = (hosts: string[], commands: string[] = []) =>
				fauxAssistantMessage(
					fauxToolCall("propose_scope", { operations: [{ what: "Fetch the pages", commands, hosts }] }),
					{ stopReason: "toolUse" },
				);

			it("lets its commands reach its hosts without a question; refuses any other at once, then again", async () => {
				initTheme("dark");
				const titles: string[] = [];
				const { harness } = await start(
					recording(titles, (options) => options[0]),
					approveAway,
				);
				harness.setResponses([
					propose(["127.0.0.2"], ["curl"]),
					fauxAssistantMessage(fauxToolCall("bash", { command: `curl -sS ${base}/in; true` }), {
						stopReason: "toolUse",
					}),
					fauxAssistantMessage(fauxToolCall("bash", { command: `wget -qO- ${base}/other; true` }), {
						stopReason: "toolUse",
					}),
					fauxAssistantMessage(fauxToolCall("bash", { command: `wget -qO- ${base}/again; true` }), {
						stopReason: "toolUse",
					}),
					fauxAssistantMessage("done"),
				]);
				await harness.session.prompt("go");
				const outputs = harness.session.messages
					.filter((message) => message.role === "toolResult" && message.toolName === "bash")
					.map((message) => JSON.stringify((message as { content: unknown }).content));
				expect(outputs[0]).toContain("hello /in");
				// wget is not one of the operation's commands: the host is refused without a question.
				expect(outputs[1]).not.toContain("hello /other");
				expect(outputs[1]).toContain("outside the approved task scope while the user is away");
				expect(outputs[2]).not.toContain("hello /again");
				expect(hostQuestions(titles)).toHaveLength(0);
			});

			it("while the user stays: a host blocked for the task is refused again without a question", async () => {
				initTheme("dark");
				const titles: string[] = [];
				const offered: string[] = [];
				const approve = (async (factory: (...args: unknown[]) => ScopeView) => {
					let result: ScopeApproval | undefined;
					const view = factory(
						{ terminal: { rows: 40, columns: 100 }, requestRender: () => {} },
						undefined,
						undefined,
						(value: ScopeApproval | undefined) => {
							result = value;
						},
					);
					for (const key of ["\x1b[B", "\x1b[B", "\x1b[B", "\r"]) view.handleInput(key);
					return result;
				}) as unknown as ExtensionUIContext["custom"];
				const { harness } = await start(
					recording(titles, (options) => {
						offered.push(...options);
						return options.find((option) => option.endsWith("for this task") && option.startsWith("Block"));
					}),
					approve,
				);
				harness.setResponses([
					propose(["example.org"], ["curl"]),
					fauxAssistantMessage(fauxToolCall("bash", { command: `curl -sS ${base}/one; true` }), {
						stopReason: "toolUse",
					}),
					fauxAssistantMessage(fauxToolCall("bash", { command: `curl -sS ${base}/two; true` }), {
						stopReason: "toolUse",
					}),
					fauxAssistantMessage("done"),
				]);
				await harness.session.prompt("go");
				const outputs = harness.session.messages
					.filter((message) => message.role === "toolResult" && message.toolName === "bash")
					.map((message) => JSON.stringify((message as { content: unknown }).content));
				expect(hostQuestions(titles)).toHaveLength(1);
				expect(offered).toContain('Allow 127.0.0.2 for "run curl" for this task');
				expect(offered).toContain("Block 127.0.0.2 for this task");
				expect(outputs[0]).not.toContain("hello /one");
				expect(outputs[1]).not.toContain("hello /two");
			});

			it("closes a background task's open connections when the user ends the scope", async () => {
				initTheme("dark");
				const { harness } = await start(async (title, options) => {
					if (title.startsWith("Task scope:")) return options.find((option) => option.startsWith("End"));
					return allowAll(title, options);
				}, approveAway);
				const started = slowRequests.length;
				harness.setResponses([
					propose(["127.0.0.2"]),
					fauxAssistantMessage(
						fauxToolCall("background", {
							action: "run",
							command: `curl -sS -N -p ${base}/slow > slow.txt 2>&1; echo "curl exit $?" >> slow.txt`,
						}),
						{ stopReason: "toolUse" },
					),
					fauxAssistantMessage("done"),
				]);
				await harness.session.prompt("go");
				let deadline = Date.now() + 10_000;
				while (slowRequests.length === started && Date.now() < deadline)
					await new Promise((r) => setTimeout(r, 50));
				expect(slowRequests.length).toBe(started + 1);
				const file = join(harness.tempDir, "slow.txt");
				// The server notes the request as it writes the answer's start: curl must have it (unbuffered, -N)
				// before the scope ends, or the cut gives "Empty reply from server".
				deadline = Date.now() + 10_000;
				while (!readFileSync(file, "utf8").includes("started") && Date.now() < deadline)
					await new Promise((r) => setTimeout(r, 20));
				await harness.session.prompt("/perm scope");
				deadline = Date.now() + 10_000;
				while (!readFileSync(file, "utf8").includes("curl exit") && Date.now() < deadline) {
					await new Promise((r) => setTimeout(r, 50));
				}
				const output = readFileSync(file, "utf8");
				expect(Date.now() - slowRequests.at(-1)!).toBeLessThan(3_500);
				expect(output).toContain("started");
				expect(output).not.toContain("finished");
				expect(output).not.toContain("curl exit 0");
			});

			it("keeps a background task's hosts after its task, until the scope's time is up", async () => {
				initTheme("dark");
				const titles: string[] = [];
				const { harness } = await start(
					recording(titles, () => undefined),
					approveAway,
				);
				const wait = `while [ ! -e go-$N ]; do sleep 0.05; done`;
				const command = [1, 2, 3]
					.map((n) => `${wait.replace("$N", String(n))}; curl -sS ${base}/b${n} > b${n}.txt 2>&1`)
					.join("; ");
				harness.setResponses([
					propose(["127.0.0.2"]),
					fauxAssistantMessage(fauxToolCall("background", { action: "run", command }), { stopReason: "toolUse" }),
					fauxAssistantMessage("done"),
				]);
				const file = (n: number) => join(harness.tempDir, `b${n}.txt`);
				const fetched = async (n: number) => {
					writeFileSync(join(harness.tempDir, `go-${n}`), "");
					const deadline = Date.now() + 10_000;
					while (!(existsSync(file(n)) && readFileSync(file(n), "utf8")) && Date.now() < deadline) {
						await new Promise((resolve) => setTimeout(resolve, 50));
					}
					return readFileSync(file(n), "utf8");
				};
				await harness.session.prompt("go");
				expect(await fetched(1)).toBe("hello /b1\n");
				// The task has ended: the background task still holds the scope.
				expect(await fetched(2)).toBe("hello /b2\n");
				expect(hostQuestions(titles)).toHaveLength(0);
				// The scope's time is up: the next connection is asked about as without a scope (unanswered here).
				const now = Date.now();
				const later = vi.spyOn(Date, "now").mockReturnValue(now + 9 * 60 * 60_000);
				try {
					expect(await fetched(3)).not.toContain("hello /b3");
				} finally {
					later.mockRestore();
				}
				expect(hostQuestions(titles)).toHaveLength(1);
			});
		});
	});

	it("tells the model what is hidden, before and after, and shows the sandbox in the footer", async () => {
		const statuses: string[] = [];
		const harness = await createHarness({
			extensionFactories: [{ name: "permissions", factory: permissionsExtension }],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				select: allowAll,
				setStatus: (key, text) => {
					if (key === "permissions" && text) statuses.push(text);
				},
			}),
		});
		expect(statuses.at(-1)).toBe("perm: broad · sandbox");
		const result = await bash(harness, `cat ${agentDir}/auth.json; true`);
		expect(text(result)).toContain("is hidden by the sandbox");
		expect(harness.session.agent.state.systemPrompt).toContain("# Sandbox");
		expect(harness.session.agent.state.systemPrompt).toContain(agentDir);
	});

	it("runs excluded commands outside, and the user's ! commands inside only when asked", async () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sandbox: { excludedCommands: ["touch"] } }));
		const questions: string[] = [];
		let { harness } = await start(async (title, options) => {
			questions.push(title);
			return allowAll(title, options);
		});
		await bash(harness, `touch ${outside}/excluded.txt`);
		expect(existsSync(join(outside, "excluded.txt"))).toBe(true);
		expect(questions.join("\n")).toContain("runs outside the sandbox");
		// The user's own rule still allows it without a question.
		writeFileSync(
			join(agentDir, "permissions.json"),
			JSON.stringify({ mode: "broad", allow: [`bash(touch ${outside}/ruled.txt)`] }),
		);
		questions.length = 0;
		({ harness } = await start(async (title, options) => {
			questions.push(title);
			return allowAll(title, options);
		}));
		await bash(harness, `touch ${outside}/ruled.txt`);
		expect(existsSync(join(outside, "ruled.txt"))).toBe(true);
		expect(questions).toEqual([]);
		await bash(harness, `touch ${outside}/compound.txt; true`);
		expect(existsSync(join(outside, "compound.txt"))).toBe(false);

		const userBash = async (command: string) => {
			const handled = await harness.session.extensionRunner.emitUserBash({
				type: "user_bash",
				command,
				excludeFromContext: true,
				cwd: harness.tempDir,
			});
			await harness.session.executeBash(command, undefined, {
				excludeFromContext: true,
				operations: handled?.operations,
			});
		};
		await userBash(`echo x > ${outside}/user-outside.txt`);
		expect(existsSync(join(outside, "user-outside.txt"))).toBe(true);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sandbox: { userCommands: true } }));
		({ harness } = await start());
		await userBash(`echo x > ${outside}/user-inside.txt`);
		expect(existsSync(join(outside, "user-inside.txt"))).toBe(false);
	});

	it("keeps Git hooks and the project's Prism config read-only", async () => {
		const { harness } = await start();
		execFileSync("git", ["init", "--quiet", harness.tempDir], {
			env: {
				PATH: process.env.PATH,
				HOME: harness.tempDir,
				XDG_CONFIG_HOME: harness.tempDir,
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: "/dev/null",
			},
			stdio: "ignore",
		});
		mkdirSync(join(harness.tempDir, ".git", "hooks"), { recursive: true });
		mkdirSync(join(harness.tempDir, CONFIG_DIR_NAME), { recursive: true });
		// The sandbox is computed per command, so folders created now count.
		// fork: a computed config path reaches the mounts instead of the earlier literal-path refusal.
		// fork: the command writes its private copy of the Git metadata; a hook and a HEAD that names no ref
		// are refused when its changes are published, and the real ones stay as they were.
		const head = readFileSync(join(harness.tempDir, ".git", "HEAD"), "utf8");
		const result = await bash(
			harness,
			`configDir=${CONFIG_DIR_NAME}; echo x > .git/hooks/pre-commit; echo '{}' > "$configDir/settings.json"; echo ok > .git/HEAD; true`,
		);
		expect(existsSync(join(harness.tempDir, ".git", "hooks", "pre-commit"))).toBe(false);
		expect(existsSync(join(harness.tempDir, CONFIG_DIR_NAME, "settings.json"))).toBe(false);
		expect(readFileSync(join(harness.tempDir, ".git", "HEAD"), "utf8")).toBe(head);
		expect(text(result)).toContain("Git changes were not applied");
		expect(text(result)).toContain("hooks/pre-commit is a Git hook, which is never published from the sandbox");
	});

	// fork: only the user's uid is mapped, so root's included files looked like
	// nobody's and ssh refused them before connecting ("Bad owner or permissions").
	it.skipIf(!existsSync("/etc/ssh/ssh_config") || !includedSshFiles().length)(
		"lets ssh read the system configuration; the included files stay read-only",
		async () => {
			const { harness } = await start();
			const included = includedSshFiles()[0]!;
			const result = await bash(
				harness,
				`ssh -G example.com > resolved.txt; echo ssh=$?; cat '${included}' > seen.txt; touch '${included}' 2>&1; true`,
			);
			expect(text(result)).toContain("ssh=0");
			expect(text(result)).not.toContain("Bad owner");
			expect(text(result)).toMatch(/Read-only file system|Permission denied/);
			expect(readFileSync(join(harness.tempDir, "resolved.txt"), "utf8")).toMatch(/^hostname example\.com$/m);
			expect(readFileSync(join(harness.tempDir, "seen.txt"), "utf8")).toBe(readFileSync(included, "utf8"));
		},
	);

	it("runs background tasks in the sandbox too", async () => {
		const { harness } = await start();
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("background", { action: "run", command: `echo out > ${outside}/bg.txt; echo in > bg.txt` }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		const deadline = Date.now() + 5_000;
		while (!existsSync(join(harness.tempDir, "bg.txt")) && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		expect(existsSync(join(harness.tempDir, "bg.txt"))).toBe(true);
		expect(existsSync(join(outside, "bg.txt"))).toBe(false);
	});

	// the sandbox is on by default in ask and safe too.
	it("is on in ask mode by default, and off when turned off for broad", async () => {
		writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode: "ask" }));
		let { harness } = await start();
		expect(sessionSandbox(harness.sessionManager)).toMatchObject({ bwrap: expect.any(String) });
		writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode: "broad" }));
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sandbox: { modes: { broad: false } } }));
		({ harness } = await start());
		expect(sessionSandbox(harness.sessionManager)).toBeUndefined();
	});

	// Prism starts and says how to fix it; the commands that need the sandbox stay blocked.
	it("keeps Prism running when bubblewrap is missing, refused or drops the filter, and never runs the command outside", async () => {
		const savedPath = process.env.PATH;
		const fakeBin = mkdtempSync(join(tmpdir(), "prism-fake-bwrap-"));
		const fakes = {
			missing: undefined,
			refused: "echo 'bwrap: setting up uid map: Permission denied' >&2\nexit 1",
			// Runs the real bubblewrap without the seccomp filter.
			unfiltered: `for arg in "$@"; do shift; if [ -n "$skip" ]; then skip=; continue; fi; if [ "$arg" = --seccomp ]; then skip=1; continue; fi; set -- "$@" "$arg"; done\nexec ${bwrap} "$@"`,
		};
		const expected = {
			missing: /not installed/,
			refused:
				/AppArmor[\s\S]*profile bwrap \/\S*bwrap flags=\(unconfined\)[\s\S]*sudo apparmor_parser -r \/etc\/apparmor.d\/bwrap/,
			unfiltered: /seccomp filter did not apply/,
		};
		try {
			for (const [label, script] of Object.entries(fakes) as [keyof typeof fakes, string | undefined][]) {
				if (script) {
					writeFileSync(join(fakeBin, "bwrap"), `#!/bin/sh\n${script}\n`);
					chmodSync(join(fakeBin, "bwrap"), 0o755);
				}
				process.env.PATH = script ? `${fakeBin}:${savedPath}` : fakeBin;
				// Ask mode, where a command asks first.
				writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode: "ask" }));
				const questions: string[] = [];
				const { harness, shutdowns, notices } = await start(async (title, options) => {
					if (title.startsWith("Allow this action?")) questions.push(title);
					return allowAll(title, options);
				});
				expect(shutdowns, label).toEqual([]);
				expect(notices.join("\n"), label).toMatch(expected[label]);
				expect(notices.join("\n"), label).toMatch(/stay blocked[\s\S]*Check the sandbox again/);
				process.env.PATH = savedPath;
				const result = await bash(harness, `echo ran > ran-${label}.txt`);
				expect(result.isError, label).toBe(true);
				// the model is told not to retry or work around it, and the user is not asked for nothing.
				expect(text(result), label).toMatch(
					/stays blocked until the user fixes it; do not retry or try to work around it/,
				);
				expect((await bash(harness, "npm --version")).isError, label).toBe(true);
				expect(questions, label).toEqual([]);
				expect(existsSync(join(harness.tempDir, `ran-${label}.txt`)), label).toBe(false);
				// Fixed (the real bubblewrap is back on PATH): checked again from /settings, without restarting.
				await settingsSections().find((section) => section.domain === "permissions")!.onChange!(
					"sandbox-check",
					"check",
				);
				expect(notices.at(-1), label).toBe("The sandbox works.");
				expect((await bash(harness, `echo ran > ran-${label}.txt`)).isError, label).toBe(false);
				// The same commands ask once the sandbox works.
				expect(questions.length, label).toBeGreaterThan(0);
				expect(existsSync(join(harness.tempDir, `ran-${label}.txt`)), label).toBe(true);
			}
		} finally {
			process.env.PATH = savedPath;
			rmSync(fakeBin, { recursive: true, force: true });
		}
	});
});
