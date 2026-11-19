/**
 * /export-zip, a portable archive of sessions for a model working in another harness.
 * The user picks the sessions and the files; nothing else goes in. The archive holds `manifest.json`, `IMPORT.md`
 * (how to rebuild the context, and the archive's limits), each session's messages as JSON and as Markdown, and the
 * chosen files under `files/`. The secrets Prism knows (stored keys, key variables) are masked everywhere; files
 * that usually hold credentials are never offered. The rest is not analysed, and the confirmation says so.
 */
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	lstatSync,
	openSync,
	readlinkSync,
	readSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { APP_NAME, expandTildePath, VERSION } from "../config.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "../core/extensions/types.ts";
import { type SessionEntry, SessionManager } from "../core/session-manager.ts";
import { createZipArchive, ZIP_MAX_ENTRIES } from "../utils/zip.ts";
import { chooseExportNative } from "./export-native.ts";
import { fill, t } from "./i18n/index.ts";
import { hasInteractiveClient, hasNativeMenus } from "./interactive-client.ts";
import { relativeInside, within } from "./path-within.ts";
import { knownSecrets } from "./secrets/env.ts";
import { type MaskCount, maskText, maskValue } from "./secrets/mask.ts";

export const EXPORT_FORMAT = "prism-portable-export";
export const EXPORT_FORMAT_VERSION = 1;
/** A larger file is listed as excluded rather than read into memory. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
/**
 * The archive is built in memory (about 1.5 times what it holds, measured): past this total, further files are
 * listed as excluded.
 */
export const MAX_TOTAL_FILE_BYTES = 100 * 1024 * 1024;
/**
 * The chosen sessions are loaded and turned into JSON and Markdown in memory: the peak measured is about five times
 * the size of their files (200 MB of sessions, 1 GB more). Past this total, nothing is exported.
 */
export const MAX_TOTAL_SESSION_BYTES = 200 * 1024 * 1024;

/** Why sessions this large cannot be exported, or undefined when they fit. Read from their size on disk. */
export function sessionsSizeProblem(
	paths: readonly string[],
	maxBytes: number = MAX_TOTAL_SESSION_BYTES,
): string | undefined {
	const total = paths.reduce((sum, path) => sum + (statSync(path, { throwIfNoEntry: false })?.size ?? 0), 0);
	if (total <= maxBytes) return undefined;
	const mb = (bytes: number) => String(Math.ceil(bytes / 1024 / 1024));
	return fill(
		"The chosen sessions take {0} MB, more than the {1} MB an archive can hold: nothing exported. Choose fewer sessions.",
		mb(total),
		mb(maxBytes),
	);
}

/**
 * fork: a classic ZIP counts its entries on 16 bits. Each session gives
 * two entries and the manifest and guide two more, so this many sessions are refused before any is loaded.
 */
export function sessionCountProblem(count: number, maxEntries: number = ZIP_MAX_ENTRIES): string | undefined {
	const maxSessions = Math.floor((maxEntries - 2) / 2);
	if (count <= maxSessions) return undefined;
	return fill(
		"{0} sessions chosen, more than the {1} an archive can hold: nothing exported. Choose fewer sessions.",
		String(count),
		String(maxSessions),
	);
}

/** Names of files that usually hold credentials: never offered, listed as excluded when a session wrote one. */
const CREDENTIAL_FILE =
	/(^|\/)(\.env(\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|auth\.json|credentials(\.json)?|id_(rsa|dsa|ecdsa|ed25519)|.*\.(pem|key|p12|pfx|kdbx))$/i;

export interface ExportedMessage {
	index: number;
	timestamp?: string;
	role: string;
	model?: string;
	content: ExportedPart[];
	/**
	 * fork: on a compaction summary, the index of the first message it
	 * kept. The messages before it are the ones it replaced in the model's context; they stay here as history.
	 */
	keptFrom?: number;
}

export type ExportedPart =
	| { type: "text"; text: string }
	| { type: "thinking"; text: string }
	| { type: "tool_call"; id: string; tool: string; arguments: unknown }
	| { type: "tool_result"; toolCallId: string; tool: string; isError: boolean; text: string }
	| { type: "image"; omitted: string };

export interface ExportSession {
	/** The session file. */
	path: string;
	id: string;
	name?: string;
}

export interface ExportFile {
	/** Relative to the project folder. */
	path: string;
	status: "included" | "missing" | "excluded";
	/** The entry's name in the archive, which holds no known secret. */
	archivePath?: string;
	reason?: string;
}

export interface PortableExport {
	entries: { name: string; data: string | Uint8Array }[];
	manifest: Record<string, unknown>;
	/** Occurrences of known secrets replaced. */
	masked: number;
	files: ExportFile[];
}

const iso = (time: unknown) =>
	typeof time === "number" ? new Date(time).toISOString() : typeof time === "string" ? time : undefined;

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			const block = part as { type?: string; text?: unknown; mimeType?: unknown };
			if (block.type === "text" && typeof block.text === "string") return block.text;
			if (block.type === "image") return `[image ${String(block.mimeType ?? "")} omitted]`;
			return "";
		})
		.join("\n");
}

