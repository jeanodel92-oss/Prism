/**
 * fork: the Git repositories below the project and
 * the folders the user made writable. Before a command, the layout gives each one the treatment of the project's own
 * repository (a private copy of its Git folder, or the earlier protection). After it, every repository that was not
 * under that treatment for the whole command, made by it, by another program meanwhile or before an interruption, is
 * checked, and reported when its hooks or configuration would run something at a host `git` command. Prism changes
 * nothing in it (Q-G3).
 *
 * The walk keeps each folder's identity and change time. Creating, removing or renaming an entry changes its folder's
 * change time, which no process can set back, so a folder whose identity and change time are those of the last walk
 * is not read again. That holds only on filesystems that keep the change time this way: elsewhere (FUSE, network
 * filesystems, overlays) each folder is read again at every walk. A folder changed within the last second is read
 * again the next time: a change in the same clock tick as the read keeps its change time. Kept folders changed over a
 * second before the walk, so any later change moves their change time by more than a second: milliseconds suffice.
 */

import { createHash } from "node:crypto";
import {
	type Dirent,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	type Stats,
	statfsSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createdConfigReason } from "./git-validate.ts";
import { within } from "./path-within.ts";

export interface FoundRepositories {
	/** Folders that hold a `.git` (folder, file or link). */
	repositories: string[];
	/** Bare repositories: folders that hold `HEAD`, `objects` and `refs`. */
	bare: string[];
	/** Folders the walk could not read, where a repository would go unseen. */
	unreadable: string[];
	/** fork: entries named like a secret file (`isSecretName`), which safe mode hides. */
	secrets: string[];
}

interface Entry {
	dev: number;
	ino: number;
	ctime: number;
	repository: boolean;
	bare: boolean;
	folders: string[];
	secrets: string[];
}

/**
 * The names of the permission gate's default protected paths that hold secrets (`DEFAULT_PROTECTED_GLOBS` in
 * `permissions.ts`), without the Git and Prism configuration files, which commands must still read.
 */
const SECRET_NAMES = new Set([
	"id_rsa",
	"id_rsa.pub",
	"id_ed25519",
	"id_ed25519.pub",
	".netrc",
	"netrc",
	"authorized_keys",
	// fork: the names added to the gate's list, so safe mode hides them too.
	// Those protected only under a given folder (`.aws/credentials`, `.kube/config`, `config/database.yml`) are not
	// here: by their name alone they would hide ordinary files.
	".env~",
	".envrc",
	".dev.vars",
	"id_ecdsa",
	"id_ecdsa_sk",
	"id_ed25519_sk",
	"id_dsa",
	".npmrc",
	".pypirc",
	".git-credentials",
	".htpasswd",
	"credentials.json",
	"service-account.json",
	"secrets.json",
	"secrets.yaml",
	"secrets.yml",
	"kubeconfig",
	"wp-config.php",
	"local.settings.json",
]);
const SECRET_SUFFIXES = [
	".pem",
	".key",
	".p12",
	".pfx",
	".jks",
	".keystore",
	".tfstate",
	".tfstate.backup",
	".tfvars",
	".tfvars.json",
];
const isSecretName = (name: string) =>
	name === ".env" ||
	name.startsWith(".env.") ||
	SECRET_SUFFIXES.some((suffix) => name.endsWith(suffix)) ||
	SECRET_NAMES.has(name);

const RACY_MS = 1000;
const cache = new Map<string, Entry>();

// statfs magic numbers of the filesystems that update a folder's change time at each entry created, removed or
// renamed in it: ext2-4, btrfs, xfs, tmpfs, f2fs, bcachefs.
const CTIME_FILESYSTEMS = new Set([0xef53, 0x9123683e, 0x58465342, 0x01021994, 0xf2f52010, 0xca451a4e]);
const ctimeKept = new Map<number, boolean>();

