/**
 * Search past sessions.
 *
 * Gives the model one tool, `session_search`, to look through previous
 * conversations stored in <agent dir>/sessions/. Also exposes `/sessions` so
 * you can grep them yourself without burning a model turn.
 *
 * Nothing is injected into context automatically — the model only sees what it
 * explicitly searches for.
 *
 * fork: copy of fork/reference/extensions/session-search.ts, shipped as the built-in
 * extension `builtin:session-search`. Change from the reference: the sessions dir comes from
 * `getSessionsDir()` instead of `~/.pi/agent/sessions`.
 */

import { open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { APP_NAME, getSessionsDir } from "../config.ts";
import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";
import { fill, t } from "./i18n/index.ts";
import { isLocalEndpoint } from "./request-inspector.ts";

const MAX_FILES = 400;
const MAX_FILE_BYTES = 12 * 1024 * 1024;
const SNIPPET_CHARS = 260;
const DEFAULT_LIMIT = 8;

type SessionFile = { path: string; cwd: string; started: string; mtime: number };
type Hit = { file: SessionFile; role: string; text: string; score: number };

async function readHeader(path: string): Promise<string> {
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.alloc(64 * 1024);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		return buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0] ?? "";
	} finally {
		await handle.close();
	}
}

/**
 * Every session file, newest first. `sessionDir` is a session folder chosen instead of the default storage: its
 * sessions are directly in it, as `SessionManager.listAll(sessionDir)` reads them, not in one folder per project.
 */
async function listSessionFiles(sessionDir?: string): Promise<SessionFile[]> {
	const SESSIONS_ROOT = sessionDir ?? getSessionsDir();
	let dirs: string[];
	try {
		dirs = sessionDir === undefined ? await readdir(SESSIONS_ROOT) : [""];
	} catch {
		return [];
	}
	const files: SessionFile[] = [];
	for (const dir of dirs) {
		const dirPath = join(SESSIONS_ROOT, dir);
		let names: string[];
		try {
			if (!(await stat(dirPath)).isDirectory()) continue;
			names = await readdir(dirPath);
		} catch {
			continue;
		}
		for (const name of names) {
			if (!name.endsWith(".jsonl")) continue;
			const path = join(dirPath, name);
			try {
				const info = await stat(path);
				if (info.size > MAX_FILE_BYTES) continue;
				files.push({ path, cwd: "", started: "", mtime: info.mtimeMs });
			} catch {
				// skip unreadable entries
			}
		}
	}
	// fork: not cut here; the search caps the files of its own scope.
	return files.sort((a, b) => b.mtime - a.mtime);
}

/**
 * fork: where `at`, an index in `text.toLowerCase()`, falls in `text`. Lowering
 * can lengthen text (U+0130 becomes two code units), so the index is not the same in both.
 */
function sourceIndex(text: string, lower: string, at: number): number {
	if (lower.length === text.length) return at;
	let source = 0;
	let lowered = 0;
	for (const char of text) {
		lowered += char.toLowerCase().length;
		if (lowered > at) return source;
		source += char.length;
	}
	return Math.min(at, text.length);
}

/** Pull readable text out of one session entry. */
function entryText(entry: unknown): { role: string; text: string } | undefined {
	// fork: a line that is valid JSON but not an object ("null") threw and failed every search.
	if (typeof entry !== "object" || entry === null) return undefined;
	const record = entry as { type?: string; message?: { role?: string; content?: unknown } };
	if (record.type !== "message" || !record.message) return undefined;
	const { role, content } = record.message;
	if (typeof content === "string") return { role: role ?? "?", text: content };
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	for (const block of content) {
		const typed = block as { type?: string; text?: string };
		if (typed?.type === "text" && typeof typed.text === "string") parts.push(typed.text);
	}
	if (parts.length === 0) return undefined;
	return { role: role ?? "?", text: parts.join("\n") };
}

/**
 * fork: every hit was kept, then sorted, before the few asked for were
 * taken. `hits` now holds only the best `limit`, in order (higher score, then newer session, then found first), the
 * order the former stable sort gave.
 */
