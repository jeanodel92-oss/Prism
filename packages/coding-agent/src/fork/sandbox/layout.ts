/**
 * fork: what the sandbox lets a command see and write, and the bubblewrap arguments that
 * enforce it. Pure: the paths that exist are passed in, so tests can build any
 * layout without touching the machine.
 */

import { type ExecFileSyncOptionsWithStringEncoding, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	type Dirent,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "../../config.ts";
import { extensionCopies } from "../browser/setup.ts";
import { phoneLinkDirs } from "../config-policy.ts";
import { cacheFile } from "../file-cache.ts";
import { saveGlobalSetting } from "../global-settings.ts";
import { requireHostProgram } from "../host-program.ts";
import type { Mode } from "../permissions.ts";
import { unseenCodeReason } from "../shell-unseen-code.ts";
import type { CacheLayer } from "./cache-layers.ts";
import { huskyScripts } from "./git-hooks.ts";
import { findRepositories, identities, type RepositorySearch, repositoryStatePath } from "./nested-git.ts";
import { within } from "./path-within.ts";
import { DEFAULT_NETWORK_SETTINGS, type NetworkSettings } from "./proxy.ts";
import { isReadable, readableSet } from "./read-limit.ts";
import { REBUILT_SETTINGS, relocated } from "./tool-settings.ts";

/** The `sandbox` object of the global settings.json; a project cannot change it. */
export interface SandboxSettings {
	/**
	 * Modes in which shell commands run in the sandbox. Default: all but unrestricted;
	 * fork.9 QA: unrestricted can have it too, when turned on.
	 */
	modes: Record<Mode, boolean>;
	/** Extra writable paths (`~` expands to the home folder). */
	allowWrite: string[];
	/** Extra hidden paths. */
	hide: string[];
	/** Hosts the commands may reach through Prism's proxy. */
	network: NetworkSettings;
	/** Run the user's `!` commands in the sandbox too (off by default). */
	userCommands: boolean;
	/** Commands run outside the sandbox, as `docker` or `docker compose`. */
	excludedCommands: string[];
	/** fork: Git in the sandbox signs commits and tags with the user's key, through Prism. Off by default. */
	gitSigning: boolean;
	/** fork: commands list the user's containers and images, read only, through Prism. Off by default. */
	containers: boolean;
	/** fork: commands read the state of the system's services over D-Bus, through Prism. Off by default. */
	serviceState: boolean;
	/** fork (SEC-04): the `sudo` tool, root outside the sandbox (sudo.ts). Off by default. */
	sudo: boolean;
	/** Remember the sudo password in Prism's memory for five minutes. Off by default. */
	sudoRememberPassword: boolean;
	/** fork: what commands may read (sandbox.md § 9.10). */
	read: ReadSettings;
}

/** fork: the `read` object of the sandbox settings. */
export interface ReadSettings {
	/**
	 * `project`: the home folder shows only the project, the tools' resources and `allow` (read-limit.ts); `all`:
	 * everything but the hidden paths. `project` by default once compatibility was measured
	 * ; any other value than `all` keeps it, so a typo never opens the home folder.
	 */
	limit: "all" | "project";
	/** Folders readable too; `~` expands. */
	allow: string[];
	/** Tools of the resource table turned off, by name (`read.tools`: { "<name>": false }). */
	toolsOff: string[];
}

export const DEFAULT_SANDBOX_SETTINGS: SandboxSettings = {
	modes: { broad: true, ask: true, safe: true, unrestricted: false },
	allowWrite: [],
	hide: [],
	network: DEFAULT_NETWORK_SETTINGS,
	userCommands: false,
	excludedCommands: [],
	gitSigning: false,
	containers: false,
	serviceState: false,
	sudo: false,
	sudoRememberPassword: false,
	read: { limit: "project", allow: [], toolsOff: [] },
};

/** Credentials and agent configs hidden by default, relative to the home folder. */
export const DEFAULT_HIDDEN_HOME_PATHS: readonly string[] = [
	".ssh",
	".gnupg",
	".aws",
	".config/gh",
	".docker",
	".kube",
	".netrc",
	".git-credentials",
	".pi",
	".mozilla",
	".config/google-chrome",
	".config/chromium",
	".config/BraveSoftware",
	".config/net.imput.helium",
	".local/share/keyrings",
	// fork: the other common places of credentials, which `read.limit: "all"` let
	// commands read: tokens of Git, package registries, cloud and AI command-line tools, secret stores, browsers, mail.
	".config/git/credentials",
	".pypirc",
	".cargo/credentials.toml",
	".cargo/credentials",
	".config/gcloud",
	".azure",
	".claude/.credentials.json",
	".codex/auth.json",
	".config/github-copilot",
	".config/Code/User/globalStorage",
	".config/rclone",
	".config/sops/age",
	".password-store",
	".pgpass",
	".vault-token",
	".local/share/kwalletd",
	".config/microsoft-edge",
	".config/vivaldi",
	".librewolf",
	".zen",
	".var/app/app.zen_browser.zen",
	".thunderbird",
	".env",
];

/**
 * fork: hidden too when commands read everything (`read.limit: "all"`). Reading
 * limited to the project leaves them out already, shows `~/.npmrc` rebuilt without its tokens, and lets the user open
 * them (`read.allow`), which the list above would forbid.
 */
export const READ_ALL_HIDDEN_HOME_PATHS: readonly string[] = [".npmrc", ".bash_history", ".zsh_history"];

/**
 * fork: system folders that hold the user's secrets outside the home folder, hidden
 * like it: the journal (commands given to sudo, services' errors), the dumps of crashed programs (a browser's or a
 * password manager's memory) and local mail. A folder of `read.allow` that covers one shows it again: reading the
 * journal is a real debugging need.
 */
export const SYSTEM_SECRET_PATHS: readonly string[] = [
	"/var/log/journal",
	"/run/log/journal",
	"/var/lib/systemd/coredump",
	"/var/mail",
	"/var/spool/mail",
];

/** Package manager caches left writable, or npm install and most builds fail. */
export const DEFAULT_WRITABLE_HOME_PATHS: readonly string[] = [".npm", ".cache", ".cargo/registry", "go/pkg"];

const isStringList = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((item) => typeof item === "string");

/** Reads the settings; any field of the wrong type keeps its default. */
export function parseSandboxSettings(value: unknown): SandboxSettings {
	const raw =
		typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	const modes = typeof raw.modes === "object" && raw.modes !== null ? (raw.modes as Record<string, unknown>) : {};
	const network =
		typeof raw.network === "object" && raw.network !== null ? (raw.network as Record<string, unknown>) : {};
	const read = typeof raw.read === "object" && raw.read !== null ? (raw.read as Record<string, unknown>) : {};
	const tools = typeof read.tools === "object" && read.tools !== null ? (read.tools as Record<string, unknown>) : {};
	const flag = (key: Mode) =>
		typeof modes[key] === "boolean" ? (modes[key] as boolean) : DEFAULT_SANDBOX_SETTINGS.modes[key];
	return {
		modes: { broad: flag("broad"), ask: flag("ask"), safe: flag("safe"), unrestricted: flag("unrestricted") },
		allowWrite: isStringList(raw.allowWrite) ? raw.allowWrite : [],
		hide: isStringList(raw.hide) ? raw.hide : [],
		network: {
			askNewHosts: network.askNewHosts !== false,
			allow: isStringList(network.allow) ? network.allow : [],
			deny: isStringList(network.deny) ? network.deny : [],
		},
		userCommands: raw.userCommands === true,
		excludedCommands: isStringList(raw.excludedCommands)
			? raw.excludedCommands.map((command) => command.trim()).filter(Boolean)
			: [],
		gitSigning: raw.gitSigning === true,
		containers: raw.containers === true,
		serviceState: raw.serviceState === true,
		sudo: raw.sudo === true,
		sudoRememberPassword: raw.sudoRememberPassword === true,
		read: {
			limit: read.limit === "all" ? "all" : "project",
			allow: isStringList(read.allow) ? read.allow : [],
			toolsOff: Object.keys(tools).filter((tool) => tools[tool] === false),
		},
	};
}

/** Q-L10: the user chose, at startup, to let the agent read the whole home folder until Prism exits. */
let readEverything = false;
export function readEverythingThisRun(on = true): void {
	readEverything = on;
}

/** The last sandbox settings read from each agent folder's settings.json. */
const lastReadSettings = new Map<string, SandboxSettings>();

/**
 * settings.json is there but its sandbox rules cannot be known. Nothing that depends
 * on them may run until the file is fixed; the message says where and how, never what the file holds.
 */
export class SandboxSettingsError extends Error {}

/** How {@link SandboxSettingsError}'s message starts, to recognise a sandbox blocked by it. */
export const SANDBOX_SETTINGS_ERROR_START = "Prism cannot use the sandbox settings in ";

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** The first field of the `sandbox` object whose type is wrong, as a path; undefined when all are right. */
function wrongSandboxField(sandbox: unknown): string | undefined {
	if (sandbox === undefined) return undefined;
	if (!isObject(sandbox)) return "sandbox";
	const checks: Array<[string, unknown, (value: unknown) => boolean]> = [
		["modes", sandbox.modes, isObject],
		...(["broad", "ask", "safe", "unrestricted"] as const).map(
			(mode): [string, unknown, (value: unknown) => boolean] => [
				`modes.${mode}`,
				isObject(sandbox.modes) ? sandbox.modes[mode] : undefined,
				(value) => typeof value === "boolean",
			],
		),
		["allowWrite", sandbox.allowWrite, isStringList],
		["hide", sandbox.hide, isStringList],
		["network", sandbox.network, isObject],
		[
			"network.askNewHosts",
			isObject(sandbox.network) ? sandbox.network.askNewHosts : undefined,
			(value) => typeof value === "boolean",
		],
		["network.allow", isObject(sandbox.network) ? sandbox.network.allow : undefined, isStringList],
		["network.deny", isObject(sandbox.network) ? sandbox.network.deny : undefined, isStringList],
		["excludedCommands", sandbox.excludedCommands, isStringList],
		...(["userCommands", "gitSigning", "containers", "serviceState", "sudo", "sudoRememberPassword"] as const).map(
			(key): [string, unknown, (value: unknown) => boolean] => [
				key,
				sandbox[key],
				(value) => typeof value === "boolean",
			],
		),
		["read", sandbox.read, isObject],
		["read.allow", isObject(sandbox.read) ? sandbox.read.allow : undefined, isStringList],
		["read.tools", isObject(sandbox.read) ? sandbox.read.tools : undefined, isObject],
	];
	return checks.find(([, value, valid]) => value !== undefined && !valid(value))?.[0];
}

/** Where a JSON parse failed, as a line and column, without the text around it. */
function parseFailure(error: SyntaxError, text: string): string {
	const position = Number(/position (\d+)/.exec(error.message)?.[1]);
	if (!Number.isFinite(position)) return "The file is not valid JSON.";
	const before = text.slice(0, position).split("\n");
	return `The file is not valid JSON (line ${before.length}, column ${before.at(-1)!.length + 1}).`;
}

/**
 * The global settings' sandbox object, read from the file so a project's settings never apply. Only a missing
 * file means the defaults. A file that cannot be read or parsed, or whose sandbox fields have the wrong type, keeps
 * the last rules read in this process (a typo, or a read while another session rewrites it); with none, it throws
 * {@link SandboxSettingsError} rather than fall back on defaults that would drop hidden paths and blocked hosts.
 */
const readSettingsFile = cacheFile(
	(path: string): { settings?: SandboxSettings; problem?: string } => {
		let settings: SandboxSettings | undefined;
		let problem: string | undefined;
		let text: string | undefined;
		try {
			text = readFileSync(path, "utf8");
			const file: unknown = JSON.parse(text);
			if (!isObject(file)) problem = "The file is not a JSON object.";
			else {
				const wrong = wrongSandboxField(file.sandbox);
				if (wrong) problem = `The value of "${wrong}" has the wrong type.`;
				else {
					settings = parseSandboxSettings(file.sandbox);
				}
			}
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") {
				return {};
			} else if (error instanceof SyntaxError && text !== undefined) problem = parseFailure(error, text);
			else problem = `The file cannot be read (${code ?? "unknown error"}).`;
		}
		return { settings, problem };
	},
	(result) => result.problem === undefined,
);

