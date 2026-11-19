/**
 * fork: the ssh that Prism runs for Git over SSH follows the
 * user's configuration (aliases, keys, jump hosts, their own ProxyCommand), but nothing in it may come from a file
 * the sandbox can change: a planted `Match exec`, `ProxyCommand` or provider would run on the host, and a planted
 * control socket link would reach a host the user never allowed. Before each run, Prism reads the files ssh will
 * read and the paths they name, as ssh expands them, and refuses with the file and line when one is writable from
 * the sandbox. Read statically: evaluating the configuration (`ssh -G`) would already run its `Match exec`.
 */

import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { SandboxLayout } from "./layout.ts";
import { within } from "./path-within.ts";
import { expand, words } from "./ssh-config.ts";

const SYSTEM_CONFIG = "/etc/ssh/ssh_config";
// OpenSSH's own limit on nested includes.
const MAX_DEPTH = 16;

/** Run on the host, through the user's shell or loaded into ssh. */
const COMMANDS = new Set(["proxycommand", "localcommand", "knownhostscommand", "xauthlocation"]);
const PROVIDERS = new Set(["pkcs11provider", "securitykeyprovider"]);
/** Read by ssh: a key, certificate or host key list the sandbox wrote would change whom ssh trusts or is. */
const FILES = new Set([
	"identityfile",
	"certificatefile",
	"userknownhostsfile",
	"globalknownhostsfile",
	"revokedhostkeys",
	"identityagent",
]);

/** How Prism runs ssh for one request, or why it does not. */
export interface SshPlan {
	program: string;
	/** Options before Prism's own: `-S none` when the user's control sockets live where the sandbox writes. */
	options: string[];
}

let override: { home: string; system?: string } | undefined;

/** Tests only: the home whose `.ssh/config` is read, so a test never reads the user's real one, and the system file. */
export function overrideSshFiles(files: { home: string; system?: string } | undefined): void {
	override = files;
}

/** ssh's home: the password database's, not `$HOME`. */
const sshHome = () => override?.home ?? userInfo().homedir;

/** A path by its real location, following links up to the deepest part that exists. */
function realLocation(path: string): string {
	let existing = resolve(path);
	const rest: string[] = [];
	for (;;) {
		try {
			return join(realpathSync(existing), ...rest.reverse());
		} catch {
			const parent = dirname(existing);
			if (parent === existing) return resolve(path);
			rest.push(basename(existing));
			existing = parent;
		}
	}
}

/** Whether a command can create or change a path; `roots` are the real folders it writes, when known. */
export type SandboxWrites = ((path: string) => boolean) & { roots?: readonly string[] };

/**
 * Whether a command in this layout can create or change `path`: its real location, and each entry the path goes
 * through. fork: `project/proxy`, a link to /usr/bin/nc, is protected by its target, but
 * the command can replace the link itself before ssh reads it; so can it replace a folder link on the way.
 */
export function sandboxWrites(
	layout: Pick<SandboxLayout, "writable" | "readOnly" | "hidden" | "missing" | "tmp">,
): SandboxWrites {
	const real = (paths: readonly (string | undefined)[]) =>
		paths.filter((path): path is string => path !== undefined).map(realLocation);
	const roots = real([...layout.writable, layout.tmp]);
	const kept = real([...layout.readOnly, ...layout.hidden, ...(layout.missing ?? []).map((entry) => entry.path)]);
	const writable = (target: string) =>
		roots.some((root) => within(target, root)) && !kept.some((path) => within(target, path));
	const writes = (path: string): boolean => {
		if (writable(realLocation(path))) return true;
		// Each entry, by its real folder: a mount point (kept, or a writable root itself) cannot be replaced.
		for (let entry = resolve(path); dirname(entry) !== entry; entry = dirname(entry)) {
			const folder = realLocation(dirname(entry));
			const name = join(folder, basename(entry));
			if (writable(folder) && !roots.includes(name) && !kept.some((path) => within(name, path))) return true;
		}
		return false;
	};
	return Object.assign(writes, { roots });
}

interface Context {
	home: string;
	env: NodeJS.ProcessEnv;
	writes: SandboxWrites;
}

/**
 * `~`, `%d`, `%u`, `%%` and `${VAR}` as ssh expands them in paths. fork: any other `%`
 * token (`%n`, `%h`…) takes its value from the destination, so it becomes `*`, a pattern judged for every value,
 * never one letter that names another path.
 */
