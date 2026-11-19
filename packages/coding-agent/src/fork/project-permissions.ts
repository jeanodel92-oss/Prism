/**
 * fork: permissions given "for this project". They come back in every
 * session opened on the project, are kept in Prism's folder and never in the repository, and each can
 * be revoked from /settings. A project is the real path of its Git root, or of the folder outside Git: a
 * moved or renamed folder is not recognised (it asks again), and each Git worktree is a project of its own.
 */

import { spawnSync } from "node:child_process";
import { existsSync, type FSWatcher, mkdirSync, readFileSync, realpathSync, watch } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "../config.ts";
import { cacheFile, fileVersion } from "./file-cache.ts";
import { lockForkFile } from "./file-lock.ts";
import { hostProgram } from "./host-program.ts";
import { isRuleText } from "./permission-rule.ts";
import { writeFileAtomicSync } from "./secrets/atomic-write.ts";

/**
 * A host given to the commands of one rule for the project, and to no other: a host allowed for
 * `npm install` is not one `curl` may reach.
 */
export interface HostGrant {
	host: string;
	/** The command rule, as the permission gate writes it: `bash(npm install*)`. */
	rule: string;
}

/**
 * What one project was given: rules the permission gate allows, rules it blocks, and
 * hosts for the commands of a rule.
 */
export interface ProjectGrants {
	allow: string[];
	deny: string[];
	hosts: HostGrant[];
}

const FILE_NAME = "project-permissions.json";
const GRANTS_POLL_MS = 1000;
/** fork: the retry budget this file had before it took the shared lock, 100 tries 20 ms apart. */
const LOCK_RETRY = { attempts: 100, delayMs: 20 };
/**
 * The projects found, by the folder asked about, with what the answer depended on. fork
 * `git init` in a folder of a repository makes it a project of its own; the answer is found again when the
 * nearest `.git` above the folder, or the folder's real path, has changed.
 */
const roots = new Map<string, { root: string; real: string; marker: string | undefined }>();

/** The nearest folder at or above `dir` that holds a `.git`, where Git's discovery stops. */
function nearestGitMarker(dir: string): string | undefined {
	for (let current = dir; ; current = dirname(current)) {
		if (existsSync(join(current, ".git"))) return current;
		if (dirname(current) === current) return undefined;
	}
}