function parts(content: unknown): ExportedPart[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (!Array.isArray(content)) return [];
	const out: ExportedPart[] = [];
	for (const part of content) {
		const block = part as Record<string, unknown>;
		if (block.type === "text" && typeof block.text === "string") out.push({ type: "text", text: block.text });
		else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking)
			out.push({ type: "thinking", text: block.thinking });
		else if (block.type === "toolCall")
			out.push({
				type: "tool_call",
				id: String(block.id ?? ""),
				tool: String(block.name ?? ""),
				arguments: block.arguments,
			});
		else if (block.type === "image") out.push({ type: "image", omitted: String(block.mimeType ?? "image") });
	}
	return out;
}

/** The messages of the session's current branch, in order, compactions and summaries included. */
export function exportedMessages(entries: readonly SessionEntry[]): ExportedMessage[] {
	const messages: ExportedMessage[] = [];
	// The index of the first message each entry gives, or would give: where a compaction's kept messages start.
	const startOf = new Map<string, number>();
	for (const entry of entries) {
		startOf.set(entry.id, messages.length);
		const at = iso(entry.timestamp);
		const add = (role: string, content: ExportedPart[], model?: string, keptFrom?: number) =>
			messages.push({
				index: messages.length,
				...(at ? { timestamp: at } : {}),
				role,
				...(model ? { model } : {}),
				content,
				...(keptFrom !== undefined ? { keptFrom } : {}),
			});
		if (entry.type === "compaction") {
			// Nothing kept (the boundary is the compaction itself, or not on this branch): it starts at the summary.
			add(
				"compaction_summary",
				[{ type: "text", text: entry.summary }],
				undefined,
				startOf.get(entry.firstKeptEntryId) ?? messages.length,
			);
			continue;
		}
		if (entry.type === "branch_summary") {
			add("branch_summary", [{ type: "text", text: entry.summary }]);
			continue;
		}
		if (entry.type === "custom_message") {
			add(`custom:${entry.customType}`, parts(entry.content));
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message as unknown as Record<string, unknown>;
		const role = String(message.role);
		if (role === "toolResult") {
			add(role, [
				{
					type: "tool_result",
					toolCallId: String(message.toolCallId ?? ""),
					tool: String(message.toolName ?? ""),
					isError: message.isError === true,
					text: textOf(message.content),
				},
			]);
		} else if (role === "bashExecution") {
			add(role, [{ type: "text", text: `$ ${String(message.command ?? "")}\n${String(message.output ?? "")}` }]);
		} else {
			add(role, parts(message.content), typeof message.model === "string" ? message.model : undefined);
		}
	}
	return messages;
}

/** A readable transcript of the same messages. */
export function transcriptMarkdown(title: string, messages: readonly ExportedMessage[]): string {
	const lines = [`# ${title}`, ""];
	for (const message of messages) {
		lines.push(`## ${message.index + 1}. ${message.role}${message.model ? ` (${message.model})` : ""}`);
		if (message.timestamp) lines.push(`_${message.timestamp}_`);
		if (message.keptFrom !== undefined)
			lines.push(
				message.keptFrom > 0
					? `_Replaces messages 1 to ${message.keptFrom} in the model's context; keeps those from ${message.keptFrom + 1}._`
					: "_Replaces no earlier message in the model's context._",
			);
		lines.push("");
		for (const part of message.content) {
			if (part.type === "text") lines.push(part.text);
			else if (part.type === "thinking") lines.push(`> Thinking:\n> ${part.text.split("\n").join("\n> ")}`);
			else if (part.type === "tool_call")
				lines.push(
					`Tool call \`${part.tool}\` (${part.id}):`,
					"```json",
					JSON.stringify(part.arguments, null, 2),
					"```",
				);
			else if (part.type === "tool_result")
				lines.push(`Result of \`${part.tool}\`${part.isError ? " (error)" : ""}:`, "```", part.text, "```");
			else lines.push(`[${part.omitted} omitted]`);
			lines.push("");
		}
	}
	return lines.join("\n");
}

/** The files the session's write and edit calls changed, relative to the project; outside it, absolute. */
export function writtenFiles(entries: readonly SessionEntry[], cwd: string): string[] {
	const found = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		for (const part of entry.message.content) {
			if (part.type !== "toolCall" || (part.name !== "write" && part.name !== "edit")) continue;
			const path = part.arguments.path;
			if (typeof path !== "string" || !path) continue;
			const absolute = resolve(cwd, path);
			found.add(relativeInside(cwd, absolute) ?? absolute);
		}
	}
	return [...found].sort();
}