function keepsChangeTime(folder: string, dev: number): boolean {
	let kept = ctimeKept.get(dev);
	if (kept === undefined) {
		try {
			kept = CTIME_FILESYSTEMS.has(statfsSync(folder).type);
		} catch {
			kept = false;
		}
		ctimeKept.set(dev, kept);
	}
	return kept;
}

/** The repositories below `roots`, the roots included. `.git` folders and bare repositories are not entered. */
export function findRepositories(roots: string[]): FoundRepositories {
	const found: FoundRepositories = { repositories: [], bare: [], unreadable: [], secrets: [] };
	const settled = Date.now() - RACY_MS;
	// A root inside another is walked with it; links are not followed, so no folder is reached twice.
	// Preserve the former prefix semantics: / matches itself, but its children require //.
	const pending = [...new Set(roots)].filter(
		(root, _, all) => !all.some((other) => other !== root && within(root, `${other}/`)),
	);
	for (let folder = pending.pop(); folder !== undefined; folder = pending.pop()) {
		let stats: Stats;
		try {
			stats = lstatSync(folder);
		} catch {
			continue;
		}
		if (!stats.isDirectory()) continue;
		let entry = cache.get(folder);
		if (entry?.dev !== stats.dev || entry.ino !== stats.ino || entry.ctime !== stats.ctimeMs) {
			let names: Dirent[];
			try {
				names = readdirSync(folder, { withFileTypes: true });
			} catch {
				cache.delete(folder);
				found.unreadable.push(folder);
				continue;
			}
			const has = (name: string) => names.some((item) => item.name === name);
			const bare = has("HEAD") && has("objects") && has("refs");
			entry = {
				dev: stats.dev,
				ino: stats.ino,
				ctime: stats.ctimeMs,
				repository: has(".git"),
				bare,
				folders: bare
					? []
					: names.filter((item) => item.isDirectory() && item.name !== ".git").map(({ name }) => name),
				secrets: bare
					? []
					: names.filter((item) => !item.isDirectory() && isSecretName(item.name)).map(({ name }) => name),
			};
			if (stats.ctimeMs <= settled && keepsChangeTime(folder, stats.dev)) cache.set(folder, entry);
			else cache.delete(folder);
		}
		if (entry.repository) found.repositories.push(folder);
		if (entry.bare) found.bare.push(folder);
		for (const name of entry.secrets) found.secrets.push(`${folder}/${name}`);
		for (const name of entry.folders) pending.push(`${folder}/${name}`);
	}
	return found;
}

/**
 * Which Git folder a repository is: its `.git` entry (or the bare repository's folder), by identity, with the text of
 * a `.git` file. A command that swaps it for another changes this.
 */
export function repositoryIdentity(folder: string, bare: boolean): string | undefined {
	const path = bare ? folder : join(folder, ".git");
	try {
		const stats = lstatSync(path);
		const identity = `${stats.dev}:${stats.ino}`;
		return stats.isFile() ? `${identity}:${readFileSync(path, "utf8")}` : identity;
	} catch {
		return undefined;
	}
}

/** What a layout searched and gave its treatment to, compared after the command. */
export interface RepositorySearch {
	roots: string[];
	/** The repositories under the layout's treatment, by folder: their identity (`repositoryIdentity`). */
	known: Record<string, string>;
	/** Git folders the layout covers otherwise (the project's, its submodules'): a `.git` file naming one is theirs. */
	gitDirs: string[];
	unreadable: string[];
	/** Where the repositories checked last are kept, for those an interrupted command made. */
	state: string;
	/** The folders commands may write: a local remote must lead into one. */
	writable: string[];
}

/** The repositories of a walk, by folder, with their identity. */
export function identities(found: FoundRepositories): Record<string, string> {
	const known: Record<string, string> = {};
	for (const [folders, bare] of [
		[found.repositories, false],
		[found.bare, true],
	] as const) {
		for (const folder of folders) {
			const identity = repositoryIdentity(folder, bare);
			if (identity !== undefined) known[folder] = identity;
		}
	}
	return known;
}

