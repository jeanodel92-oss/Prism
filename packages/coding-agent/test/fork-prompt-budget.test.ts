/**
 * fork: the site says Prism's first request is about 7,000 tokens of
 * system prompt and tool definitions (fork/tools/prompt-cost.sh measures it exactly). Nothing failed when it grew.
 * This test puts a ceiling on that size with the default modules, measured in characters (stable, unlike a token
 * count, which depends on the model's tokenizer), so a change that inflates the prompt fails here and must raise the
 * ceiling on purpose; then re-measure with prompt-cost.sh and fix the site's figure if it no longer holds.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

/** Measured 2026-11-23 on dev: 11,035 + 30,372 = 41,407 characters; the ceiling leaves 10 %. Raise on purpose only. */
const CEILING_CHARS = 45_500;

describe("fork: size of the first request (TESTS-05)", () => {
	const saved = process.env[ENV_AGENT_DIR];
	const savedHome = process.env.HOME;
	let harness: Harness | undefined;
	let agentDir: string;
	let home: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-prompt-budget-"));
		home = mkdtempSync(join(tmpdir(), "prism-prompt-budget-home-"));
		process.env[ENV_AGENT_DIR] = agentDir;
		process.env.HOME = home;
	});

	afterEach(() => {
		harness?.cleanup();
		if (saved === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = saved;
		if (savedHome === undefined) delete process.env.HOME;
		else process.env.HOME = savedHome;
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	});

	it("keeps the system prompt and tool definitions under the ceiling with the default modules", async () => {
		harness = await createHarness({ extensionFactories: builtInExtensions });
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });
		let size: { prompt: number; tools: number } | undefined;
		const current = harness;
		current.setResponses([
			() => {
				const { systemPrompt, tools } = current.session.agent.state;
				size = {
					prompt: systemPrompt.length,
					tools: JSON.stringify(
						tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
					).length,
				};
				return fauxAssistantMessage("done");
			},
		]);
		await current.session.prompt("hello");
		if (!size) throw new Error("no request");
		const total = size.prompt + size.tools;
		expect(total).toBeLessThanOrEqual(CEILING_CHARS);
	});
});
