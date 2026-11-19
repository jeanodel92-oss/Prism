// fork: the interface language changes what the user reads, never what the
// model receives. Tool definitions and the harness's own prompt sections stay in English whatever the language.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import { writeAgent } from "../src/fork/agents.ts";
import { type Language, setLanguage } from "../src/fork/i18n/index.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, createTestUiContext, getMessageText, getToolResult, type Harness } from "./suite/harness.ts";

describe("fork: the interface language never reaches the model", () => {
	const saved = process.env[ENV_AGENT_DIR];
	const savedHome = process.env.HOME;
	const harnesses: Harness[] = [];
	let agentDir: string;
	let home: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-model-facing-"));
		process.env[ENV_AGENT_DIR] = agentDir;
		// The prompt lists the tools' folders that exist in the home folder. Under ./test.sh, another test file can
		// create one in the shared home between the two requests (config.test.ts runs `pnpm`, which makes
		// ~/.local/share/pnpm): this test has its own.
		home = mkdtempSync(join(tmpdir(), "prism-model-facing-home-"));
		process.env.HOME = home;
		// With an agent, the agent tool is registered too.
		writeAgent({ name: "reader", description: "Reads files.", tools: ["read"], instructions: "Read." }, agentDir);
	});

	afterEach(() => {
		setLanguage("en");
		for (const harness of harnesses.splice(0)) harness.cleanup();
		if (saved === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = saved;
		if (savedHome === undefined) delete process.env.HOME;
		else process.env.HOME = savedHome;
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	});

	async function firstRequest(language: Language): Promise<{ systemPrompt: string; tools: unknown }> {
		setLanguage(language);
		const harness = await createHarness({ extensionFactories: builtInExtensions });
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });
		// What the agent sends with this request: its state while the provider answers.
		let seen: { systemPrompt: string; tools: unknown } | undefined;
		harness.setResponses([
			() => {
				const { systemPrompt, tools } = harness.session.agent.state;
				seen = {
					// The temp dirs differ from one session to the next. The hidden paths are the ones that exist,
					// and under ./test.sh another test file can create one (~/.pi) between the two requests.
					systemPrompt: systemPrompt
						.replaceAll(harness.tempDir, "<cwd>")
						.replace(/(hidden and give "Permission denied": ).*/, "$1<paths>"),
					tools: tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
				};
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("hello");
		if (!seen) throw new Error("no request");
		return seen;
	}

	it("sends the same tool definitions and system prompt in English and in French", async () => {
		const english = await firstRequest("en");
		const french = await firstRequest("fr");
		expect(english.tools).not.toEqual([]);
		expect(JSON.stringify(english.tools)).toContain('"agent"');
		expect(french.tools).toEqual(english.tools);
		expect(french.systemPrompt).toBe(english.systemPrompt);
	});

	it("returns the harness's tool errors to the model in English, and shows them translated", async () => {
		initTheme("dark");
		setLanguage("fr");
		writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ allow: ["agent"] }));
		const harness = await createHarness({ extensionFactories: builtInExtensions });
		harnesses.push(harness);
		// No interface: the configuration tool refuses.
		await harness.session.bindExtensions({ mode: "print" });
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("agent", { agent: "nobody", task: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("configure_prism", { action: "module", name: "trace", enabled: true })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");

		const agent = getToolResult(harness, "agent");
		expect(getMessageText(agent)).toBe("Unknown agent: nobody");
		const config = getToolResult(harness, "configure_prism");
		expect(getMessageText(config)).toBe(
			"Configuration changes need the user at the terminal or the Prism window. Print, scheduled runs and RPC clients without dialogs are refused.",
		);

		const definition = (name: string) => harness.session.getToolDefinition(name);
		const shown = (name: string, result: typeof agent) =>
			stripAnsi(
				definition(name)!.renderResult!(
					{ content: result.content, details: undefined },
					{ expanded: true, isPartial: false },
					theme,
					{ isError: result.isError } as never,
				)
					.render(200)
					.join("\n"),
			).trim();
		expect(shown("agent", agent)).toBe("Agent inconnu : nobody");
		expect(shown("configure_prism", config)).not.toContain("Configuration changes");
		// The harness's exit line is translated; the agent's own stderr is shown as it is, even when it reads like
		// a catalog entry.
		const failed = (text: string) => ({ ...agent, content: [{ type: "text" as const, text }] });
		expect(shown("agent", failed("Agent exited with code 2"))).toBe("L’agent s’est arrêté avec le code 2");
		expect(shown("agent", failed("Done. Close"))).toBe("Done. Close");
		expect(shown("agent", failed("Agent stopped."))).toBe("Agent arrêté.");
	});
});