function realGitDir(path: string): string | undefined {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
}

function gitDirReasons(gitdir: string, writable: string[], depth: number): string[] {
	const reasons: string[] = [];
	for (const name of ["config", "config.worktree"]) {
		const file = join(gitdir, name);
		const entry = lstatSync(file, { throwIfNoEntry: false });
		if (!entry) continue;
		if (!entry.isFile()) {
			reasons.push(`${file} is not a file`);
			continue;
		}
		const reason = createdConfigReason(readFileSync(file), writable, gitdir);
		if (reason) reasons.push(`${file}: ${reason}`);
	}
	const hooks = join(gitdir, "hooks");
	const entry = lstatSync(hooks, { throwIfNoEntry: false });
	if (entry?.isDirectory()) {
		for (const name of readdirSync(hooks)) if (!name.endsWith(".sample")) reasons.push(`hook ${join(hooks, name)}`);
	} else if (entry) reasons.push(`${hooks} is not a folder`);
	const modules = join(gitdir, "modules");
	if (lstatSync(modules, { throwIfNoEntry: false })?.isDirectory()) {
		for (const name of readdirSync(modules)) {
			const module = join(modules, name);
			if (!lstatSync(join(module, "HEAD"), { throwIfNoEntry: false })) continue;
			if (depth >= 4) reasons.push(`${module}: submodules nested too deep to check`);
			else reasons.push(...gitDirReasons(module, writable, depth + 1));
		}
	}
	return reasons;
}

/** What in this repository would run at a host `git` command, or needs a check by the user; empty when nothing. */
export function repositoryReasons(
	folder: string,
	bare: boolean,
	search: Pick<RepositorySearch, "gitDirs" | "roots" | "writable">,
) {
	try {
		if (bare) return gitDirReasons(folder, search.writable, 0);
		const dotGit = join(folder, ".git");
		const entry = lstatSync(dotGit, { throwIfNoEntry: false });
		if (!entry) return [];
		if (entry.isDirectory()) return gitDirReasons(dotGit, search.writable, 0);
		if (!entry.isFile()) return [`${dotGit} is a link`];
		const pointer = /^gitdir: (.+)\r?\n?$/.exec(readFileSync(dotGit, "utf8"));
		if (!pointer) return [`${dotGit} is not a Git pointer`];
		const gitdir = resolve(folder, pointer[1]!);
		// A linked worktree or a submodule of a repository the layout covered: its Git folder was checked there.
		if (search.gitDirs.some((root) => gitdir === root || within(gitdir, `${root}/`))) return [];
		// fork: a Git folder outside the project and the writable folders is
		// not read, by its real path, so the report tells nothing of what the sandbox does not show.
		const real = realGitDir(gitdir);
		if (
			!real ||
			!search.roots.some((root) => {
				const folder = realGitDir(root) ?? root;
				return real === folder || within(real, `${folder}/`);
			})
		)
			return [`${dotGit} points outside the project and the writable folders; Prism did not look there`];
		// A submodule of an enclosing repository, as `git submodule update --init` makes it in a fresh clone: its Git
		// folder is in that repository's `modules`, and checked here as it would be there.
		const enclosing = dirname(dotGit)
			.split("/")
			.map((_, n, parts) => parts.slice(0, n).join("/"))
			.filter(
				(ancestor) =>
					ancestor &&
					(gitdir === join(ancestor, ".git", "modules") ||
						within(gitdir, `${join(ancestor, ".git", "modules")}/`)),
			);
		if (enclosing.length > 0) return gitDirReasons(gitdir, search.writable, 0);
		return [`${dotGit} points to ${gitdir}`, ...gitDirReasons(gitdir, search.writable, 0)];
	} catch (error) {
		return [`${folder} could not be checked (${(error as NodeJS.ErrnoException).code ?? String(error)})`];
	}
}

