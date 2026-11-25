/**
 * fork: runs shell commands in the sandbox. The permission gate decides, per session,
 * whether the sandbox is active (its mode and the settings) and publishes it here; the bash tool and
 * the background tool read it when they start a command. A sandbox that does not work stops Prism
 * instead of letting commands run without it.
 */

import { spawnSync } from "node:child_process";
import {
	accessSync,
	chmodSync,
	constants,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { getAgentDir, getPackageDir } from "../../config.ts";
import { type BashOperations, createLocalBashOperations, createLocalShellOperations } from "../../core/tools/bash.ts";
import { getShellConfig, getShellEnv, type ShellConfig } from "../../utils/shell.ts";
import { withDesktopEnv } from "../desktop/env.ts";
import { addSandboxWritable, hostProgram } from "../host-program.ts";
import { realPath } from "../real-path.ts";
import { keyFiles } from "../secrets/key-files.ts";
import { cacheLayers, overlaysWork } from "./cache-layers.ts";
import { commandTmpDir, writableDirectory } from "./command-tmpdir.ts";
import {
	type FinishOptions,
	finishGitCopy,
	type GitCopy,
	gitCopyArgs,
	gitCopyRefusal,
	hooksLayer,
	prepareGitCopies,
	removeOldGitCopies,
} from "./git-copy.ts";
import { type CopyOrigin, keptGitCopiesWarning, reportGitCopies, writeHolder } from "./git-orphans.ts";
import { recoverGitPublications } from "./git-publish.ts";
import {
	buildLayout,
	bwrapArgs,
	DEFAULT_WRITABLE_HOME_PATHS,
	isExcludedCommand,
	prepareLayout,
	readSandboxSettings,
	type SandboxLayout,
	type SandboxSettings,
} from "./layout.ts";
import { checkNewRepositories, type RepositorySearch, riskyRepositories } from "./nested-git.ts";
// Preserve the former prefix semantics: / matches itself, but its children require //.
import { within } from "./path-within.ts";
import { type HostPolicy, type NetworkChannel, type NetworkCommand, openNetworkChannel } from "./proxy.ts";
import { TOOL_RESOURCES } from "./read-limit.ts";
import { relaySnapshot } from "./relay-snapshot.ts";
import { seccompArch, seccompFilter } from "./seccomp.ts";
import { closeSessionNet, prepareSessionNet, sessionNetPrefix, sessionNetReport } from "./session-net.ts";
import { closeSessionPorts } from "./session-ports.ts";
import { sshConfigCopies } from "./ssh-config.ts";
import { sandboxWrites } from "./ssh-provenance.ts";
import { createToolCaches } from "./tool-caches.ts";
import { rebuiltSettingsCopies } from "./tool-settings.ts";

export interface SandboxRuntime {
	bwrap: string;
	settings: SandboxSettings;
	agentDir: string;
	/** The seccomp filter's file, read by bubblewrap on fd 3. */
	seccomp: string;
	/** Which hosts the commands may reach through the proxy. */
	policy: HostPolicy;
	/** The session's private /tmp (`sessionTmpDir`). */
	tmp: string;
	/** fork: paths the user let the agent read in this session or project, read before each command. */
	readable?: () => string[];
	/** fork: what the start found of Git work a Prism or a task that ended left, for the user. */
	gitReport?: string;
	/** fork (SEC-07): why the session's commands do not share `localhost`, for the user. */
	netReport?: string;
	/** fork: the relay's Node startup snapshot, when this Node gains from one (`relay-snapshot.ts`). */
	relaySnapshot?: string;
	/** fork (SEC-08): asks the user about a command's change to `core.hooksPath`; without it, the change is refused. */
	askHooks?: FinishOptions["askHooks"];
	/** fork: asks the user about a command's changes to remotes and identity. */
	askGitConfig?: FinishOptions["askGitConfig"];
	/** fork: safe mode; the project is mounted read-only (`LayoutInput`). */
	readOnlyProject?: boolean;
	/** files hidden from this session's commands only, read before each command. */
	sessionHidden?: () => string[];
}

/** A sandbox that should run but does not: commands fail with this reason instead of running outside it. */
export interface BrokenSandbox {
	error: string;
	gitReport?: string;
}

export type SessionSandbox = SandboxRuntime | BrokenSandbox;

/** Keyed by the session manager, which the gate's context and the session's tools share. */
const runtimes = new WeakMap<object, SessionSandbox>();

const commandLayouts = new WeakMap<SandboxRuntime, Map<string, SandboxLayout>>();

/** The layout this call actually mounted; consumed once by its result note. */
export function takeSandboxLayout(runtime: SandboxRuntime, toolCallId: string): SandboxLayout | undefined {
	const layouts = commandLayouts.get(runtime);
	const layout = layouts?.get(toolCallId);
	layouts?.delete(toolCallId);
	return layout;
}

export function setSessionSandbox(session: object, sandbox: SessionSandbox | undefined): void {
	if (sandbox) runtimes.set(session, sandbox);
	else runtimes.delete(session);
	// the files that received a key in this session (secrets/key-files.ts).
	if (sandbox && !("error" in sandbox)) sandbox.sessionHidden = () => keyFiles(session);
}

export function sessionSandbox(session: object): SessionSandbox | undefined {
	return runtimes.get(session);
}

/** What the model is told about a command a broken sandbox refused. */
export function brokenSandboxReason(sandbox: BrokenSandbox): string {
	return `The sandbox does not work, so the command was not run: ${sandbox.error.replace(/\.?$/, ".")} Every shell command stays blocked until the user fixes it; do not retry or try to work around it. Tell the user, who can check it again in /sandbox once fixed.`;
}

/** fork: each session's private /tmp, by session id. */
const sessionTmps = new Map<string, string>();
let exitHooked = false;

/**
 * a custom agent works in the /tmp of the session that started it, which
 * names it in this variable (agents.ts): files one writes there, the other finds. The folder stays the session's: the
 * agent never removes it.
 */
export const SHARED_TMP_ENV = "PRISM_SHARED_TMP";
const borrowedTmps = new Set<string>();

/** The parent's /tmp named in SHARED_TMP_ENV, when it is one of Prism's private folders of this user (mode 0700). */
function sharedTmpDir(): string | undefined {
	const dir = process.env[SHARED_TMP_ENV];
	if (!dir || dirname(dir) !== tmpdir() || !/^prism-tmp-\d+-[^.]+$/.test(basename(dir))) return undefined;
	try {
		const stat = lstatSync(dir, { throwIfNoEntry: false });
		if (!stat?.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) return undefined;
	} catch {
		return undefined;
	}
	return dir;
}

function removeSessionTmps(): void {
	for (const dir of sessionTmps.values()) if (!borrowedTmps.has(dir)) removeTmpUnlessHeld(dir);
	sessionTmps.clear();
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: the process exists under another user.
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

// A background task can outlive its session and Prism itself; while it runs, a marker file next to the folder
// (`<folder>.task-<pid>`, out of the sandbox's sight) keeps its /tmp in place.
const MARKER = /^(prism-tmp-\d+-[^.]+)\.task-(\d+)$/;

/** Removes a private /tmp no running background task uses; the markers of ended tasks go with it. */
function removeTmpUnlessHeld(dir: string): void {
	let names: string[];
	try {
		names = readdirSync(dirname(dir));
	} catch {
		return;
	}
	const markers = names.filter((name) => MARKER.exec(name)?.[1] === basename(dir));
	if (markers.some((name) => isAlive(Number(MARKER.exec(name)?.[2])))) return;
	rmSync(dir, { recursive: true, force: true });
	for (const name of markers) rmSync(join(dirname(dir), name), { force: true });
}

/** Removes the folders left by Prism processes that ended without removing theirs (killed, crashed). */
function removeOrphanTmps(): void {
	let names: string[];
	try {
		names = readdirSync(tmpdir());
	} catch {
		return;
	}
	for (const name of names) {
		if (MARKER.test(name)) continue;
		const pid = Number(/^prism-tmp-(\d+)-/.exec(name)?.[1]);
		if (!pid || pid === process.pid || isAlive(pid)) continue;
		const dir = join(tmpdir(), name);
		try {
			const stat = lstatSync(dir, { throwIfNoEntry: false });
			if (stat?.isDirectory() && stat.uid === process.getuid?.()) removeTmpUnlessHeld(dir);
		} catch (error) {
			if (!["EACCES", "EPERM", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
		}
	}
}

/**
 * The folder bound at /tmp for a session's sandboxed commands: shared by them, by no other session (mode 0700).
 * It outlives mode changes and reloads; it is removed when the session ends or Prism exits, or later, when the
 * last background task using it ends.
 */
export function sessionTmpDir(sessionId: string): string {
	const known = sessionTmps.get(sessionId);
	if (known && existsSync(known)) return known;
	if (!exitHooked) {
		// One listener for the whole process: a /new empties the map, and a listener per refill would pile up.
		exitHooked = true;
		process.once("exit", removeSessionTmps);
		// SIGINT (ctrl+c in print mode) ends Prism without an "exit" event, so nothing would clean up. Clean up,
		// then send the signal again: the handlers that remain end the process as they would have.
		process.once("SIGINT", () => {
			removeSessionTmps();
			process.kill(process.pid, "SIGINT");
		});
	}
	if (sessionTmps.size === 0) removeOrphanTmps();
	const shared = sharedTmpDir();
	if (shared) {
		borrowedTmps.add(shared);
		sessionTmps.set(sessionId, shared);
		return shared;
	}
	const dir = mkdtempSync(join(tmpdir(), `prism-tmp-${process.pid}-`));
	sessionTmps.set(sessionId, dir);
	return dir;
}

/** The session's private /tmp, if it has made one; unlike sessionTmpDir, makes none. */
export const existingSessionTmpDir = (sessionId: string): string | undefined => sessionTmps.get(sessionId);

/** Removes a session's private /tmp, when the session ends. */
export function removeSessionTmpDir(sessionId: string): void {
	const dir = sessionTmps.get(sessionId);
	if (!dir) return;
	sessionTmps.delete(sessionId);
	if (!borrowedTmps.has(dir)) removeTmpUnlessHeld(dir);
	// fork (SEC-07): its background tasks still running keep the session's network.
	closeSessionNet(dir);
	// the browser's relays of the session's ports end with it.
	closeSessionPorts(dir);
}

/**
 * Keeps `dir` while the background task `pid` runs.
 * Call the result when the task ends: the folder goes if its session has ended and no other task uses it.
 */
export function holdSessionTmp(dir: string, pid: number): () => void {
	const marker = `${dir}.task-${pid}`;
	try {
		// Exclusive creation: in the shared /tmp, never write through a file or link someone else put there.
		writeFileSync(marker, "", { flag: "wx", mode: 0o600 });
	} catch {}
	return () => {
		rmSync(marker, { force: true });
		if (![...sessionTmps.values()].includes(dir) && !borrowedTmps.has(dir)) removeTmpUnlessHeld(dir);
	};
}

/** The runtime, undefined without a sandbox; throws when the sandbox is broken. */
export function requireSandbox(sandbox: SessionSandbox | undefined): SandboxRuntime | undefined {
	if (sandbox && "error" in sandbox) throw new Error(brokenSandboxReason(sandbox));
	return sandbox;
}

/** bubblewrap on PATH, outside what the sandbox can write, or undefined. */
export function findBwrap(path = process.env.PATH ?? ""): string | undefined {
	return hostProgram("bwrap", path);
}

const isDirectory = (path: string) => {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
};

/** An empty file nobody can read, bound over each hidden file; it lives in the hidden agent dir. */
function unreadableFile(agentDir: string): string {
	const file = join(agentDir, "sandbox", "unreadable");
	if (!existsSync(file)) {
		mkdirSync(join(agentDir, "sandbox"), { recursive: true, mode: 0o700 });
		writeFileSync(file, "", { mode: 0o000 });
	}
	chmodSync(file, 0o000);
	return file;
}

/** Writes the seccomp filter for this machine; undefined on an architecture it does not know. */
function writeSeccompFilter(agentDir: string): string | undefined {
	const arch = seccompArch();
	if (!arch) return undefined;
	mkdirSync(join(agentDir, "sandbox"), { recursive: true, mode: 0o700 });
	const file = join(agentDir, "sandbox", `seccomp-${arch}.bpf`);
	writeFileSync(file, seccompFilter(arch), { mode: 0o600 });
	return file;
}

/** The relay that gives the command its network (relay.ts), from the sources or the built package. */
function relayPath(): string {
	const packageDir = getPackageDir();
	return existsSync(join(packageDir, "src"))
		? join(packageDir, "src", "fork", "sandbox", "relay.ts")
		: join(packageDir, "dist", "fork", "sandbox", "relay.js");
}

/** The pipes of one command's network, whose answers last until it ends; close it when it does. */
export function openSandboxNetwork(runtime: SandboxRuntime, command: NetworkCommand): NetworkChannel {
	return openNetworkChannel(join(runtime.agentDir, "sandbox", "run"), runtime.policy.open(command));
}

/**
 * The command line that runs `argv` in the sandbox for `cwd`, behind the network relay. A `sh` opens the
 * filter on fd 3 and the channel's pipes on fds 4 and 5, then replaces itself with bubblewrap, so
 * bubblewrap's parent stays the caller (`--die-with-parent`).
 */
/** The settings a command's layout uses: with reading limited, what the user allowed when asked opens too. */
function layoutSettings(runtime: SandboxRuntime): SandboxSettings {
	const granted = runtime.readable?.() ?? [];
	const hidden = runtime.sessionHidden?.() ?? [];
	if (granted.length === 0 && hidden.length === 0) return runtime.settings;
	const { read, hide } = runtime.settings;
	return { ...runtime.settings, read: { ...read, allow: [...read.allow, ...granted] }, hide: [...hide, ...hidden] };
}

export function sandboxArgv(
	runtime: SandboxRuntime,
	cwd: string,
	channel: NetworkChannel,
	argv: string[],
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	return sandboxCommand(runtime, cwd, channel, argv, env).argv;
}

/**
 * fork: `sandboxArgv` for a background task `command`, whose repositories work in private copies of their
 * Git metadata as the bash tool's do. `started` records the task's process with its copies; `finish` publishes them
 * once the task has ended and returns the notes for its log. A task that outlives Prism leaves its copies
 * unpublished, reported at a later start (sandbox.md § 10.2, `git-orphans.ts`).
 */
export function sandboxTask(
	runtime: SandboxRuntime,
	cwd: string,
	channel: NetworkChannel,
	argv: string[],
	command: string,
	env: NodeJS.ProcessEnv,
): { argv: string[]; started: (pid: number) => void; finish: () => Promise<string[]> } {
	const copies: GitCopy[] = [];
	const sandboxed = sandboxCommand(runtime, cwd, channel, argv, env, { copies, origin: { cwd, command, task: true } });
	return {
		argv: sandboxed.argv,
		started: (pid) => {
			for (const copy of copies) writeHolder(copy.folder, pid);
		},
		finish: () => {
			sandboxed.release();
			const repositories = sandboxed.layout.repositories;
			return finishCopies(
				runtime,
				copies,
				sandboxed.writable,
				[],
				repositories && (() => riskyRepositories(repositories)),
			);
		},
	};
}

/**
 * `sandboxArgv`, with the folders the command may write; with `git`, each repository it finds works in a private
 * copy of its Git metadata, recorded with the command's origin and pushed to `git.copies`,
 * which the caller finishes after the command. `release` removes the command's cache layers once it has ended
 *; those not released go when Prism exits.
 */
function sandboxCommand(
	runtime: SandboxRuntime,
	cwd: string,
	channel: NetworkChannel,
	argv: string[],
	env: NodeJS.ProcessEnv,
	gitIn?: { copies: GitCopy[]; origin: CopyOrigin },
): { argv: string[]; writable: string[]; layout: SandboxLayout; release: () => void } {
	// fork: a read-only project gets no private Git copy to publish.
	const git = runtime.readOnlyProject ? undefined : gitIn;
	const copies = git?.copies;
	// By their real paths: a package or a node under /tmp is only visible through the read-only binds below.
	const relay = realPath(relayPath());
	const node = realPath(process.execPath);
	// fork: an absent cache could not be made by the command, which then failed.
	createToolCaches(layoutSettings(runtime), cwd);
	const tmp = runtime.tmp;
	const layout = buildLayout({
		cwd,
		agentDir: runtime.agentDir,
		tmp,
		runFrom: [dirname(relay), dirname(node)],
		prism: [dirname(relay), dirname(node)],
		settings: layoutSettings(runtime),
		readOnlyProject: runtime.readOnlyProject,
		// A repository the copy does not cover keeps the protection the layout gives it. A blocked layout's copies are
		// unchanged, and removed after the command like any other.
		// fork (SEC-08): the startup check, which has no `git`, judges the layout the commands get, with their copies
		// (a relative `core.hooksPath` such as Husky's needs no refusal then), but makes none.
		copyGitDir: !git
			? (gitDir) => gitCopyRefusal(gitDir) === undefined
			: tmp
				? (gitDir) => {
						const made = prepareGitCopies(gitDir, {
							folder: join(runtime.agentDir, "sandbox", "git-copies"),
							tmp,
							origin: git.origin,
						});
						if ("reason" in made) return false;
						git.copies.push(...made);
						return true;
					}
				: undefined,
	});
	// The real Git folders the check's copies would cover stay read-only to it.
	if (!git) {
		const covered = (layout.privateGit ?? []).map(({ gitDir }) => gitDir);
		layout.writable = layout.writable.filter(
			(path) => !covered.some((gitDir) => path === gitDir || within(path, `${gitDir}/`)),
		);
		layout.readOnly.push(...covered);
	}
	if (copies && copies.length > 0) {
		for (const [index, layer] of (layout.hookLayers ?? []).entries()) {
			const copy = copies.find(({ gitDir }) => gitDir === layer.gitDir);
			if (copy) layer.source = hooksLayer(copy, layer.path, index);
		}
		const copied = (path: string) => copies.some(({ gitDir }) => path === gitDir || within(path, `${gitDir}/`));
		layout.writable = layout.writable.filter((path) => !copied(path));
		layout.readOnly = layout.readOnly.filter((path) => !copied(path));
		layout.missing = layout.missing?.filter(({ path }) => !copied(path));
		layout.gitCopies = copies.map(gitCopyArgs);
	}
	prepareLayout(layout);
	// fork: a settings file with a rebuilt copy is shown through it, no longer hidden.
	const settings = rebuiltSettingsCopies(join(runtime.agentDir, "sandbox"), layout.home?.settings ?? []);
	layout.hidden = layout.hidden.filter((path) => !settings.some(([, original]) => original === path));
	layout.copies = [...sshConfigCopies(join(runtime.agentDir, "sandbox")), ...settings];
	// fork (SEC-07): `host.prism.internal` names this command's own address of the relay (`relay.ts`).
	if (channel.hosts && existsSync("/etc/hosts")) layout.copies.push([channel.hosts, realPath("/etc/hosts")]);
	channel.network.sandboxWrites = sandboxWrites(layout);
	// fork: the package caches through layers of this command's own, never the real caches.
	const layersRoot = join(runtime.agentDir, "sandbox", "layers");
	const caches = layout.caches ?? [];
	const layers = cacheLayers(caches, {
		overlays: caches.length > 0 && overlaysWork(runtime.bwrap, caches, layersRoot),
		root: layersRoot,
		fallback: join(runtime.agentDir, "sandbox", "tool-caches"),
		project: cwd,
	});
	layout.cacheLayers = layers.layers;
	// fork: before the command runs, so nothing it writes is ever run on the host.
	addSandboxWritable([
		...layout.writable,
		...(layout.tmp ? [layout.tmp] : []),
		...(layout.home ? [layout.home.cache] : []),
		...layers.folders,
	]);
	const current = readSandboxSettings(runtime.agentDir);
	channel.network.gitSigning = current.gitSigning;
	channel.network.containers = current.containers;
	channel.network.serviceState = current.serviceState;
	// fork: the relay's snapshot on fd 6, which the relay closes before it runs the command.
	const snapshot = runtime.relaySnapshot && existsSync(runtime.relaySnapshot) ? runtime.relaySnapshot : undefined;
	const tmpdir = commandTmpDir(env.TMPDIR, layout, writableDirectory);
	// fork (SEC-07): in the session's network namespace when it has one, so its commands share `localhost`.
	const sessionNet = sessionNetPrefix(tmp);
	const command = [
		"/bin/sh",
		"-c",
		snapshot
			? 'filter=$1; in=$2; out=$3; blob=$4; shift 4; exec "$@" 3<"$filter" 4<"$in" 5>"$out" 6<"$blob"'
			: 'filter=$1; in=$2; out=$3; shift 3; exec "$@" 3<"$filter" 4<"$in" 5>"$out"',
		"sh",
		runtime.seccomp,
		channel.toRelay,
		channel.fromRelay,
		...(snapshot ? [snapshot] : []),
		...sessionNet,
		runtime.bwrap,
		...bwrapArgs(layout, isDirectory, unreadableFile(runtime.agentDir)),
		...(sessionNet.length ? ["--share-net"] : []),
		...(tmpdir !== env.TMPDIR && tmpdir !== undefined ? ["--setenv", "TMPDIR", tmpdir] : []),
		// fork: Podman's client needs a runtime folder; the user's is hidden, so a private one.
		...(current.containers && layout.tmp ? CONTAINERS_RUNTIME_ARGS : []),
		...gitMaintenanceArgs(),
		"--seccomp",
		"3",
		"--",
		node,
		...(snapshot ? ["--snapshot-blob", "/proc/self/fd/6"] : []),
		relay,
		channel.alias,
		channel.localPorts.join(",") || "-",
		...argv,
	];
	return { argv: command, writable: layout.writable, layout, release: layers.release };
}

/** Publishes what a command changed in its copies, in order; the notes for its output. */
async function finishCopies(
	runtime: SandboxRuntime,
	copies: GitCopy[],
	writable: string[],
	newRepositories: string[] = [],
	risky?: () => string[],
): Promise<string[]> {
	const notes: string[] = [];
	for (const copy of copies) {
		const note = await finishCopy(runtime, copy, writable, newRepositories, risky);
		if (note) notes.push(note);
	}
	if (copies.length > 0) {
		const warning = keptGitCopiesWarning(
			join(runtime.agentDir, "sandbox", "git-copies"),
			runtime.policy,
			runtime.tmp,
		);
		if (warning) notes.push(warning);
	}
	return notes;
}

/** Publishes what a command changed in its copy of a repository's Git metadata; a note for its output, if any. */
async function finishCopy(
	runtime: SandboxRuntime,
	copy: GitCopy,
	writable: string[],
	newRepositories: string[],
	risky: (() => string[]) | undefined,
): Promise<string | undefined> {
	try {
		return await finishGitCopy(copy, {
			sandbox: { bwrap: runtime.bwrap, seccomp: runtime.seccomp },
			journalDir: join(runtime.agentDir, "sandbox", "git-journal"),
			writable,
			newRepositories,
			riskyRepositories: risky,
			askHooks: runtime.askHooks,
			askGitConfig: runtime.askGitConfig,
		});
	} catch (error) {
		return `Prism: this command's Git changes to ${copy.gitDir} could not be checked (${error instanceof Error ? error.message : String(error)}); they are kept in ${copy.metadata}.`;
	}
}

/**
 * fork: Git's automatic maintenance is off in the sandbox, through the environment only,
 * as `git -c` would: a detached `git maintenance run --auto` after a commit or a fetch would leave its locks behind.
 * Entries the user's environment already gives come first; an explicit `git gc` or `git maintenance run` still runs.
 */
export function gitMaintenanceArgs(env: NodeJS.ProcessEnv = process.env): string[] {
	const count = /^\d+$/.test(env.GIT_CONFIG_COUNT ?? "") ? Number(env.GIT_CONFIG_COUNT) : 0;
	return [
		["maintenance.auto", "false"],
		["gc.auto", "0"],
	]
		.flatMap(([key, value], n) => [
			"--setenv",
			`GIT_CONFIG_KEY_${count + n}`,
			key!,
			"--setenv",
			`GIT_CONFIG_VALUE_${count + n}`,
			value!,
		])
		.concat("--setenv", "GIT_CONFIG_COUNT", String(count + 2));
}

/** The private /tmp's folder that `XDG_RUNTIME_DIR` names while commands see the user's containers. */
const CONTAINERS_RUNTIME_ARGS = [
	"--perms",
	"0700",
	"--dir",
	"/tmp/prism-runtime",
	"--setenv",
	"XDG_RUNTIME_DIR",
	"/tmp/prism-runtime",
];

/**
 * The bash tool's operations: in the sandbox when the session has one, the local shell otherwise.
 * The sandbox is looked up for each command, so a mode change applies to the next one.
 */
export function createSandboxableBashOperations(
	getSandbox: () => SessionSandbox | undefined,
	shellPath?: string,
	commandPrefix?: string,
): BashOperations {
	const local = createLocalBashOperations({ shellPath });
	return {
		exec: async (command, cwd, options) => {
			const runtime = requireSandbox(getSandbox());
			// The model's command, without the prefix the tool puts before it (the user's shellCommandPrefix).
			const own =
				commandPrefix && command.startsWith(`${commandPrefix}\n`)
					? command.slice(commandPrefix.length + 1)
					: command;
			// fork: judged as the gate judged it, without the prefix, whose line break
			// made every excluded command run in the sandbox after the user was told it would run outside.
			if (!runtime || isExcludedCommand(own, runtime.settings.excludedCommands)) {
				// graphical programs open on the agent's desktop while it runs.
				return local.exec(command, cwd, { ...options, env: withDesktopEnv(options.env ?? getShellEnv()) });
			}
			const channel = openSandboxNetwork(runtime, { toolCallId: options.toolCallId, command: own });
			const copies: GitCopy[] = [];
			let writable: string[] = [];
			let release = () => {};
			let repositories: RepositorySearch | undefined;
			try {
				await prepareSessionNet(runtime.tmp, runtime.bwrap);
				return await createLocalShellOperations("bash", (): ShellConfig => {
					const shell = getShellConfig(shellPath);
					const sandboxed = sandboxCommand(
						runtime,
						cwd,
						channel,
						[shell.shell, ...shell.args],
						options.env ?? getShellEnv(),
						{ copies, origin: { cwd, command: own, task: false } },
					);
					writable = sandboxed.writable;
					release = sandboxed.release;
					if (options.toolCallId) {
						let layouts = commandLayouts.get(runtime);
						if (!layouts) {
							layouts = new Map();
							commandLayouts.set(runtime, layouts);
						}
						layouts.set(options.toolCallId, sandboxed.layout);
					}
					repositories = sandboxed.layout.repositories;
					const [program, ...args] = sandboxed.argv;
					return { shell: program!, args, commandTransport: shell.commandTransport };
				}).exec(command, cwd, options);
			} finally {
				channel.close();
				release();
				// fork: a repository the command could write directly. Checked before
				// the publication, which refuses to add one as a submodule.
				const found = repositories && checkNewRepositories(repositories);
				// fork: also after an interrupted command, whose Git changes are published or kept.
				const search = repositories;
				for (const note of await finishCopies(
					runtime,
					copies,
					writable,
					found?.folders ?? [],
					search && (() => riskyRepositories(search)),
				))
					options.onData(Buffer.from(`\n${note}\n`));
				if (found) options.onData(Buffer.from(`\n${found.note}\n`));
			}
		},
	};
}

/**
 * Checks that the sandbox works for `cwd`: bubblewrap and the relay start, the agent dir is unreadable,
 * the home folder read-only and the seccomp filter applied inside it. Returns the reason it does not, for the user.
 */
export function probeSandbox(runtime: SandboxRuntime, cwd: string): string | undefined {
	const home = homedir();
	// Exit 13: the seccomp filter let `unshare` create a namespace. Exit 14: the host's /tmp shows through, where
	// the session's own folder would be visible by its name.
	// Exit 15: an entry of the home folder that reading limited to the project does not show is there.
	const script =
		'test -r "$1" && exit 11; [ "$2" = check-home ] && test -w "$3" && exit 12; unshare -U true 2>/dev/null && exit 13; [ "$4" != - ] && test -e "$4" && exit 14; [ "$5" != - ] && test -e "$5" && exit 15; exit 0';
	const relay = realPath(relayPath());
	const node = realPath(process.execPath);
	const layout = buildLayout({
		cwd,
		agentDir: runtime.agentDir,
		prism: [dirname(relay), dirname(node)],
		settings: layoutSettings(runtime),
	});
	// sandbox.md § 9.4: an existing entry, so that nothing is written in the home folder; neither shown nor holding
	// something shown, where the sandbox makes a mount point.
	// ~/.config is shown, empty but for its resources (bwrapArgs).
	const shown = layout.home
		? [...layout.home.read, ...layout.writable, join(home, ".cache"), join(home, ".config")]
		: [];
	const witness = layout.home
		? homeEntries(home)
				.map((name) => join(home, name))
				.find(
					(path) => !shown.some((root) => path === root || within(path, `${root}/`) || within(root, `${path}/`)),
				)
		: undefined;
	// The home folder may itself sit in a writable path. Under /tmp (a test HOME), the sandbox sees the private
	// /tmp instead, where bubblewrap leaves a writable stand-in for each folder it mounts through.
	const homeChecked =
		isWritable(home) &&
		!home.startsWith("/tmp/") &&
		!layout.writable.some((path) => home === path || within(home, `${path}/`));
	// The probe makes no connection, so the proxy need not answer while spawnSync blocks.
	const channel = openSandboxNetwork(runtime, { command: "sandbox check" });
	const probe = sandboxCommand(
		runtime,
		cwd,
		channel,
		[
			"/bin/sh",
			"-c",
			script,
			"probe",
			runtime.agentDir,
			homeChecked ? "check-home" : "-",
			home,
			runtime.tmp.startsWith("/tmp/") ? runtime.tmp : "-",
			witness ?? "-",
		],
		process.env,
	);
	const [program, ...args] = probe.argv;
	const result = spawnSync(program!, args, {
		encoding: "utf8",
		timeout: 10_000,
		stdio: ["ignore", "pipe", "pipe"],
	});
	channel.close();
	probe.release();
	if (result.error) return `bubblewrap could not start (${result.error.message}).`;
	if (result.status === 11) return "the sandbox did not hide Prism's agent folder.";
	if (result.status === 12) return "the sandbox left the home folder writable.";
	if (result.status === 13) return "the sandbox's seccomp filter did not apply.";
	if (result.status === 14) return "the sandbox left the shared /tmp visible.";
	if (result.status === 15)
		return "the sandbox showed the home folder beyond what reading limited to the project allows.";
	if (result.status !== 0) {
		const detail = (result.stderr || "").trim().split("\n").slice(-3).join(" ");
		if (/prism sandbox relay|Cannot find module/.test(detail)) {
			return `the sandbox's network relay did not start (${detail}).`;
		}
		const apparmor = /uid map|namespace|Operation not permitted|Permission denied/i.test(detail)
			? ` On Ubuntu 24.04 and later, AppArmor blocks the user namespaces bubblewrap needs unless a profile allows them. To allow them for bubblewrap (any program can then create namespaces through it), run:\n\n  printf 'abi <abi/4.0>,\\ninclude <tunables/global>\\nprofile bwrap ${runtime.bwrap} flags=(unconfined) {\\n  userns,\\n}\\n' | sudo tee /etc/apparmor.d/bwrap && sudo apparmor_parser -r /etc/apparmor.d/bwrap\n\n`
			: "";
		return `bubblewrap failed (${detail || `exit ${result.status ?? result.signal}`}).${apparmor}`;
	}
	return undefined;
}

function homeEntries(home: string): string[] {
	try {
		return readdirSync(home).sort();
	} catch {
		return [];
	}
}

function isWritable(path: string): boolean {
	try {
		accessSync(path, constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

export const BWRAP_MISSING =
	"bubblewrap (bwrap) is not installed. Install it (Fedora: sudo dnf install bubblewrap; Debian, Ubuntu: sudo apt install bubblewrap; Arch: sudo pacman -S bubblewrap)";

/**
 * fork: what the start did with publications a crash cut, and the private Git
 * copies left unfinished, reported once. Never blocks the start: a failure to look is reported too.
 */
function gitStartReport(recovered: string[], copiesFolder: string, session: object, tmp: string): string | undefined {
	let copies: string[];
	try {
		copies = reportGitCopies(copiesFolder, session, tmp);
	} catch (error) {
		copies = [`- the kept copies in ${copiesFolder} could not be read (${String(error)})`];
	}
	const lines: string[] = [];
	if (recovered.length > 0)
		lines.push("Prism: Git publications a stop or crash interrupted:", ...recovered.map((line) => `- ${line}`));
	if (copies.length > 0)
		lines.push(
			"Prism: private Git copies a stop or crash left unfinished. Nothing of them was applied to the repositories, removed or resumed:",
			...copies,
			"/sandbox lists them with how to read them. Each stays until you remove its folder.",
		);
	return lines.length > 0 ? lines.join("\n") : undefined;
}

/** The sandbox for this session, or the reason it cannot run. */
export async function startSandbox(
	settings: SandboxSettings,
	cwd: string,
	policy: HostPolicy,
	tmp: string,
	readable?: () => string[],
): Promise<SessionSandbox> {
	const agentDir = getAgentDir();
	// fork: every folder this session's commands may write, before Prism runs any program
	// on the host: bubblewrap first, then Git for the first layout. A wider set than each command's: it only refuses more.
	const home = homedir();
	addSandboxWritable([
		cwd,
		tmp,
		join(agentDir, "sandbox", "cache"),
		...settings.allowWrite.map((path) => resolve(cwd, path === "~" ? home : path.replace(/^~(?=\/)/, home))),
		...[...DEFAULT_WRITABLE_HOME_PATHS, ...TOOL_RESOURCES.flatMap((tool) => tool.write)].map((path) =>
			join(home, path),
		),
	]);
	const bwrap = findBwrap();
	if (!bwrap) return { error: BWRAP_MISSING };
	const seccomp = writeSeccompFilter(agentDir);
	if (!seccomp) return { error: `the sandbox has no seccomp filter for this architecture (${process.arch}).` };
	const runtime: SandboxRuntime = { bwrap, settings, agentDir, seccomp, policy, tmp, readable };
	try {
		// fork: a publication a crash cut is finished or undone before any other.
		const recovered = recoverGitPublications(join(agentDir, "sandbox", "git-journal"));
		removeOldGitCopies(join(agentDir, "sandbox", "git-copies"));
		runtime.gitReport = gitStartReport(recovered, join(agentDir, "sandbox", "git-copies"), policy, tmp);
		try {
			runtime.relaySnapshot = relaySnapshot(agentDir);
		} catch {
			runtime.relaySnapshot = undefined;
		}
		runtime.netReport = await sessionNetReport(tmp, bwrap);
		let failure = probeSandbox(runtime, cwd);
		// A snapshot this Node cannot start the relay from: the relay starts as before, and the next start makes another.
		if (failure && runtime.relaySnapshot) {
			rmSync(runtime.relaySnapshot, { force: true });
			runtime.relaySnapshot = undefined;
			failure = probeSandbox(runtime, cwd);
		}
		return failure ? { error: failure, gitReport: runtime.gitReport } : runtime;
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}
