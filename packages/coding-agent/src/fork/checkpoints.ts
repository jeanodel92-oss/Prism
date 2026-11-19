/**
 * File checkpoints / undo.
 *
 * Snapshots every file the model is about to mutate (`write`, `edit`) and lets
 * you rewind. Checkpoints are grouped by turn, so `/undo` reverts one whole
 * model turn rather than a single edit.
 *
 * Registers no tools — the model never sees any of this, so it costs zero
 * context. Everything is driven by you:
 *
 *   /undo          revert the last turn's file changes
 *   /checkpoints   list turns and rewind to any of them
 *
 * Snapshots live in <agent dir>/checkpoints/<session>/ and are pruned to the
 * most recent MAX_SESSIONS sessions on startup.
 *
 * fork: copy of fork/reference/extensions/checkpoints.ts, shipped as the built-in
 * extension `builtin:checkpoints`. Change from the reference: the agent dir comes from
 * `getAgentDir()` instead of `~/.pi/agent`.
 */

import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { getAgentDir } from "../config.ts";
import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";
import { resolveToCwd } from "../core/tools/path-utils.ts";
import { anchoredOpenSupported, removeWithoutLinks, writeWithoutLinks } from "./anchored-open.ts";
import { readBoundedSync } from "./bounded-read.ts";
import { confirmCurrent } from "./confirm-current.ts";
import { fill, t } from "./i18n/index.ts";
import { realPath } from "./real-path.ts";
import { writeFileAtomicSync } from "./secrets/atomic-write.ts";
import { checkpointKey, openBackup, sealBackup } from "./secrets/checkpoint-cipher.ts";

const MAX_SESSIONS = 20;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const WATCHED_TOOLS = new Set(["write", "edit"]);

type Snapshot = {
	seq: number;
	turn: number;
	path: string;
	/** fork: the file the path led to when saved; restored there through no link. */
	real?: string;
	/** Snapshot file name, or null when the file did not exist yet. */
	blob: string | null;
	/** fork: the file's permissions, given back when /undo creates it again. */
	mode?: number;
	tool: string;
	ts: string;
};

export interface CheckpointPlan {
	turn: number;
	revision: string;
	files: { path: string; action: "restore" | "delete" }[];
	skipped: string[];
}

export interface CheckpointPanel {
	snapshot(): { turns: { turn: number; files: string[]; ts: string }[] };
	preview(turn: number): CheckpointPlan;
	restore(turn: number, revision: string): Promise<{ restored: number; removed: number; failed: string[] }>;
}

const panels = new WeakMap<ExtensionContext["sessionManager"], CheckpointPanel>();

export function checkpointPanel(ctx: ExtensionContext): CheckpointPanel | undefined {
	return panels.get(ctx.sessionManager);
}

/**
 * fork: an entry of index.json as this extension writes it. A damaged entry ({}) made `seq` NaN, so
 * every later snapshot was written to the same blob and /undo restored one file's content into another.
 */
