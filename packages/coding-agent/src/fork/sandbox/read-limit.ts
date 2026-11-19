/**
 * fork: what the agent may read in the home folder when reading is limited to the project
 *. An allow-list replaces the hidden list there: what is not listed is not shown,
 * including what a tool installs tomorrow. Pure: the paths that exist are passed in, so tests can build any home
 * without touching the machine. Mounting the set is the sandbox's job (§ 9.4), judging native tools the guard's.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { hostProgram } from "../host-program.ts";
import { within } from "./path-within.ts";
import { relocated } from "./tool-settings.ts";

/** One tool's resources, relative to the home folder; a `*` ends the last segment only. */
export interface ToolResources {
	tool: string;
	read: readonly string[];
	write: readonly string[];
	hidden: readonly string[];
}

/**
 * The default table (§ 9.3): short, no promise to be complete, each line used when its folders exist. Paths under
 * `.cache` are left out: the sandbox shows its own cache there. Settings that can hold
 * credentials are left out: commands see them rebuilt from allowed fields (Q-L3, `tool-settings.ts`): `~/.npmrc`,
 * pip's and uv's configuration, Cargo's `config.toml` (a registry token can be written there).
 */
export const TOOL_RESOURCES: readonly ToolResources[] = [
	{
		tool: "Git",
		read: [".gitconfig", ".config/git"],
		write: [],
		hidden: [".config/git/credentials", ".git-credentials"],
	},
	{
		tool: "Rust",
		read: [".rustup", ".cargo"],
		write: [".cargo/registry", ".cargo/git"],
		hidden: [".cargo/credentials", ".cargo/credentials.toml", ".cargo/config", ".cargo/config.toml"],
	},
	{
		tool: "npm, pnpm",
		read: [".local/npm", ".npm-global", ".config/pnpm", ".local/share/pnpm"],
		write: [".npm"],
		hidden: [".config/pnpm/auth.ini"],
	},
	{
		tool: "Python",
		read: [".local/share/uv/python", ".local/share/uv/tools", ".local/share/pipx", ".local/lib/python3.*"],
		write: [],
		hidden: [".local/share/uv/credentials", ".pypirc"],
	},
	{ tool: "nvm", read: [".nvm"], write: [], hidden: [] },
	{ tool: "pyenv", read: [".pyenv"], write: [], hidden: [] },
	{ tool: "Bun", read: [".bun"], write: [".bun/install/cache"], hidden: [] },
	{
		tool: "Ruby",
		read: [".gem", ".local/share/gem"],
		write: [".gem", ".local/share/gem"],
		hidden: [".gem/credentials"],
	},
	{ tool: "Go", read: ["go", ".config/go"], write: ["go/pkg"], hidden: [] },
	{
		tool: "mise, asdf, Volta, SDKMAN, Deno",
		read: [".local/share/mise", ".config/mise", ".asdf", ".tool-versions", ".volta", ".sdkman", ".deno"],
		write: [],
		hidden: [],
	},
];

/** Variables that name a tool's folder (§ 9.3); each one under the home folder is readable. */
export const TOOL_VARIABLES: readonly string[] = [
	"RUSTUP_HOME",
	"CARGO_HOME",
	"NVM_DIR",
	"PYENV_ROOT",
	"GOPATH",
	"GOMODCACHE",
	"BUN_INSTALL",
	"PNPM_HOME",
	"VOLTA_HOME",
	"SDKMAN_DIR",
	"ASDF_DATA_DIR",
	"MISE_DATA_DIR",
	"DENO_DIR",
	"VIRTUAL_ENV",
	"CONDA_PREFIX",
	"JAVA_HOME",
	"ANDROID_HOME",
];

/** Credentials hidden even inside a readable folder, besides the hidden paths of the settings (§ 9.3). */
export const HIDDEN_INSIDE: readonly string[] = [
	".netrc",
	".cargo/credentials.toml",
	".config/git/credentials",
	".local/share/uv/credentials",
	".config/pnpm/auth.ini",
	".gem/credentials",
	".pypirc",
];

/** Folders never readable as a whole, though some of their entries are. */
const TOO_WIDE: readonly string[] = [".local", ".config", ".local/share", ".local/lib", ".cache"];

/** Outside the home folder, hidden too: other accounts and mounted media. */
const OUTSIDE: readonly string[] = ["/root", "/run/media", "/media", "/mnt"];