/** Files of the project that give its context to a model, when present. */
export function contextFiles(cwd: string): string[] {
	const names = ["AGENTS.md", "CLAUDE.md", "README.md", "project/SPEC.md", "project/roadmap.md", "project/handoff.md"];
	return names.filter((name) => existsSync(join(cwd, name)));
}

/** Why a file cannot go in the archive, or undefined. */
export function fileExclusion(path: string, cwd: string): string | undefined {
	if (isAbsolute(path) || path.split(/[\\/]/).includes("..")) return "outside the project folder";
	if (CREDENTIAL_FILE.test(path)) return "may hold credentials";
	const absolute = resolve(cwd, path);
	// Preserve the former prefix semantics: / matches itself, but its children require //.
	if (absolute === resolve(cwd) || !within(absolute, resolve(cwd) + sep)) return "outside the project folder";
	// Every folder between the project and the file must be a real folder of the project: a link there could
	// lead anywhere.
	const root = resolve(cwd);
	for (let dir = dirname(absolute); dir !== root && within(dir, root + sep); dir = dirname(dir)) {
		const stat = lstatSync(dir, { throwIfNoEntry: false });
		if (!stat) return undefined;
		if (stat.isSymbolicLink()) return "a symbolic link in its path";
	}
	const stat = lstatSync(absolute, { throwIfNoEntry: false });
	if (!stat) return undefined;
	if (stat.isSymbolicLink()) return "a symbolic link";
	if (!stat.isFile()) return "not a regular file";
	if (stat.size > MAX_FILE_BYTES) return `larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`;
	return undefined;
}

/**
 * The file's content, read through one descriptor that is checked after opening: a file swapped for a link, or
 * a folder swapped for one, between the check above and the read cannot bring a file from outside the project.
 */
export function readProjectFile(
	path: string,
	cwd: string,
	/** Tests only: runs between the check and the open, where a swap would happen. */
	afterCheck?: () => void,
): { data: Buffer } | { reason: string } | "missing" {
	const reason = fileExclusion(path, cwd);
	if (reason) return { reason };
	afterCheck?.();
	const absolute = resolve(cwd, path);
	let fd: number;
	try {
		// O_NOFOLLOW refuses a link as the last part; O_NONBLOCK keeps a pipe swapped in from blocking the open.
		fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return "missing";
		return { reason: code === "ELOOP" ? "a symbolic link" : "could not be read" };
	}
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) return { reason: "not a regular file" };
		if (stat.size > MAX_FILE_BYTES) return { reason: `larger than ${MAX_FILE_BYTES / 1024 / 1024} MB` };
		// Where the descriptor really leads, folders included.
		let opened: string;
		try {
			opened = readlinkSync(`/proc/self/fd/${fd}`);
		} catch {
			opened = realpathSync(absolute);
			const again = lstatSync(opened);
			if (again.ino !== stat.ino || again.dev !== stat.dev) return { reason: "changed while being read" };
		}
		if (opened !== join(realpathSync(cwd), relative(resolve(cwd), absolute))) {
			const root = realpathSync(cwd);
			return {
				reason:
					opened === root || within(opened, root + sep)
						? "changed while being read"
						: "outside the project folder",
			};
		}
		const data = Buffer.alloc(stat.size);
		let read = 0;
		while (read < data.length) {
			const count = readSync(fd, data, read, data.length - read, read);
			if (count === 0) break;
			read += count;
		}
		return { data: data.subarray(0, read) };
	} finally {
		closeSync(fd);
	}
}