export function readSandboxSettings(agentDir = getAgentDir()): SandboxSettings {
	const path = join(agentDir, "settings.json");
	const result = readSettingsFile(path);
	let settings = result.settings;
	if (result.problem) {
		const last = lastReadSettings.get(agentDir);
		if (!last) {
			throw new SandboxSettingsError(
				`${SANDBOX_SETTINGS_ERROR_START}${path}. ${result.problem} Until the file is fixed, every tool call and command is refused, so that hidden paths, blocked hosts and other limits cannot be lost. Fix the file, or remove it to start from the defaults: Prism uses it again as soon as it can be read.`,
			);
		}
		settings = last;
	} else if (settings) {
		// Preserve last-valid state per directory spelling, including reads served by the file cache.
		lastReadSettings.set(agentDir, settings);
	} else {
		lastReadSettings.delete(agentDir);
		settings = parseSandboxSettings(undefined);
	}
	return readEverything ? { ...settings!, read: { ...settings!.read, limit: "all" } } : settings!;
}

/** The message of {@link SandboxSettingsError} when the sandbox settings cannot be used; undefined when they can. */
export function sandboxSettingsProblem(agentDir?: string): string | undefined {
	try {
		readSandboxSettings(agentDir);
		return undefined;
	} catch (error) {
		if (error instanceof SandboxSettingsError) return error.message;
		throw error;
	}
}

const settingsListeners = new Set<() => void>();

/** Lets session resources drop privileges or secrets as soon as the user changes sandbox settings. */
export function subscribeSandboxSettings(listener: () => void): () => void {
	settingsListeners.add(listener);
	return () => settingsListeners.delete(listener);
}

/**
 * fork: sets one sandbox setting (`path` inside the `sandbox` object) in the global settings, under the
 * settings lock, from /settings > Permissions & sandbox. Throws when settings.json is not valid JSON.
 */