function keepBest(hits: Hit[], hit: Hit, limit: number): void {
	// Whether `a` ranks after `b`: a lower score, or the same score in an older session.
	const after = (a: Hit, b: Hit) => (b.score - a.score || b.file.mtime - a.file.mtime) > 0;
	let at = hits.length;
	while (at > 0 && after(hits[at - 1], hit)) at--;
	if (at >= limit) return;
	hits.splice(at, 0, hit);
	if (hits.length > limit) hits.pop();
}

export async function searchSessions(
	query: string,
	scope: "project" | "all",
	cwd: string,
	limit: number,
	exclude?: string,
	signal?: AbortSignal,
	sessionDir?: string,
): Promise<{ hits: Hit[]; scanned: number }> {
	const terms = query
		.toLowerCase()
		.split(/\s+/)
		.filter((term) => term.length > 0);
	if (terms.length === 0) return { hits: [], scanned: 0 };

	const hits: Hit[] = [];
	let scanned = 0;
	let inScope = 0;

	for (const file of await listSessionFiles(sessionDir)) {
		// fork: a cancelled search reads no further file.
		signal?.throwIfAborted();
		// fork: the current session is in the model's context already; the tool searches the others.
		if (file.path === exclude) continue;
		let lines: string[];
		try {
			const header = await readHeader(file.path);
			try {
				const parsed = JSON.parse(header) as { cwd?: unknown; timestamp?: unknown };
				// fork: a number here made formatting the hits throw (`started.slice`).
				file.cwd = typeof parsed.cwd === "string" ? parsed.cwd : "";
				file.started = typeof parsed.timestamp === "string" ? parsed.timestamp : "";
			} catch {
				// Headerless files remain searchable in the all-sessions scope.
			}
			if (scope === "project" && file.cwd !== cwd) continue;
			// fork: the newest MAX_FILES of this scope, not of the whole storage,
			// where other projects' newer sessions left none of this project's.
			if (inScope >= MAX_FILES) break;
			inScope += 1;
			lines = (await readFile(file.path, "utf8")).split("\n");
		} catch {
			continue;
		}
		scanned += 1;

		const seen = new Set<string>();
		for (const line of lines) {
			if (!line) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue;
			}
			const extracted = entryText(parsed);
			if (!extracted) continue;
			const haystack = extracted.text.toLowerCase();
			const matched = terms.filter((term) => haystack.includes(term));
			if (matched.length === 0) continue;

			// Centre the snippet on the first match.
			const at = sourceIndex(extracted.text, haystack, haystack.indexOf(matched[0]));
			const start = Math.max(0, at - SNIPPET_CHARS / 3);
			const snippet = extracted.text.slice(start, start + SNIPPET_CHARS).trim();
			if (seen.has(snippet)) continue;
			seen.add(snippet);

			keepBest(hits, { file, role: extracted.role, text: snippet, score: matched.length / terms.length }, limit);
		}
	}

	return { hits, scanned };
}

function formatHits(hits: Hit[], scanned: number): string {
	if (hits.length === 0) return `No matches (searched ${scanned} session(s)).`;
	return hits
		.map((hit) => {
			const when = (hit.file.started || new Date(hit.file.mtime).toISOString()).slice(0, 16).replace("T", " ");
			return `[${when}] ${hit.file.cwd || "?"} · ${hit.role}\n${hit.text}`;
		})
		.join("\n\n---\n\n");
}

/** One line of /sessions' list: when, where, who, and what matched. */
function hitRow(hit: Hit): string {
	const when = (hit.file.started || new Date(hit.file.mtime).toISOString()).slice(0, 16).replace("T", " ");
	return `[${when}] ${hit.file.cwd || "?"} · ${t(hit.role)}: ${hit.text.replace(/\s+/g, " ").trim()}`;
}

/**
 * fork: excerpts of other sessions, perhaps private ones held with a local model, reach a cloud
 * model only with the user's consent: once, or for the rest of this session. Without a UI, they do not.
 */
