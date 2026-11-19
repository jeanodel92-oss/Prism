/**
 * fork: with "only when my message contains @agent", the keyword was checked on
 * the prompt that started the run, after a skill or template was expanded. A steer sent during the run did not count,
 * so "@agent look" then "no, stop" still let the model run an agent, and a template whose text held the keyword
 * passed for a message that did not.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import agentsExtension, { writeAgent } from "../../src/fork/agents.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const REFUSED = "Refused: the user lets you run an agent only when their latest message contains @agent.";
const PASSED = "passed the keyword check";

describe("fork: the agent keyword is checked on the latest message the user sent", () => {
	const harnesses: Harness[] = [];
	let dir: string;
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		vi.unstubAllEnvs();
		rmSync(dir, { recursive: true, force: true });
	});

	async function start() {
		dir = mkdtempSync(join(tmpdir(), "prism-agent-keyword-"));
		vi.stubEnv(ENV_AGENT_DIR, dir);
		writeFileSync(
			join(dir, "settings.json"),
			JSON.stringify({
				agentInvocation: { autonomous: false, explicitRequest: false, keyword: true, keywordText: "@agent" },
			}),
		);
		writeAgent(
			{ name: "reader", description: "Reads", model: "fake/scripted", tools: ["read"], instructions: "Answer." },
			dir,
		);
		let release: () => void = () => {};
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		const wait: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Waits",
			parameters: Type.Object({}),
			execute: async () => {
				await released;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await createHarness({
			tools: [wait],
			extensionFactories: [
				(pi: ExtensionAPI) => agentsExtension(pi),
				// Runs after the agents gate: a call it let through stops here instead of starting a real agent.
				(pi: ExtensionAPI) =>
					pi.on("tool_call", (event) =>
						event.toolName === "agent" ? { block: true, reason: PASSED } : undefined,
					),
			],
		});
		harnesses.push(harness);
		const waiting = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start" && event.toolName === "wait") {
					unsubscribe();
					resolve();
				}
			});
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("agent", { agent: "reader", task: "look" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		return { harness, waiting, release };
	}

	const agentResult = (harness: Harness) =>
		getMessageText(harness.session.messages.find((m) => m.role === "toolResult" && m.toolName === "agent"));

	it("refuses once a steer without the keyword follows a prompt with it", async () => {
		const { harness, waiting, release } = await start();
		const run = harness.session.prompt("@agent look at the repo");
		await waiting;
		await harness.session.steer("no, do it yourself");
		release();
		await run;
		expect(agentResult(harness)).toContain(REFUSED);
	});

	it("lets the call through once a steer adds the keyword", async () => {
		const { harness, waiting, release } = await start();
		const run = harness.session.prompt("look at the repo");
		await waiting;
		await harness.session.steer("@agent take over");
		release();
		await run;
		expect(agentResult(harness)).toContain(PASSED);
	});
});
