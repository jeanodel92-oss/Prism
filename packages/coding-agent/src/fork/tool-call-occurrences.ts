/**
 * fork: a tool call id is unique within one assistant message, not within a
 * session: two turns, or two branches, may reuse it. A tool result belongs to the call of that id in the nearest
 * assistant message above it in the tree, and both are keyed by that message's entry id and the call id.
 *
 * `core/export-html/template.js` runs in the browser and repeats this pairing in `pairToolCalls`; keep them alike.
 */

import type { SessionEntry } from "../core/session-manager.ts";

/** The key of one tool call: the entry of the assistant message that made it, and its id. */
export function toolCallKey(ownerEntryId: string, toolCallId: string): string {
	return `${ownerEntryId}:${toolCallId}`;
}

export interface ToolCallPairing {
	/** Tool result entry id to the entry id of the assistant message whose call it answers. */
	ownerOfResult: Map<string, string>;
	/** Tool call key to the entry id of its first result. */
	resultOfCall: Map<string, string>;
}

export function pairToolCalls(entries: readonly SessionEntry[]): ToolCallPairing {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const ownerOfResult = new Map<string, string>();
	const resultOfCall = new Map<string, string>();
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "toolResult" || !entry.message.toolCallId) continue;
		const callId = entry.message.toolCallId;
		let parent = entry.parentId ? byId.get(entry.parentId) : undefined;
		while (parent && !(parent.type === "message" && parent.message.role === "assistant")) {
			parent = parent.parentId ? byId.get(parent.parentId) : undefined;
		}
		if (parent?.type !== "message" || parent.message.role !== "assistant") continue;
		const content = parent.message.content;
		if (!Array.isArray(content) || !content.some((block) => block.type === "toolCall" && block.id === callId))
			continue;
		ownerOfResult.set(entry.id, parent.id);
		const key = toolCallKey(parent.id, callId);
		if (!resultOfCall.has(key)) resultOfCall.set(key, entry.id);
	}
	return { ownerOfResult, resultOfCall };
}