async function consentToSend(
	ctx: ExtensionContext,
	hits: Hit[],
	allowed: { session: boolean },
	signal: AbortSignal | undefined,
): Promise<boolean> {
	if (allowed.session || isLocalEndpoint(ctx.model?.baseUrl)) return true;
	if (!ctx.hasUI) return false;
	const sessions = new Set(hits.map((hit) => hit.file.path)).size;
	const once = t("Send them this time");
	const always = t("Send them for the rest of this session");
	const choice = await ctx.ui.select(
		fill(
			"Send {0} excerpt(s) of {1} other session(s) to {2}? They may hold private work, held with another model or in another project.",
			String(hits.length),
			String(sessions),
			ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : t("the model"),
		),
		[once, always, t("Do not send them")],
		{ signal },
	);
	// fork: an answer given after the call was cancelled consents to nothing.
	signal?.throwIfAborted();
	if (choice === always) allowed.session = true;
	return choice === once || choice === always;
}

export default function (pi: ExtensionAPI) {
	const allowed = { session: false };
	pi.on("session_start", () => {
		allowed.session = false;
	});
	pi.registerTool({
		name: "session_search",
		label: "Session Search",
		// fork: reads the saved sessions.
		permissions: ["fs.read"],
		description: `Search the transcripts of the user's other ${APP_NAME} sessions, not the current one, for earlier decisions, context or code. Matches on keywords. Excerpts reach a cloud model only if the user allows it.`,
		promptSnippet: "Search the user's other, earlier sessions",
		promptGuidelines: [
			"Use session_search when the user refers to earlier work, a past decision, or something discussed in a previous session.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Keywords to look for" }),
			scope: Type.Optional(Type.String({ description: '"project" (current directory, default) or "all"' })),
			limit: Type.Optional(Type.Number({ description: `Max results (default ${DEFAULT_LIMIT})` })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const scope = params.scope === "all" ? "all" : "project";
			const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIMIT, 1), 25);
			const current = ctx.sessionManager.getSessionFile();
			const { hits, scanned } = await searchSessions(params.query, scope, ctx.cwd, limit, current, signal);
			signal?.throwIfAborted();
			if (hits.length > 0 && !(await consentToSend(ctx, hits, allowed, signal))) {
				return {
					content: [
						{
							type: "text",
							text: `The user did not allow sending excerpts of other sessions to this model (${hits.length} match(es) withheld). Do not retry; ask the user if needed.`,
						},
					],
					details: { matches: 0, withheld: hits.length, scanned, scope },
				};
			}
			return {
				content: [{ type: "text", text: formatHits(hits, scanned) }],
				details: { matches: hits.length, scanned, scope },
			};
		},
	});

	pi.registerCommand("sessions", {
		description: t("Search past sessions (usage: /sessions [all] <keywords>)"),
		handler: async (args, ctx) => {
			let query = args.trim();
			let scope: "project" | "all" = "project";
			if (query.startsWith("all ")) {
				scope = "all";
				query = query.slice(4).trim();
			}
			if (!query && ctx.hasUI) query = (await ctx.ui.input(t("Search past sessions"), t("keywords")))?.trim() ?? "";
			if (!query) {
				ctx.ui.notify(t("Usage: /sessions [all] <keywords>"), "info");
				return;
			}
			const { hits, scanned } = await searchSessions(query, scope, ctx.cwd, 12);
			ctx.ui.notify(fill("{0} match(es) across {1} session(s)", String(hits.length), String(scanned)), "info");
			if (hits.length === 0 || !ctx.hasUI) return;
			// Fork.9 QA: results as a list that closes and opens a session, not a cut widget that stayed on screen.
			const rows = new Map(hits.map((hit) => [hitRow(hit), hit.file.path]));
			const choice = await ctx.ui.select(t("Open a session"), [...rows.keys()]);
			const path = choice === undefined ? undefined : rows.get(choice);
			if (path) await ctx.switchSession(path);
		},
	});
}