function expandPath(word: string, context: Context): string {
	return word
		.replace(/^~(?=\/|$)/, context.home)
		.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_all, name: string) => context.env[name] ?? "")
		.replace(/%(.)/g, (_all, token: string) =>
			token === "d" ? context.home : token === "u" ? userInfo().username : token === "%" ? "%" : "*",
		);
}

/**
 * fork: the files a relative path of an option can name. ssh runs from `/` and opens
 * some relative to its cwd, some from the home folder: both are judged, so neither is checked in place of the other.
 */
const opened = (path: string, context: Context): string[] =>
	isAbsolute(path) ? [path] : [resolve("/", path), resolve(context.home, path)];

/**
 * Whether a pattern can name a path the sandbox writes: its fixed part, or a writable folder below it that a match
 * could reach, whether or not a file is there yet. fork: `Include /tmp/work/*\/ssh.conf`
 * matches the project `/tmp/work/a`'s file once a command writes it, though `/tmp/work` itself is not writable.
 */
function patternWrites(pattern: string, context: Context): boolean {
	const root = patternRoot(pattern);
	if (context.writes(root)) return true;
	if (root === pattern) return false;
	return (context.writes.roots ?? []).some((folder) => within(folder, root));
}

/**
 * The paths a shell command names (words with a `/` or a leading `~` or `$HOME`; relative ones from `/`, ssh's cwd),
 * or the reason Prism cannot know them. fork: ssh hands the line to the user's shell,
 * where quotes, escapes, variables and patterns change which program runs; cut at spaces, `"/tmp/my project/proxy"`
 * was two other paths. A line with any of them is refused, never guessed.
 */
