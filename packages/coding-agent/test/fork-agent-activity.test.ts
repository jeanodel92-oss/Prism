// what a subagent does, step by step, read from its process's events.
import { describe, expect, it } from "vitest";
import { AgentActivity, MAX_AGENT_STEPS, stepLine, stepTarget } from "../src/fork/agent-activity.ts";

describe("fork: a subagent's steps", () => {
	it("records each tool call, its end, and what the agent says between calls", () => {
		const activity = new AgentActivity();
		expect(
			activity.record({
				type: "message_end",
				message: {
					role: "assistant",
					stopReason: "toolUse",
					content: [{ type: "text", text: "Looking\naround." }],
				},
			}),
		).toBe(true);
		activity.record({ type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: { command: "ls -la" } });
		activity.record({
			type: "tool_execution_start",
			toolCallId: "b",
			toolName: "grep",
			args: { pattern: "TODO", path: "src" },
		});
		const sent = activity.snapshot();
		activity.record({ type: "tool_execution_end", toolCallId: "a", isError: false });
		activity.record({ type: "tool_execution_end", toolCallId: "b", isError: true });
		// The final answer is the tool's result, not a step.
		expect(
			activity.record({
				type: "message_end",
				message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done." }] },
			}),
		).toBe(false);
		expect(activity.steps.map(stepLine)).toEqual(["  “Looking around.”", "✓ bash ls -la", "✗ grep TODO in src"]);
		// What an update sent does not change afterwards.
		expect(sent.steps.map(stepLine)).toEqual(["  “Looking around.”", "… bash ls -la", "… grep TODO in src"]);
	});

	it("keeps the newest steps and counts the others", () => {
		const activity = new AgentActivity();
		for (let i = 0; i < MAX_AGENT_STEPS + 5; i++)
			activity.record({
				type: "tool_execution_start",
				toolCallId: String(i),
				toolName: "read",
				args: { path: `f${i}` },
			});
		expect(activity.steps).toHaveLength(MAX_AGENT_STEPS);
		expect(activity.dropped).toBe(5);
		expect(activity.steps[0]?.target).toBe("f5");
	});

	it("names what a call works on in one short line", () => {
		expect(stepTarget("read", { path: "a.ts" })).toBe("a.ts");
		expect(stepTarget("find", { pattern: "*.md" })).toBe("*.md");
		expect(stepTarget("custom", { n: 1, label: "x\ny" })).toBe("x y");
		expect(stepTarget("bash", { command: "x".repeat(300) })).toHaveLength(120);
		expect(stepTarget("ls", undefined)).toBe("");
	});
});