/** Writes the archive only where nothing exists yet: never over a file, and never through a link. */
export function writeArchiveFile(target: string, entries: PortableExport["entries"]): void {
	// "wx" is O_CREAT | O_EXCL: it fails on any existing path, a dangling link included.
	writeFileSync(target, createZipArchive(entries), { flag: "wx", mode: 0o600 });
}

const IMPORT_GUIDE = `# Importing this archive

This archive was exported by {app} {version} for a model or a person working in another tool. It is not an
installer and nothing in it needs to run. Read \`manifest.json\` first.

## What is here

- \`manifest.json\`: the format and its version, when and from where the archive was made, the list of sessions
  and files with their paths inside the archive, what was left out and why, and the limits below.
- \`sessions/<n>-<id>/messages.json\`: one session's messages in order, as a JSON array. Each message has an
  \`index\`, an ISO \`timestamp\` when known, a \`role\` (\`user\`, \`assistant\`, \`toolResult\`, \`bashExecution\`,
  \`compaction_summary\`, \`branch_summary\` or \`custom:<type>\`), the \`model\` for assistant messages, and
  \`content\`: parts of type \`text\`, \`thinking\` (the model's reasoning, when it was kept), \`tool_call\` (tool
  name and arguments), \`tool_result\` (the text the tool returned) or \`image\` (left out). A
  \`compaction_summary\` also has \`keptFrom\`: the \`index\` of the first message it kept.
- \`sessions/<n>-<id>/transcript.md\`: the same messages as readable Markdown.
- \`files/\`: the files the user chose, at their path relative to the project folder.

## Rebuilding the context

1. Read the sessions in the order of \`manifest.json\`, each from its first message. Every message of the branch
   is here as history, including those a compaction summarised. To rebuild the context the model last saw, take
   the last \`compaction_summary\`, then the messages from its \`keptFrom\` up to it (skipping any older
   \`compaction_summary\` among them), then the messages after it. The messages before \`keptFrom\` are those the
   summary replaced. Without a \`compaction_summary\`, every message is in the context.
2. Tool calls name the tools of {app} (\`read\`, \`write\`, \`edit\`, \`bash\`…). Their arguments and results show
   what was done; your own tools may differ, and nothing here replays them.
3. Paths in the messages are those of the original machine (\`origin.projectPath\` in the manifest). The files
   chosen for export are under \`files/\`, relative to that folder; a file marked \`missing\` no longer existed when
   the archive was made, and one marked \`excluded\` was left out for the reason given.
4. Continue from the last messages of the most recent session, checking the current state of the files before
   relying on what the messages say about them.

## Limits

- Only the current branch of each session is exported, without the settings, permissions, model configuration,
  extensions or credentials of {app}.
- Images are left out. Messages a compaction summarised are kept as history, though the model saw only their
  summary.
- The secrets {app} knew when exporting (stored keys and key variables) are replaced by \`[secret hidden: …]\`.
  Nothing else was analysed: messages and files may contain personal or confidential data.
`;

