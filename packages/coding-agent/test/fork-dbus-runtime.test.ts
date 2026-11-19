import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { SYSTEM_BUS } from "../src/fork/sandbox/dbus.ts";
import { parseSandboxSettings } from "../src/fork/sandbox/layout.ts";
import { DEFAULT_NETWORK_SETTINGS, HostPolicy } from "../src/fork/sandbox/proxy.ts";
import {
	createSandboxableBashOperations,
	findBwrap,
	removeSessionTmpDir,
	type SandboxRuntime,
	sessionTmpDir,
	startSandbox,
} from "../src/fork/sandbox/runtime.ts";

const bwrap = findBwrap();
const usableBwrap =
	bwrap &&
	spawnSync(bwrap, ["--ro-bind", "/", "/", "--unshare-user", "--", "true"], {
		timeout: 5000,
		stdio: "ignore",
	}).status === 0;
const probeHome = mkdtempSync("/tmp/prism-dbus-availability-");
const systemBus =
	existsSync(SYSTEM_BUS) &&
	spawnSync(
		"busctl",
		[
			`--address=unix:path=${SYSTEM_BUS}`,
			"call",
			"org.freedesktop.DBus",
			"/org/freedesktop/DBus",
			"org.freedesktop.DBus",
			"GetNameOwner",
			"s",
			"org.freedesktop.systemd1",
		],
		{ env: { ...process.env, HOME: probeHome }, timeout: 5000, stdio: "ignore" },
	).status === 0;
rmSync(probeHome, { recursive: true, force: true });

