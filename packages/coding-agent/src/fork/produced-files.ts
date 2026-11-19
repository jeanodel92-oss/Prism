/**
 * fork: the files a session produced, so a user finds them without a shell. Files written by
 * `write` and `edit`, the full output of a truncated command, and, in a git repository, the files a `bash`
 * command created or changed (`git status` before and after the command). Each record keeps the file's
 * size and modification time when it was produced, so the list can say a file is gone or changed since.
 * Records are custom session entries: they survive a restart and follow the branch, and the model never
 * sees them. The `/files` panel shows them in its "Produced" tab (`file-browser.ts`).
 */
import { execFile } from "node:child_process";
import { lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";
import type { SessionEntry } from "../core/session-manager.ts";
import { resolveToCwd } from "../core/tools/path-utils.ts";
import { hostGit } from "./host-program.ts";
import { realPath } from "./real-path.ts";

export const PRODUCED_ENTRY = "prism-produced";
/** Above this many changed paths, `git status` describes a generated tree, not files a user looks for. */
const MAX_STATUS_PATHS = 2000;
/** Files recorded for one command at most. */
const MAX_PER_COMMAND = 50;
const GIT_TIMEOUT_MS = 2000;

export type ProducedSource = "write" | "edit" | "bash" | "output";

export interface ProducedFile {
	/** Absolute path. */
	path: string;
	source: ProducedSource;
	/** When the file was produced (ms). */
	at: number;
	size?: number;
	mtimeMs?: number;
}

export type ProducedState = "present" | "changed" | "absent";

function isProducedFile(value: unknown): value is ProducedFile {
	const file = value as ProducedFile;
	return (
		typeof file === "object" &&
		file !== null &&
		typeof file.path === "string" &&
		isAbsolute(file.path) &&
		["write", "edit", "bash", "output"].includes(file.source) &&
		typeof file.at === "number"
	);
}

/** The regular file's size and time, or undefined when there is no regular file there. */
function stamp(path: string): { size: number; mtimeMs: number } | undefined {
	try {
		const stat = lstatSync(path);
		return stat.isFile() ? { size: stat.size, mtimeMs: stat.mtimeMs } : undefined;
	} catch {
		return undefined;
	}
}

/** Whether the file is still there as it was produced. */
export function producedState(file: ProducedFile): ProducedState {
	const now = stamp(realPath(file.path));
	if (!now) return "absent";
	if (file.size === undefined || file.mtimeMs === undefined) return "present";
	return now.size === file.size && now.mtimeMs === file.mtimeMs ? "present" : "changed";
}

/** The session's produced files, newest first, one row per path (its latest record). */
export function producedFiles(branch: readonly SessionEntry[], pending: readonly ProducedFile[] = []): ProducedFile[] {
	const all: ProducedFile[] = [];
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== PRODUCED_ENTRY) continue;
		const files = (entry.data as { files?: unknown } | undefined)?.files;
		if (Array.isArray(files)) all.push(...files.filter(isProducedFile));
	}
	all.push(...pending);
	const latest = new Map<string, ProducedFile>();
	for (const file of all) latest.set(file.path, file);
	return [...latest.values()].sort((a, b) => b.at - a.at);
}

function run(cwd: string, args: string[]): Promise<string | undefined> {
	return new Promise((resolve) => {
		// Prism runs git outside the sandbox: no program the repository names.
		const git = hostGit(cwd);
		if (!git) return resolve(undefined);
		execFile(
			git.program,
			[...git.options, ...args],
			{ cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
			(error, stdout) => resolve(error ? undefined : stdout),
		);
	});
}

/** Changed and untracked paths of the repository with their size and time, or undefined when unknown. */
async function gitSnapshot(root: string): Promise<Map<string, string> | undefined> {
	// fork: Git checks a submodule's working tree
	// with that submodule's own configuration (filters, fsmonitor), which a sandboxed command can write in a repository
	// it makes; `.gitmodules` overrides a configured `diff.ignoreSubmodules`, the option does not. A submodule moved
	// to another commit is still listed.
	const out = await run(root, [
		"status",
		"--porcelain=v1",
		"-z",
		"--untracked-files=all",
		"--ignore-submodules=dirty",
	]);
	if (out === undefined) return undefined;
	const entries = out.split("\0");
	const snapshot = new Map<string, string>();
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i]!;
		if (entry.length < 4) continue;
		// A rename or copy is followed by its original path.
		if (entry[0] === "R" || entry[0] === "C") i++;
		if (snapshot.size >= MAX_STATUS_PATHS) return undefined;
		const path = join(root, entry.slice(3));
		const now = stamp(path);
		snapshot.set(path, `${entry.slice(0, 2)} ${now ? `${now.size} ${now.mtimeMs}` : "-"}`);
	}
	return snapshot;
}

/** Regular files that appeared or changed between two snapshots. */
export function changedBetween(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] {
	return [...after]
		.filter(([path, state]) => before.get(path) !== state && !state.endsWith(" -"))
		.map(([path]) => path);
}

/** Records what the session produces; part of the `files` module, so turning the panel off stops it too. */
export function trackProducedFiles(pi: ExtensionAPI): (ctx: ExtensionContext) => ProducedFile[] {
	let pending: ProducedFile[] = [];
	let root: string | undefined;
	const before = new Map<string, Map<string, string> | undefined>();

	const record = (written: string, source: ProducedSource) => {
		// fork: write and edit follow a final link; the file produced is its target.
		const path = realPath(written);
		const now = stamp(path);
		if (!now) return;
		pending.push({ path, source, at: Date.now(), ...now });
	};
	const flush = () => {
		if (pending.length === 0) return;
		const files = pending;
		pending = [];
		try {
			pi.appendEntry(PRODUCED_ENTRY, { files });
		} catch {
			// The list is a convenience: losing a record never stops the task.
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		pending = [];
		before.clear();
		root = (await run(ctx.cwd, ["rev-parse", "--show-toplevel"]))?.trim() || undefined;
	});
	pi.on("tool_call", async (event) => {
		// Awaited: the command starts only once the state before it is known.
		if (event.toolName === "bash" && root) before.set(event.toolCallId, await gitSnapshot(root));
	});
	pi.on("tool_result", async (event, ctx) => {
		const first = before.get(event.toolCallId);
		before.delete(event.toolCallId);
		if (event.isError && event.toolName !== "bash") return;
		if (event.toolName === "write" || event.toolName === "edit") {
			const raw = event.input.path;
			if (typeof raw === "string" && raw.length > 0) record(resolveToCwd(raw, ctx.cwd), event.toolName);
			return;
		}
		if (event.toolName !== "bash") return;
		const output = (event.details as { fullOutputPath?: unknown } | undefined)?.fullOutputPath;
		if (typeof output === "string" && isAbsolute(output)) record(output, "output");
		const last = first && root ? await gitSnapshot(root) : undefined;
		if (!first || !last) return;
		for (const path of changedBetween(first, last).slice(0, MAX_PER_COMMAND)) record(path, "bash");
	});
	pi.on("turn_end", async () => flush());
	pi.on("agent_end", async () => flush());
	pi.on("session_shutdown", async () => flush());

	// Including the records not written to the session yet.
	return (ctx) => producedFiles(ctx.sessionManager.getBranch(), pending);
}
