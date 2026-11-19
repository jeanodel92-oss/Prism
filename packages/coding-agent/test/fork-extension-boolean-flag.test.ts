/**
 * fork: an extension's boolean flag placed before the prompt does not
 * swallow it; a string flag keeps its value, and `--` keeps its meaning.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { createAgentSessionServices } from "../src/core/agent-session-services.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { mayHoldMessage } from "../src/fork/cli-flag-values.ts";

describe("extension flags before the prompt", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fork-ext-flags-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	async function parse(argv: string[]) {
		const parsed = parseArgs(argv);
		const services = await createAgentSessionServices({
			cwd: dir,
			agentDir: join(dir, "agent"),
			extensionFlagValues: parsed.unknownFlags,
			resourceLoaderOptions: {
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.registerFlag("yolo", { type: "boolean", description: "boolean" });
						pi.registerFlag("label", { type: "string", description: "string" });
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});
		const flags = services.resourceLoader.getExtensions().runtime.flagValues;
		return { messages: parsed.messages, yolo: flags.get("yolo"), label: flags.get("label"), services };
	}

	it("gives the prompt after a boolean flag back to the messages", async () => {
		const result = await parse(["--yolo", "Summarize this repo"]);
		expect(result.messages).toEqual(["Summarize this repo"]);
		expect(result.yolo).toBe(true);
		expect(result.services.diagnostics).toEqual([]);
	});

	it("keeps the order of the messages around boolean and string flags", async () => {
		const result = await parse(["first", "--yolo", "second", "--label", "name", "third", "--yolo", "fourth"]);
		expect(result.messages).toEqual(["first", "second", "third", "fourth"]);
		expect(result.label).toBe("name");
		expect(result.yolo).toBe(true);
	});

	it("keeps a string flag's value and a boolean before --", async () => {
		const result = await parse(["--label", "name", "--yolo", "--", "--not-a-flag", "prompt"]);
		expect(result.label).toBe("name");
		expect(result.yolo).toBe(true);
		expect(result.messages).toEqual(["--not-a-flag", "prompt"]);
	});

	it("does not give a message back twice when services are created again", async () => {
		const parsed = parseArgs(["--yolo", "once"]);
		for (let round = 0; round < 2; round++) {
			await createAgentSessionServices({
				cwd: dir,
				agentDir: join(dir, "agent"),
				extensionFlagValues: parsed.unknownFlags,
				resourceLoaderOptions: {
					extensionFactories: [(pi: ExtensionAPI) => pi.registerFlag("yolo", { type: "boolean" })],
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
		}
		expect(parsed.messages).toEqual(["once"]);
	});

	// Before extensions are loaded, a launch with a word after an unknown flag is not a plain one.
	it("counts a word taken by an unknown flag as a possible message before services exist", () => {
		expect(mayHoldMessage(parseArgs([]))).toBe(false);
		expect(mayHoldMessage(parseArgs(["--yolo"]))).toBe(false);
		expect(mayHoldMessage(parseArgs(["--yolo", "Summarize this repo"]))).toBe(true);
		expect(mayHoldMessage(parseArgs(["Summarize this repo"]))).toBe(true);
	});
});
