import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import backgroundExtension, { backgroundTasks } from "../src/fork/background.ts";
import permissionsExtension from "../src/fork/permissions.ts";
import { commandTmpDir, writableDirectory } from "../src/fork/sandbox/command-tmpdir.ts";
import { buildLayout, parseSandboxSettings, type SandboxLayout } from "../src/fork/sandbox/layout.ts";
import { DEFAULT_NETWORK_SETTINGS, HostPolicy } from "../src/fork/sandbox/proxy.ts";
import {
	createSandboxableBashOperations,
	findBwrap,
	removeSessionTmpDir,
	sandboxArgv,
	sessionSandbox,
} from "../src/fork/sandbox/runtime.ts";
import { createHarness, createTestUiContext, getMessageText, getToolResult, type Harness } from "./suite/harness.ts";

describe("fork: command TMPDIR decision", () => {
	const home = "/home/test";
	const project = `${home}/project`;
	const allowed = "/work/allowed";
	const layout = buildLayout({
		cwd: project,
		home,
		agentDir: `${home}/.prism/agent`,
		tmp: "/session-tmp",
		settings: parseSandboxSettings({ allowWrite: [allowed] }),
		exists: (path) => [home, project, allowed, `${home}/.prism/agent`].includes(path),
		realpath: (path) => path,
		env: { PATH: "" },
	});
	const directory = (path: string) => resolve(path);

	it.each([
		[`${home}/private/tmp`, "/tmp"],
		["/tmp/custom", "/tmp"],
		["/tmp", "/tmp"],
		["/tmp/", "/tmp/"],
		["/usr", "/tmp"],
		[`${project}/tmp`, `${project}/tmp`],
		[`${allowed}/tmp`, `${allowed}/tmp`],
		[`${project}-other/tmp`, "/tmp"],
		[undefined, undefined],
		["", ""],
		["tmp", "tmp"],
		["~/tmp", "~/tmp"],
	])("chooses %s → %s from the computed writable binds", (value, expected) => {
		expect(commandTmpDir(value, layout, directory)).toBe(expected);
	});

	it("leaves a display-only layout unchanged", () => {
		expect(commandTmpDir("/usr", { ...layout, tmp: undefined }, directory)).toBe("/usr");
	});

	it("replaces host /tmp descendants even when a writable bind lists them", () => {
		expect(commandTmpDir("/tmp/custom", { ...layout, writable: ["/tmp"] }, directory)).toBe("/tmp");
	});

	it("rejects absent, non-directory or unwritable destinations", () => {
		expect(commandTmpDir(`${project}/tmp`, layout, () => undefined)).toBe("/tmp");
	});

	it("rejects read-only, copied and hidden mounts inside writable binds", () => {
		for (const protection of [
			{ readOnly: [project] },
			{ hidden: [project] },
			{ copies: [["/copy", project]] as Array<[string, string]> },
		]) {
			expect(commandTmpDir(`${project}/tmp`, { ...layout, ...protection }, directory)).toBe("/tmp");
		}
	});

	it("follows links to hidden home folders and private /tmp subfolders", () => {
		for (const target of [`${home}/private/tmp`, "/tmp/custom"]) {
			expect(commandTmpDir(`${project}/link`, layout, () => target)).toBe("/tmp");
		}
		expect(commandTmpDir(`${project}/link`, layout, () => `${allowed}/tmp`)).toBe(`${project}/link`);
		expect(commandTmpDir(`${project}/link`, layout, () => "/tmp")).toBe(`${project}/link`);
		expect(commandTmpDir("/work/link", layout, () => `${project}/tmp`)).toBe("/work/link");
		expect(commandTmpDir(`${home}/private/link`, layout, () => `${project}/tmp`)).toBe("/tmp");
		expect(commandTmpDir("/hidden/link", { ...layout, hidden: ["/hidden"] }, () => project)).toBe("/tmp");
		expect(commandTmpDir(`${project}/link/../../../../tmp`, layout, () => `${home}/private/tmp`)).toBe("/tmp");
	});

	it("checks the project's cache source instead of the host home cache", () => {
		const cache = layout.home!;
		const inspect = vi.fn(directory);
		expect(commandTmpDir(`${home}/.cache/tmp`, layout, inspect)).toBe(`${home}/.cache/tmp`);
		expect(inspect).toHaveBeenCalledWith(
			`${home}/.cache/tmp`,
			{ source: cache.cache, destination: `${home}/.cache` },
			expect.any(Function),
		);
		expect(commandTmpDir(`${home}/.cache/absent`, layout, () => undefined)).toBe("/tmp");
		expect(commandTmpDir(`${home}/.cache/link`, layout, () => `${home}/private/tmp`)).toBe("/tmp");
	});
});