export function saveSandboxSetting(path: readonly string[], value: unknown, agentDir = getAgentDir()): void {
	saveGlobalSetting(["sandbox", ...path], value, agentDir);
	for (const listener of settingsListeners) listener();
}

/**
 * Whether a command runs outside the sandbox: a single command whose words start with an entry of
 * `excludedCommands`. A line with several commands, a substitution or a redirection never does, so
 * `docker ps; rm -rf ~` stays inside.
 */
export function isExcludedCommand(command: string, excluded: readonly string[]): boolean {
	// fork: it runs outside the sandbox, so nothing its words do not show.
	if (excluded.length === 0 || /[;&|<>]/.test(command) || unseenCodeReason(command)) return false;
	const words = command.trim().split(/\s+/).join(" ");
	return excluded.some((entry) => {
		const wanted = entry.split(/\s+/).join(" ");
		return words === wanted || words.startsWith(`${wanted} `);
	});
}

export function sandboxedMode(settings: SandboxSettings, mode: Mode): boolean {
	return settings.modes[mode];
}

export interface SandboxLayout {
	cwd: string;
	/**
	 * fork: the session's private folder, bound at /tmp before everything else, so commands
	 * never see the host's /tmp or other sessions' files. Undefined in a layout that is only shown.
	 */
	tmp?: string;
	/** Bound read-write, in this order. */
	writable: string[];
	/** Read-only again inside a writable path: Prism's project config, Git hooks and config. */
	readOnly: string[];
	/** Replaced by an empty, unreadable folder or file. */
	hidden: string[];
	/** Absent protected entries, reserved by mounts before the command starts. */
	missing?: { path: string; directory: boolean; content?: string }[];
	/** A layout that cannot preserve both protection and writable Git/project state. */
	blocked?: string;
	/** Configurations requiring narrower write access; reads and isolated commands remain available. */
	restrictions?: { path: string; reason: string }[];
	/** fork: [copy, original] pairs, each original file shown through its copy (`ssh-config.ts`). */
	copies?: Array<[string, string]>;
	/**
	 * fork: reading limited to the project. The home folder is replaced by an empty, read-only folder that
	 * shows only `read` (read-only) and the writable paths; `cache`, the project's own folder, stands for ~/.cache
	 *; `hiddenOutside` are empty too (Q-L4).
	 */
	home?: { path: string; read: string[]; cache: string; hiddenOutside: string[]; settings: string[] };
	/**
	 * fork: bubblewrap's arguments of the private copies of Git metadata (`git-copy.ts`), mounted after the
	 * writable folders; the protections inside the copied Git folders are then left out.
	 */
	gitCopies?: string[][];
	/** Repositories covered by a private Git copy, also when the layout is only shown. */
	privateGit?: { repository: string; gitDir: string }[];
	/**
	 * fork: the hooks folders `core.hooksPath` names in the working tree of a copied repository. Each is
	 * shown through `source`, a private layer never published (`hooksLayer`), so Git in the sandbox may rewrite its
	 * hooks (Husky does at each install) while Git outside it runs the real ones; read-only without a `source`.
	 */
	hookLayers?: { path: string; gitDir: string; source?: string }[];
	/**
	 * fork (SEC-08): Husky's scripts folders (`.husky`), which the hooks of a `_` folder run: read-only, mounted
	 * before the hooks folders' layers so that those stay private.
	 */
	hookScripts?: string[];
	/** fork: the repositories found below the project and `allowWrite`, checked after the command. */
	repositories?: RepositorySearch;
	/**
	 * fork (AS-010): the package caches among `writable`, shown to each command through `cacheLayers`
	 * (`cache-layers.ts`), never bound as they are: what a command writes there never reaches the real caches.
	 */
	caches?: string[];
	/** fork (AS-010): one command's view of `caches`; a cache without one is read-only. */
	cacheLayers?: CacheLayer[];
}

export interface LayoutInput {
	cwd: string;
	home?: string;
	agentDir?: string;
	uid?: number;
	/** The session's private /tmp (`sessionTmpDir`); undefined when the layout is only shown. */
	tmp?: string;
	/** Folders the sandbox runs its own programs from (node, the network relay), bound read-only when the private
	 * /tmp would hide them. */
	runFrom?: string[];
	settings: SandboxSettings;
	/** Defaults to the file system; tests pass their own. */
	exists?: (path: string) => boolean;
	/** The path with its links resolved; defaults to the file system. */
	realpath?: (path: string) => string;
	/** Whether the path is a file; defaults to the file system. */
	isFile?: (path: string) => boolean;
	/** Git's `core.hooksPath` for the project, as Git resolves it; defaults to asking Git. */
	hooksPath?: (cwd: string) => string | undefined;
	readFile?: (path: string) => string;
	isSymlink?: (path: string) => boolean;
	readlink?: (path: string) => string;
	/** fork: the commands' environment, for the PATH and tools' variables; defaults to Prism's. */
	env?: Record<string, string | undefined>;
	/** fork: folders Prism runs from, readable when reading is limited to the project. */
	prism?: string[];
	/**
	 * fork: makes a private copy of a repository's Git folder for the command (`git-copy.ts`); true when the
	 * copy covers it. `core.hooksPath` then needs no refusal or protection inside that folder, nothing written there
	 * being published but the closed list of `git-validate.ts`. Asked once per repository, never for submodules.
	 */
	copyGitDir?: (gitDir: string) => boolean;
	/**
	 * fork: safe mode's promise, "changes no file", kept by the sandbox rather
	 * than by the classifier alone: the project, `allowWrite` and the Git folders are mounted read-only. The private
	 * /tmp and the package managers' caches stay writable, or reading tools such as `npm ls` fail.
	 */
	readOnlyProject?: boolean;
}

const fileExists = (path: string) => {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
};

const expandHome = (path: string, home: string) =>
	path === "~" ? home : path.startsWith("~/") ? `${home}/${path.slice(2)}` : path;

const absolutePath = (base: string, path: string) => (isAbsolute(path) ? path : `${base}/${path}`);

const GIT_READ: ExecFileSyncOptionsWithStringEncoding = {
	encoding: "utf8",
	timeout: 2000,
	stdio: ["ignore", "pipe", "pipe"],
};

/** fork: the Git that reads configurations here, never one from where the sandbox writes. */
const hostGitProgram = () => requireHostProgram("git");

/** The entries of a Git configuration file whose keys match; none if it cannot be read. */
const configEntries = (file: string, keys: string, includes = false) => {
	try {
		const scope = includes ? ["--includes"] : [];
		return execFileSync(
			hostGitProgram(),
			["config", "--file", file, ...scope, "--null", "--get-regexp", keys],
			GIT_READ,
		)
			.split("\0")
			.filter(Boolean)
			.map((record) => {
				const newline = record.indexOf("\n");
				return { key: record.slice(0, newline), value: record.slice(newline + 1) };
			});
	} catch {
		return [];
	}
};

