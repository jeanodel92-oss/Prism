import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import checkpoints from "../../src/fork/checkpoints.ts";
import permissions from "../../src/fork/permissions.ts";
import { createHarness, createTestUiContext, type Harness } from "./harness.ts";

describe("fork agentic scenarios", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		vi.unstubAllEnvs();
	});

	async function createForkHarness(mode: "broad" | "safe" = "broad", confirm = false): Promise<Harness> {
		const harness = await createHarness({ extensionFactories: [permissions, checkpoints] });
		harnesses.push(harness);
		const agentDir = join(harness.tempDir, "agent");
		mkdirSync(agentDir);
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode }));
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({ confirm: async () => confirm }),
		});
		return harness;
	}

	function toolResults(messages: readonly unknown[]): ToolResultMessage[] {
		return messages.filter(
			(message): message is ToolResultMessage =>
				typeof message === "object" && message !== null && "role" in message && message.role === "toolResult",
		);
	}

	it("reads, edits, reads back, and returns the final answer", async () => {
		const harness = await createForkHarness();
		const file = join(harness.tempDir, "note.txt");
		writeFileSync(file, "before\n");
		const received: ToolResultMessage[][] = [];
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "note.txt" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("edit", { path: "note.txt", oldText: "before", newText: "after" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("read", { path: "note.txt" })], { stopReason: "toolUse" }),
			(context) => {
				received.push(toolResults(context.messages));
				return fauxAssistantMessage("Updated and verified.");
			},
		]);

		await harness.session.prompt("Change before to after, verify it, then report.");

		expect(readFileSync(file, "utf8")).toBe("after\n");
		expect(
			harness.session.messages.filter((message) => message.role === "toolResult").map((message) => message.toolName),
		).toEqual(["read", "edit", "read"]);
		expect(
			received[0]?.map((message) => message.content.map((part) => (part.type === "text" ? part.text : "")).join("")),
		).toEqual(["before\n", "Successfully replaced 1 block(s) in note.txt.", "after\n"]);
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "Updated and verified." }],
		});
		expect(harness.eventsOfType("tool_execution_end")).toHaveLength(3);
	});

	it("surfaces a failed edit and recovers on the next prompt", async () => {
		const harness = await createForkHarness();
		const file = join(harness.tempDir, "recover.txt");
		writeFileSync(file, "current\n");
		let failedResult: ToolResultMessage | undefined;
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("edit", { path: "recover.txt", oldText: "missing", newText: "wrong" })], {
				stopReason: "toolUse",
			}),
			(context) => {
				failedResult = toolResults(context.messages).find((message) => message.toolName === "edit");
				return fauxAssistantMessage("The edit did not match.");
			},
			fauxAssistantMessage(
				[fauxToolCall("edit", { path: "recover.txt", oldText: "current", newText: "recovered" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Recovered on the next prompt."),
		]);

		await harness.session.prompt("Try an edit with the wrong old text.");
		expect(failedResult?.isError).toBe(true);
		await harness.session.prompt("Correct the file using its current contents.");

		expect(readFileSync(file, "utf8")).toBe("recovered\n");
		expect(harness.session.messages.filter((message) => message.role === "assistant").at(-1)).toMatchObject({
			content: [{ type: "text", text: "Recovered on the next prompt." }],
		});
		expect(harness.eventsOfType("agent_end").length).toBeGreaterThanOrEqual(2);
	});

	it("uses bash output in the model's following turn", async () => {
		const harness = await createForkHarness();
		let observedOutput = "";
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "printf 'value=42\\n'" })], { stopReason: "toolUse" }),
			(context) => {
				observedOutput =
					toolResults(context.messages)
						.at(-1)
						?.content.map((part) => (part.type === "text" ? part.text : ""))
						.join("") ?? "";
				return fauxAssistantMessage(observedOutput.includes("value=42") ? "The value is 42." : "Missing value.");
			},
		]);

		await harness.session.prompt("Run the command and report its value.");

		expect(observedOutput).toContain("value=42");
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "The value is 42." }],
		});
		expect(harness.eventsOfType("tool_execution_end").some((event) => event.toolName === "bash")).toBe(true);
	});

	it("undoes an edit through the checkpoints extension", async () => {
		const harness = await createForkHarness("broad", true);
		const file = join(harness.tempDir, "undo.txt");
		writeFileSync(file, "original\n");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("edit", { path: "undo.txt", oldText: "original", newText: "changed" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Changed."),
		]);

		await harness.session.prompt("Change the file.");
		expect(readFileSync(file, "utf8")).toBe("changed\n");
		await harness.session.prompt("/undo");

		expect(readFileSync(file, "utf8")).toBe("original\n");
		expect(harness.session.messages.filter((message) => message.role === "toolResult")).toHaveLength(1);
	});

	it("reports safe-mode permission denial as an error without writing", async () => {
		const harness = await createForkHarness("safe");
		const file = join(harness.tempDir, "blocked.txt");
		let deniedResult: ToolResultMessage | undefined;
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "blocked.txt", content: "must not exist" })], {
				stopReason: "toolUse",
			}),
			(context) => {
				deniedResult = toolResults(context.messages).find((message) => message.toolName === "write");
				return fauxAssistantMessage("Write was blocked safely.");
			},
		]);

		await harness.session.prompt("Write the file.");

		expect(deniedResult?.isError).toBe(true);
		expect(deniedResult?.content.map((part) => (part.type === "text" ? part.text : "")).join(" ")).toContain("safe");
		expect(() => readFileSync(file, "utf8")).toThrow();
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "Write was blocked safely." }],
		});
		expect(harness.eventsOfType("tool_execution_end")).toHaveLength(1);
	});

	it("aborts a slow bash tool and accepts a new prompt", async () => {
		const harness = await createForkHarness();
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("bash", { command: "printf 'started\\n'; sleep 10; printf 'finished\\n'" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("The new prompt worked."),
		]);
		let releaseStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			releaseStarted = resolve;
		});
		const unsubscribe = harness.session.subscribe((event) => {
			if (
				event.type === "tool_execution_update" &&
				event.toolName === "bash" &&
				JSON.stringify(event.partialResult).includes("started")
			) {
				releaseStarted?.();
			}
		});
		const interruptedPrompt = harness.session.prompt("Start a slow command.");
		await started;
		await harness.session.abort();
		await interruptedPrompt;
		unsubscribe();
		harness.setResponses([fauxAssistantMessage("The new prompt worked.")]);

		await harness.session.prompt("Continue after the interruption.");

		expect(
			harness.session.messages
				.filter((message) => message.role === "assistant")
				.some((message) => message.stopReason === "aborted"),
		).toBe(true);
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "The new prompt worked." }],
		});
		expect(harness.session.isStreaming).toBe(false);
	});
});
