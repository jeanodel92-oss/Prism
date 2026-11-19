// fork: an outcome is reported as it happened, never as a success
// the code did not check.
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { generateBranchSummary } from "../src/core/compaction/branch-summarization.ts";
import { type CompactionPreparation, compact, generateSummaryWithUsage } from "../src/core/compaction/index.ts";
import { execCommand } from "../src/core/exec.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { createBashTool } from "../src/core/tools/bash.ts";
import { OutputAccumulator } from "../src/core/tools/output-accumulator.ts";

const { completeSimpleMock } = vi.hoisted(() => ({ completeSimpleMock: vi.fn() }));
vi.mock("@earendil-works/pi-ai/compat", async (importOriginal) => ({
	...(await importOriginal<typeof import("@earendil-works/pi-ai/compat")>()),
	completeSimple: completeSimpleMock,
}));

const model = {
	id: "m",
	name: "M",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
} as Model<"anthropic-messages">;

const reply = (content: AssistantMessage["content"]): AssistantMessage => ({
	role: "assistant",
	content,
	api: "anthropic-messages",
	provider: "anthropic",
	model: "m",
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: Date.now(),
});

const EMPTY_REPLIES = [
	reply([]),
	reply([{ type: "text", text: "  \n " }]),
	reply([{ type: "thinking", thinking: "I would summarize." }]),
];

describe("fork: false successes and swallowed errors", () => {
	it("287: a command killed by a signal from outside does not exit 0", async () => {
		const killed = await execCommand(process.execPath, ["-e", "process.kill(process.pid, 'SIGKILL')"], process.cwd());
		expect(killed.code).toBe(137);
		expect(killed.killed).toBe(false);
		expect((await execCommand(process.execPath, ["-e", "process.exit(0)"], process.cwd())).code).toBe(0);
		expect((await execCommand(process.execPath, ["-e", "process.exit(3)"], process.cwd())).code).toBe(3);
	});

	it("072: a summary with no text is refused, for the history, a split turn and a branch", async () => {
		const messages: AgentMessage[] = [{ role: "user", content: "Summarize this.", timestamp: Date.now() }];
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "keep",
			messagesToSummarize: [],
			turnPrefixMessages: messages,
			isSplitTurn: true,
			tokensBefore: 100,
			fileOps: { read: new Set(["a.ts"]), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20 },
		};
		const entry = {
			type: "message",
			id: "e1",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: messages[0],
		} as SessionEntry;
		for (const [index, empty] of EMPTY_REPLIES.entries()) {
			completeSimpleMock.mockReset();
			completeSimpleMock.mockResolvedValue(empty);
			await expect(generateSummaryWithUsage(messages, model, 2000, "k"), `history ${index}`).rejects.toThrow(
				"Summarization failed: the summary is empty",
			);
			await expect(compact(preparation, model, "k"), `split turn ${index}`).rejects.toThrow(
				"Turn prefix summarization failed: the summary is empty",
			);
			const branch = await generateBranchSummary([entry], { model, signal: new AbortController().signal });
			expect(branch, `branch ${index}`).toEqual({ error: "Branch summarization failed: the summary is empty" });
		}
	});

	it("253: a full output log that cannot be written keeps the command's result and says the log is missing", async () => {
		vi.stubEnv("TMPDIR", join(tmpdir(), "prism-missing-tmp", "nested"));
		try {
			const output = new OutputAccumulator({ maxLines: 10, maxBytes: 1000 });
			for (let line = 1; line <= 50; line++) output.append(Buffer.from(`line ${line}\n`));
			output.finish();
			const snapshot = output.snapshot({ persistIfTruncated: true });
			expect(snapshot.fullOutputPath).toBeUndefined();
			expect(snapshot.fullOutputError).toContain("ENOENT");
			await output.closeTempFile();
			const full = await output.readFullOutput(100);
			expect(full.truncated).toBe(true);
			expect(full.content).toContain("line 50");

			const result = await createBashTool(process.cwd()).execute("bash-log", { command: "seq 1 3000" });
			const text = result.content.map((block) => ("text" in block ? block.text : "")).join("");
			expect(text).toContain("3000");
			expect(text).toContain("Full output: not saved");
			expect(text).not.toContain("undefined");
		} finally {
			vi.unstubAllEnvs();
		}
	});
});