/**
 * fork: the Git directories under a repository's `modules` folder, submodule names
 * with slashes (`modules/a/b`) included; nested submodules are in each one's own `modules`. A Git directory is
 * recognised by its HEAD or config file (files: a submodule named `libs/config` is a folder), so that removing its
 * HEAD does not hide it; Git refuses a submodule inside another's Git directory. Links to folders are
 * followed, each real folder once. The folder is read-only in the sandbox, so a command cannot plant markers
 * that would hide a Git directory.
 */
function submoduleGitDirs(modules: string, depth = 0, seen = new Set<string>()): string[] {
	if (depth > 64) throw new Error(`Git submodule names nested too deeply under ${modules}`);
	let entries: Dirent[] = [];
	try {
		const real = realpathSync(modules);
		if (seen.has(real)) return [];
		seen.add(real);
		entries = readdirSync(modules, { withFileTypes: true });
	} catch {}
	const isFolder = (path: string) => {
		try {
			return statSync(path).isDirectory();
		} catch {
			return false;
		}
	};
	return entries
		.filter((entry) => entry.isDirectory() || (entry.isSymbolicLink() && isFolder(join(modules, entry.name))))
		.flatMap((entry) => {
			const path = join(modules, entry.name);
			return ["HEAD", "config"].some((name) => fileExists(join(path, name)))
				? [path]
				: submoduleGitDirs(path, depth + 1, seen);
		});
}

