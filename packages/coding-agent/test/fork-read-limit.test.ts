// fork: reading limited to the project computes what the home folder shows
// the project, the tools' resources and what the user allowed; credentials stay hidden inside them.
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR, getReadmePath } from "../src/config.ts";
import type { ExtensionAPI, ExtensionUIContext } from "../src/core/extensions/types.ts";
import permissionsExtension, { decidePermission, modePolicy, READ_LIMIT_NOTICE } from "../src/fork/permissions.ts";
import { addProjectRule, readProjectGrants } from "../src/fork/project-permissions.ts";
import { chooseHomeStart, opensWholeHome, startsFresh } from "../src/fork/sandbox/home-start.ts";
import {
	buildLayout,
	bwrapArgs,
	DEFAULT_HIDDEN_HOME_PATHS,
	DEFAULT_SANDBOX_SETTINGS,
	parseSandboxSettings,
	readEverythingThisRun,
	readSandboxSettings,
	type SandboxSettings,
} from "../src/fork/sandbox/layout.ts";
import { sandboxPromptSection, sandboxResultNote } from "../src/fork/sandbox/notes.ts";
import { isReadable, type ReadLimitInput, readableSet } from "../src/fork/sandbox/read-limit.ts";
import { findBwrap, removeSessionTmpDir, sessionSandbox, sessionTmpDir } from "../src/fork/sandbox/runtime.ts";
import { createToolCaches } from "../src/fork/sandbox/tool-caches.ts";
import type { ListEditor } from "../src/fork/settings-list-editor.ts";
import { settingsSections } from "../src/fork/settings-sections.ts";
import type { ScopeApproval, ScopeView } from "../src/fork/task-scope.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, createTestUiContext, getMessageText, getToolResult, type Harness } from "./suite/harness.ts";