function realOrSame(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/** The project `cwd` belongs to: the real path of its Git root (a worktree's own), else of `cwd`. */
export function projectRoot(cwd: string): string {
	const real = realOrSame(cwd);
	const marker = nearestGitMarker(real);
	const known = roots.get(cwd);
	if (known && known.real === real && known.marker === marker) return known.root;
	// fork: Git from PATH, never from where the sandbox writes.
	const program = hostProgram("git");
	const git = program
		? spawnSync(program, ["-C", cwd, "rev-parse", "--show-toplevel"], {
				encoding: "utf8",
				timeout: 2_000,
				stdio: ["ignore", "pipe", "ignore"],
			})
		: undefined;
	const top = git?.status === 0 ? git.stdout.trim() : "";
	const root = realOrSame(top || cwd);
	// fork: Git that timed out or could not start said nothing about the folder;
	// its fallback is used this once and Git is asked again next time.
	if (git === undefined || (git.status !== null && git.error === undefined)) roots.set(cwd, { root, real, marker });
	return root;
}

const fileOf = (agentDir: string) => join(agentDir, FILE_NAME);

const strings = (value: unknown): string[] =>
	Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const hostGrants = (value: unknown): HostGrant[] =>
	Array.isArray(value)
		? value.filter(
				(item): item is HostGrant =>
					typeof item === "object" &&
					item !== null &&
					typeof (item as HostGrant).host === "string" &&
					typeof (item as HostGrant).rule === "string",
			)
		: [];

const readAllFile = cacheFile((file: string): Record<string, unknown> => {
	if (!existsSync(file)) return {};
	const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
	const projects = (parsed as { projects?: unknown })?.projects;
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not a JSON object");
	if (projects === undefined) return {};
	if (typeof projects !== "object" || projects === null || Array.isArray(projects)) {
		throw new Error('"projects" is not an object');
	}
	for (const [root, grants] of Object.entries(projects)) {
		const entry = grants as { allow?: unknown; deny?: unknown };
		for (const key of ["allow", "deny"] as const) {
			const list = entry?.[key];
			if (list !== undefined && (!Array.isArray(list) || !list.every((item) => typeof item === "string"))) {
				throw new Error(`"${key}" of ${root} is not a list of text rules`);
			}
			// fork: a rule the gate cannot read makes the file invalid, as in permissions.json.
			const unreadable = list?.find((rule: string) => !isRuleText(rule));
			if (unreadable !== undefined) throw new Error(`"${key}" of ${root} holds an invalid rule: ${unreadable}`);
		}
	}
	return projects as Record<string, unknown>;
});

const readAll = (agentDir: string) => readAllFile(fileOf(agentDir));

function grantsIn(projects: Record<string, unknown>, root: string): ProjectGrants {
	const grants = projects[root] as { allow?: unknown; deny?: unknown; hosts?: unknown } | undefined;
	return { allow: strings(grants?.allow), deny: strings(grants?.deny), hosts: hostGrants(grants?.hosts) };
}

/**
 * fork: the last valid content of each agent dir's file. A file that no longer
 * parses keeps its last valid rules; without one, `projectGrantsProblem` makes the gate refuse every call, instead
 * of dropping the rules refused for projects without a word.
 */
const lastValid = new Map<string, Record<string, unknown>>();

function readChecked(agentDir: string): { projects?: Record<string, unknown>; problem?: string } {
	try {
		const projects = readAll(agentDir);
		lastValid.set(agentDir, projects);
		return { projects };
	} catch (error) {
		return { problem: error instanceof Error ? error.message : String(error) };
	}
}

/** Why the rules given for projects cannot be known: the file does not parse and no valid version was read. */
export function projectGrantsProblem(agentDir = getAgentDir()): string | undefined {
	const { problem } = readChecked(agentDir);
	return problem && !lastValid.has(agentDir)
		? `${fileOf(agentDir)} is not a valid project permissions file (${problem})`
		: undefined;
}

/** What `cwd`'s project was given; the last valid version when the file no longer parses, else nothing. */
export function readProjectGrants(cwd: string, agentDir = getAgentDir()): ProjectGrants {
	const projects = readChecked(agentDir).projects ?? lastValid.get(agentDir);
	return projects ? grantsIn(projects, projectRoot(cwd)) : { allow: [], deny: [], hosts: [] };
}

/**
 * Changes one project's grants under a lock every Prism process takes, so two sessions changing the file at
 * once both keep their change. Written whole, then renamed: a reader never sees half a file. Throws when the
 * file cannot be read, locked or written, and nothing is changed then.
 */
async function update(cwd: string, agentDir: string, change: (grants: ProjectGrants) => ProjectGrants): Promise<void> {
	const file = fileOf(agentDir);
	mkdirSync(agentDir, { recursive: true });
	// fork: the shared lock of the fork's files (real path, refused once lost),
	// with this file's own retry budget.
	await lockForkFile(
		file,
		() => {
			// fork: under the lock, the last writer's version, never a cached one.
			const all = readAllFile.fresh(file);
			const root = projectRoot(cwd);
			const next = change(grantsIn(all, root));
			if (next.allow.length === 0 && next.deny.length === 0 && next.hosts.length === 0) delete all[root];
			else all[root] = next;
			writeFileAtomicSync(file, `${JSON.stringify({ projects: all }, null, 2)}\n`);
			lastValid.set(agentDir, all);
		},
		LOCK_RETRY,
	);
}

export async function addProjectRule(
	cwd: string,
	rule: string,
	effect: "allow" | "deny" = "allow",
	agentDir = getAgentDir(),
	hosts: readonly string[] = [],
): Promise<void> {
	await update(cwd, agentDir, (grants) => ({
		...grants,
		[effect]: [...new Set([...grants[effect], rule])],
		hosts:
			effect === "allow"
				? [
						...grants.hosts,
						...hosts
							.filter((host) => !grants.hosts.some((grant) => grant.host === host && grant.rule === rule))
							.map((host) => ({ host, rule })),
					]
				: grants.hosts,
	}));
}

export async function removeProjectRule(
	cwd: string,
	rule: string,
	effect: "allow" | "deny" = "allow",
	agentDir = getAgentDir(),
): Promise<void> {
	await update(cwd, agentDir, (grants) => ({
		...grants,
		[effect]: grants[effect].filter((item) => item !== rule),
		hosts: effect === "allow" ? grants.hosts.filter((grant) => grant.rule !== rule) : grants.hosts,
	}));
}

const sameGrant = (a: HostGrant, b: HostGrant) => a.host === b.host && a.rule === b.rule;

export async function addProjectHost(cwd: string, grant: HostGrant, agentDir = getAgentDir()): Promise<void> {
	await update(cwd, agentDir, (grants) => ({
		...grants,
		hosts: [...grants.hosts.filter((item) => !sameGrant(item, grant)), { host: grant.host, rule: grant.rule }],
	}));
}

export async function removeProjectHost(cwd: string, grant: HostGrant, agentDir = getAgentDir()): Promise<void> {
	await update(cwd, agentDir, (grants) => ({
		...grants,
		hosts: grants.hosts.filter((item) => !sameGrant(item, grant)),
	}));
}

/**
 * Calls `onChange` when any process changes the project grants (or the named settings file), so a host taken
 * back in another session closes its connections here too. Falls back to polling when the folder cannot be
 * watched. Returns the function that stops watching.
 */
export function watchProjectGrants(
	onChange: () => void,
	agentDir = getAgentDir(),
	watchFolder: typeof watch = watch,
	fileName = FILE_NAME,
): () => void {
	let watcher: FSWatcher | undefined;
	let timer: NodeJS.Timeout | undefined;
	// fork.9 (engine defect 5): taking a grant back is a guarantee, and other applications of the session can use up
	// the inotify instances that `watch` needs (EMFILE). The file is then read at intervals.
	// fork.10 (RT-001): by its whole stamp, not its mtime: a file replaced with the same mtime is a change too.
	// fork: with its content while the stamp is too recent to tell two versions
	// apart (RACY_MS), and at the next look after such a one.
	const poll = () => {
		const path = join(agentDir, fileName);
		const look = (withContent: boolean): { stamp: string; racy: boolean; content?: string } => {
			try {
				const { stamp, racy } = fileVersion(path);
				return { stamp, racy, content: racy || withContent ? readFileSync(path, "utf8") : undefined };
			} catch {
				return { stamp: "", racy: false };
			}
		};
		let seen = look(false);
		timer = setInterval(() => {
			const now = look(seen.racy);
			const same = now.stamp === seen.stamp && (!seen.racy || now.content === seen.content);
			seen = now;
			if (!same) onChange();
		}, GRANTS_POLL_MS);
		timer.unref();
	};
	try {
		mkdirSync(agentDir, { recursive: true });
		watcher = watchFolder(agentDir, { persistent: false }, (_event, name) => {
			if (name === fileName) onChange();
		});
		watcher.on("error", () => {
			watcher?.close();
			if (!timer) poll();
		});
	} catch {
		poll();
	}
	return () => {
		watcher?.close();
		clearInterval(timer);
	};
}