export interface ReadLimitInput {
	cwd: string;
	home?: string;
	/** The environment the commands get: `PATH` and the variables of `TOOL_VARIABLES`. */
	env?: Record<string, string | undefined>;
	/** Folders Prism runs from (its installation, node), readable by its own commands. */
	prism?: readonly string[];
	/** Folders the user allowed (`read.allow`, global and for this project); `~` expands. */
	allow?: readonly string[];
	/** `sandbox.allowWrite`: writing implies reading. */
	allowWrite?: readonly string[];
	/** Hidden paths, the defaults and `sandbox.hide`, hidden even when another rule lists them; `~` expands. */
	hide?: readonly string[];
	/** Tools of the table the user turned off (`read.tools`), by name. */
	toolsOff?: readonly string[];
	/** The project's Git top level and common directory, as Git gives them; defaults to asking Git. */
	git?: (cwd: string) => { top: string; common: string } | undefined;
	exists?: (path: string) => boolean;
	realpath?: (path: string) => string;
	/** A folder's entries; defaults to the file system. */
	entries?: (path: string) => string[];
}

export interface ReadableSet {
	home: string;
	/** The project: the Git top level, else the working folder; undefined when that would be the whole home folder. */
	project?: string;
	/** Set when Prism was opened in the home folder or above it (Q-L10): no project is readable until the user says. */
	wholeHome?: boolean;
	/** A worktree's common Git directory, outside the project. */
	gitCommon?: string;
	/** Readable in the home folder, each with the rule that lists it. */
	read: { path: string; why: string }[];
	/** Writable in the home folder: tools' caches and `allowWrite`. */
	write: string[];
	/** Hidden inside readable folders. */
	hidden: string[];
	/** Hidden outside the home folder (Q-L4). */
	hiddenOutside: string[];
}

const expandHome = (path: string, home: string) =>
	path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;

const askGit = (cwd: string) => {
	// fork: Git from PATH, never from where the sandbox writes.
	const git = hostProgram("git");
	if (!git) return undefined;
	try {
		// fork: one value per call, only its final line break removed: a folder name may
		// hold a line break, which splitting one output by lines cut.
		const ask = (option: string) =>
			execFileSync(git, ["rev-parse", option], {
				cwd,
				encoding: "utf8",
				timeout: 2000,
				stdio: ["ignore", "pipe", "ignore"],
			}).replace(/\n$/, "");
		const top = ask("--show-toplevel");
		const common = ask("--git-common-dir");
		return top && common ? { top, common: resolve(cwd, common) } : undefined;
	} catch {
		return undefined;
	}
};

const listEntries = (path: string) => {
	try {
		return readdirSync(path);
	} catch {
		return [];
	}
};

/** The tools of the table found in the home folder, with their folders that exist (§ 9.7, /settings). */
export function toolsFound(
	home = homedir(),
	exists: (path: string) => boolean = existsSync,
	entries: (path: string) => string[] = listEntries,
): { tool: string; paths: string[] }[] {
	return TOOL_RESOURCES.map((tool) => ({
		tool: tool.tool,
		paths: tool.read.flatMap((path) => {
			const name = basename(path);
			if (!name.endsWith("*")) return exists(join(home, path)) ? [join(home, path)] : [];
			const parent = join(home, dirname(path));
			return entries(parent)
				.filter((entry) => entry.startsWith(name.slice(0, -1)))
				.map((entry) => join(parent, entry));
		}),
	})).filter((tool) => tool.paths.length > 0);
}