describe("fork: reading limited to the project", () => {
	let home: string;
	let project: string;
	const file = (path: string, content = "x") => {
		mkdirSync(dirname(join(home, path)), { recursive: true });
		writeFileSync(join(home, path), content);
	};
	const set = (input: Partial<ReadLimitInput> = {}) =>
		readableSet({
			cwd: project,
			home,
			env: {},
			git: () => undefined,
			...input,
			hide: [...DEFAULT_HIDDEN_HOME_PATHS.map((path) => `~/${path}`), ...(input.hide ?? [])],
		});
	const readable = (input: Partial<ReadLimitInput>, ...paths: string[]) => {
		const limit = set(input);
		return paths.filter((path) => isReadable(limit, join(home, path)));
	};

	beforeEach(() => {
		home = realpathSync(mkdtempSync(join(tmpdir(), "prism-read-limit-")));
		project = join(home, "projects/p");
		for (const path of [
			".bash_history",
			".zsh_history",
			"Documents/secret.txt",
			".codex/auth.json",
			".codex/packages/codex/bin/codex",
			".cache/huggingface/token",
			"projects/autre/README.md",
			"projects/p/src/index.ts",
			".gitconfig",
			".config/git/ignore",
			".config/git/credentials",
			".config/Code/User/settings.json",
			".rustup/settings.toml",
			".cargo/bin/cargo",
			".cargo/registry/index/x",
			".cargo/credentials.toml",
			".cargo/config.toml",
			".npmrc",
			".npm/_logs/x",
			".local/bin/tool",
			".local/lib/python3.14/site-packages/x.py",
			".local/share/uv/credentials/credentials.toml",
			".local/share/uv/python/cpython/bin/python3",
			".local/share/keyrings/login.keyring",
			".ssh/id_ed25519",
			".netrc",
		]) {
			file(path);
		}
		symlinkSync(join(home, ".codex/packages/codex/bin/codex"), join(home, ".local/bin/codex"));
	});
	afterEach(() => rmSync(home, { recursive: true, force: true }));

	it("shows the project and the tools' resources, and nothing else of the home folder", () => {
		const limit = set({ env: { PATH: `${home}/.local/bin:${home}/.cargo/bin:/usr/bin` } });
		expect(limit.project).toBe(project);
		expect(limit.read.map(({ path, why }) => [path.slice(home.length + 1), why])).toEqual([
			[".gitconfig", "Git"],
			[".config/git", "Git"],
			[".rustup", "Rust"],
			[".cargo", "Rust"],
			[".local/share/uv/python", "Python"],
			[".local/lib/python3.14", "Python"],
			[".local/bin", "PATH"],
		]);
		expect(limit.write.map((path) => path.slice(home.length + 1))).toEqual([".cargo/registry", ".npm"]);
		// Credentials inside readable folders, and Cargo's configuration until it is rebuilt from allowed fields.
		expect(limit.hidden.map((path) => path.slice(home.length + 1)).sort()).toEqual([
			".cargo/config.toml",
			".cargo/credentials.toml",
			".config/git/credentials",
		]);
		expect(
			readable(
				{ env: { PATH: `${home}/.local/bin` } },
				"projects/p/src/index.ts",
				".rustup/settings.toml",
				".cargo/bin/cargo",
				".npm/_logs/x",
				".local/bin/tool",
				".config/git/ignore",
			),
		).toHaveLength(6);
		expect(
			readable(
				{ env: { PATH: `${home}/.local/bin` } },
				".bash_history",
				".zsh_history",
				"Documents/secret.txt",
				".codex/auth.json",
				// A link of the PATH leads into a folder with credentials: the folder stays closed.
				".codex/packages/codex/bin/codex",
				".cache/huggingface/token",
				"projects/autre/README.md",
				".config/Code/User/settings.json",
				".cargo/credentials.toml",
				".config/git/credentials",
				".npmrc",
				".local/share/uv/credentials/credentials.toml",
				".ssh/id_ed25519",
				".netrc",
				"",
			),
		).toEqual([]);
	});

	it("opens no wide folder, hidden folder or link out of the set through the PATH or a variable", () => {
		symlinkSync(join(home, ".ssh"), join(home, "sshbin"));
		symlinkSync(home, join(home, "all"));
		const limit = set({
			env: {
				PATH: [home, `${home}/.local`, `${home}/.config`, `${home}/.ssh`, `${home}/sshbin`, `${home}/all`].join(
					":",
				),
				CARGO_HOME: `${home}/.local`,
				VIRTUAL_ENV: `${home}/.local/share/keyrings`,
				JAVA_HOME: `${home}/.cache`,
				GOPATH: "relative/go",
			},
		});
		expect(limit.read.map(({ why }) => why)).not.toContain("PATH");
		expect(limit.read.map(({ why }) => why)).not.toContain("CARGO_HOME");
		expect(limit.read.map(({ why }) => why)).not.toContain("VIRTUAL_ENV");
		expect(limit.read.map(({ why }) => why)).not.toContain("JAVA_HOME");
		// A tool's folder that is a link elsewhere in the home folder shows where it leads, and only that.
		rmSync(join(home, ".rustup"), { recursive: true });
		file("toolchains/rustup/settings.toml");
		file("toolchains/other.txt");
		symlinkSync(join(home, "toolchains/rustup"), join(home, ".rustup"));
		// The guard passes real paths (§ 9.5).
		expect(readable({}, "toolchains/rustup/settings.toml")).toHaveLength(1);
		expect(readable({}, "toolchains/other.txt")).toEqual([]);
		// Credentials stay hidden where the link leads.
		rmSync(join(home, ".cargo"), { recursive: true });
		file("toolchains/cargo/bin/cargo");
		file("toolchains/cargo/credentials.toml");
		symlinkSync(join(home, "toolchains/cargo"), join(home, ".cargo"));
		expect(readable({}, "toolchains/cargo/bin/cargo", "toolchains/cargo/credentials.toml")).toEqual([
			"toolchains/cargo/bin/cargo",
		]);
		// The same through a link that leads into a hidden folder.
		rmSync(join(home, ".rustup"));
		symlinkSync(join(home, ".ssh"), join(home, ".rustup"));
		expect(set().read.map(({ path }) => path)).not.toContain(join(home, ".ssh"));
		expect(readable({}, ".ssh/id_ed25519")).toEqual([]);
	});

	it("adds what the user allows, never a hidden folder, and removes what the user hides or turns off", () => {
		file("datasets/sales.csv");
		file("out/build.log");
		expect(readable({ allow: ["~/datasets"] }, "datasets/sales.csv")).toHaveLength(1);
		expect(
			readable({ allow: ["~/.ssh", "~/.netrc", "~"] }, ".ssh/id_ed25519", ".netrc", "Documents/secret.txt"),
		).toEqual([]);
		// Writing implies reading.
		const limit = set({ allowWrite: ["~/out"] });
		expect(limit.write).toContain(join(home, "out"));
		expect(isReadable(limit, join(home, "out/build.log"))).toBe(true);
		expect(readable({ hide: ["~/.cargo"] }, ".cargo/bin/cargo", ".rustup/settings.toml")).toEqual([
			".rustup/settings.toml",
		]);
		expect(readable({ toolsOff: ["Rust"] }, ".cargo/bin/cargo", ".rustup/settings.toml", ".gitconfig")).toEqual([
			".gitconfig",
		]);
	});

	it("takes the Git top level as the project, with a worktree's common directory", () => {
		file("projects/main/.git/HEAD");
		file("projects/main/secret.txt");
		mkdirSync(join(project, "src/deep"), { recursive: true });
		const limit = set({
			cwd: join(project, "src/deep"),
			git: () => ({ top: project, common: join(home, "projects/main/.git") }),
		});
		expect(limit.project).toBe(project);
		expect(limit.gitCommon).toBe(join(home, "projects/main/.git"));
		expect(isReadable(limit, join(home, "projects/main/.git/HEAD"))).toBe(true);
		// The main repository's working files are another project.
		expect(isReadable(limit, join(home, "projects/main/secret.txt"))).toBe(false);
		expect(set({ git: () => ({ top: project, common: join(project, ".git") }) }).gitCommon).toBeUndefined();
	});

	it("shows no project when Prism is opened in the home folder or above it", () => {
		expect(set({ cwd: home })).toMatchObject({ wholeHome: true, project: undefined });
		expect(set({ cwd: "/", git: () => undefined })).toMatchObject({ wholeHome: true, project: undefined });
		expect(isReadable(set({ cwd: home }), join(home, "Documents/secret.txt"))).toBe(false);
	});

	it("hides the other accounts and mounted media, except a project or a folder the user names there", () => {
		const present = new Set(["/home/me", "/home/other", "/root", "/mnt", "/mnt/disk/p", "/mnt/disk/data", "/media"]);
		const machine: Partial<ReadLimitInput> = {
			home: "/home/me",
			cwd: "/mnt/disk/p",
			exists: (path) => present.has(path),
			realpath: (path) => path,
			entries: (path) => (path === "/home" ? ["me", "other"] : []),
		};
		const limit = set(machine);
		expect(limit.hiddenOutside).toEqual(["/home/other", "/root", "/media", "/mnt"]);
		expect(isReadable(limit, "/mnt/disk/p/file")).toBe(true);
		expect(isReadable(limit, "/usr/bin/git")).toBe(true);
		for (const path of ["/home/other/notes", "/root/x", "/mnt/disk/data/x", "/media/usb/x"]) {
			expect(isReadable(limit, path), path).toBe(false);
		}
		expect(isReadable(set({ ...machine, allow: ["/mnt/disk/data"] }), "/mnt/disk/data/x")).toBe(true);
		// A PATH entry is not an explicit choice: it does not reopen a mounted disk.
		present.add("/mnt/disk/bin");
		expect(isReadable(set({ ...machine, env: { PATH: "/mnt/disk/bin" } }), "/mnt/disk/bin/tool")).toBe(false);
	});

	describe("in the sandbox's layout", () => {
		const limited: SandboxSettings = {
			...DEFAULT_SANDBOX_SETTINGS,
			read: { limit: "project", allow: [], toolsOff: [] },
		};
		const everything: SandboxSettings = { ...limited, read: { ...limited.read, limit: "all" } };
		const layoutFor = (cwd = project, settings = limited) =>
			buildLayout({ cwd, home, agentDir: join(home, ".pi/agent"), settings, env: { PATH: `${home}/.cargo/bin` } });

		it("is on by default, and reads its settings", () => {
			expect(parseSandboxSettings({}).read).toEqual({ limit: "project", allow: [], toolsOff: [] });
			expect(
				parseSandboxSettings({ read: { limit: "project", allow: ["~/data"], tools: { Rust: false, Git: true } } })
					.read,
			).toEqual({ limit: "project", allow: ["~/data"], toolsOff: ["Rust"] });
			expect(parseSandboxSettings({ read: { limit: "everything", allow: "~" } }).read).toEqual({
				limit: "project",
				allow: [],
				toolsOff: [],
			});
			expect(layoutFor(project, everything).home).toBeUndefined();
		});

		it("replaces the home folder with the project, the resources and the project's own cache", () => {
			const layout = layoutFor();
			expect(layout.blocked).toBeUndefined();
			expect(layout.home).toMatchObject({ path: home, read: expect.arrayContaining([join(home, ".rustup")]) });
			expect(layout.home?.cache).toMatch(new RegExp(`^${home}/\\.pi/agent/sandbox/cache/[0-9a-f]{16}$`));
			expect(layoutFor(join(home, "projects/autre")).home?.cache).not.toBe(layout.home?.cache);
			// The real ~/.cache is no longer writable; the tools' caches of the table are.
			expect(layout.writable).toContain(join(home, ".npm"));
			expect(layout.writable).not.toContain(join(home, ".cache"));
			// What the home folder does not show is not mounted there, even unreadable; credentials inside are.
			expect(layout.hidden).not.toContain(join(home, ".ssh"));
			expect(layout.hidden).not.toContain(join(home, ".pi/agent"));
			expect(layout.hidden).toContain(join(home, ".cargo/credentials.toml"));
			const args = bwrapArgs(layout, (path) => !path.endsWith(".toml"), "/unreadable");
			const at = (...pair: string[]) =>
				args.findIndex((_arg, index) => pair.every((part, offset) => args[index + offset] === part));
			expect(at("--tmpfs", home)).toBeGreaterThan(at("--ro-bind", "/", "/"));
			expect(at("--ro-bind", join(home, ".rustup"))).toBeGreaterThan(at("--tmpfs", home));
			expect(at("--bind", layout.home!.cache, join(home, ".cache"))).toBeGreaterThan(at("--tmpfs", home));
			// Podman's client needs ~/.config, shown empty but for the resources in it.
			expect(at("--dir", join(home, ".config"))).toBe(at("--tmpfs", home) + 2);
			expect(at("--bind", project)).toBeGreaterThan(at("--tmpfs", home));
			expect(at("--ro-bind", "/unreadable", join(home, ".cargo/credentials.toml"))).toBeGreaterThan(
				at("--ro-bind", join(home, ".cargo")),
			);
			expect(at("--remount-ro", home)).toBe(args.indexOf("--chdir") - 2);
			// Other accounts and mounted media are emptied the same way.
			const outside = bwrapArgs({ ...layout, home: { ...layout.home!, hiddenOutside: ["/mnt"] } }, () => true, "/x");
			expect(outside.join(" ")).toContain(`--tmpfs /mnt --tmpfs ${home}`);
			expect(outside.join(" ")).toContain(`--remount-ro /mnt --remount-ro ${home} --chdir`);
		});

		it("refuses commands when Prism is opened in the home folder", () => {
			expect(layoutFor(home).blocked).toContain("opened in the home folder");
		});

		// Q-L12: refused, with a precise folder to name instead, whatever the read limit.
		it("refuses commands, saying why, when the home folder or a folder above it is writable or readable", () => {
			for (const wide of ["~", home, dirname(home), "/"]) {
				for (const read of [limited.read, everything.read]) {
					const writing = layoutFor(project, { ...limited, read, allowWrite: [wide] }).blocked;
					expect(writing).toContain(`sandbox.allowWrite lists ${wide}, which is the home folder or holds it`);
					expect(writing).toContain(join(home, "Documents"));
					expect(writing).not.toContain('"all"');
					const reading = layoutFor(project, { ...limited, read: { ...read, allow: [wide] } }).blocked;
					expect(reading).toContain(`sandbox.read.allow lists ${wide}`);
					expect(reading?.includes('sandbox.read.limit: "all"')).toBe(read.limit === "project");
				}
			}
			// Through a link too; a folder of the home folder is not refused.
			mkdirSync(join(home, "links"), { recursive: true });
			symlinkSync(home, join(home, "links/home"));
			expect(layoutFor(project, { ...limited, allowWrite: ["~/links/home"] }).blocked).toContain("holds it");
			expect(layoutFor(project, { ...limited, allowWrite: ["~/Documents"] }).blocked).toBeUndefined();
			// Nor does such a folder open anything to the file tools.
			const wide = set({ allow: ["~", dirname(home)], allowWrite: ["~", "/"] });
			expect([wide.read, wide.write]).toEqual([set().read, set().write]);
		});

		// Lot 7 (Q-L3): the settings that can hold credentials are rebuilt, unless shown as they are or hidden.
		it("lists the settings to rebuild", () => {
			const settings = (read: Partial<SandboxSettings["read"]> = {}, hide: string[] = []) =>
				layoutFor(project, { ...limited, hide, read: { ...limited.read, ...read } }).home?.settings;
			// ~/.cargo/config is absent here, so not hidden in ~/.cargo, which is shown: nothing to rebuild.
			expect(settings()).toEqual(
				[".npmrc", ".config/pip/pip.conf", ".pip/pip.conf", ".config/uv/uv.toml", ".cargo/config.toml"].map(
					(path) => join(home, path),
				),
			);
			expect(settings({ allow: ["~/.npmrc"] })).not.toContain(join(home, ".npmrc"));
			expect(settings({}, ["~/.config/pip"])).not.toContain(join(home, ".config/pip/pip.conf"));
			expect(settings({ toolsOff: ["Rust"] })).not.toContain(join(home, ".cargo/config.toml"));
			expect(layoutFor(project, everything).home).toBeUndefined();
		});

		it("tells the model what it may read, and why a file of the home folder is missing", () => {
			const layout = layoutFor();
			expect(sandboxPromptSection(layout)).toContain("Reading is limited to the project, the tools' resources (");
			expect(sandboxPromptSection(layoutFor(project, everything))).not.toContain("Reading is limited");
			expect(
				sandboxResultNote(`cat ~/Documents/x\ncat: ${home}/Documents/x: No such file or directory`, layout),
			).toContain("~/Documents/x is outside what the agent may read");
			// In a folder it shows, a missing file is just missing; outside the home folder too.
			for (const text of [
				`cat ${home}/.rustup/nope\ncat: ${home}/.rustup/nope: No such file or directory`,
				`cat ${project}/nope\ncat: ${project}/nope: No such file or directory`,
				"cat /etc/nope\ncat: /etc/nope: No such file or directory",
			]) {
				expect(sandboxResultNote(text, layout), text).toBeUndefined();
			}
			expect(
				sandboxResultNote(`cat ~/x\ncat: ${home}/x: No such file or directory`, layoutFor(project, everything)),
			).toBeUndefined();
		});
	});
});