export function buildLayout(input: LayoutInput): SandboxLayout {
	const home = input.home ?? homedir();
	const exists = input.exists ?? existsSync;
	const realpath = input.realpath ?? realpathSync;
	// bubblewrap mounts on the real path: through an absolute link (Ubuntu's /var/run -> /run) it cannot create
	// the mount point and fails. Resolving also removes duplicates such as /var/run/dbus and /run/dbus.
	const present = (paths: string[]) =>
		paths
			.filter(exists)
			.map((path) => {
				try {
					return realpath(path);
				} catch {
					return path;
				}
			})
			.filter((path, index, all) => all.indexOf(path) === index);
	const cwd = resolve(input.cwd);
	const uid = input.uid ?? process.getuid?.() ?? 0;
	const read = input.readFile ?? ((path: string) => readFileSync(path, "utf8"));
	const isFile = input.isFile ?? fileExists;
	const isSymlink =
		input.isSymlink ??
		((path: string) => {
			if (input.exists) return false;
			try {
				return lstatSync(path).isSymbolicLink();
			} catch {
				return false;
			}
		});
	const readlink = input.readlink ?? readlinkSync;
	// fork: the tools' caches of the resource table replace the default writable paths, ~/.cache the
	// project's own cache.
	const limit =
		input.settings.read.limit === "project"
			? readableSet({
					cwd,
					home,
					env: input.env,
					prism: input.prism,
					allow: input.settings.read.allow,
					allowWrite: input.settings.allowWrite,
					hide: [...DEFAULT_HIDDEN_HOME_PATHS.map((path) => join(home, path)), ...input.settings.hide],
					toolsOff: input.settings.read.toolsOff,
					exists: input.exists,
					realpath: input.realpath,
				})
			: undefined;
	const caches = present(limit ? limit.write : DEFAULT_WRITABLE_HOME_PATHS.map((path) => join(home, path)));
	const allowWrite = input.settings.allowWrite.map((path) => resolve(cwd, expandHome(path, home)));
	const writable = present([cwd, ...caches, ...allowWrite]);
	// fork (AS-010): a cache the user made writable, or one that holds the project or is in it, is bound as it is.
	const allowed = present(allowWrite);
	const layered = caches.filter((path) => !allowed.includes(path) && !within(cwd, path) && !within(path, cwd));
	const readOnly = new Set<string>();
	const readOnlyDirectories = new Set<string>();
	const missing = new Map<string, { directory: boolean; content?: string }>();
	const gitState = new Set<string>();
	const reasons = new Map<string, string>();
	let blocked: string | undefined;
	const refuse = (reason: string) => {
		blocked ??= `Cannot protect sandbox metadata: ${reason}`;
	};
	// fork: a folder that is the home folder or holds it would open all of it, so the
	// commands are refused, whatever the read limit; reading everything is sandbox.read.limit: "all".
	const homes = present([home]).concat(home);
	for (const [name, paths] of [
		["sandbox.allowWrite", input.settings.allowWrite],
		["sandbox.read.allow", input.settings.read.allow],
	] as const) {
		const wide = paths.find((path) => {
			const absolute = resolve(cwd, expandHome(path, home));
			return [absolute, ...present([absolute])].some((target) => homes.some((folder) => within(folder, target)));
		});
		if (wide === undefined) continue;
		const all =
			name === "sandbox.read.allow" && input.settings.read.limit === "project"
				? ', or let commands read everything (sandbox.read.limit: "all")'
				: "";
		blocked ??= `${name} lists ${wide}, which is the home folder or holds it: the commands would get all of it. Name the folder they need instead, such as ${join(home, "Documents")}${all}.`;
	}
	// Resolve links one component at a time, retaining their directory entries, including dangling links.
	const canonical = (path: string): string => {
		const pending = absolutePath(cwd, path).split("/");
		let target = "/";
		let links = 0;
		for (let part = pending.shift(); part !== undefined; part = pending.shift()) {
			if (!part || part === ".") continue;
			if (part === "..") {
				target = dirname(target);
				continue;
			}
			const next = join(target, part);
			if (!isSymlink(next)) {
				target = next;
				continue;
			}
			if (++links > 40) throw new Error(`too many symbolic links in ${path}`);
			if (writable.some((root) => within(target, root))) {
				readOnly.add(target);
				readOnlyDirectories.add(target);
				reasons.set(target, `symbolic configuration path ${next} requires protecting its parent entry`);
			}
			const link = readlink(next);
			if (isAbsolute(link)) target = "/";
			pending.unshift(...link.split("/"));
		}
		return present([target])[0] ?? target;
	};
	const protect = (path: string, directory: boolean, content?: string) => {
		const target = canonical(path);
		// Git uses /dev/null to disable configuration or hooks; a read-only bind would break shell redirections.
		if (target === "/dev/null") return;
		if (exists(target)) {
			readOnly.add(target);
			if (directory) readOnlyDirectories.add(target);
			return;
		}
		// Reserve the first absent component. Nothing below it may be created or substituted by the command.
		let absent = target;
		while (dirname(absent) !== absent && !exists(dirname(absent))) absent = dirname(absent);
		if (writable.some((root) => within(absent, root))) {
			const isDirectory = absent !== target || directory;
			missing.set(absent, { directory: isDirectory, content });
			readOnly.add(absent);
			if (isDirectory) readOnlyDirectories.add(absent);
		}
	};
	// fork: whether each repository works in a private copy of its Git folder, by common Git folder.
	const copied = new Map<string, boolean>();
	const privateGit: NonNullable<SandboxLayout["privateGit"]> = [];
	const hookLayers = new Map<string, string>();
	const hookScripts = new Set<string>();
	const roots = new Set<string>();
	for (const root of [cwd, ...writable]) {
		for (let folder = root; ; folder = dirname(folder)) {
			roots.add(folder);
			if (dirname(folder) === folder) break;
		}
	}
	// fork: the repositories below the project and the folders the user made
	// writable get the project's treatment; after the command, those that did not have it are checked (`nested-git.ts`).
	// Not below the tools' caches, where the user does not run Git.
	const ancestors = new Set(roots);
	const bare = new Set<string>();
	let repositories: SandboxLayout["repositories"];
	let secrets: string[] = [];
	if (!input.exists && !blocked) {
		const searched = present([cwd, ...input.settings.allowWrite.map((path) => resolve(cwd, expandHome(path, home)))]);
		const found = findRepositories(searched);
		secrets = found.secrets;
		// A submodule's or a linked worktree's `.git` file names a folder in another repository's Git folder, which the
		// rules below cover with that repository.
		const owners = [...found.repositories, ...ancestors].map((folder) => join(folder, ".git")).concat(found.bare);
		for (const folder of found.repositories) {
			const dotGit = join(folder, ".git");
			let pointer: RegExpExecArray | null = null;
			try {
				pointer = isFile(dotGit) ? /^gitdir: (.+)\r?\n?$/.exec(read(dotGit)) : null;
			} catch {}
			const gitdir = pointer ? resolve(folder, pointer[1]!) : undefined;
			if (gitdir && owners.some((owner) => owner !== dotGit && within(gitdir, owner))) continue;
			roots.add(folder);
		}
		for (const folder of found.bare) {
			roots.add(folder);
			bare.add(folder);
		}
		repositories = {
			roots: searched,
			known: identities(found),
			gitDirs: owners,
			unreadable: found.unreadable,
			state: repositoryStatePath(input.agentDir ?? getAgentDir(), cwd),
			writable,
		};
	}
	try {
		// `git` is how to reach a repository without its working tree, a deinitialised submodule's for example.
		const projects = new Map<string, { gitdir: string; common: string; git?: string[]; root?: string }>();
		// fork: a hook that links to a writable file would run its new content.
		const hookFolders = new Set<string>();
		// fork.12 (AS-025): the browser extension's copies in ~/Prism, the window's folder when it opens in the home
		// folder. The browser loads them again at each start, outside the sandbox: read-only for commands, in every mode.
		for (const copy of extensionCopies(home)) {
			if (!exists(copy)) continue;
			const target = canonical(copy);
			if (!writable.some((root) => within(target, root))) continue;
			protect(target, true);
			reasons.set(target, `holds the Prism browser extension, which the browser runs outside the sandbox`);
		}
		for (const root of roots) {
			if (ancestors.has(root)) {
				// only Prism's own folder is reserved when absent; a `.pi` that exists
				// (a project also used with pi) stays read-only, but none is created any more.
				protect(join(root, CONFIG_DIR_NAME), true);
				if (CONFIG_DIR_NAME !== ".pi" && exists(join(root, ".pi"))) protect(join(root, ".pi"), true);
			}
			const dotGit = bare.has(root) ? root : join(root, ".git");
			if (!exists(dotGit) && !isSymlink(dotGit)) continue;
			let gitdir = dotGit;
			if (isFile(dotGit)) {
				protect(dotGit, false);
				const pointer = /^gitdir: (.+)\r?\n?$/.exec(read(dotGit));
				if (!pointer) throw new Error(`invalid Git pointer ${dotGit}`);
				gitdir = absolutePath(root, pointer[1]!);
			}
			gitdir = canonical(gitdir);
			if (!exists(gitdir)) throw new Error(`missing Git directory ${gitdir}`);
			// An empty .git can be a sandbox sentinel, not a repository whose state should be opened for writing. It stays
			// read-only, so a command cannot turn it into a repository whose hooks the next host `git` would run. Outside
			// the folders commands write to Git ignores it, and so
			// does Prism: no restriction and no note; inside them, writing there is refused with this reason.
			if (!exists(join(gitdir, "HEAD"))) {
				protect(gitdir, true);
				if (writable.some((root) => within(gitdir, root))) {
					gitState.add(gitdir);
					reasons.set(gitdir, `incomplete Git metadata at ${gitdir} cannot safely be opened for writing`);
				}
				continue;
			}
			const commonFile = join(gitdir, "commondir");
			const common = exists(commonFile) ? canonical(absolutePath(gitdir, read(commonFile).trim())) : gitdir;
			if (!exists(common)) throw new Error(`missing common Git directory ${common}`);
			projects.set(root, { gitdir, common });
			if (input.copyGitDir && !copied.has(common)) copied.set(common, input.copyGitDir(common));
			gitState.add(gitdir);
			gitState.add(common);
			// Git's mutable state must stay writable, including when a worktree's common directory is outside cwd.
			for (const path of [common, gitdir]) if (!writable.includes(path)) writable.push(path);
			protect(join(common, "config"), false);
			protect(join(common, "hooks"), true);
			hookFolders.add(join(common, "hooks"));
			protect(join(common, "config.worktree"), false);
			protect(join(gitdir, "config.worktree"), false);
			protect(commonFile, false, ".\n");
			if (gitdir !== common) protect(join(gitdir, "gitdir"), false);
			// Opening the shared Git state must not expose another registered worktree's configuration.
			const worktrees = join(common, "worktrees");
			if (!input.exists && exists(worktrees)) {
				for (const name of readdirSync(worktrees)) {
					const pointer = join(worktrees, name, "gitdir");
					if (!exists(pointer)) continue;
					const dotGit = resolve(dirname(pointer), read(pointer).trim());
					if (exists(dotGit)) roots.add(dirname(dotGit));
				}
			}
		}
		// fork: a submodule's Git directory is writable state;
		// a hook, a configuration or a `commondir` written there would act at the user's next host git command in the
		// submodule. No inert file reserves `commondir` without changing Git's semantics, so each submodule's Git
		// directory is read-only as a whole, nested ones included.
		// So is each repository's `modules` folder, where `git submodule` keeps them.
		const submodules = new Map<string, string | undefined>();
		const moduleFolders: string[] = [];
		// Every real folder the search went through, link targets included.
		const searched = new Set<string>();
		if (!input.exists) {
			for (const { common } of projects.values()) {
				const modules = join(common, "modules");
				if (exists(modules) && !isFile(modules)) moduleFolders.push(canonical(modules));
			}
			const queue: { worktree?: string; modules: string }[] = [...projects].map(([root, { common }]) => ({
				worktree: root,
				modules: join(common, "modules"),
			}));
			const add = (path: string, worktree?: string) => {
				const gitdir = canonical(path);
				// Found first without its working tree (a `core.worktree` from an include), then through .gitmodules.
				if (submodules.has(gitdir) && (submodules.get(gitdir) !== undefined || worktree === undefined)) return;
				if (!submodules.has(gitdir) && submodules.size >= 1024)
					throw new Error(`too many Git submodules in ${cwd}`);
				// Read as Git reads it: config.worktree and conditional includes too.
				let configured: string | undefined;
				try {
					configured = execFileSync(
						hostGitProgram(),
						["--git-dir", gitdir, "--work-tree", gitdir, "config", "--null", "--get-all", "core.worktree"],
						GIT_READ,
					)
						.split("\0")
						.at(-2);
				} catch {
					configured = configEntries(join(gitdir, "config"), "^core\\.worktree$", true).at(-1)?.value;
				}
				const top =
					worktree ?? (configured === undefined ? undefined : canonical(absolutePath(gitdir, configured)));
				submodules.set(gitdir, top);
				queue.push({ worktree: top, modules: join(gitdir, "modules") });
				const commonFile = join(gitdir, "commondir");
				const common = isFile(commonFile) ? absolutePath(gitdir, read(commonFile).trim()) : undefined;
				if (common && exists(common)) add(common);
			};
			for (let item = queue.shift(); item; item = queue.shift()) {
				for (const gitdir of submoduleGitDirs(item.modules, 0, searched)) add(gitdir);
				if (!item.worktree) continue;
				// Also where `.gitmodules` says, for a Git directory kept elsewhere or inside the submodule.
				for (const { value } of configEntries(join(item.worktree, ".gitmodules"), "^submodule\\..*\\.path$")) {
					if (!value || isAbsolute(value) || value.split("/").some((part) => part === "." || part === ".."))
						continue;
					const dotGit = join(item.worktree, value, ".git");
					if (isFile(dotGit)) {
						protect(dotGit, false);
						const pointer = /^gitdir: (.+)\r?\n?$/.exec(read(dotGit));
						if (pointer) add(absolutePath(dirname(dotGit), pointer[1]!), canonical(dirname(dotGit)));
					} else if (exists(dotGit)) add(dotGit, canonical(dirname(dotGit)));
				}
			}
			for (const modules of moduleFolders) protect(modules, true);
			// A link to a writable folder would let a command plant markers there that hide a Git directory.
			for (const folder of searched) {
				if ([...moduleFolders, ...submodules.keys()].some((root) => within(folder, root))) continue;
				protect(folder, true);
				moduleFolders.push(folder);
			}
			const protectGitDir = (gitdir: string) => {
				protect(gitdir, true);
				gitState.add(gitdir);
				// A link would leave its target writable.
				for (const name of ["hooks", "config", "config.worktree", "commondir"]) {
					const path = join(gitdir, name);
					if (isSymlink(path)) protect(path, name === "hooks");
				}
				hookFolders.add(join(gitdir, "hooks"));
			};
			for (const [gitdir, worktree] of submodules) {
				protectGitDir(gitdir);
				if (worktree && isFile(join(worktree, ".git"))) protect(join(worktree, ".git"), false);
				// Its linked worktrees, as for the project's own.
				let linked: string[] = [];
				try {
					linked = readdirSync(join(gitdir, "worktrees"));
				} catch {}
				if (linked.length > 256) throw new Error(`too many worktrees of the Git submodule ${gitdir}`);
				for (const name of linked) {
					const pointer = join(gitdir, "worktrees", name, "gitdir");
					if (!isFile(pointer)) continue;
					const dotGit = resolve(dirname(pointer), read(pointer).trim());
					if (!isFile(dotGit)) continue;
					protect(dotGit, false);
					const own = canonical(dirname(pointer));
					// Its folder may link out of the submodule's Git directory.
					protectGitDir(own);
					const commonFile = join(own, "commondir");
					const common = isFile(commonFile) ? canonical(absolutePath(own, read(commonFile).trim())) : gitdir;
					if (common !== gitdir && exists(common)) protectGitDir(common);
					const root = canonical(dirname(dotGit));
					if (exists(join(own, "HEAD")))
						projects.set(own, { gitdir: own, common, root, git: ["--git-dir", own, "--work-tree", root] });
				}
				// Its effective configuration (global, includes, config.worktree) can name hooks outside its Git directory,
				// also while it is deinitialised. Without HEAD, Git cannot read it, nor run its hooks.
				if (!exists(join(gitdir, "HEAD"))) continue;
				// Keyed by its Git directory: its core.worktree may name the superproject's working tree, or a folder that
				// no longer exists, which Git would refuse.
				const root = worktree !== undefined && exists(worktree) ? worktree : gitdir;
				projects.set(gitdir, { gitdir, common: gitdir, root, git: ["--git-dir", gitdir, "--work-tree", root] });
			}
		}
		// `git config` only parses configuration; it does not run hooks, filters, fsmonitor or aliases.
		// Keep pure layout tests independent of both the host filesystem and the maintainer's Git configuration.
		for (const [id, project] of projects) {
			const root = project.root ?? id;
			if ([...copied].some(([gitDir, yes]) => yes && within(project.common, gitDir)))
				privateGit.push({ repository: root, gitDir: project.common });
			if (!input.exists) {
				const options: ExecFileSyncOptionsWithStringEncoding = {
					encoding: "utf8",
					timeout: 2000,
					stdio: ["ignore", "pipe", "pipe"],
				};
				const entries: { origin: string; key: string; value: string }[] = [];
				const appendRecords = (records: string[]) => {
					for (let index = 0; index + 1 < records.length; index += 2) {
						const origin = records[index]!;
						const record = records[index + 1]!;
						const newline = record.indexOf("\n");
						const key = newline < 0 ? record : record.slice(0, newline);
						const value = newline < 0 ? "" : record.slice(newline + 1);
						if (origin.startsWith("file:")) protect(absolutePath(root, origin.slice(5)), false);
						entries.push({ origin, key, value });
					}
				};
				appendRecords(
					execFileSync(
						hostGitProgram(),
						[...(project.git ?? ["-C", root]), "config", "--null", "--list", "--show-origin", "--includes"],
						options,
					).split("\0"),
				);
				const included = new Set<string>();
				// Includes that do not exist yet (or whose condition is currently false) are also security inputs.
				for (const { origin, key, value } of entries) {
					if (key === "core.worktree" && !exists(join(project.gitdir, "commondir"))) {
						const { gitdir, common } = project;
						for (const path of [gitdir, common]) {
							readOnly.add(path);
							readOnlyDirectories.add(path);
							reasons.set(
								path,
								`core.worktree=${value} in ${origin} requires read-only Git metadata to preserve the configured worktree`,
							);
						}
					}
					if (key === "include.path" || /^includeif\..*\.path$/.test(key)) {
						if (
							!origin.startsWith("file:") ||
							(value.startsWith("~") && !value.startsWith("~/")) ||
							value.includes("%(")
						) {
							throw new Error(`unsupported Git include path in ${origin}`);
						}
						const path = absolutePath(dirname(absolutePath(root, origin.slice(5))), expandHome(value, home));
						protect(path, false);
						const target = canonical(path);
						if (exists(target) && !included.has(target)) {
							if (included.size >= 128) throw new Error(`too many Git configuration includes in ${root}`);
							included.add(target);
							appendRecords(
								execFileSync(
									hostGitProgram(),
									[
										"-C",
										root,
										"config",
										"--file",
										target,
										"--null",
										"--list",
										"--show-origin",
										"--no-includes",
									],
									options,
								).split("\0"),
							);
						}
					}
					if (key === "core.hookspath") {
						const hooks = value;
						if ((hooks.startsWith("~") && !hooks.startsWith("~/")) || hooks.includes("%(")) {
							throw new Error(`unsupported Git hooks path in ${root}`);
						}
						const path = absolutePath(root, expandHome(hooks, home));
						// fork: what a command writes in a copied Git folder is never published as hooks.
						const inCopy = (target: string) =>
							copied.get(project.common) === true && within(target, project.common);
						const target = canonical(path);
						hookFolders.add(path);
						// fork (SEC-08): Husky's hooks run the scripts one folder up, which Git outside Prism runs too.
						const scripts = exists(target) ? huskyScripts(target, isFile) : undefined;
						if (scripts && writable.some((folder) => scripts !== folder && within(scripts, folder))) {
							hookScripts.add(scripts);
							reasons.set(scripts, `holds the scripts Husky's hooks in ${target} run outside the sandbox`);
						}
						if (inCopy(target)) {
							// Its links are still followed below: they may lead out of the copy.
						} else if (
							copied.get(project.common) === true &&
							exists(target) &&
							!isFile(target) &&
							writable.some((folder) => target !== folder && within(target, folder)) &&
							!writable.some((folder) => within(folder, target))
						) {
							// Q-G2: a hooks folder in the working tree gets a private layer (Husky's `.husky/_`). One that holds a
							// writable folder (`core.hooksPath=.`) cannot, and stays read-only.
							hookLayers.set(target, project.common);
						} else {
							protect(path, true);
							reasons.set(target, `core.hooksPath=${hooks} in ${origin} names a writable root or Git state`);
						}
						// Hooks run during a push run in the Git directory, so a relative path also names a folder there.
						if (project.root) {
							const pushed = absolutePath(project.gitdir, expandHome(hooks, home));
							protect(pushed, true);
							hookFolders.add(pushed);
						} else if (!isAbsolute(expandHome(hooks, home))) {
							// fork: reserving the folder would leave it in the user's Git metadata, so
							// a folder the command could create, or a name before `..` it could turn into a link, refuses
							// the command instead.
							const parts = hooks.split("/").filter((part) => part && part !== ".");
							const name = parts.findIndex((part) => part !== "..");
							for (const gitdir of new Set([project.gitdir, project.common])) {
								const pushed = canonical(absolutePath(gitdir, hooks));
								// The real Git folder, which a push runs in, keeps none of the command's files there.
								if (inCopy(pushed)) continue;
								const where = `core.hooksPath=${hooks} in ${origin} is relative, so a push received by this repository runs hooks from ${pushed}`;
								if (name >= 0 && name < parts.lastIndexOf("..")) {
									refuse(
										`${where}, through a folder name followed by "..", which a sandboxed command could replace with a link. Set core.hooksPath to an absolute path`,
									);
								} else if (!exists(pushed) && writable.some((folder) => within(pushed, folder))) {
									refuse(
										`${where}, a folder a sandboxed command could create. Outside the sandbox, create it (mkdir -p '${pushed}'; the sandbox then keeps it read-only) or set core.hooksPath to an absolute path`,
									);
								} else {
									protect(pushed, true);
									hookFolders.add(pushed);
								}
							}
						}
					}
				}
			}
			const hooks = input.hooksPath?.(root);
			if (hooks !== undefined) {
				const path = absolutePath(root, hooks);
				protect(path, true);
				reasons.set(canonical(path), `core.hooksPath=${hooks} in ${root} names a writable root or Git state`);
			}
		}
		for (const folder of input.exists ? [] : hookFolders) {
			let names: string[] = [];
			try {
				names = readdirSync(folder);
			} catch {}
			if (names.length > 1024) throw new Error(`too many Git hooks in ${folder}`);
			for (const name of names) if (isSymlink(join(folder, name))) protect(join(folder, name), false);
		}
		for (const gitdir of [...moduleFolders, ...submodules.keys()]) {
			reasons.set(
				gitdir,
				`submodule Git metadata at ${gitdir} is read-only in the sandbox, so Git commands that write to this submodule (add, commit, fetch, checkout, submodule update) must run outside it; source files stay writable`,
			);
		}
		// These files may be absent or empty, hence absent from --show-origin.
		for (const path of [
			process.env.GIT_CONFIG_GLOBAL ?? join(home, ".gitconfig"),
			join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "git", "config"),
		])
			protect(path, false);
		for (const path of input.tmp ? (input.runFrom ?? []) : []) if (path.startsWith("/tmp/")) protect(path, true);
	} catch (error) {
		refuse(error instanceof Error ? error.message : String(error));
	}
	if (repositories) repositories.gitDirs = [...new Set([...repositories.gitDirs, ...gitState])];
	let hidden: string[] = [];
	try {
		hidden = present(
			[
				input.agentDir ?? getAgentDir(),
				// fork: the phone link's folder, beside the agent folder: the PC's key,
				// the paired phones and the socket that gives pairing codes.
				...phoneLinkDirs(home),
				// Sockets: the session bus, the keyring and the compositor. X11's, in the host's /tmp, are left out
				// with it.
				`/run/user/${uid}`,
				// fork: always closed; the old allowSystemBus setting is ignored (sandbox.md § 8.3).
				"/run/dbus",
				"/var/run/dbus",
				...SYSTEM_SECRET_PATHS.filter(
					(path) =>
						!input.settings.read.allow.some((allowed) => within(path, resolve(cwd, expandHome(allowed, home)))),
				),
				...DEFAULT_HIDDEN_HOME_PATHS.map((path) => join(home, path)),
				...(limit ? [] : READ_ALL_HIDDEN_HOME_PATHS.map((path) => join(home, path))),
				...input.settings.hide.map((path) => resolve(cwd, expandHome(path, home))),
				// fork: safe mode also hides the project's secret files (`.env`, keys). The
				// project is read-only then, so the command cannot add one after this walk.
				...(input.readOnlyProject ? secrets : []),
			].map(canonical),
		);
	} catch (error) {
		refuse(error instanceof Error ? error.message : String(error));
	}
	const inCopy = (path: string) => [...copied].some(([gitDir, yes]) => yes && within(path, gitDir));
	const restrictions: { path: string; reason: string }[] = [];
	for (const path of readOnlyDirectories) {
		if (inCopy(path)) continue;
		if (writable.some((root) => within(root, path)) || [...gitState].some((root) => within(root, path))) {
			restrictions.push({ path, reason: reasons.get(path) ?? `protected metadata ${path} overlaps writable state` });
		}
	}
	// A read-only parent already prevents creation; do not materialize files that would change Git's semantics.
	for (const path of missing.keys()) {
		if (restrictions.some((restriction) => within(path, restriction.path))) {
			missing.delete(path);
			readOnly.delete(path);
		}
	}
	let homeLimit: SandboxLayout["home"];
	if (limit) {
		// Q-L10: the "project" would be the whole home folder.
		if (!limit.project) {
			blocked ??=
				"Reading is limited to the project, and Prism was opened in the home folder or above it: open Prism in a project folder, or let commands read everything (sandbox.read.limit in Prism's settings).";
		}
		const shown = [...limit.read.map(({ path }) => path), ...writable, join(home, ".cache")];
		// Q-L2: what the home folder does not show is not mounted there, not even as an unreadable stand-in.
		const mounted = (path: string) => !within(path, home) || shown.some((root) => within(path, root));
		hidden = [...hidden.filter(mounted), ...limit.hidden.filter((path) => !hidden.includes(path))];
		for (const path of [...readOnly]) if (!mounted(path)) readOnly.delete(path);
		for (const path of [...missing.keys()]) if (!mounted(path)) missing.delete(path);
		// Lot 7 (Q-L3): settings that can hold credentials, shown rebuilt from their allowed fields when the set does
		// not show them as they are and no hidden path covers them; the copies are written before each command.
		const hide = [
			...DEFAULT_HIDDEN_HOME_PATHS.map((path) => join(home, path)),
			...input.settings.hide.map((path) => resolve(cwd, expandHome(path, home))),
		];
		const settings = REBUILT_SETTINGS.filter(({ tool }) => !input.settings.read.toolsOff.includes(tool))
			// fork: and where CARGO_HOME moves Cargo's config.toml.
			.flatMap(({ path }) => relocated(path, home, input.env ?? process.env))
			.filter((path) => !isReadable(limit, path) && !hide.some((folder) => within(path, folder)));
		const key = createHash("sha256")
			.update(limit.project ?? cwd)
			.digest("hex")
			.slice(0, 16);
		homeLimit = {
			path: home,
			read: limit.read.map(({ path }) => path),
			cache: join(input.agentDir ?? getAgentDir(), "sandbox", "cache", key),
			hiddenOutside: limit.hiddenOutside,
			settings,
		};
	}
	// First among the read-only mounts, so that the protections inside them still apply above.
	const frozen = input.readOnlyProject ? writable.filter((path) => !caches.includes(path)) : [];
	return {
		cwd,
		tmp: input.tmp,
		writable: input.readOnlyProject ? writable.filter((path) => caches.includes(path)) : writable,
		readOnly: [...frozen, ...[...readOnly].filter((path) => !inCopy(path))],
		hidden,
		missing: [...missing].filter(([path]) => !inCopy(path)).map(([path, entry]) => ({ path, ...entry })),
		blocked,
		restrictions,
		...(privateGit.length > 0 ? { privateGit } : {}),
		...(homeLimit ? { home: homeLimit } : {}),
		...(hookLayers.size > 0 ? { hookLayers: [...hookLayers].map(([path, gitDir]) => ({ path, gitDir })) } : {}),
		...(hookScripts.size > 0 ? { hookScripts: [...hookScripts] } : {}),
		...(repositories ? { repositories } : {}),
		...(layered.length > 0 ? { caches: layered } : {}),
	};
}

