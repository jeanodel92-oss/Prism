/**
 * a sub-agent's full transcript.
 *
 * A sub-agent keeps its own session, next to the session that started it: `<session dir>/<session id>.agents/`. Session
 * lists read only the `.jsonl` files of a directory, so these never show among the user's sessions. A session that is
 * not saved to a file (`--no-session`) starts its agents without one, as before.
 */

import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ReadonlySessionManager } from "../core/session-manager.ts";
import { SessionManager } from "../core/session-manager.ts";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Each text of the transcript is cut there: a tool's output can be megabytes. */
const MAX_TEXT = 20_000;

export interface AgentTranscriptEntry {
	kind: "user" | "assistant" | "thinking" | "tool" | "note";
	text?: string;
	/** A tool call: its name, its arguments as JSON, its output once it has one. */
	name?: string;
	args?: string;
	output?: string;
	error?: boolean;
}

/** Where this session's sub-agents keep their sessions; `undefined` when it is not saved to a file. */
export function agentSessionDir(
	sessionManager: Pick<ReadonlySessionManager, "getSessionFile" | "getSessionId">,
): string | undefined {
	const file = sessionManager.getSessionFile();
	return file ? join(dirname(file), `${sessionManager.getSessionId()}.agents`) : undefined;
}

const cut = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n[…]` : text);

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) =>
			part && typeof part === "object" && (part as { type?: unknown }).type === "text"
				? [String((part as { text?: unknown }).text ?? "")]
				: [],
		)
		.join("\n");
}

/**
 * The transcript of the sub-agent whose session has that id, in order: its task, its replies and thinking, each tool
 * call with its output. Empty while the agent has not written its session yet (before its first reply).
 */
export function agentTranscript(
	sessionManager: Pick<ReadonlySessionManager, "getSessionFile" | "getSessionId">,
	id: string,
): { entries: AgentTranscriptEntry[] } {
	if (!SESSION_ID.test(id)) throw new Error("Invalid agent session id.");
	const dir = agentSessionDir(sessionManager);
	const file = dir && existsSync(dir) ? readdirSync(dir).find((name) => name.endsWith(`_${id}.jsonl`)) : undefined;
	if (!dir || !file) return { entries: [] };
	const entries: AgentTranscriptEntry[] = [];
	const calls = new Map<string, AgentTranscriptEntry>();
	for (const entry of SessionManager.open(join(dir, file), dir).getEntries()) {
		if (entry.type === "custom_message") {
			const text = textOf(entry.content);
			if (text) entries.push({ kind: "note", text: cut(text) });
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: string; content?: unknown; toolCallId?: unknown; isError?: unknown };
		if (message.role === "user") entries.push({ kind: "user", text: cut(textOf(message.content)) });
		else if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const part of message.content as Array<Record<string, unknown>>) {
				if (part.type === "text" && typeof part.text === "string" && part.text.trim())
					entries.push({ kind: "assistant", text: cut(part.text) });
				else if (part.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim())
					entries.push({ kind: "thinking", text: cut(part.thinking) });
				else if (part.type === "toolCall") {
					const call: AgentTranscriptEntry = {
						kind: "tool",
						name: String(part.name ?? ""),
						args: cut(JSON.stringify(part.arguments ?? {}, null, 2)),
					};
					entries.push(call);
					if (typeof part.id === "string") calls.set(part.id, call);
				}
			}
		} else if (message.role === "toolResult") {
			const call = typeof message.toolCallId === "string" ? calls.get(message.toolCallId) : undefined;
			if (call) {
				call.output = cut(textOf(message.content));
				call.error = message.isError === true;
			}
		} else {
			const text = textOf(message.content);
			if (text) entries.push({ kind: "note", text: cut(text) });
		}
	}
	return { entries };
}