const bwrap = findBwrap();

// § 9.11, tests 1, 3, 4, 7, 8 and 10, in the real sandbox: a throwaway home folder, the limit turned on.
// Owner, 2026-10-23 (Q-L11): limited by default once compatibility was measured; only `all` lifts it.
describe("fork: reading limited by default", () => {
	it("limits reading unless the settings say all, whatever else they hold", () => {
		expect(DEFAULT_SANDBOX_SETTINGS.read.limit).toBe("project");
		for (const sandbox of [
			undefined,
			{},
			{ read: {} },
			{ read: "all" },
			{ read: { limit: "bogus" } },
			{ read: { limit: true } },
		]) {
			expect(parseSandboxSettings(sandbox).read.limit, JSON.stringify(sandbox)).toBe("project");
		}
		expect(parseSandboxSettings({ read: { limit: "all" } }).read.limit).toBe("all");
	});
});

// Owner, 2026-10-23: the tools' absent caches are made before a command, which could not make them itself.
describe("fork: the tools' absent caches", () => {
	let base: string;
	let home: string;
	let bin: string;
	const limited = parseSandboxSettings({});
	const everything = parseSandboxSettings({ read: { limit: "all" } });
	const made = (settings: SandboxSettings, path = bin) =>
		createToolCaches(settings, join(home, "p"), home, path).map((folder) => folder.slice(home.length + 1));

	beforeEach(() => {
		base = realpathSync(mkdtempSync(join(tmpdir(), "prism-caches-")));
		home = join(base, "home");
		bin = join(base, "bin");
		mkdirSync(home);
		mkdirSync(bin);
		for (const tool of ["npm", "cargo"]) writeFileSync(join(bin, tool), "");
	});
	afterEach(() => rmSync(base, { recursive: true, force: true }));

	it("makes the caches of the tools in the PATH that would be writable, once", () => {
		expect(made(limited)).toEqual([".npm", ".cargo/registry", ".cargo/git"]);
		writeFileSync(join(home, ".npm/kept"), "x");
		expect(made(limited)).toEqual([]);
		expect(readFileSync(join(home, ".npm/kept"), "utf8")).toBe("x");
		// Not limited: the default writable caches, ~/.cache among them, which limited is the project's own.
		rmSync(home, { recursive: true });
		mkdirSync(home);
		expect(made(everything)).toEqual([".npm", ".cargo/registry", ".cache"]);
		expect(made(everything, "")).toEqual([]);
	});

	it("replaces nothing, follows no link, makes nothing hidden or turned off", () => {
		writeFileSync(join(home, ".npm"), "a file");
		mkdirSync(join(base, "elsewhere"));
		symlinkSync(join(base, "elsewhere"), join(home, ".cargo"));
		expect(made(limited)).toEqual([]);
		expect(readFileSync(join(home, ".npm"), "utf8")).toBe("a file");
		expect(readdirSync(join(base, "elsewhere"))).toEqual([]);
		rmSync(join(home, ".npm"));
		rmSync(join(home, ".cargo"));
		expect(made(parseSandboxSettings({ hide: ["~/.npm"], read: { tools: { Rust: false } } }))).toEqual([]);
		expect(readdirSync(home)).toEqual([]);
		expect(createToolCaches(limited, home, join(base, "absent"), bin)).toEqual([]);
	});
});