/** Builds the archive's entries: nothing is written. */
export function buildPortableExport(options: {
	cwd: string;
	sessions: readonly ExportSession[];
	files: readonly string[];
	secrets?: Map<string, string>;
	now?: Date;
	maxTotalBytes?: number;
	maxSessionBytes?: number;
	maxEntries?: number;
}): PortableExport {
	const { cwd } = options;
	const maxEntries = options.maxEntries ?? ZIP_MAX_ENTRIES;
	const tooMany = sessionCountProblem(options.sessions.length, maxEntries);
	if (tooMany) throw new Error(tooMany);
	const tooLarge = sessionsSizeProblem(
		options.sessions.map((session) => session.path),
		options.maxSessionBytes,
	);
	if (tooLarge) throw new Error(tooLarge);
	const secrets = options.secrets ?? knownSecrets();
	// fork: masked on the decoded messages, then serialized; names of entries too.
	const count: MaskCount = { replaced: 0 };
	const mask = <T>(value: T) => maskValue(value, secrets, { count });
	const names = new Set<string>();
	// An entry's name with no known secret; two names that become the same are told apart by `#2`.
	const entryName = (name: string) => {
		const masked = maskText(name, secrets, count);
		let unique = masked;
		for (let n = 2; names.has(unique); n++) unique = `${masked}#${n}`;
		names.add(unique);
		return unique;
	};
	const entries: PortableExport["entries"] = [];
	const sessions = options.sessions.map((session, index) => {
		const manager = SessionManager.open(session.path);
		const branch = manager.getBranch();
		const messages = mask(exportedMessages(branch));
		const folder = maskText(`sessions/${String(index + 1).padStart(2, "0")}-${session.id}`, secrets, count);
		const title = mask(session.name ?? `Session ${session.id}`);
		entries.push({ name: entryName(`${folder}/messages.json`), data: JSON.stringify(messages, null, 2) });
		entries.push({ name: entryName(`${folder}/transcript.md`), data: transcriptMarkdown(title, messages) });
		const models = [...new Set(messages.flatMap((message) => (message.model ? [message.model] : [])))];
		return {
			// An `id` is never masked by maskValue (an entry's, a tool call's); a session's is chosen, so it is here.
			id: maskText(session.id, secrets, count),
			...(session.name ? { name: session.name } : {}),
			created: messages[0]?.timestamp,
			lastMessage: messages.at(-1)?.timestamp,
			cwd: manager.getCwd(),
			messageCount: messages.length,
			models,
			messages: `${folder}/messages.json`,
			transcript: `${folder}/transcript.md`,
		};
	});
	let budget = options.maxTotalBytes ?? MAX_TOTAL_FILE_BYTES;
	const files: ExportFile[] = options.files.map((path) => {
		const read = readProjectFile(path, cwd);
		if (read === "missing") return { path, status: "missing" };
		if ("reason" in read) return { path, status: "excluded", reason: read.reason };
		const { data } = read;
		if (data.length > budget) return { path, status: "excluded", reason: "the archive's size limit is reached" };
		// The manifest and the guide are added last.
		if (entries.length + 3 > maxEntries)
			return { path, status: "excluded", reason: "the archive's entry limit is reached" };
		budget -= data.length;
		const text = data.toString("utf8");
		// Text is masked; a file that is not valid UTF-8 goes in as it is, and the manifest says so.
		const isText = Buffer.from(text, "utf8").equals(data);
		const archivePath = entryName(`files/${path}`);
		entries.push({ name: archivePath, data: isText ? mask(text) : data });
		return { path, archivePath, status: "included", ...(isText ? {} : { reason: "binary: not masked" }) };
	});
	const manifest = {
		format: EXPORT_FORMAT,
		formatVersion: EXPORT_FORMAT_VERSION,
		createdAt: (options.now ?? new Date()).toISOString(),
		exportedBy: { app: APP_NAME, version: VERSION },
		origin: mask({ projectName: basename(cwd), projectPath: cwd }),
		sessions: mask(sessions),
		files: mask(files),
		secretsMasked: 0,
		analysedForPersonalData: false,
		guide: "IMPORT.md",
	};
	manifest.secretsMasked = count.replaced;
	entries.unshift(
		{ name: "manifest.json", data: JSON.stringify(manifest, null, 2) },
		{
			name: "IMPORT.md",
			data: IMPORT_GUIDE.replaceAll("{app}", APP_NAME).replaceAll("{version}", VERSION),
		},
	);
	return { entries, manifest, masked: count.replaced, files };
}

const timestampName = (now: Date) => now.toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");

const isDirectory = (path: string) => {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
};

