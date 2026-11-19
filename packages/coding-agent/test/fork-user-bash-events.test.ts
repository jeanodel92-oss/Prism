// fork: a user's bash command (`!`) is told to every client of the engine, so the other screen of
// a shared session shows it: its start, then its end with the message the session records.
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type { BashOperations } from "../src/core/tools/bash.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const bashEvents = (events: AgentSessionEvent[]) => events.filter((event) => event.type.startsWith("bash_execution_"));

describe("user bash events", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("tells the start of a command, then its end with the message the session holds", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		await harness.session.executeBash("printf 'hello'", undefined, { id: "req-1", excludeFromContext: true });

		const events = bashEvents(harness.events);
		expect(events[0]).toEqual({
			type: "bash_execution_start",
			id: "req-1",
			command: "printf 'hello'",
			excludeFromContext: true,
		});
		const end = events[events.length - 1];
		expect(end.type).toBe("bash_execution_end");
		if (end.type !== "bash_execution_end") return;
		expect(end.id).toBe("req-1");
		expect(end.pending).toBeUndefined();
		expect(end.message?.output).toContain("hello");
		// The message of the event is the one the session holds: a client that reads the session knows it by it.
		expect(harness.session.messages[harness.session.messages.length - 1]).toBe(end.message);
	});

	it("tells the end of a command that could not run, without a message", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const failing: BashOperations = {
			exec: async () => {
				throw new Error("no shell");
			},
		};

		await expect(harness.session.executeBash("ls", undefined, { operations: failing })).rejects.toThrow("no shell");

		expect(bashEvents(harness.events).map((event) => event.type)).toEqual([
			"bash_execution_start",
			"bash_execution_end",
		]);
		expect(bashEvents(harness.events)[1]).toEqual({ type: "bash_execution_end", id: undefined });
		expect(harness.session.messages.some((message) => message.role === "bashExecution")).toBe(false);
	});

	it("marks the end of a command that ended during a turn as pending, and of one an extension ran", async () => {
		let release: (() => void) | undefined;
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				await released;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [waitTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const toolStarted = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start") {
					unsubscribe();
					resolve();
				}
			});
		});

		const prompt = harness.session.prompt("start");
		await toolStarted;
		// An extension that ran the command itself records its result: no start, an end.
		harness.session.recordBashResult("echo hi", { output: "hi", exitCode: 0, cancelled: false, truncated: false });

		const during = bashEvents(harness.events);
		expect(during.map((event) => event.type)).toEqual(["bash_execution_end"]);
		expect(during[0]).toMatchObject({ pending: true, message: { command: "echo hi", output: "hi" } });
		expect(harness.session.messages.some((message) => message.role === "bashExecution")).toBe(false);

		release?.();
		await prompt;
		// Settled: the session holds it, after the events said so.
		const types = harness.events.map((event) => event.type);
		expect(types.indexOf("agent_settled")).toBeGreaterThan(types.indexOf("bash_execution_end"));
		expect(harness.session.messages.some((message) => message.role === "bashExecution")).toBe(true);
	});
});