describe.skipIf(!bwrap)("fork: reading limited to the project, in the real sandbox", () => {
	let agentDir: string;
	let home: string;
	const savedAgentDir = process.env[ENV_AGENT_DIR];
	const harnesses: Harness[] = [];
	const file = (path: string, content = "canary-home") => {
		mkdirSync(dirname(join(home, path)), { recursive: true });
		writeFileSync(join(home, path), content);
	};

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-read-limit-agent-"));
		// Outside /tmp, which the sandbox replaces with the session's own.
		home = realpathSync(mkdtempSync(join("/var/tmp", "prism-read-limit-home-")));
		process.env[ENV_AGENT_DIR] = agentDir;
		vi.stubEnv("HOME", home);
		vi.stubEnv("PATH", `${home}/.cargo/bin:${home}/.local/bin:${process.env.PATH}`);
		// Git reads the throwaway ~/.gitconfig, as it would the user's (./test.sh points Git elsewhere).
		vi.stubEnv("GIT_CONFIG_GLOBAL", undefined);
		vi.stubEnv("XDG_CONFIG_HOME", undefined);
		writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode: "broad" }));
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sandbox: { read: { limit: "project" } } }));
		for (const path of [
			".bash_history",
			".zsh_history",
			"Documents/secret.txt",
			".codex/auth.json",
			".codex/packages/tool",
			".cache/huggingface/token",
			"projects/autre/README.md",
			".cargo/credentials.toml",
			".config/Code/User/settings.json",
		]) {
			file(path);
		}
		file(".gitconfig", "[user]\n\tname = Bench\n\temail = bench@example.invalid\n");
		file(".rustup/settings.toml", "default = 'stable'\n");
		file(".cargo/bin/hello", "#!/bin/sh\necho hello from cargo\n");
		chmodSync(join(home, ".cargo/bin/hello"), 0o755);
		mkdirSync(join(home, ".npm"));
		mkdirSync(join(home, ".local/bin"), { recursive: true });
		symlinkSync(join(home, ".codex/packages/tool"), join(home, ".local/bin/tool"));
	});

	afterEach(() => {
		for (const harness of harnesses.splice(0)) {
			removeSessionTmpDir(harness.sessionManager.getSessionId());
			harness.cleanup();
		}
		vi.unstubAllEnvs();
		if (savedAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = savedAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	});

	// Copied from fork-sandbox.test.ts, which does not export them.
	async function start() {
		const harness = await createHarness({
			extensionFactories: [{ name: "permissions", factory: permissionsExtension }],
		});
		harnesses.push(harness);
		const notices: string[] = [];
		const questions: string[] = [];
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				notify: (message) => notices.push(message),
				select: async (title, options) => {
					questions.push(title);
					return options.find((option) => option.startsWith("Allow"));
				},
			}),
		});
		return { harness, notices, questions };
	}
	async function bash(harness: Harness, command: string) {
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		const result = getToolResult(harness, "bash");
		return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
	}

	// an alias of a host file cannot be made from inside the sandbox; one
	// already in the project before is a limit (sandbox.md § 4).
	it("refuses a hard link from a host file into the project, with the real layout", async () => {
		const { harness } = await start();
		const made = await bash(harness, "ln ~/.rustup/settings.toml alias.toml; echo status=$?");
		expect(made).toMatch(/Invalid cross-device link|Operation not permitted/);
		expect(made).toContain("status=1");
		expect(existsSync(join(harness.tempDir, "alias.toml"))).toBe(false);
	});

	it("shows a command the project and the tools' resources, and nothing else of the home folder", async () => {
		const { harness } = await start();
		expect(sessionSandbox(harness.sessionManager)).toMatchObject({ bwrap: expect.any(String) });
		// Test 3: a link of the project to a private file.
		symlinkSync(join(home, "Documents/secret.txt"), join(harness.tempDir, "link.txt"));
		const reads = await bash(
			harness,
			[
				"cat ~/.bash_history ~/.zsh_history ~/Documents/secret.txt ~/.codex/auth.json ~/.cache/huggingface/token",
				"head ~/projects/autre/README.md ~/.config/Code/User/settings.json ~/.cargo/credentials.toml",
				`python3 -c 'open("${home}/Documents/secret.txt").read()'`,
				"cat link.txt ~/.local/bin/tool",
				// This test's home by its real path too; not all of /var/tmp, where other runs leave their own.
				`grep -r canary-home ~ ${home}`,
				"true",
			].join("; "),
		);
		expect(reads).not.toContain("canary-home");
		// Test 10: the model learns why, and where the user can widen it.
		expect(reads).toContain("outside what the agent may read");
		const listed = await bash(harness, "ls -a ~ ~/.config ~/.local; find ~ -type f");
		for (const name of [".bash_history", ".zsh_history", "Documents", ".codex", "huggingface", "projects", "Code"]) {
			expect(listed).not.toContain(name);
		}
		expect(listed).toContain(".rustup");
		// Test 4: the tools' resources, through the PATH too.
		const tools = await bash(harness, "cat ~/.rustup/settings.toml; hello; git config user.name");
		expect(tools).toContain("default = 'stable'");
		expect(tools).toContain("hello from cargo");
		expect(tools).toContain("Bench");
		// Test 7: the home folder is read-only, the caches of the table writable; the real ~/.cache is not shown.
		// fork: a write to a cache stays in the command's own layer, never in the real cache.
		const writes = await bash(
			harness,
			"touch ~/nouveau && echo created; echo n > ~/.npm/x && echo npm-ok; echo c > ~/.cache/x && echo cache-ok; true",
		);
		expect(writes).not.toContain("created");
		expect(writes).toContain("npm-ok");
		expect(writes).toContain("cache-ok");
		expect(existsSync(join(home, "nouveau"))).toBe(false);
		expect(existsSync(join(home, ".npm/x"))).toBe(false);
		expect(existsSync(join(home, ".cache/x"))).toBe(false);
		const prompt = harness.session.agent.state.systemPrompt;
		expect(prompt).toContain("Reading is limited to the project");
		expect(prompt).toContain("~/.rustup");
	});

	// Test 5: a linked worktree commits through the main repository's Git folder, which is shown,
	// while the main repository's own files are not, and its hooks and config stay read-only.
	it("commits in a linked worktree, without showing the main repository's files", async () => {
		const main = join(home, "projects/main");
		const run = (cwd: string, ...args: string[]) =>
			execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
		mkdirSync(main, { recursive: true });
		run(main, "init", "-q", "-b", "main");
		writeFileSync(join(main, "work.txt"), "canary-main-worktree");
		run(main, "add", "work.txt");
		run(main, "-c", "user.name=Bench", "-c", "user.email=bench@example.invalid", "commit", "-qm", "first");
		const { harness } = await start();
		// The session's folder already holds .pi: add the worktree beside it, then move it there.
		const beside = `${harness.tempDir}-worktree`;
		run(main, "worktree", "add", "-q", "-b", "linked", beside);
		for (const name of readdirSync(beside)) renameSync(join(beside, name), join(harness.tempDir, name));
		rmSync(beside, { recursive: true });
		run(main, "worktree", "repair", harness.tempDir);
		expect(run(harness.tempDir, "rev-parse", "--git-common-dir").trim()).toBe(join(main, ".git"));
		const out = await bash(
			harness,
			[
				"echo change > new.txt && git add new.txt && git commit -qm second && echo committed",
				"git log --oneline -1",
				`cat ${main}/work.txt`,
				`ls ${main}`,
				`cat ${main}/.git/config`,
				"true",
			].join("; "),
		);
		expect(out).toContain("committed");
		expect(out).toMatch(/second/);
		expect(run(main, "log", "--oneline", "-1", "linked")).toMatch(/second/);
		expect(out).not.toContain("canary-main-worktree");
		// The main repository's Git folder is shown: Git reads its config.
		expect(out).toContain("repositoryformatversion");
		expect(out).toContain("~/projects/main/work.txt is outside what the agent may read");
		// fork: the command writes a private copy of the Git folder, so a hook and a configuration key land
		// there; publishing them is refused, and the real repository keeps neither.
		const refused = await bash(
			harness,
			[
				`echo x > ${main}/.git/hooks/post-commit && echo hook-written`,
				`git config --file ${main}/.git/config core.bare true && echo config-written`,
				"true",
			].join("; "),
		);
		expect(refused).toContain(`this command's Git changes were not applied to ${join(main, ".git")}`);
		expect(refused).toContain("hooks/post-commit");
		expect(existsSync(join(main, ".git/hooks/post-commit"))).toBe(false);
		expect(run(main, "config", "core.bare").trim()).toBe("false");
	});

	// Lot 7 (Q-L3): npm, pip and Cargo see their settings without their credentials.
	it("shows npm, pip and Cargo their settings rebuilt without credentials", async () => {
		file(".npmrc", "registry=https://registry.example/\n//registry.example/:_authToken=npm_CANARY\n");
		file(".config/pip/pip.conf", "[global]\ntimeout = 30\nindex-url = https://user:CANARY@pypi.example/simple\n");
		file(".cargo/config.toml", '[build]\njobs = 4\n[registry]\ntoken = "CANARY"\n');
		const { harness } = await start();
		const out = await bash(
			harness,
			// ./test.sh points npm at its own user config.
			"cat ~/.npmrc ~/.config/pip/pip.conf ~/.cargo/config.toml; env -u npm_config_registry -u NPM_CONFIG_REGISTRY npm --userconfig ~/.npmrc config get registry; echo x >> ~/.npmrc; true",
		);
		expect(out).not.toContain("CANARY");
		expect(out).toContain("[global]\ntimeout = 30");
		expect(out).toContain("[build]\njobs = 4");
		expect(out.match(/https:\/\/registry\.example\//g)).toHaveLength(2);
		expect(readFileSync(join(home, ".npmrc"), "utf8")).toContain("npm_CANARY");
		expect(readFileSync(join(home, ".npmrc"), "utf8")).not.toContain("x\n");
		// A hidden path and a link are not rebuilt: the first is hidden, the second stays hidden. The sandbox's
		// settings are read when the session starts.
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ sandbox: { read: { limit: "project" }, hide: ["~/.npmrc"] } }),
		);
		rmSync(join(home, ".cargo/config.toml"));
		file("elsewhere.toml", '[build]\njobs = 8\n[registry]\ntoken = "CANARY"\n');
		symlinkSync(join(home, "elsewhere.toml"), join(home, ".cargo/config.toml"));
		const hidden = await bash((await start()).harness, "cat ~/.npmrc ~/.cargo/config.toml; echo ran");
		expect(hidden).toContain("ran");
		expect(hidden).not.toContain("registry.example");
		expect(hidden).not.toContain("CANARY");
		expect(hidden).not.toContain("jobs = 8");
	});

	// what the user allows reading opens to file tools and commands alike.
	it("shows commands what the user allowed reading: when asked, for this project, or in /settings", async () => {
		const harness = await createHarness({
			extensionFactories: [{ name: "permissions", factory: permissionsExtension }],
			initialActiveToolNames: ["read", "bash"],
		});
		harnesses.push(harness);
		const questions: string[] = [];
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				select: async (title, options) => {
					questions.push(title);
					return options.find((option) => option === 'Allow "read ~/Documents" in this session');
				},
			}),
		});
		expect(await bash(harness, "cat ~/Documents/secret.txt; true")).not.toContain("canary-home");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "~/Documents/secret.txt" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		expect(questions).toHaveLength(1);
		// The folder, for the session: the next command sees it.
		expect(await bash(harness, "cat ~/Documents/secret.txt")).toContain("canary-home");
		await addProjectRule(harness.tempDir, `readable(${join(home, "projects/autre")})`);
		expect(await bash(harness, "cat ~/projects/autre/README.md")).toContain("canary-home");

		initTheme("dark");
		const section = settingsSections().find((s) => s.domain === "permissions")!;
		const context = { advanced: () => true, requestRender: vi.fn() };
		const item = () => section.items(context).find((i) => i.id === "sandbox-read-allow")!;
		const list = item().submenu!("", vi.fn()) as ListEditor;
		const type = (text: string) => {
			list.handleInput("\r");
			for (const key of text) list.handleInput(key);
			list.handleInput("\r");
		};
		type("~/.cargo/credentials.toml");
		expect(list.render(200).join("\n")).toContain("~/.cargo/credentials.toml cannot be opened here");
		list.handleInput("\x1b");
		type("~/absent");
		expect(list.render(200).join("\n")).toContain("~/absent does not exist.");
		list.handleInput("\x1b");
		type("~/.config");
		expect(list.render(200).join("\n")).toContain("~/.config cannot be opened here");
		list.handleInput("\x1b");
		type("~/.zsh_history");
		list.handleInput("\x1b[B");
		list.handleInput("\r");
		expect(readFileSync(join(agentDir, "settings.json"), "utf8")).toContain('"~/.zsh_history"');
		expect(item().currentValue).toContain("~/.zsh_history");
		expect(await bash(harness, "cat ~/.zsh_history")).toContain("canary-home");
		// What was not allowed stays out.
		expect(await bash(harness, "cat ~/.bash_history ~/.cargo/credentials.toml; true")).not.toContain("canary-home");
	});

	it("starts with what this project may read open, without taking it for the home folder showing through", async () => {
		const { harness } = await start();
		// The first entry of the home folder, which the start-up check would otherwise use as its witness.
		await addProjectRule(harness.tempDir, `readable(${join(home, ".bash_history")})`);
		// A setting saved starts the sandbox again, with its check.
		initTheme("dark");
		await settingsSections().find((s) => s.domain === "permissions")!.onChange!("sandbox-ask-hosts", "on");
		expect(sessionSandbox(harness.sessionManager)).toMatchObject({ bwrap: expect.any(String) });
		expect(await bash(harness, "cat ~/.bash_history")).toContain("canary-home");
	});

	it("lets npm and Cargo fill their caches on a new home folder", async () => {
		rmSync(join(home, ".npm"), { recursive: true });
		for (const [tool, cache] of [
			["npm", ".npm/_cacache"],
			["cargo", ".cargo/registry/index"],
		]) {
			file(`.local/bin/${tool}`, `#!/bin/sh\nmkdir "$HOME/${cache}" && echo ${tool}-ok\n`);
			chmodSync(join(home, `.local/bin/${tool}`), 0o755);
		}
		const { harness } = await start();
		expect(await bash(harness, "npm && cargo")).toMatch(/npm-ok\s+cargo-ok/);
		// Made by Prism before the command; what the command writes in them stays in its own layer.
		expect(existsSync(join(home, ".npm"))).toBe(true);
		expect(existsSync(join(home, ".cargo/registry"))).toBe(true);
		expect(existsSync(join(home, ".npm/_cacache"))).toBe(false);
		expect(existsSync(join(home, ".cargo/registry/index"))).toBe(false);
	});

	it("shows ~/.config, which Podman's client needs, without what is in it", async () => {
		file(".config/app/token", "config-canary");
		const { harness } = await start();
		const out = await bash(harness, "test -d ~/.config && echo config-dir; ls -A ~/.config; cat ~/.config/app/token");
		expect(out).toContain("config-dir");
		expect(out).not.toContain("config-canary");
		expect(out).not.toMatch(/^app$/m);
	});

	it("reaches the network with a TMPDIR in the home folder, which commands do not see", async () => {
		mkdirSync(join(home, "tmp"));
		vi.stubEnv("TMPDIR", join(home, "tmp"));
		const { harness } = await start();
		expect(await bash(harness, "echo ran; printenv HTTPS_PROXY")).toMatch(/^ran\nhttp:\/\/127\.0\.0\.1:\d+$/m);
	});

	it("shows Git the configuration GIT_CONFIG_GLOBAL names, read only, and nothing else of its folder", async () => {
		const config = "[user]\n\tname = Dotfiles\n\temail = dotfiles@example.invalid\n";
		file("dotfiles/gitconfig", config);
		file("dotfiles/private.txt");
		vi.stubEnv("GIT_CONFIG_GLOBAL", join(home, "dotfiles/gitconfig"));
		const { harness } = await start();
		const out = await bash(
			harness,
			"git config user.name; cat ~/dotfiles/private.txt; echo x >> ~/dotfiles/gitconfig && echo wrote; true",
		);
		expect(out).toMatch(/^Dotfiles$/m);
		expect(out).not.toContain("canary-home");
		expect(out).not.toMatch(/^wrote$/m);
		expect(readFileSync(join(home, "dotfiles/gitconfig"), "utf8")).toBe(config);
	});

	it("says once that reading is limited, and where to widen it", async () => {
		writeFileSync(join(agentDir, "settings.json"), "{}");
		const first = await start();
		expect(first.notices).toContain(READ_LIMIT_NOTICE);
		expect(READ_LIMIT_NOTICE).toContain("MCP and LSP servers and your browser are not limited");
		// The user's rules are left as they were.
		expect(JSON.parse(readFileSync(join(agentDir, "permissions.json"), "utf8"))).toEqual({ mode: "broad" });
		expect((await start()).notices).not.toContain(READ_LIMIT_NOTICE);
		rmSync(join(agentDir, "sandbox", "read-limit-noticed"));
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sandbox: { read: { limit: "all" } } }));
		expect((await start()).notices).not.toContain(READ_LIMIT_NOTICE);
	});

	it("keeps reading limited while the sandbox does not work, and says it does not", async () => {
		writeFileSync(join(agentDir, "settings.json"), "{}");
		const fake = join(home, "fake-bwrap");
		mkdirSync(fake);
		writeFileSync(join(fake, "bwrap"), "#!/bin/sh\nexit 1\n");
		chmodSync(join(fake, "bwrap"), 0o755);
		vi.stubEnv("PATH", `${fake}:${process.env.PATH}`);
		const { harness, notices, questions } = await start();
		expect(sessionSandbox(harness.sessionManager)).toMatchObject({ error: expect.any(String) });
		expect(notices.join("\n")).toMatch(/sandbox/i);
		expect(notices).not.toContain(READ_LIMIT_NOTICE);
		const command = await bash(harness, "cat ~/Documents/secret.txt");
		expect(command).not.toContain("canary-home");
		expect(command).toContain("The sandbox does not work");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "~/Documents/secret.txt" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		const read = getToolResult(harness, "read")
			.content.map((part) => (part.type === "text" ? part.text : ""))
			.join("");
		// The file tools still ask, as with a working sandbox; start() answers "Allow…".
		expect(questions.join("\n")).toContain("read outside the project");
		expect(read).toContain("canary-home");
	});

	it("declares the sandbox broken when the home folder shows through", async () => {
		// Test 8: a bubblewrap that shows the real home folder, read-only, instead of the empty one.
		const fake = join(home, "fake-bwrap");
		mkdirSync(fake);
		writeFileSync(
			join(fake, "bwrap"),
			`#!/bin/sh\nfor a; do shift; if [ "$a" = --tmpfs ] && [ "$1" = "$HOME" ]; then a=--bind; set -- "$@" "$a" "$HOME"; continue; fi; set -- "$@" "$a"; done\nexec ${bwrap} "$@"\n`,
		);
		chmodSync(join(fake, "bwrap"), 0o755);
		vi.stubEnv("PATH", `${fake}:${process.env.PATH}`);
		const { harness } = await start();
		expect(await bash(harness, "echo ran")).not.toMatch(/^ran$/m);
		expect(sessionSandbox(harness.sessionManager)).toMatchObject({
			error: expect.stringContaining("showed the home folder beyond"),
		});
	});
});

