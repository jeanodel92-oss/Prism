/**
 * fork: the summary of a branch being left.
 * - a reserve as large as the context window sent the whole branch to the summarizer.
 * - its file lists missed the files edited from codemode, and those edited before the budget's cut.
 * - it sent again the messages that context edits had removed or replaced, and those a compaction summarised.
 */
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { generateBranchSummary, prepareBranchEntries } from "../src/core/compaction/index.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";

const model: Model<"anthropic-messages"> = {
	id: "test-model",
	name: "Test Model",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 4096,
};

type Entry = SessionEntry extends infer E
	? E extends SessionEntry
		? Omit<E, "id" | "parentId" | "timestamp">
		: never
	: never;

/** One path of entries, each the child of the one before. */
function path(...entries: Entry[]): SessionEntry[] {
	return entries.map(
		(entry, index) =>
			({
				...entry,
				id: `e${index}`,
				parentId: index === 0 ? null : `e${index - 1}`,
				timestamp: new Date(index + 1).toISOString(),
			}) as SessionEntry,
	);
}

const user = (text: string): Entry => ({ type: "message", message: { role: "user", content: text, timestamp: 1 } });
const assistantCall = (name: string, path: string): Entry => ({
	type: "message",
	message: {
		...fauxAssistantMessage(""),
		content: [{ type: "toolCall", id: `call-${path}`, name, arguments: { path } }],
	},
});

describe("fork: the summary of a branch being left", () => {
	it("keeps the branch within the context window when the reserve is as large as it", async () => {
		// Twenty messages of about 1000 tokens each: far more than an 8192-token window.
		const entries = path(...Array.from({ length: 20 }, (_, i) => user(`message ${i} ${"x".repeat(4000)}`)));
		for (const reserveTokens of [16384, 8192]) {
			let sent = "";
			const streamFn: StreamFn = (_model, context: Context) => {
				sent = context.messages
					.flatMap((message) =>
						typeof message.content === "string"
							? [message.content]
							: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
					)
					.join("\n");
				const stream = createAssistantMessageEventStream();
				const message: AssistantMessage = {
					...fauxAssistantMessage(""),
					content: [{ type: "text", text: "summary" }],
					api: model.api,
					provider: model.provider,
					model: model.id,
				};
				queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
				return stream;
			};
			const result = await generateBranchSummary(entries, {
				model,
				reserveTokens,
				signal: new AbortController().signal,
				streamFn,
			});
			expect(result.error).toBeUndefined();
			// The request fits the window with the reply's 4096 tokens: the newest messages, not all twenty.
			expect(Math.ceil(sent.length / 4) + 4096).toBeLessThanOrEqual(model.contextWindow);
			expect(sent).toContain("message 19");
			expect(sent).not.toContain("message 0 ");
		}
	});

	it("lists the files edited from codemode and before the budget's cut", () => {
		const nested: Entry = {
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "call-codemode",
				toolName: "codemode",
				content: [{ type: "text", text: "done" }],
				nestedCalls: {
					calls: [{ id: "n1", name: "edit", arguments: { path: "nested.ts" }, status: "ok" }],
					complete: true,
				},
				isError: false,
				timestamp: 1,
			},
		};
		const entries = path(assistantCall("edit", "early.ts"), user("y".repeat(4000)), nested, user("z".repeat(4000)));
		// Room for the last message only.
		const prepared = prepareBranchEntries(entries, 1500);
		expect(prepared.messages).toHaveLength(1);
		expect([...prepared.fileOps.edited].sort()).toEqual(["early.ts", "nested.ts"]);
	});

	it("leaves out what context edits removed or replaced, and what a compaction summarised", () => {
		const entries = path(
			user("summarised away"),
			user("kept by the compaction"),
			{
				type: "compaction",
				summary: "compaction summary",
				firstKeptEntryId: "e1",
				tokensBefore: 10,
			},
			user("secret removed from context"),
			{ type: "context_edit", targetId: "e3", replacement: null },
			user("first wording"),
			{ type: "context_edit", targetId: "e5", replacement: { content: "corrected wording" } },
		);
		const text = JSON.stringify(prepareBranchEntries(entries).messages);
		expect(text).toContain("compaction summary");
		expect(text).toContain("kept by the compaction");
		expect(text).toContain("corrected wording");
		expect(text).not.toContain("summarised away");
		expect(text).not.toContain("secret removed");
		expect(text).not.toContain("first wording");
	});

	it("keeps a list of entries that is not one path as it is", () => {
		const entries = path(user("a"), user("b"));
		entries[1] = { ...entries[1]!, parentId: "elsewhere" };
		expect(prepareBranchEntries(entries).messages).toHaveLength(2);
	});
});