/** The readable set for a session (§ 9.3), computed once and again when a setting changes (§ 9.4). */
export function readableSet(input: ReadLimitInput): ReadableSet {
	const home = resolve(input.home ?? homedir());
	const env = input.env ?? process.env;
	const exists = input.exists ?? existsSync;
	const realpath = (path: string) => {
		try {
			return (input.realpath ?? realpathSync)(path);
		} catch {
			return path;
		}
	};
	const entries = input.entries ?? listEntries;
	const inHome = (path: string) => within(path, home) && path !== home;
	const expand = (paths: readonly string[]) =>
		paths.flatMap((path) => {
			const name = basename(path);
			if (!name.endsWith("*")) return [join(home, path)];
			const parent = join(home, dirname(path));
			const prefix = name.slice(0, -1);
			return entries(parent)
				.filter((entry) => entry.startsWith(prefix))
				.map((entry) => join(parent, entry));
		});

	const tools = TOOL_RESOURCES.filter((tool) => !input.toolsOff?.includes(tool.tool));
	const hidden = [
		...new Set([
			...HIDDEN_INSIDE.map((path) => join(home, path)),
			...tools.flatMap((tool) => expand(tool.hidden)),
			// fork: the same entries where CARGO_HOME moves Cargo's folder.
			...[...HIDDEN_INSIDE, ...tools.flatMap((tool) => tool.hidden)].flatMap((path) =>
				relocated(path, home, env).slice(1),
			),
			...(input.hide ?? []).map((path) => resolve(input.cwd, expandHome(path, home))),
		]),
	].flatMap((path) => [path, realpath(path)]);
	const allowed = (path: string) =>
		inHome(path) &&
		!hidden.some((folder) => within(path, folder)) &&
		!TOO_WIDE.some((wide) => path === join(home, wide));
	// A rule may name a link: the folder shown is where it leads (bubblewrap mounts the real path), and both must
	// pass, so a link cannot open the home folder or a hidden one. Outside the home folder, only what the user
	// names explicitly reopens a hidden folder (Q-L4); the rest of the system is readable anyway.
	const real = (path: string, explicit: boolean) => {
		const absolute = resolve(path);
		const target = realpath(absolute);
		// Q-L12: the home folder or a folder above it never opens this way.
		if (!exists(target) || within(home, target) || within(home, absolute)) return undefined;
		const entry = !within(absolute, home) || allowed(absolute);
		if (within(target, home)) return entry && allowed(target) ? target : undefined;
		return within(absolute, home) ? (entry ? target : undefined) : explicit ? target : undefined;
	};

	const read: ReadableSet["read"] = [];
	const add = (path: string, why: string, explicit = false) => {
		const target = real(path, explicit);
		if (!target || read.some((entry) => within(target, entry.path))) return;
		for (let index = read.length - 1; index >= 0; index--) {
			if (within(read[index]!.path, target)) read.splice(index, 1);
		}
		read.push({ path: target, why });
	};

	for (const tool of tools) for (const path of expand(tool.read)) add(path, tool.tool);
	for (const entry of (env.PATH ?? "").split(":")) if (isAbsolute(entry)) add(entry, "PATH");
	for (const name of TOOL_VARIABLES) {
		const value = env[name];
		if (value && isAbsolute(value)) add(value, name);
	}
	// Git's global configuration where the variable puts it; layout.ts keeps it read-only in the sandbox.
	if (tools.some(({ tool }) => tool === "Git") && env.GIT_CONFIG_GLOBAL && isAbsolute(env.GIT_CONFIG_GLOBAL)) {
		add(env.GIT_CONFIG_GLOBAL, "GIT_CONFIG_GLOBAL");
	}
	for (const path of input.prism ?? []) add(path, "Prism");
	const user = (paths: readonly string[] | undefined) =>
		(paths ?? []).map((path) => resolve(input.cwd, expandHome(path, home)));
	for (const path of user(input.allow)) add(path, "allowed by the user", true);
	for (const path of user(input.allowWrite)) add(path, "Writable paths", true);

	const write = [
		...tools.flatMap((tool) => expand(tool.write)).map((path) => real(path, false)),
		...user(input.allowWrite).map((path) => real(path, true)),
	].filter((path, index, all): path is string => path !== undefined && all.indexOf(path) === index);

	const git = (input.git ?? askGit)(input.cwd);
	const project = realpath(git?.top ?? resolve(input.cwd));
	const wholeHome = within(home, project);
	const common = git && realpath(git.common);
	const gitCommon = common && !within(common, project) ? common : undefined;

	const others = within(home, "/home") ? entries("/home").map((name) => join("/home", name)) : [];
	const hiddenOutside = [...others, ...OUTSIDE].filter(
		(path) => !within(home, path) && !within(path, home) && exists(path),
	);

	return {
		home,
		project: wholeHome ? undefined : project,
		...(wholeHome ? { wholeHome } : {}),
		...(gitCommon ? { gitCommon } : {}),
		read,
		write,
		// A link is not hidden itself (bubblewrap cannot mount on it): its target is, by its real path.
		hidden: [...new Set(hidden)].filter(
			(path) =>
				exists(path) &&
				realpath(path) === path &&
				(read.some((entry) => within(path, entry.path)) || write.some((folder) => within(path, folder))),
		),
		hiddenOutside,
	};
}

/** Whether the set lets the agent read `path` (a real path): the guard's test for native tools (§ 9.5). */
export function isReadable(set: ReadableSet, path: string): boolean {
	const absolute = resolve(path);
	if (set.hidden.some((folder) => within(absolute, folder))) return false;
	if (set.project && within(absolute, set.project)) return true;
	if (set.gitCommon && within(absolute, set.gitCommon)) return true;
	if (set.read.some((entry) => within(absolute, entry.path)) || set.write.some((folder) => within(absolute, folder))) {
		return true;
	}
	return !within(absolute, set.home) && !set.hiddenOutside.some((folder) => within(absolute, folder));
}