describe("fork: TMPDIR filesystem facts", () => {
	let base: string;
	beforeEach(() => {
		base = mkdtempSync("/tmp/prism-tmpdir-facts-");
	});
	afterEach(() => rmSync(base, { recursive: true, force: true }));

	it("checks existence and directory type, and resolves links", () => {
		mkdirSync(join(base, "directory"));
		writeFileSync(join(base, "file"), "");
		chmodSync(join(base, "file"), 0o700);
		symlinkSync(join(base, "directory"), join(base, "link"));
		expect(writableDirectory(join(base, "absent"))).toBeUndefined();
		expect(writableDirectory(join(base, "file"))).toBeUndefined();
		expect(writableDirectory(join(base, "link"))).toBe(realpathSync(join(base, "directory")));
	});

	it.skipIf(process.getuid?.() === 0)("rejects host directories without write or search permission", () => {
		const path = join(base, "restricted");
		mkdirSync(path);
		try {
			for (const mode of [0o555, 0o666]) {
				chmodSync(path, mode);
				expect(writableDirectory(path)).toBeUndefined();
			}
		} finally {
			chmodSync(path, 0o700);
		}
	});

	it("resolves cache links in the sandbox namespace, not into Prism's hidden cache source", () => {
		const source = join(base, "cache-source");
		const destination = "/home/test/.cache";
		mkdirSync(join(source, "tmp"), { recursive: true });
		symlinkSync("tmp", join(source, "relative"));
		symlinkSync(`${destination}/tmp`, join(source, "absolute"));
		symlinkSync(`${source}/tmp`, join(source, "hidden-source"));
		const mount = { source, destination };
		for (const name of ["tmp", "relative", "absolute", "relative/../tmp"]) {
			expect(writableDirectory(`${destination}/${name}`, mount)).toBe(`${destination}/tmp`);
		}
		// This absolute link still names the hidden source inside the sandbox; do not map it back to ~/.cache.
		expect(writableDirectory(`${destination}/hidden-source`, mount)).toBe(`${source}/tmp`);
		expect(writableDirectory(`${destination}/absent/../tmp`, mount)).toBeUndefined();
		symlinkSync("loop", join(source, "loop"));
		expect(writableDirectory(`${destination}/loop`, mount)).toBeUndefined();
	});

	it("rejects a real project link pointing into a hidden home directory", () => {
		// Outside /tmp, so its special rule cannot conceal a missing symlink check.
		const root = mkdtempSync(join(process.cwd(), ".prism-tmpdir-links-"));
		try {
			const project = join(root, "project");
			const hidden = join(root, "home/private");
			mkdirSync(project);
			mkdirSync(hidden, { recursive: true });
			symlinkSync(hidden, join(project, "link"));
			symlinkSync(project, join(hidden, "back"));
			const layout: SandboxLayout = {
				cwd: project,
				tmp: "/session-tmp",
				writable: [project],
				hidden: [hidden],
				readOnly: [],
			};
			expect(commandTmpDir(project, layout, writableDirectory)).toBe(project);
			expect(commandTmpDir(join(project, "link"), layout, writableDirectory)).toBe("/tmp");
			expect(commandTmpDir(`${project}/link/../private`, layout, writableDirectory)).toBe("/tmp");
			expect(commandTmpDir(`${project}/link/back`, layout, writableDirectory)).toBe("/tmp");
			expect(commandTmpDir(`${project}/absent/..`, layout, writableDirectory)).toBe("/tmp");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("sets TMPDIR through bwrap only, using the command's environment", () => {
		const home = join(base, "home");
		const project = join(home, "project");
		const agentDir = join(base, "agent");
		mkdirSync(project, { recursive: true });
		mkdirSync(agentDir);
		vi.stubEnv("HOME", home);
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		vi.stubEnv("TMPDIR", "/tmp/host-value");
		const policy = new HostPolicy(() => DEFAULT_NETWORK_SETTINGS, undefined);
		const network = policy.open({ command: "mktemp" });
		const channel = {
			toRelay: "/in",
			fromRelay: "/out",
			localPorts: [],
			alias: "127.88.0.1",
			network,
			close: () => network.close(),
		};
		const runtime = {
			bwrap: "/bwrap",
			settings: parseSandboxSettings({}),
			agentDir,
			seccomp: "/filter",
			policy,
			tmp: base,
		};
		try {
			const args = sandboxArgv(runtime, project, channel, ["/bin/true"], { TMPDIR: join(home, "hidden"), PATH: "" });
			expect(args.slice(args.indexOf("--setenv"), args.indexOf("--setenv") + 3)).toEqual([
				"--setenv",
				"TMPDIR",
				"/tmp",
			]);
			expect(sandboxArgv(runtime, project, channel, ["/bin/true"], { PATH: "" })).not.toContain("TMPDIR");
			expect(process.env.TMPDIR).toBe("/tmp/host-value");
		} finally {
			channel.close();
			vi.unstubAllEnvs();
		}
	});

	it("leaves unsandboxed commands' TMPDIR unchanged", async () => {
		const chunks: Buffer[] = [];
		const result = await createSandboxableBashOperations(() => undefined).exec('printf "%s" "$TMPDIR"', base, {
			env: { ...process.env, TMPDIR: "/hidden/unusable" },
			onData: (data) => chunks.push(data),
			timeout: 5,
		});
		expect(result.exitCode).toBe(0);
		expect(Buffer.concat(chunks).toString()).toBe("/hidden/unusable");
	});
});

const bwrap = findBwrap();
const python = spawnSync("python3", ["--version"], { timeout: 2000, stdio: "ignore" }).status === 0;
const node = spawnSync("node", ["--version"], { timeout: 2000, stdio: "ignore" }).status === 0;

describe.skipIf(!bwrap)("fork: TMPDIR in the real sandbox", () => {
	let base: string | undefined;
	let home: string;
	let harness: Harness | undefined;

	beforeEach(() => {
		// /tmp is replaced inside the sandbox; keep the throwaway home and project outside it.
		base = realpathSync(mkdtempSync("/var/tmp/prism-tmpdir-"));
		home = join(base, "home");
		const agentDir = join(base, "agent");
		mkdirSync(join(home, "private-tmp"), { recursive: true });
		mkdirSync(agentDir);
		vi.stubEnv("HOME", home);
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		vi.stubEnv("TMPDIR", base);
		vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
		vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
		writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode: "broad" }));
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sandbox: { read: { limit: "project" } } }));
	});

	afterEach(() => {
		if (harness) {
			removeSessionTmpDir(harness.sessionManager.getSessionId());
			harness.cleanup();
			harness = undefined;
		}
		vi.unstubAllEnvs();
		if (base) rmSync(base, { recursive: true, force: true });
		base = undefined;
	});

	async function start() {
		harness = await createHarness({
			extensionFactories: [
				{ name: "permissions", factory: permissionsExtension },
				{ name: "background", factory: backgroundExtension },
			],
		});
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				select: async (_title, options) => options.find((o) => o.startsWith("Allow")),
			}),
		});
		expect(sessionSandbox(harness.sessionManager)).toMatchObject({ bwrap });
		return harness;
	}

	async function run(h: Harness, tool: "bash" | "background", command: string) {
		h.setResponses([
			fauxAssistantMessage(fauxToolCall(tool, tool === "bash" ? { command } : { action: "run", command }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await h.session.prompt("go");
		const result = getToolResult(h, tool);
		expect(result.isError, getMessageText(result)).not.toBe(true);
		return getMessageText(result);
	}

	it("makes mktemp use private /tmp when inherited TMPDIR is hidden", async () => {
		const h = await start();
		vi.stubEnv("TMPDIR", join(home, "private-tmp"));
		const result = await run(h, "bash", 'p=$(mktemp) && test -f "$p" && printf "created:%s\\n" "$p"');
		expect(result).toMatch(/created:\/tmp\/tmp\./);
		expect(process.env.TMPDIR).toBe(join(home, "private-tmp"));
	});

	it.skipIf(!python)("gives Python tempfile a usable private /tmp", async () => {
		const h = await start();
		vi.stubEnv("TMPDIR", join(home, "private-tmp"));
		expect(await run(h, "bash", "python3 -c 'import tempfile; print(tempfile.mkdtemp())'")).toMatch(/\/tmp\/tmp/);
	});

	it.skipIf(!node)("lets Node write through os.tmpdir()", async () => {
		const h = await start();
		vi.stubEnv("TMPDIR", join(home, "private-tmp"));
		expect(
			await run(
				h,
				"bash",
				`node -e 'const fs = require("node:fs"); const os = require("node:os"); console.log(fs.mkdtempSync(os.tmpdir() + "/node-"))'`,
			),
		).toMatch(/\/tmp\/node-/);
	});

	it("keeps an existing writable project TMPDIR", async () => {
		const h = await start();
		const custom = join(h.tempDir, "custom-tmp");
		mkdirSync(custom);
		vi.stubEnv("TMPDIR", custom);
		expect(await run(h, "bash", 'p=$(mktemp) && test -f "$p" && echo "$p"')).toContain(`${custom}/tmp.`);
	});

	it("gives a background task the same private /tmp as foreground bash", async () => {
		const h = await start();
		vi.stubEnv("TMPDIR", join(home, "private-tmp"));
		const command = 'p=$(mktemp) && test -f "$p" && printf "created:%s\\n" "$p"';
		expect(await run(h, "bash", command)).toMatch(/created:\/tmp\/tmp\./);
		await run(h, "background", command);
		await vi.waitFor(
			() => {
				expect(backgroundTasks()?.[0]?.status).toBe("done");
				expect(readFileSync(backgroundTasks()![0]!.logPath, "utf8")).toMatch(/created:\/tmp\/tmp\./);
			},
			{ timeout: 8000 },
		);
	});
});