// No provider: exercise the same bash operations used by the tool, with disposable HOME and agent dirs.
describe.skipIf(!usableBwrap)("fork: private container runtime and service reads in the real sandbox", () => {
	let base: string;
	let project: string;
	let agentDir: string;
	let ids: string[];
	let sockets: Server[];

	beforeEach(() => {
		base = mkdtempSync("/tmp/prism-dbus-runtime-");
		project = join(base, "project");
		agentDir = join(base, "agent");
		mkdirSync(project);
		mkdirSync(agentDir);
		mkdirSync(join(base, "home"));
		vi.stubEnv("HOME", join(base, "home"));
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		vi.stubEnv("XDG_CONFIG_HOME", join(base, "home/.config"));
		vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
		vi.stubEnv("TMPDIR", "/tmp");
		expect(spawnSync("git", ["init", "-q", project], { timeout: 5000 }).status).toBe(0);
		ids = [];
		sockets = [];
	});

	afterEach(async () => {
		for (const socket of sockets) await new Promise<void>((done) => socket.close(() => done()));
		for (const id of ids) removeSessionTmpDir(id);
		vi.unstubAllEnvs();
		rmSync(base, { recursive: true, force: true });
	});

	async function start(containers: boolean, serviceState = false): Promise<SandboxRuntime> {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sandbox: { containers, serviceState } }));
		const id = `${base}-${ids.length}`;
		ids.push(id);
		const tmp = sessionTmpDir(id);
		expect(existsSync(join(tmp, "prism-runtime"))).toBe(false);
		const runtime = await startSandbox(
			parseSandboxSettings({ containers, serviceState, read: { limit: "project" } }),
			project,
			new HostPolicy(() => DEFAULT_NETWORK_SETTINGS, undefined),
			tmp,
		);
		if ("error" in runtime) throw new Error(runtime.error);
		return runtime;
	}

	async function run(runtime: SandboxRuntime, command: string) {
		const chunks: Buffer[] = [];
		const result = await createSandboxableBashOperations(() => runtime).exec(command, project, {
			env: { ...process.env, XDG_RUNTIME_DIR: "/run/user/prism-inherited" },
			onData: (chunk) => chunks.push(chunk),
			timeout: 15,
		});
		return { ...result, text: Buffer.concat(chunks).toString() };
	}

	it("creates a user-owned 0700 runtime for the command, isolates sessions, and removes it with private /tmp", async () => {
		const first = await start(true);
		const second = await start(true);
		const folder = join(first.tmp, "prism-runtime");
		const created = await run(
			first,
			'test "$XDG_RUNTIME_DIR" = /tmp/prism-runtime && echo own > "$XDG_RUNTIME_DIR/canary" && stat -c "%a %u" "$XDG_RUNTIME_DIR"',
		);
		expect(created.exitCode, created.text).toBe(0);
		expect(created.text.trim()).toBe(`700 ${process.getuid!()}`);
		expect(statSync(folder).mode & 0o777).toBe(0o700);
		expect(statSync(folder).uid).toBe(process.getuid!());
		expect(readFileSync(join(folder, "canary"), "utf8")).toBe("own\n");
		const isolated = await run(
			second,
			`test ! -e '${folder}/canary' && test ! -e "$XDG_RUNTIME_DIR/canary" && echo other > "$XDG_RUNTIME_DIR/canary"`,
		);
		expect(isolated.exitCode, isolated.text).toBe(0);
		expect((await run(first, 'cat "$XDG_RUNTIME_DIR/canary"')).text.trim()).toBe("own");
		removeSessionTmpDir(ids[0]!);
		expect(existsSync(first.tmp)).toBe(false);
		expect(existsSync(folder)).toBe(false);
		expect(existsSync(join(second.tmp, "prism-runtime/canary"))).toBe(true);
	});

	it("does not set or create the virtual runtime while containers are off", async () => {
		const runtime = await start(false);
		const result = await run(runtime, 'printf "%s\\n" "$XDG_RUNTIME_DIR"; test ! -e /tmp/prism-runtime');
		expect(result.exitCode, result.text).toBe(0);
		expect(result.text.trim()).toBe("/run/user/prism-inherited");
		expect(existsSync(join(runtime.tmp, "prism-runtime"))).toBe(false);
	});

	it("hides host runtime paths and denies Unix connections even to a visible synthetic socket", async () => {
		const runtime = await start(true);
		const visibleSocket = join(project, "synthetic-agent.sock");
		const socket = createServer((stream) => stream.end("host-canary"));
		sockets.push(socket);
		await new Promise<void>((done) => socket.listen(visibleSocket, done));
		expect(statSync(visibleSocket).isSocket()).toBe(true);
		const outside = await new Promise<string>((done, fail) => {
			const client = connect(visibleSocket);
			let text = "";
			client.on("data", (chunk: Buffer) => {
				text += chunk.toString();
			});
			client.on("end", () => done(text));
			client.on("error", fail);
		});
		expect(outside).toBe("host-canary");
		const uid = process.getuid!();
		const paths = [
			"bus",
			"wayland-0",
			"pipewire-0",
			"pulse/native",
			"gnupg/S.gpg-agent",
			"ssh-agent",
			"systemd/private",
		];
		const result = await run(
			runtime,
			[
				`test ! -S /run/user/${uid}/bus`,
				...paths.map((path) => `test ! -S /run/user/${uid}/${path}`),
				"test ! -S /tmp/.X11-unix/X0",
				`test -S '${visibleSocket}'`,
				`node -e 'const net = require("node:net"); const s = net.connect(${JSON.stringify(visibleSocket)}); s.on("connect", () => { process.exit(23); }); s.on("error", e => { console.log(e.code); process.exit(e.code === "EACCES" || e.code === "EPERM" ? 0 : 24); });'`,
			].join(" && "),
		);
		expect(result.exitCode, result.text).toBe(0);
		expect(result.text).toMatch(/EACCES|EPERM/);
	});

	describe.skipIf(!systemBus)("system bus", () => {
		it("keeps status, show, list-units and is-active usable, and refuses changes with a reason", async () => {
			const runtime = await start(false, true);
			for (const command of [
				"systemctl status --no-pager dbus.service",
				"systemctl show dbus.service -p ActiveState -p SubState -p MainPID",
				"systemctl list-units --no-pager --type=service",
				"systemctl is-active dbus.service",
			]) {
				const result = await run(runtime, command);
				expect(result.exitCode, result.text).toBe(0);
				// systemd prints the properties in its own order, which differs between versions.
				if (command.includes(" show ")) {
					expect(result.text).toMatch(/^ActiveState=active$/m);
					expect(result.text).toMatch(/^SubState=running$/m);
					expect(result.text).toMatch(/^MainPID=\d+$/m);
				}
			}
			// state fields only, never the unit's command line or environment.
			const configuration = await run(
				runtime,
				"systemctl show dbus.service -p ExecStart -p Environment -p ActiveState",
			);
			expect(configuration.text).toMatch(/^ActiveState=active$/m);
			expect(configuration.text).not.toMatch(/ExecStart=.*path=/);
			expect(configuration.text).not.toMatch(/^Environment=./m);
			const refused = await run(runtime, "systemctl stop prism-audit-nonexistent.service");
			expect(refused.exitCode).not.toBe(0);
			expect(refused.text).toContain("StopUnit on org.freedesktop.systemd1 is refused");
			const match = await run(
				runtime,
				`busctl --system call org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus AddMatch s "type='signal'"`,
			);
			expect(match.exitCode).not.toBe(0);
			expect(match.text).toContain("match rules must select only systemd signals");
		});

		it("denies service reads with the setting off", async () => {
			const result = await run(await start(false), "systemctl show dbus.service -p ActiveState");
			expect(result.exitCode).not.toBe(0);
			expect(result.text).toContain("Commands read the state of services");
		});
	});
});