function isSnapshot(value: unknown): value is Snapshot {
	if (typeof value !== "object" || value === null) return false;
	const { seq, turn, path, real, blob, mode, tool, ts } = value as Record<string, unknown>;
	return (
		Number.isSafeInteger(seq) &&
		(seq as number) > 0 &&
		Number.isSafeInteger(turn) &&
		(turn as number) > 0 &&
		typeof path === "string" &&
		path.length > 0 &&
		(real === undefined || (typeof real === "string" && real.startsWith("/"))) &&
		(blob === null || (typeof blob === "string" && /^\d+\.snap$/.test(blob))) &&
		(mode === undefined || (Number.isSafeInteger(mode) && (mode as number) >= 0 && (mode as number) <= 0o777)) &&
		typeof tool === "string" &&
		typeof ts === "string"
	);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where a session's checkpoints live: keyed by its id, else its file name (shared with /state). */
export function checkpointDir(sessionManager: {
	getSessionId?: () => string | undefined;
	getSessionFile?: () => string | undefined;
}): string | undefined {
	const id = sessionManager.getSessionId?.();
	const file = sessionManager.getSessionFile?.();
	if (id === undefined && file === undefined) return undefined;
	const name = id ?? basename(String(file)).replace(/\.jsonl$/, "");
	// fork: an id chosen with --session-id is unique within one project's sessions only;
	// the session file is unique.
	const unique = file === undefined ? "" : `-${createHash("sha256").update(resolve(file)).digest("hex").slice(0, 12)}`;
	const root = join(getAgentDir(), "checkpoints");
	const own = join(root, `${name}${unique}`);
	// fork: a session saved by an older Prism keeps its checkpoints in the folder named by its id alone. A generated id (a UUID) is that session's own, so the folder is still used, under
	// its name, which its encrypted backups are bound to. A chosen id may be another project's: not taken.
	if (unique && id !== undefined && UUID.test(id) && !existsSync(own) && existsSync(join(root, id)))
		return join(root, id);
	return own;
}

export default function (pi: ExtensionAPI) {
	let dir: string | undefined;
	let index: Snapshot[] = [];
	let seq = 0;
	let turn = 0;
	let revision = randomUUID();
	/** fork: files too large to snapshot, by turn, so /undo can say so. */
	let skipped = new Map<number, Set<string>>();

	const indexPath = () => join(dir as string, "index.json");
	// fork: the files a turn could not snapshot, kept beside the index so a resumed
	// session still warns that /undo leaves them as they are.
	const skippedPath = () => join(dir as string, "skipped.json");
	function persistSkipped() {
		if (!dir) return;
		try {
			const entries = [...skipped].map(([at, paths]) => [at, [...paths]]);
			writeFileAtomicSync(skippedPath(), JSON.stringify(entries), { mode: 0o600 });
		} catch {
			// best-effort: the warning was already shown, and the folder may be the reason the snapshot failed
		}
	}
	function loadSkipped(): Map<number, Set<string>> {
		const loaded = new Map<number, Set<string>>();
		try {
			const stored: unknown = JSON.parse(readFileSync(skippedPath(), "utf8"));
			if (!Array.isArray(stored)) return loaded;
			for (const item of stored) {
				if (!Array.isArray(item) || !Number.isSafeInteger(item[0]) || item[0] <= 0 || !Array.isArray(item[1]))
					continue;
				const paths = item[1].filter(
					(path: unknown): path is string => typeof path === "string" && path.length > 0,
				);
				if (paths.length > 0) loaded.set(item[0], new Set(paths));
			}
		} catch {
			// none recorded, or unreadable: nothing to warn about
		}
		return loaded;
	}
	// fork: a backup is bound to its session folder and name.
	const blobName = (blob: string) => `${basename(dir as string)}/${blob}`;
	/** The backups' key, when one of the backups `entries` restore may be encrypted; undefined when it cannot be read. */
	const keyFor = async (entries: readonly Snapshot[]) =>
		entries.some((entry) => entry.blob) ? await checkpointKey(getAgentDir()).catch(() => undefined) : undefined;

	function persist() {
		if (!dir) return;
		// fork: replaced whole; a crash leaves the previous index, never half of one.
		writeFileAtomicSync(indexPath(), JSON.stringify(index, null, 2), { mode: 0o600 });
		persistSkipped();
		revision = randomUUID();
	}

	function prune() {
		const ROOT = join(getAgentDir(), "checkpoints");
		try {
			// fork: the open session's folder is never pruned, even when older than the
			// others; it counts as one of the MAX_SESSIONS kept.
			const sessions = readdirSync(ROOT)
				.map((name) => ({ name, path: join(ROOT, name) }))
				.filter((entry) => entry.path !== dir && statSync(entry.path).isDirectory())
				.sort((a, b) => statSync(b.path).mtimeMs - statSync(a.path).mtimeMs);
			for (const stale of sessions.slice(MAX_SESSIONS - 1)) {
				rmSync(stale.path, { recursive: true, force: true });
			}
		} catch {
			// pruning is best-effort
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		dir = checkpointDir(ctx.sessionManager) ?? join(getAgentDir(), "checkpoints", `${Date.now()}`);
		mkdirSync(dir, { recursive: true, mode: 0o700 });

		// Resuming a session: pick the existing history back up.
		try {
			const stored: unknown = JSON.parse(readFileSync(indexPath(), "utf8"));
			index = Array.isArray(stored) ? stored.filter(isSnapshot) : [];
		} catch (error) {
			// fork: an index that does not parse is kept aside for repair, not overwritten.
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				try {
					renameSync(indexPath(), `${indexPath()}.damaged-${Date.now()}`);
				} catch {}
			}
			index = [];
		}
		skipped = loadSkipped();
		// A turn that only skipped files still counts, so the next turn does not reuse its number.
		// A loop, not a spread: the skipped turns come from a file.
		turn = index.reduce((max, entry) => Math.max(max, entry.turn), 0);
		for (const at of skipped.keys()) turn = Math.max(turn, at);
		// Never a backup's name again, even one an index no longer lists.
		seq = Math.max(
			index.reduce((max, entry) => Math.max(max, entry.seq), 0),
			...readdirSync(dir).map((name) => Number(/^(\d+)\.snap$/.exec(name)?.[1] ?? 0)),
		);
		revision = randomUUID();
		panels.set(ctx.sessionManager, {
			snapshot: () => ({ turns: turnSummary() }),
			preview: (fromTurn) => {
				if (!Number.isSafeInteger(fromTurn) || !index.some((entry) => entry.turn === fromTurn))
					throw new Error(t("Unknown checkpoint turn."));
				const files = new Map<string, "restore" | "delete">();
				for (const entry of index.filter((entry) => entry.turn >= fromTurn).sort((a, b) => b.seq - a.seq)) {
					// Match rewind's order even when a damaged index repeats a sequence number.
					files.set(entry.path, entry.blob ? "restore" : "delete");
				}
				return {
					turn: fromTurn,
					revision,
					files: [...files].map(([path, action]) => ({ path, action })),
					skipped: [...new Set([...skipped].filter(([at]) => at >= fromTurn).flatMap(([, paths]) => [...paths]))],
				};
			},
			restore: async (fromTurn, expected) => {
				const key = await keyFor(index);
				if (!ctx.isIdle()) throw new Error(t("Stop the current turn before restoring files."));
				if (expected !== revision)
					throw new Error(t("Checkpoints changed. Review the files again before restoring."));
				if (!Number.isSafeInteger(fromTurn) || !index.some((entry) => entry.turn === fromTurn))
					throw new Error(t("Unknown checkpoint turn."));
				return rewind(fromTurn, key);
			},
		});
		prune();
	});
	pi.on("session_shutdown", (_event, ctx) => {
		panels.delete(ctx.sessionManager);
	});

	pi.on("turn_start", async () => {
		turn += 1;
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!dir || !WATCHED_TOOLS.has(event.toolName)) return;
		const raw = (event.input as { path?: unknown })?.path;
		if (typeof raw !== "string" || raw.length === 0) return;

		// fork: resolve like the write and edit tools (~ and @ prefixes).
		const target = resolveToCwd(raw, ctx.cwd);
		// Read before the checks below, so that nothing runs between them and the new entry.
		const key = await checkpointKey(getAgentDir()).catch((error: unknown) =>
			error instanceof Error ? error : new Error(String(error)),
		);
		// One snapshot per file per turn: the first one holds the pre-turn state.
		if (index.some((entry) => entry.turn === turn && entry.path === target)) return;

		seq += 1;
		let blob: string | null = null;
		// A file with no snapshot: no misleading entry, but said now and in /undo.
		const skip = (warning: string) => {
			const forTurn = skipped.get(turn || 1) ?? new Set<string>();
			if (forTurn.has(target)) return;
			forTurn.add(target);
			skipped.set(turn || 1, forTurn);
			persistSkipped();
			revision = randomUUID();
			ctx.ui.notify(warning, "warning");
		};
		let mode: number | undefined;
		if (existsSync(target)) {
			try {
				const stat = statSync(target);
				mode = stat.mode & 0o777;
				if (stat.size <= MAX_SNAPSHOT_BYTES) {
					const name = `${String(seq).padStart(5, "0")}.snap`;
					if (key instanceof Error) throw key;
					// fork: a FIFO is refused without blocking, and no more than the limit is read.
					const sealed = sealBackup(key, blobName(name), readBoundedSync(target, MAX_SNAPSHOT_BYTES));
					writeFileSync(join(dir, name), sealed, { mode: 0o600 });
					blob = name;
				} else {
					skip(
						fill(
							"{0} is larger than {1} MB: no checkpoint, /undo cannot restore it.",
							target,
							String(MAX_SNAPSHOT_BYTES / 1024 / 1024),
						),
					);
					return;
				}
			} catch (error) {
				// fork: a snapshot that cannot be saved is skipped the same way, with
				// its reason; the write itself goes on, as for a file too large.
				const reason = error instanceof Error ? error.message : String(error);
				skip(fill("{0}: the checkpoint could not be saved ({1}), /undo cannot restore it.", target, reason));
				return;
			}
		}
		index.push({
			seq,
			turn: turn || 1,
			path: target,
			real: realPath(target),
			blob,
			...(mode === undefined ? {} : { mode }),
			tool: event.toolName,
			ts: new Date().toISOString(),
		});
		persist();
	});

	/** Restore every snapshot with turn >= fromTurn, newest first. */
	function rewind(fromTurn: number, key: Buffer | undefined): { restored: number; removed: number; failed: string[] } {
		const affected = index.filter((entry) => entry.turn >= fromTurn).sort((a, b) => b.seq - a.seq);
		let restored = 0;
		let removed = 0;
		const failed: string[] = [];
		/** The paths whose last restore, the one that sets their state, failed. */
		const notRestored = new Set<string>();
		for (const entry of affected) {
			notRestored.delete(entry.path);
			try {
				if (entry.blob) {
					const data = openBackup(readFileSync(join(dir as string, entry.blob)), blobName(entry.blob), key);
					// fork: a link put on the path since the save is not followed.
					if (anchoredOpenSupported) writeWithoutLinks(entry.real ?? realPath(entry.path), data, entry.mode);
					else writeFileSync(entry.path, data, { mode: entry.mode ?? 0o666 });
					restored += 1;
				} else if (anchoredOpenSupported) {
					const real = entry.real ?? realPath(entry.path);
					if (lstatSync(real, { throwIfNoEntry: false })) {
						removeWithoutLinks(real);
						removed += 1;
					}
				} else if (existsSync(entry.path)) {
					unlinkSync(entry.path);
					removed += 1;
				}
			} catch (error) {
				failed.push(`${entry.path}: ${(error as Error).message}`);
				notRestored.add(entry.path);
			}
		}
		// fork: a file not restored keeps its checkpoints, to try again once fixed.
		index = index.filter((entry) => entry.turn < fromTurn || notRestored.has(entry.path));
		for (const t of [...skipped.keys()]) if (t >= fromTurn) skipped.delete(t);
		persist();
		return { restored, removed, failed };
	}

	function turnSummary() {
		const turns = [...new Set(index.map((entry) => entry.turn))].sort((a, b) => b - a);
		return turns.map((t) => {
			const entries = index.filter((entry) => entry.turn === t);
			return {
				turn: t,
				files: [...new Set(entries.map((entry) => entry.path))],
				ts: entries[0]?.ts ?? "",
			};
		});
	}

	function report(ctx: ExtensionContext, result: ReturnType<typeof rewind>, label: string) {
		const parts = [fill("{0}: {1} restored", label, String(result.restored))];
		if (result.removed > 0) parts.push(fill("{0} deleted", String(result.removed)));
		if (result.failed.length > 0) parts.push(fill("{0} failed", String(result.failed.length)));
		ctx.ui.notify(parts.join(", "), result.failed.length > 0 ? "warning" : "info");
		for (const failure of result.failed) ctx.ui.notify(failure, "error");
	}

	// fork: like the panel's restore, the commands restore only while no
	// turn runs, and only the turns their question showed (confirmCurrent); a turn added meanwhile asks again.
	const busy = (ctx: ExtensionContext) => {
		if (ctx.isIdle()) return false;
		ctx.ui.notify(t("Stop the current turn before restoring files."), "warning");
		return true;
	};
	const changedNotice = t("Checkpoints changed during the question three times in a row; nothing was restored.");

	pi.registerCommand("undo", {
		description: "Revert the file changes from the last model turn",
		handler: async (_args, ctx) => {
			if (index.length === 0) {
				ctx.ui.notify(t("No checkpoints to undo."), "info");
				return;
			}
			if (busy(ctx)) return;
			const read = () => ({
				value: index.length > 0 ? Math.max(...index.map((entry) => entry.turn)) : 0,
				version: revision,
			});
			const confirmed = await confirmCurrent(
				(last) => {
					if (last === 0) {
						ctx.ui.notify(t("No checkpoints to undo."), "info");
						return false;
					}
					const files = [...new Set(index.filter((e) => e.turn === last).map((e) => e.path))];
					const notRestored = [...(skipped.get(last) ?? [])];
					return ctx.ui.confirm(
						fill("Undo turn {0}?", String(last)),
						[
							fill("{0} file(s):", String(files.length)),
							...files.map((f) => `  ${f}`),
							...(notRestored.length > 0
								? [t("Not restored (no checkpoint):"), ...notRestored.map((f) => `  ${f}`)]
								: []),
							t("Changes made by bash commands are not tracked."),
						].join("\n"),
					);
				},
				read,
				{ changedMessage: changedNotice },
			).catch((error: Error) => {
				ctx.ui.notify(error.message, "warning");
				return undefined;
			});
			if (!confirmed || busy(ctx)) return;
			const last = confirmed.value;
			report(ctx, rewind(last, await keyFor(index)), t(`Undid turn ${last}`));
		},
	});

	pi.registerCommand("checkpoints", {
		description: "List file checkpoints and rewind to one",
		handler: async (_args, ctx) => {
			const summary = turnSummary();
			if (summary.length === 0) {
				ctx.ui.notify(t("No checkpoints in this session."), "info");
				return;
			}
			if (busy(ctx)) return;
			const confirmed = await confirmCurrent(
				async (shown) => {
					const labels = shown.map(
						(item) =>
							`turn ${item.turn} · ${item.files.length} file(s) · ${item.ts.slice(11, 19)} · ${item.files
								.map((f) => basename(f))
								.slice(0, 3)
								.join(", ")}`,
					);
					const shownLabels = labels.map(t);
					const choice = await ctx.ui.select(t("Rewind to before which turn?"), [...shownLabels, t("Cancel")]);
					if (!choice || choice === t("Cancel")) return undefined;
					return shown[shownLabels.indexOf(choice)]?.turn;
				},
				() => ({ value: turnSummary(), version: revision }),
				{ changedMessage: changedNotice },
			).catch((error: Error) => {
				ctx.ui.notify(error.message, "warning");
				return undefined;
			});
			if (!confirmed || busy(ctx)) return;
			const picked = confirmed.answer;
			report(ctx, rewind(picked, await keyFor(index)), t(`Rewound to before turn ${picked}`));
		},
	});
}