/**
 * Mounts need real entries. Create only absent, inert metadata, exclusively, before starting the command.
 * In particular an empty commondir breaks Git; `.` preserves the ordinary repository's common directory.
 */
export function prepareLayout(layout: SandboxLayout): void {
	if (layout.blocked) throw new Error(layout.blocked);
	if (layout.home) mkdirSync(layout.home.cache, { recursive: true, mode: 0o700 });
	for (const { path, directory, content } of layout.missing ?? []) {
		if (directory) mkdirSync(path, { mode: 0o755 });
		else writeFileSync(path, content ?? "", { flag: "wx", mode: 0o644 });
	}
}

/**
 * fork: the folders between a writable path and a read-only path inside it. A
 * read-only mount does not stop the folder that holds it from being renamed, removed and rebuilt (`.git` with
 * `.git/hooks` in it); each of these folders is mounted on itself, and the kernel refuses to rename or remove a
 * mount point.
 */
export function pinnedFolders(
	layout: Pick<SandboxLayout, "writable" | "readOnly" | "hookLayers" | "hookScripts"> & { hidden?: string[] },
): string[] {
	const pinned = new Set<string>();
	const layers = [...(layout.hookLayers ?? []).map(({ path }) => path), ...(layout.hookScripts ?? [])];
	for (const path of [...layout.readOnly, ...(layout.hidden ?? []), ...layers]) {
		const root = layout.writable.find((writable) => path !== writable && within(path, writable));
		if (!root) continue;
		for (let folder = dirname(path); folder !== root && within(folder, root); folder = dirname(folder))
			pinned.add(folder);
	}
	return [...pinned].sort((a, b) => a.length - b.length);
}