// § 9.11, tests 2, 3 and 9: the file tools, which do not run in the sandbox, judge the same readable set.
describe("fork: the file tools, with reading limited to the project", () => {
	let agentDir: string;
	let home: string;
	const savedAgentDir = process.env[ENV_AGENT_DIR];
	const harnesses: Harness[] = [];
	const file = (path: string, content = "canary-home") => {
		mkdirSync(dirname(join(home, path)), { recursive: true });
		writeFileSync(join(home, path), content);
	};
	const limit = (on: boolean) =>
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ sandbox: { read: { limit: on ? "project" : "all" } } }),
		);

	beforeEach(() => {
		home = realpathSync(mkdtempSync(join("/var/tmp", "prism-read-tools-home-")));
		// In the home folder, as usual: only its skills, prompts, themes and extensions are Prism's own files.
		agentDir = join(home, ".pi/agent");
		mkdirSync(agentDir, { recursive: true });
		process.env[ENV_AGENT_DIR] = agentDir;
		vi.stubEnv("HOME", home);
		// The broad mode allows every other call: only reading outside the project asks.
		writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode: "broad" }));
		limit(true);
		for (const path of ["Documents/secret.txt", "Documents/other.txt", "Documents/third.txt", ".bash_history"])
			file(path);
		file(".rustup/settings.toml", "default = 'stable'\n");
	});

	afterEach(() => {
		for (const harness of harnesses.splice(0)) {
			removeSessionTmpDir(harness.sessionManager.getSessionId());
			harness.cleanup();
		}
		vi.unstubAllEnvs();
		if (savedAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = savedAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	});

	async function start(
		answer?: (title: string, options: string[]) => string | undefined,
		ui = true,
		custom?: ExtensionUIContext["custom"],
		mcp = false,
	) {
		const harness = await createHarness({
			extensionFactories: [
				{ name: "permissions", factory: permissionsExtension },
				...(mcp ? [{ name: "mcp-fs", factory: mcpServer }] : []),
			],
			initialActiveToolNames: ["read", "bash", "grep", "find", "ls", ...(mcp ? ["mcp__fs__read_file"] : [])],
		});
		harnesses.push(harness);
		const questions: { title: string; options: string[] }[] = [];
		await harness.session.bindExtensions(
			ui
				? {
						uiContext: createTestUiContext({
							custom,
							select: async (title, options) => {
								questions.push({ title, options });
								return answer?.(title, options);
							},
						}),
					}
				: {},
		);
		return { harness, questions };
	}
	async function call(harness: Harness, tool: string, input: Parameters<typeof fauxToolCall>[1]) {
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall(tool, input), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		return getToolResult(harness, tool)
			.content.map((part) => (part.type === "text" ? part.text : ""))
			.join("");
	}

	// An MCP server's file tool, as the MCP extension declares it: read-only, closed world.
	const mcpServer = (pi: ExtensionAPI) =>
		pi.registerTool({
			name: "mcp__fs__read_file",
			label: "read_file",
			description: "Reads a file.",
			parameters: Type.Object({ path: Type.String() }),
			namespace: { name: "mcp__fs" },
			annotations: { readOnlyHint: true, openWorldHint: false },
			execute: async (_id, params) => ({
				content: [{ type: "text", text: readFileSync(params.path.replace(/^~/, home), "utf8") }],
				details: {},
			}),
		});

	// Lot 8 (§ 9.6 point 2): an aid, not a boundary (Q-L9).
	it("asks for an MCP call's path outside the readable set, as for a file tool", () => {
		const project = join(home, "projects/p");
		mkdirSync(project, { recursive: true });
		const mcp = (readOnlyHint = true) => ({
			declaration: {
				namespace: { name: "mcp__fs", description: "" },
				annotations: { readOnlyHint, openWorldHint: false },
			},
		});
		const decide = (
			input: Record<string, unknown>,
			session: Parameters<typeof decidePermission>[3] = { mode: "broad" },
			options = mcp(),
		) => decidePermission("mcp__fs__read_file", input, project, session, options);
		for (const input of [
			{ path: "~/Documents/secret.txt" },
			{ uri: `file://${home}/Documents/secret.txt` },
			{ args: { files: ["notes.txt", `${home}/.bash_history`] } },
		]) {
			expect(decide(input), JSON.stringify(input)).toMatchObject({
				effect: "prompt",
				tier: "ask",
				reason: expect.stringContaining("read outside the project"),
			});
		}
		for (const input of [
			{ path: "notes.txt" },
			{ path: `${project}/a.txt` },
			{ path: "~/.rustup/settings.toml" },
			{ query: `grep ${home}/Documents` },
			{ path: "/etc/hosts" },
		]) {
			expect(decide(input).effect, JSON.stringify(input)).toBe("allow");
		}
		expect(
			decide({ path: "~/Documents/secret.txt" }, { mode: "broad", allow: [`readable(${home}/Documents)`] }).effect,
		).toBe("allow");
		// A rule that allows the tool does not skip it; safe mode refuses a tool that runs a program.
		expect(decide({ path: "~/Documents/secret.txt" }, { mode: "ask", allow: ["mcp__fs__read_file"] }).effect).toBe(
			"prompt",
		);
		expect(decide({ path: "~/Documents/secret.txt" }, { mode: "safe" }, mcp(false)).effect).toBe("block");
		// Credentials keep their dangerous question.
		file(".ssh/id_ed25519");
		expect(decide({ path: "~/.ssh/id_ed25519" }).tier).toBe("danger");
		// The MCP resource tool: a file:// resource is a path the server reads.
		expect(
			decidePermission("read_mcp_resource", { server: "fs", uri: `file://${home}/.bash_history` }, project, {
				mode: "broad",
			}).effect,
		).toBe("prompt");
		// Not an MCP tool, or reading not limited: not checked.
		expect(
			decidePermission(
				"other",
				{ path: "~/Documents/secret.txt" },
				project,
				{ mode: "broad" },
				{
					declaration: { permissions: ["fs.read"] },
				},
			).effect,
		).toBe("allow");
		limit(false);
		expect(decide({ path: "~/Documents/secret.txt" }).effect).toBe("allow");
	});

	it("refuses an MCP call's path without a UI, and its answer opens the file tools too", async () => {
		const refused = (await start(undefined, false, undefined, true)).harness;
		const text = await call(refused, "mcp__fs__read_file", { path: "~/Documents/secret.txt" });
		expect(text).not.toContain("canary-home");
		expect(text).toContain("is outside what the agent may read");
		const { harness, questions } = await start(
			(_title, options) => options.find((option) => option === 'Allow "read ~/Documents" in this session'),
			true,
			undefined,
			true,
		);
		expect(await call(harness, "mcp__fs__read_file", { path: "~/Documents/secret.txt" })).toContain("canary-home");
		expect(questions).toHaveLength(1);
		expect(questions[0]!.title).toContain(`${home}/Documents/secret.txt`);
		expect(await call(harness, "mcp__fs__read_file", { path: "~/Documents/other.txt" })).toContain("canary-home");
		expect(await call(harness, "read", { path: "~/Documents/third.txt" })).toContain("canary-home");
		expect(questions).toHaveLength(1);
	});

	it("refuses, without a UI, what is outside the readable set, and tells the model why", async () => {
		const { harness } = await start(undefined, false);
		// Test 3: a link of the project to a private file is judged on its target.
		symlinkSync(join(home, "Documents/secret.txt"), join(harness.tempDir, "link.txt"));
		for (const [tool, input] of [
			["read", { path: "~/Documents/secret.txt" }],
			["read", { path: "link.txt" }],
			["read", { path: `${home}/.bash_history` }],
			["ls", { path: "~" }],
			["find", { pattern: "*.txt", path: "~" }],
			["grep", { pattern: "canary", path: "~/Documents" }],
		] as const) {
			const text = await call(harness, tool, input);
			expect(text, `${tool} ${JSON.stringify(input)}`).not.toContain("canary-home");
			expect(text, `${tool} ${JSON.stringify(input)}`).toContain("is outside what the agent may read");
		}
		expect(await call(harness, "read", { path: "~/.rustup/settings.toml" })).toContain("default = 'stable'");
		expect(await call(harness, "read", { path: "link.txt" })).toContain("~/Documents/secret.txt");
		// A path the user hides stays hidden inside a readable folder.
		file(".rustup/private.txt");
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ sandbox: { read: { limit: "project" }, hide: ["~/.rustup/private.txt"] } }),
		);
		expect(await call(harness, "read", { path: "~/.rustup/private.txt" })).not.toContain("canary-home");
	});

	it("asks with a UI: once opens only that file, the folder opens the rest of it", async () => {
		const answers = ["Allow once", 'Allow "read ~/Documents" in this session'];
		const { harness, questions } = await start(
			(_title, options) => options.find((option) => option === answers[0]) && answers.shift(),
		);
		expect(await call(harness, "read", { path: "~/Documents/secret.txt" })).toContain("canary-home");
		expect(questions).toHaveLength(1);
		expect(questions[0]!.title).toContain(`${home}/Documents/secret.txt`);
		expect(questions[0]!.options).toEqual([
			"Allow once",
			'Allow "read ~/Documents/secret.txt" in this session',
			'Allow "read ~/Documents/secret.txt" in this project',
			'Allow "read ~/Documents" in this session',
			'Allow "read ~/Documents" in this project',
			"Block this action once",
		]);
		expect(await call(harness, "read", { path: "~/Documents/other.txt" })).toContain("canary-home");
		expect(questions).toHaveLength(2);
		expect(await call(harness, "read", { path: "~/Documents/third.txt" })).toContain("canary-home");
		expect(await call(harness, "grep", { pattern: "canary", path: "~/Documents" })).toContain("canary-home");
		expect(questions).toHaveLength(2);
		// The folder only: the rest of the home folder still asks.
		await call(harness, "read", { path: "~/.bash_history" });
		expect(questions).toHaveLength(3);
		// Q-L12: a file right in the home folder opens alone, never with all of it.
		expect(questions[2]!.options.filter((option) => option.startsWith('Allow "'))).toEqual([
			'Allow "read ~/.bash_history" in this session',
			'Allow "read ~/.bash_history" in this project',
		]);
		// Credentials keep their own, dangerous question.
		file(".ssh/id_ed25519");
		await call(harness, "read", { path: "~/.ssh/id_ed25519" });
		expect(questions[3]!.title).toMatch(/^Potentially dangerous action: read/);
		// Prism's own files: its skills, its documentation.
		file(".pi/agent/skills/demo/SKILL.md", "skill-text");
		file(".pi/agent/other.txt");
		await call(harness, "read", { path: join(agentDir, "other.txt") });
		expect(questions).toHaveLength(5);
		expect(await call(harness, "read", { path: join(agentDir, "skills/demo/SKILL.md") })).toContain("skill-text");
		expect(await call(harness, "read", { path: getReadmePath() })).not.toContain("outside what the agent may read");
		expect(questions).toHaveLength(5);
	});

	it("opens nothing with a rule for the home folder or above it, written by hand (Q-L12)", async () => {
		const { harness, questions } = await start((_title, options) => options.find((o) => o.startsWith("Block")));
		await addProjectRule(harness.tempDir, `readable(${home})`);
		await addProjectRule(harness.tempDir, "readable(/)");
		expect(await call(harness, "read", { path: "~/Documents/secret.txt" })).not.toContain("canary-home");
		expect(questions).toHaveLength(1);
	});

	it("keeps an answer for the project in Prism's folder", async () => {
		const { harness } = await start((_title, options) =>
			options.find((option) => option.endsWith('/secret.txt" in this project')),
		);
		expect(await call(harness, "read", { path: "~/Documents/secret.txt" })).toContain("canary-home");
		expect(readProjectGrants(harness.tempDir).allow).toEqual([`readable(${home}/Documents/secret.txt)`]);
	});

	it("refuses at once in an away task scope, then says it was already refused (test 9)", async () => {
		// The scope screen: user away, approved (keys as in fork-sandbox.test.ts).
		const away = (async (factory: (...args: unknown[]) => ScopeView) => {
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
		const { harness, questions } = await start(undefined, true, away);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("propose_scope", {
					operations: [{ what: "Run the tests", commands: ["node --test"] }],
					minutes: 5,
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("read", { path: "~/Documents/secret.txt" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("read", { path: "~/Documents/other.txt" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		const reads = harness.session.messages
			.filter(
				(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "read",
			)
			.map((message) => getMessageText(message));
		expect(getMessageText(getToolResult(harness, "propose_scope"))).toContain("The user is away");
		expect(reads).toHaveLength(2);
		expect(reads[0]).toContain("the user is away");
		expect(reads[1]).toContain("already refused in this task");
		expect(reads.join("")).not.toContain("canary-home");
		expect(questions).toEqual([]);
	});

	it("reads this session's full outputs and /tmp, not another session's (test 6)", async () => {
		const { harness } = await start(undefined, false);
		const tmp = realpathSync(tmpdir());
		const made: string[] = [];
		const put = (path: string, content: string) => {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, content);
			made.push(path);
			return path;
		};
		try {
			// This session's full output, which the result cites.
			const output = await call(harness, "bash", { command: "seq 1 3000" });
			const cited = /Full output: (\S+?)\]/.exec(output)?.[1];
			expect(cited, output).toMatch(/\/pi-bash-[0-9a-f]{16}\.log$/);
			made.push(cited!);
			expect(await call(harness, "read", { path: cited!, offset: 1, limit: 2 })).toContain("1\n2");
			// The full output of the user's own ! command.
			const user = (await harness.session.executeBash("seq 1 100000")).fullOutputPath;
			expect(user).toMatch(/\/pi-bash-[0-9a-f]{16}\.log$/);
			made.push(user!);
			expect(await call(harness, "read", { path: user!, offset: 99999, limit: 1 })).toContain("99999");
			// This session's /tmp, the one its commands see.
			const own = put(join(sessionTmpDir(harness.sessionManager.getSessionId()), "mine.txt"), "own-tmp");
			expect(await call(harness, "read", { path: own })).toContain("own-tmp");
			// Another session's full outputs and /tmp; naming them in a command's output does not make them own.
			const other = put(join(tmp, "pi-bash-0123456789abcdef.log"), "canary-other-session");
			const otherMcp = put(join(tmp, "pi-mcp-0123456789abcdef.png"), "canary-other-session");
			const otherTmp = put(join(tmp, "prism-tmp-1-zzzzzz", "notes.txt"), "canary-other-session");
			made.push(dirname(otherTmp));
			await call(harness, "bash", { command: `echo ${other} ${otherMcp} ${otherTmp}` });
			// nor does an edit's diff that the model filled with them.
			harness.sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: "edit-1",
				toolName: "edit",
				content: [{ type: "text", text: "Successfully replaced 1 block(s) in notes.md." }],
				details: { diff: `+names: ${other} ${otherMcp} ${otherTmp}`, patch: "" },
				isError: false,
				timestamp: Date.now(),
			});
			for (const path of [other, otherMcp, otherTmp, dirname(otherTmp)]) {
				const text = await call(harness, "read", { path });
				expect(text, path).not.toContain("canary-other-session");
				expect(text, path).toContain("is outside what the agent may read");
			}
			expect(await call(harness, "grep", { pattern: "canary", path: dirname(otherTmp) })).not.toContain(
				"canary-other-session",
			);
			// A file the user leaves in the temporary folder stays readable.
			const dropped = put(join(tmp, `prism-read-limit-drop-${process.pid}.txt`), "dropped-by-user");
			expect(await call(harness, "read", { path: dropped })).toContain("dropped-by-user");
		} finally {
			for (const path of made) rmSync(path, { recursive: true, force: true });
		}
	});

	it("changes nothing while reading is not limited", async () => {
		limit(false);
		const { harness, questions } = await start();
		expect(await call(harness, "read", { path: "~/Documents/secret.txt" })).toContain("canary-home");
		expect(questions).toEqual([]);
		expect(decidePermission("read", { path: `${home}/Documents/x` }, harness.tempDir, { mode: "ask" }).effect).toBe(
			"allow",
		);
		limit(true);
		expect(decidePermission("read", { path: `${home}/Documents/x` }, harness.tempDir, { mode: "safe" }).effect).toBe(
			"prompt",
		);
		expect(
			decidePermission("read", { path: `${home}/Documents/x` }, harness.tempDir, { mode: "unrestricted" }).effect,
		).toBe("allow");
		expect(modePolicy("broad", "read-outside")).toBe("ask");
	});
});

describe("fork: Prism opened in the home folder with reading limited", () => {
	let agentDir: string;
	let home: string;
	const startDir = process.cwd();
	const made: string[] = [];
	const savedAgentDir = process.env[ENV_AGENT_DIR];

	beforeEach(() => {
		home = realpathSync(mkdtempSync(join("/var/tmp", "prism-home-start-")));
		agentDir = join(home, ".pi/agent");
		mkdirSync(join(home, "projects/p"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sandbox: { read: { limit: "project" } } }));
		process.env[ENV_AGENT_DIR] = agentDir;
		vi.stubEnv("HOME", home);
	});
	afterEach(() => {
		process.chdir(startDir);
		readEverythingThisRun(false);
		vi.unstubAllEnvs();
		if (savedAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = savedAgentDir;
		for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	});

	it("asks only for a new session in the home folder or above it, with reading limited", () => {
		expect(homedir()).toBe(home);
		expect(opensWholeHome(home)).toBe(true);
		expect(opensWholeHome(dirname(home))).toBe(true);
		expect(opensWholeHome("/")).toBe(true);
		expect(opensWholeHome(join(home, "projects/p"))).toBe(false);
		expect(opensWholeHome(tmpdir())).toBe(false);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sandbox: { read: { limit: "all" } } }));
		expect(opensWholeHome(home)).toBe(false);

		const args = (extra: Record<string, unknown>) => ({ messages: [], fileArgs: [], ...extra }) as never;
		expect(startsFresh(args({}))).toBe(true);
		expect(startsFresh(args({ extensions: ["/abs/ext.ts", "~/ext.ts", "npm:pkg"] }))).toBe(true);
		for (const extra of [
			{ continue: true },
			{ resume: true },
			{ session: "abc" },
			{ fork: "abc" },
			{ fileArgs: ["notes.md"] },
			{ extensions: ["./ext.ts"] },
			{ skills: ["skills/x"] },
		]) {
			expect(startsFresh(args(extra)), JSON.stringify(extra)).toBe(false);
		}
	});

	it("works in a new folder of /tmp by default, kept, where the sandbox runs commands", async () => {
		const offered: { label: string; value: string }[] = [];
		const folder = await chooseHomeStart(home, async (title, options) => {
			expect(title).toContain("the project would be the whole home folder");
			offered.push(...options);
			return options[0]!.value;
		});
		made.push(folder);
		expect(offered.map((option) => option.value)).toEqual(["tmp", "home", "none"]);
		expect(offered[0]!.label).toBe("Work in a new folder in /tmp (kept after the session)");
		expect(folder.startsWith(join(tmpdir(), "prism-work-"))).toBe(true);
		expect(existsSync(folder)).toBe(true);
		expect(realpathSync(process.cwd())).toBe(realpathSync(folder));
		expect(opensWholeHome(folder)).toBe(false);
		const layout = buildLayout({ cwd: folder, home, agentDir, settings: readSandboxSettings(agentDir), env: {} });
		expect(layout.blocked).toBeUndefined();
		expect(layout.writable).toContain(realpathSync(folder));
		expect(readSandboxSettings(agentDir).read.limit).toBe("project");
	});

	it("stays in the home folder: reading everything until Prism exits, or nothing", async () => {
		const layout = () => buildLayout({ cwd: home, home, agentDir, settings: readSandboxSettings(agentDir), env: {} });
		for (const answer of ["none", undefined] as const) {
			expect(await chooseHomeStart(home, async () => answer)).toBe(home);
			expect(process.cwd()).toBe(startDir);
			expect(layout().blocked).toContain("opened in the home folder");
		}
		expect(await chooseHomeStart(home, async () => "home")).toBe(home);
		expect(process.cwd()).toBe(startDir);
		expect(readSandboxSettings(agentDir).read.limit).toBe("all");
		expect(layout().blocked).toBeUndefined();
		expect(layout().home).toBeUndefined();
		// Only for this run: the settings file still says project.
		expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).sandbox.read.limit).toBe("project");
	});
});
