/**
 * fork: what the summary of a branch being left is built from.
 *
 * - Its messages are those the model saw on that branch: the session projection (buildSessionProjection) applies
 *   the compactions and the context edits, so a message removed or replaced in context is not sent again.
 * - Its token budget stays positive: a reserve as large as the context window used to mean "no limit".
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { buildSessionProjection, type SessionEntry } from "../core/session-manager.ts";

/** One entry of the branch with the message it gives the summary. */
export interface BranchSummarySource {
	entry: SessionEntry;
	message: AgentMessage;
}

/**
 * The entries' messages as the model saw them, in order. `toMessage` is the summary's own choice per entry (tool
 * results left out, a compaction as its summary); the projection decides which entries count and their content.
 * Entries that are not one path of the tree (a caller's own list) keep their raw messages.
 */
export function branchSummarySources(
	entries: readonly SessionEntry[],
	toMessage: (entry: SessionEntry) => AgentMessage | undefined,
): BranchSummarySource[] {
	const raw = () =>
		entries.flatMap((entry) => {
			const message = toMessage(entry);
			return message ? [{ entry, message }] : [];
		});
	const last = entries.at(-1);
	if (!last || entries.some((entry, index) => index > 0 && entry.parentId !== entries[index - 1]!.id)) return raw();
	// The path stops at the first entry: a compaction or an edit before the branch cannot reach into it.
	const projection = buildSessionProjection([...entries], last.id);
	const sources: BranchSummarySource[] = [];
	for (const { sourceEntry, messages } of projection.entries) {
		// Left out of context (an edit with no replacement, an older compaction), or nothing the model reads.
		if (messages.length === 0) continue;
		const message = toMessage(sourceEntry);
		if (!message) continue;
		// A message or custom message carries its edited content; a summary entry cannot be edited.
		const projected =
			sourceEntry.type === "message" || sourceEntry.type === "custom_message" ? messages[0] : undefined;
		sources.push({ entry: sourceEntry, message: projected ?? message });
	}
	return sources;
}

/**
 * The tokens of branch history a summary request may hold. The configured reserve is kept when it leaves room;
 * when it is as large as the window, the request keeps room for the summary's reply and its fixed prompt only.
 */
export function branchSummaryBudget(
	model: { contextWindow?: number; maxTokens?: number },
	reserveTokens: number,
	promptText: string,
): number {
	const contextWindow = model.contextWindow || 128000;
	const budget = contextWindow - reserveTokens;
	if (budget > 0) return budget;
	const reply = Math.min(4096, model.maxTokens && model.maxTokens > 0 ? model.maxTokens : 4096);
	return Math.max(1, contextWindow - reply - Math.ceil(promptText.length / 4));
}