/**
 * fork: the repositories below the search's roots whose hooks or configuration
 * run programs now, whichever command made them. The publication refuses an index or a commit that adds one as a
 * submodule: a repository reported after an earlier command is no longer among that command's new repositories.
 */
export function riskyRepositories(search: RepositorySearch): string[] {
	return findRepositories(search.roots).repositories.filter(
		(folder) => repositoryReasons(folder, false, search).length > 0,
	);
}

/** Where a project's last check is kept, in Prism's own folder. */
export function repositoryStatePath(agentDir: string, cwd: string): string {
	const key = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	return join(agentDir, "sandbox", "repositories", `${key}.json`);
}

function readState(path: string): Record<string, string> | undefined {
	try {
		const known: unknown = JSON.parse(readFileSync(path, "utf8")).known;
		if (typeof known !== "object" || known === null) return undefined;
		return Object.fromEntries(Object.entries(known).filter(([, identity]) => typeof identity === "string"));
	} catch {
		return undefined;
	}
}

function writeState(path: string, known: Record<string, string>): void {
	try {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const next = `${path}.${process.pid}`;
		writeFileSync(next, JSON.stringify({ known }), { mode: 0o600 });
		renameSync(next, path);
	} catch {}
}

/**
 * fork: the repositories the checks below reported in this process, by folder,
 * with what in them would run; `unseen` those the user has not been warned about yet. The report went into the
 * command's output, which the model reads and the user only if they open it, while the user's shell prompt, editor or
 * `git status` runs what the report names.
 */
const reported = new Map<string, string>();
let unseen: string[] = [];

/** The repositories reported since the last call, for a warning the user sees. */
export function takeUnseenRepositories(): string[] {
	const taken = unseen;
	unseen = [];
	return taken;
}

/** /sandbox: the repositories reported in this process, with what in them would run. */
export function reportedRepositories(): Array<{ folder: string; reasons: string }> {
	return [...reported].map(([folder, reasons]) => ({ folder, reasons }));
}

/** Tests only. */
export function resetReportedRepositories(): void {
	reported.clear();
	unseen = [];
}

/**
 * The repositories that were not under the layout's treatment for the whole command, with what in them would run,
 * and the folders that became unreadable; undefined when none needs the user. A repository is skipped only when the
 * layout covered it with the identity it has now, and the last check (any session's) saw it so too. `folders` are
 * the repositories whose hooks or configuration would run a program (AS-018).
 */
export function checkNewRepositories(before: RepositorySearch): { note: string; folders: string[] } | undefined {
	const found = findRepositories(before.roots);
	const now = identities(found);
	const checked = readState(before.state);
	const bare = new Set(found.bare);
	const lines: string[] = [];
	const folders: string[] = [];
	for (const [folder, identity] of Object.entries(now)) {
		if (before.known[folder] === identity && (checked === undefined || checked[folder] === identity)) continue;
		const reasons = repositoryReasons(folder, bare.has(folder), before);
		if (reasons.length === 0) continue;
		const shown = reasons.slice(0, 8).join("; ");
		lines.push(`- ${folder}: ${shown}`);
		folders.push(folder);
		reported.set(folder, shown);
		if (!unseen.includes(folder)) unseen.push(folder);
	}
	writeState(before.state, now);
	const unreadable = found.unreadable.filter((folder) => !before.unreadable.includes(folder));
	for (const folder of unreadable) lines.push(`- ${folder}: unreadable, a repository in it would go unchecked`);
	if (lines.length === 0) return undefined;
	return {
		note: [
			"Prism: these Git repositories appeared or changed outside Prism's protection (made by this command, by another program meanwhile, or before an interruption), and their hooks or configuration would run programs at a Git command outside Prism:",
			...lines,
			"The sandbox protects them from the next command on, but not what is already written. Check these files before running Git there outside Prism; Prism did not change them. The user is warned too.",
		].join("\n"),
		folders,
	};
}
