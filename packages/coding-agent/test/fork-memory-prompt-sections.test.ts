// fork: a non-empty memory file used to return a full
// systemPrompt, which forced the prompt and dropped every structured addition made after it
// (append-system's instructions, any later section).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import appendSystemExtension, { APPEND_SYSTEM_TEXT } from "../src/fork/append-system.ts";
import memoryExtension from "../src/fork/memory.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

describe("fork: memory keeps later prompt additions", () => {
	let agentDir: string;
	const savedAgentDir = process.env[ENV_AGENT_DIR];
	const harnesses: Harness[] = [];

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-memory-sections-"));
		process.env[ENV_AGENT_DIR] = agentDir;
	});

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		if (savedAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = savedAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("keeps append-system and a later section when memory is not empty", async () => {
		writeFileSync(join(agentDir, "MEMORY.md"), "# Memory\n\n- prefers tabs\n");
		const later = (pi: ExtensionAPI) => {
			pi.on("before_agent_start", async (event) => {
				event.systemPromptOptions.sections.later_probe = "later section text";
			});
		};
		// Built-in order: memory runs before append-system.
		const harness = await createHarness({
			extensionFactories: [
				{ name: "memory", factory: memoryExtension },
				{ name: "append-system", factory: appendSystemExtension },
				{ name: "later", factory: later },
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });

		const prompts: string[] = [];
		const capture = () => {
			prompts.push(harness.session.systemPrompt);
			return fauxAssistantMessage("ok");
		};
		harness.setResponses([capture, capture]);
		await harness.session.prompt("hi");
		await harness.session.prompt("again");

		const [first, second] = prompts;
		expect(first).toContain("## Memory (global)\n# Memory\n\n- prefers tabs");
		expect(first).toContain(APPEND_SYSTEM_TEXT);
		expect(first).toContain("later section text");
		// Identical on every turn, so the prompt cache still holds.
		expect(second).toBe(first);
	});
});