/**
 * bubblewrap's arguments, up to and excluding `--`. Later mounts cover earlier ones, so the order is:
 * the whole system read-only, the private /tmp, the limited home folder, writable paths (a project under
 * /tmp stays reachable; the package caches through their layers, AS-010), the private copies of Git folders, the
 * folders that hold read-only paths, the private layers of hooks folders, read-only again inside them, copies, hidden
 * paths;
 * last, the limited home folder becomes read-only, once every mount point in it is made.
 */
export function bwrapArgs(
	layout: SandboxLayout,
	isDirectory: (path: string) => boolean,
	/** An empty file without permissions, bound over each hidden file. */
	unreadableFile: string,
): string[] {
	if (layout.blocked) throw new Error(layout.blocked);
	const args = [
		"--die-with-parent",
		"--new-session",
		"--unshare-all",
		"--ro-bind",
		"/",
		"/",
		"--dev",
		"/dev",
		"--proc",
		"/proc",
	];
	if (layout.tmp) args.push("--bind", layout.tmp, "/tmp");
	const home = layout.home;
	if (home) {
		for (const path of home.hiddenOutside) args.push("--tmpfs", path);
		args.push("--tmpfs", home.path);
		// Empty unless resources show what is in it: Podman's client stops when ~/.config is absent.
		args.push("--dir", join(home.path, ".config"));
		for (const path of home.read) args.push("--ro-bind", path, path);
		args.push("--bind", home.cache, join(home.path, ".cache"));
	}
	for (const path of layout.writable) {
		if (!layout.caches?.includes(path)) {
			args.push("--bind", path, path);
			continue;
		}
		// fork (AS-010): a cache through its layer for this command; read-only without one.
		const layer = layout.cacheLayers?.find((entry) => entry.path === path);
		if (!layer) args.push("--ro-bind", path, path);
		else if ("source" in layer) args.push("--bind", layer.source, path);
		else args.push("--overlay-src", path, "--overlay", layer.upper, layer.work, path);
	}
	for (const copy of layout.gitCopies ?? []) args.push(...copy);
	for (const path of pinnedFolders(layout)) args.push("--bind", path, path);
	// After the folders that hold them, which would cover them; Husky's scripts folder holds its hooks folder.
	for (const path of layout.hookScripts ?? []) args.push("--ro-bind", path, path);
	for (const { path, source } of layout.hookLayers ?? [])
		args.push(source ? "--bind" : "--ro-bind", source ?? path, path);
	for (const path of layout.readOnly) args.push("--ro-bind", path, path);
	for (const [copy, original] of layout.copies ?? []) args.push("--ro-bind", copy, original);
	for (const path of layout.hidden) {
		// Unreadable rather than empty: "Permission denied" tells what happened, an empty ~/.ssh does not.
		if (isDirectory(path)) args.push("--perms", "0000", "--tmpfs", path);
		else args.push("--ro-bind", unreadableFile, path);
	}
	if (home) for (const path of [...home.hiddenOutside, home.path]) args.push("--remount-ro", path);
	args.push("--chdir", layout.cwd);
	return args;
}