/**
 * where the user asks for the archive. Relative to the project, `~` for the home folder; a folder takes
 * the generated name and `.zip` is added when missing. Empty is the generated name in the project. An existing
 * file is refused here as well as when written.
 */
export function archiveDestination(
	typed: string,
	cwd: string,
	generated: string,
): { path: string } | { problem: string } {
	const value = typed.trim();
	if (!value) return { path: join(cwd, generated) };
	let path = resolve(cwd, expandTildePath(value));
	if (isDirectory(path)) path = join(path, generated);
	else if (!/\.zip$/i.test(path)) path += ".zip";
	if (!isDirectory(dirname(path))) return { problem: fill("Folder not found: {0}", dirname(path)) };
	if (existsSync(path)) return { problem: fill("{0} already exists: choose another name.", path) };
	return { path };
}

/** One toggle list: the options checked, or undefined when cancelled. */
async function chooseMany(
	ctx: ExtensionCommandContext,
	title: string,
	labels: readonly string[],
	checked: boolean[],
): Promise<boolean[] | undefined> {
	const next = t("Continue");
	const cancel = t("Cancel");
	for (;;) {
		const options = labels.map((label, index) => `${checked[index] ? "[x]" : "[ ]"} ${label}`);
		const choice = await ctx.ui.select(title, [...options, next, cancel]);
		if (choice === undefined || choice === cancel) return undefined;
		if (choice === next) return checked;
		const index = options.indexOf(choice);
		if (index >= 0) checked[index] = !checked[index];
	}
}

