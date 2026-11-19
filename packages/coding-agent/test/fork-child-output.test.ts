// fork: output of the Prism processes that the agent tool starts. Lines are split in one pass
// whatever the chunking, characters cut between two chunks survive, and a line that is JSON but not an event is
// ignored instead of ending Prism. Replay the fuzz with PI_FUZZ_SEED.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import agentsExtension, { writeAgent } from "../src/fork/agents.ts";
import { ChildLines, MAX_CHILD_LINE_BYTES } from "../src/fork/child-process.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

function makeRandom(seed: number): () => number {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
		return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
	};
}

const seed = Number(process.env.PI_FUZZ_SEED ?? 7_718);

describe("fork: child process output", () => {
	it("splits any chunking of the output into the same lines", () => {
		const random = makeRandom(seed);
		const alphabet = ["a", "é", "\n", "\n", "{", "😀", " "];
		for (let index = 0; index < 2000; index++) {
			let output = "";
			for (let length = Math.floor(random() * 60); length > 0; length--) {
				output += alphabet[Math.floor(random() * alphabet.length)];
			}
			const reader = new ChildLines();
			const lines: string[] = [];
			for (let start = 0; start < output.length; ) {
				const end = start + 1 + Math.floor(random() * 8);
				const parsed = reader.push(output.slice(start, end));
				expect(parsed.overflow).toBe(false);
				lines.push(...parsed.lines);
				start = end;
			}
			const expected = output.split("\n");
			expect([...lines, reader.rest()], `seed=${seed} case=${index} ${JSON.stringify(output)}`).toEqual(expected);
		}
	});

	it("reports a line over the limit, finished or not, and reads a long line in linear time", () => {
		const half = "é".repeat(MAX_CHILD_LINE_BYTES / 4);
		const reader = new ChildLines();
		expect(reader.push(half).overflow).toBe(false);
		expect(reader.push(half).overflow).toBe(false);
		expect(reader.push("x").overflow).toBe(true);
		expect(new ChildLines().push(`${half}${half}x\n`).overflow).toBe(true);
		const split = new ChildLines();
		split.push(half);
		expect(split.push(`${half}x\nnext`).overflow).toBe(true);
		expect(new ChildLines().push(`${half}${half}\nnext`)).toMatchObject({
			overflow: false,
			lines: [`${half}${half}`],
		});

		const chunk = "x".repeat(64 * 1024);
		const started = performance.now();
		const long = new ChildLines();
		for (let count = 0; count < 256; count++) long.push(chunk);
		expect(long.push("\n").lines[0]).toHaveLength(16 * 1024 * 1024);
		// The old splitter took 1.2 s here; one pass takes tens of milliseconds.
		expect(performance.now() - started).toBeLessThan(500);
	});

	describe("agent", () => {
		let harness: Harness | undefined;
		let agentDir = "";
		const saved = { script: process.argv[1], agentDir: process.env[ENV_AGENT_DIR] };

		afterEach(() => {
			harness?.cleanup();
			harness = undefined;
			process.argv[1] = saved.script!;
			if (saved.agentDir === undefined) delete process.env[ENV_AGENT_DIR];
			else process.env[ENV_AGENT_DIR] = saved.agentDir;
			delete process.env.FAKE_AGENT_CHILD;
			rmSync(agentDir, { recursive: true, force: true });
		});

		async function runAgent(mode: string): Promise<string> {
			agentDir = mkdtempSync(join(tmpdir(), "prism-child-output-"));
			process.env[ENV_AGENT_DIR] = agentDir;
			writeAgent({ name: "other", description: "answers", tools: ["read"], instructions: "Answer." });
			process.env.FAKE_AGENT_CHILD = mode;
			// The agent tool starts the current script again; here it is the fake child.
			process.argv[1] = new URL("./fixtures/fake-agent-child.mjs", import.meta.url).pathname;
			harness = await createHarness({ extensionFactories: [agentsExtension] });
			await harness.session.bindExtensions({ uiContext: createTestUiContext() });
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("agent", { agent: "other", task: "question" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
				// the agent answers in a message, which starts a turn of its own.
				fauxAssistantMessage("done"),
			]);
			const uncaught: unknown[] = [];
			const listener = (error: unknown) => uncaught.push(error);
			process.on("uncaughtException", listener);
			let answer: unknown;
			try {
				await harness.session.prompt("go");
				// with an interface, the agent runs in the background and
				// its answer comes as a message.
				await vi.waitFor(
					() => {
						answer = harness?.session.messages.find(
							(message) => message.role === "custom" && message.customType === "agent-answer",
						);
						expect(answer).toBeDefined();
					},
					{ timeout: 15_000 },
				);
			} finally {
				process.off("uncaughtException", listener);
			}
			expect(uncaught).toEqual([]);
			const result = harness.session.messages.findLast((message) => message.role === "toolResult")!;
			expect(result.isError).toBe(false);
			return String((answer as { content: unknown }).content);
		}

		it("keeps a character cut between two chunks", async () => {
			expect(await runAgent("split-character")).toContain("café crème");
		});

		it("ignores lines that are JSON but not events", async () => {
			expect(await runAgent("not-an-object")).toContain("answer after junk");
		});
	});
});