function commandPaths(command: string, context: Context): string[] | string {
	const readable = command.replace(/\$\{?HOME\}?(?=\/|\s|$)/g, "~");
	if (/['"\\`$*?[{]/.test(readable))
		return "holds quotes, a variable or a pattern, which only the shell can read: Prism cannot tell what it runs";
	return readable
		.split(/[\s;&|()<>=]+/)
		.filter((word) => word.includes("/") || word.startsWith("~"))
		.map((word) => resolve("/", expandPath(word, context)));
}

const reason = (file: string, line: number, what: string, path: string) =>
	`${file} line ${line} (${what}) names ${path}, which commands in the sandbox can change, and ssh runs on this machine`;

/** The part of an Include pattern that exists without matching: where a new matching file could appear. */
function patternRoot(pattern: string): string {
	const parts = pattern.split("/");
	const glob = parts.findIndex((part) => /[*?[]/.test(part));
	return glob < 0 ? pattern : parts.slice(0, glob).join("/") || "/";
}

/**
 * Checks the files of ssh's configuration and what they name. Returns the plan, or why Git over SSH is refused.
 * `writes` says whether the sandbox can change a path (`sandboxWrites`).
 */
export function sshPlan(
	writes: SandboxWrites,
	program = "ssh",
	env: NodeJS.ProcessEnv = process.env,
): SshPlan | string {
	const context: Context = { home: sshHome(), env, writes };
	const options: string[] = [];
	/** A configured command whose program is found on PATH, or a jump host (ssh runs ssh again). */
	let searchesPath = false;
	let runsCommands = false;
	const seen = new Set<string>();
	const visit = (file: string, base: string, depth: number): string | undefined => {
		if (writes(file)) return `ssh reads ${file}, which commands in the sandbox can change`;
		let text: string;
		try {
			if (!statSync(file).isFile()) return undefined;
			text = readFileSync(file, "utf8");
		} catch {
			return undefined;
		}
		const lines = text.split("\n");
		for (let index = 0; index < lines.length; index++) {
			const match = /^\s*([A-Za-z0-9]+)(?:\s*=\s*|\s+)(.*)$/.exec(lines[index]!);
			if (!match) continue;
			const keyword = match[1]!.toLowerCase();
			const args = words(match[2]!);
			const line = index + 1;
			if (keyword === "include") {
				for (const word of args) {
					const expanded = expandPath(word, context);
					const pattern = isAbsolute(expanded) ? expanded : join(base, expanded);
					if (patternWrites(pattern, context)) return reason(file, line, "Include", pattern);
					for (const included of expand(pattern)) {
						let real: string;
						try {
							real = realpathSync(included);
						} catch {
							continue;
						}
						if (seen.has(real) || depth >= MAX_DEPTH) continue;
						seen.add(real);
						const refused = visit(real, base, depth + 1);
						if (refused) return refused;
					}
				}
			} else if (keyword === "match") {
				for (let at = args.findIndex((word) => /^!?exec$/i.test(word)); at >= 0 && at + 1 < args.length; ) {
					runsCommands = true;
					searchesPath ||= !/^\S*\//.test(args[at + 1]!.trim());
					const paths = commandPaths(args[at + 1]!, context);
					if (typeof paths === "string") return `${file} line ${line} (Match exec) ${paths}`;
					for (const path of paths) {
						if (patternWrites(path, context)) return reason(file, line, "Match exec", path);
					}
					const next = args.slice(at + 2).findIndex((word) => /^!?exec$/i.test(word));
					at = next < 0 ? -1 : at + 2 + next;
				}
			} else if (COMMANDS.has(keyword) || keyword === "proxyjump") {
				if (args[0]?.toLowerCase() === "none") continue;
				runsCommands = true;
				searchesPath ||= keyword === "proxyjump" || !/^(?:exec\s+)?\S*\//.test(args.join(" ").trim());
				// The rest of the line as written: ssh gives it to the shell with its quotes.
				const paths = keyword === "proxyjump" ? [] : commandPaths(match[2]!, context);
				if (typeof paths === "string") return `${file} line ${line} (${match[1]!}) ${paths}`;
				for (const path of paths) {
					if (patternWrites(path, context)) return reason(file, line, match[1]!, path);
				}
			} else if (PROVIDERS.has(keyword) || FILES.has(keyword)) {
				for (const word of args) {
					if (/^(none|internal|SSH_AUTH_SOCK)$/i.test(word)) continue;
					// ssh reads a leading `$NAME` as the variable, without braces, in these options.
					const value = word.replace(
						/^\$([A-Za-z_][A-Za-z0-9_]*)$/,
						(_all, name: string) => context.env[name] ?? "",
					);
					for (const path of opened(expandPath(value, context), context))
						if (patternWrites(path, context)) return reason(file, line, match[1]!, path);
				}
			} else if (keyword === "controlpath") {
				const word = args[0];
				// Another session's socket put there would carry this connection to a host the user never allowed.
				if (
					word &&
					word.toLowerCase() !== "none" &&
					opened(expandPath(word, context), context).some((path) => patternWrites(path, context))
				) {
					options.length = 0;
					options.push("-S", "none");
				}
			}
		}
		return undefined;
	};
	const user = join(context.home, ".ssh", "config");
	for (const [file, base] of [
		[user, join(context.home, ".ssh")],
		[override?.system ?? SYSTEM_CONFIG, dirname(SYSTEM_CONFIG)],
	] as const) {
		seen.add(file);
		const refused = visit(file, base, 1);
		if (refused) return refused;
	}
	// The default keys and known hosts.
	if (writes(join(context.home, ".ssh")))
		return `ssh reads ${join(context.home, ".ssh")}, which commands in the sandbox can change`;
	const found = program.includes("/") ? program : findProgram(program, env.PATH ?? "");
	if (!found) return { program, options };
	if (writes(found)) return `ssh would run ${found}, which commands in the sandbox can change`;
	if (runsCommands) {
		// Those commands run through the user's shell, and a bare program name is found on PATH.
		const shell = env.SHELL || "/bin/sh";
		if (writes(shell))
			return `ssh runs its configured commands with ${shell}, which commands in the sandbox can change`;
		for (const dir of searchesPath ? (env.PATH ?? "").split(":").filter(Boolean) : []) {
			if (writes(dir)) {
				return `ssh runs configured commands found on PATH, and ${dir} on PATH is writable from the sandbox`;
			}
		}
	}
	return { program: realLocation(found), options };
}

/** The executable `name` on `path`, as a command would find it. */
export function findProgram(name: string, path: string): string | undefined {
	for (const dir of path.split(":").filter(Boolean)) {
		const candidate = join(dir, name);
		try {
			if (!statSync(candidate).isFile()) continue;
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {}
	}
	return undefined;
}