export function portableExport(pi: ExtensionAPI, maxSessionBytes: number = MAX_TOTAL_SESSION_BYTES): void {
	pi.registerCommand("export-zip", {
		description: t("Export chosen sessions and files as a portable ZIP archive"),
		handler: async (_args, ctx) => {
			if (!hasInteractiveClient(ctx)) {
				ctx.ui.notify(t("/export-zip needs the interactive terminal."), "warning");
				return;
			}
			const cwd = ctx.cwd;
			const current = ctx.sessionManager.getSessionFile();
			const listed = await SessionManager.list(cwd, ctx.sessionManager.getSessionDir());
			const sessions = listed.filter((session) => session.messageCount > 0 || session.path === current);
			if (sessions.length === 0) {
				ctx.ui.notify(t("No saved session to export in this project."), "warning");
				return;
			}
			const sessionParts = (session: (typeof sessions)[number]) => [
				session.name ?? session.firstMessage.replace(/\s+/g, " ").slice(0, 50),
				session.modified.toISOString().slice(0, 16).replace("T", " "),
				fill("{0} messages", String(session.messageCount)),
				...(session.path === current ? [t("this session")] : []),
			];
			/** None chosen, or too large: checked before any chosen session is loaded. */
			const sessionsProblem = (chosen: typeof sessions) =>
				chosen.length === 0
					? { message: t("No session chosen: nothing exported."), type: "info" as const }
					: ((message) => (message ? { message, type: "warning" as const } : undefined))(
							sessionCountProblem(chosen.length) ??
								sessionsSizeProblem(
									chosen.map((session) => session.path),
									maxSessionBytes,
								),
						);
			const filesFor = (chosen: typeof sessions) => {
				const written = new Set<string>();
				for (const session of chosen) {
					for (const path of writtenFiles(SessionManager.open(session.path).getBranch(), cwd)) written.add(path);
				}
				const candidates = [...new Set([...contextFiles(cwd), ...written])];
				return {
					offered: candidates.filter((path) => fileExclusion(path, cwd) === undefined),
					refused: candidates.filter((path) => fileExclusion(path, cwd) !== undefined),
				};
			};
			const fileLabel = (path: string) => (existsSync(join(cwd, path)) ? path : fill("{0} (missing)", path));
			const generatedName = () => `${APP_NAME}-export-${timestampName(new Date())}.zip`;
			/** The destination the user chose, else the generated name in the project. */
			let destination: string | undefined;
			const changeDestination = (typed: string) => {
				const found = archiveDestination(typed, cwd, generatedName());
				if ("problem" in found) return found.problem;
				destination = found.path;
				return undefined;
			};
			const prepare = (chosen: typeof sessions, files: string[], refused: string[]) => {
				const now = new Date();
				const target = destination ?? join(cwd, `${APP_NAME}-export-${timestampName(now)}.zip`);
				const built = buildPortableExport({
					cwd,
					sessions: chosen.map((session) => ({ path: session.path, id: session.id, name: session.name })),
					files: [...files, ...refused],
					now,
					maxSessionBytes,
				});
				const included = built.files.filter((file) => file.status === "included");
				return {
					target,
					built,
					sessions: fill("Sessions: {0}", String(chosen.length)),
					items: [
						fill("Files: {0}", included.map((file) => file.path).join(", ") || t("none")),
						...built.files
							.filter((file) => file.status === "excluded")
							.map((file) => fill("Left out: {0} ({1})", file.path, t(file.reason ?? ""))),
						...built.files
							.filter((file) => file.status === "missing")
							.map((file) => fill("Missing: {0}", file.path)),
						fill("Known secrets masked: {0}", String(built.masked)),
					],
					warning: t(
						"Not analysed: messages, tool results and files may contain personal or confidential data, and the paths of this machine.",
					),
					archive: fill("Archive: {0}", target),
				};
			};
			let prepared: ReturnType<typeof prepare>;
			if (hasNativeMenus(ctx)) {
				// the Prism window asks the sessions, the files and the confirmation in one panel.
				let refused: string[] = [];
				const picked = (ids: string[]) => sessions.filter((_, index) => ids.includes(String(index)));
				const confirmed = await chooseExportNative(ctx, {
					sessions: sessions.map((session, index) => {
						const [label, ...meta] = sessionParts(session);
						return {
							id: String(index),
							label: label ?? "",
							description: meta.join(" · "),
							checked: session.path === current,
						};
					}),
					files: (ids) => {
						const problem = sessionsProblem(picked(ids));
						if (problem) return { problem: problem.message };
						const found = filesFor(picked(ids));
						refused = found.refused;
						return {
							files: found.offered.map((path) => ({ id: path, label: fileLabel(path), checked: false })),
						};
					},
					review: (ids, files) => {
						const data = prepare(picked(ids), files, refused);
						return {
							lines: [data.sessions, data.archive],
							items: data.items,
							warning: data.warning,
							destination: data.target,
							data,
						};
					},
					destination: changeDestination,
				});
				if (!confirmed) return;
				prepared = confirmed;
			} else {
				const pickedSessions = await chooseMany(
					ctx,
					t("Sessions to export"),
					sessions.map((session) => sessionParts(session).join(" · ")),
					sessions.map((session) => session.path === current),
				);
				if (!pickedSessions) return;
				const chosen = sessions.filter((_, index) => pickedSessions[index]);
				const problem = sessionsProblem(chosen);
				if (problem) {
					ctx.ui.notify(problem.message, problem.type);
					return;
				}
				const { offered, refused } = filesFor(chosen);
				let files: string[] = [];
				if (offered.length > 0) {
					const pickedFiles = await chooseMany(
						ctx,
						t("Files to include (none by default)"),
						offered.map(fileLabel),
						offered.map(() => false),
					);
					if (!pickedFiles) return;
					files = offered.filter((_, index) => pickedFiles[index]);
				}
				const create = t("Create the archive");
				const change = t("Change the destination");
				for (;;) {
					prepared = prepare(chosen, files, refused);
					const summary = [prepared.sessions, ...prepared.items, prepared.warning, prepared.archive].join("\n");
					const choice = await ctx.ui.select(`${t("Portable export")}\n\n${summary}`, [
						create,
						change,
						t("Cancel"),
					]);
					if (choice === create) break;
					if (choice !== change) return;
					// Escape keeps the destination shown; a problem is said, then the summary comes back.
					const typed = await ctx.ui.input(t("Archive destination (a file or a folder)"), prepared.target);
					const problem = typed === undefined ? undefined : changeDestination(typed);
					if (problem) ctx.ui.notify(problem, "warning");
				}
			}
			const { target, built } = prepared;
			try {
				writeArchiveFile(target, built.entries);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				ctx.ui.notify(fill("{0} already exists: nothing written.", target), "warning");
				return;
			}
			ctx.ui.notify(fill("Archive written: {0}", target), "info");
		},
	});
}
