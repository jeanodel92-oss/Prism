// what the corrections of the 2026-11-01 code review still lacked. A command too long
// for its question is read in full before it can be allowed (M7); safe mode without the sandbox runs only plain
// commands (H1); the H2 predicate does not refuse harmless forms.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import permissionsExtension from "../src/fork/permissions.ts";
import { unseenCodeReason } from "../src/fork/shell-unseen-code.ts";
import { createHarness, createTestUiContext, getToolResult, type Harness } from "./suite/harness.ts";

describe("fork.10: follow-ups of the 2026-11-01 code review", () => {
	let agentDir: string;
	const saved = process.env[ENV_AGENT_DIR];
	const harnesses: Harness[] = [];

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-followups-"));
		process.env[ENV_AGENT_DIR] = agentDir;
	});
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		if (saved === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = saved;
		rmSync(agentDir, { recursive: true, force: true });
	});

	async function engine(
		mode: string,
		select: (title: string, options: string[]) => string | undefined,
		editor: (title: string, text?: string) => void = () => {},
		sandbox = false,
	) {
		writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode }));
		if (!sandbox)
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ sandbox: { modes: { broad: false, ask: false, safe: false } } }),
			);
		const harness = await createHarness({
			extensionFactories: [{ name: "permissions", factory: permissionsExtension }],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				select: async (title, options) => select(title, options),
				editor: async (title, text) => {
					editor(title, text);
					return text;
				},
			}),
		});
		const run = async (command: string) => {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("bash", { command }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("go");
			return JSON.stringify(getToolResult(harness, "bash"));
		};
		return { harness, run };
	}

	it("M7: a long command offers only refusals until it is read in full", async () => {
		const offered: string[][] = [];
		const read: string[] = [];
		const { harness, run } = await engine(
			"ask",
			(_title, options) => {
				offered.push(options);
				return options.find((o) => o.startsWith("Show the whole")) ?? options.find((o) => o === "Allow once");
			},
			(_title, text) => read.push(text ?? ""),
		);
		const witness = join(harness.tempDir, "w");
		const command = `echo ${"x".repeat(6000)} > /dev/null; touch ${witness}`;
		await run(command);
		expect(offered[0]).not.toContain("Allow once");
		expect(offered[0]?.[0]).toBe("Show the whole command first");
		expect(read).toEqual([command]);
		expect(offered[1]).toContain("Allow once");
		expect(existsSync(witness)).toBe(true);
	});

	it("M7: a long here-document is read in full before it can be allowed", async () => {
		const offered: string[][] = [];
		const titles: string[] = [];
		const read: string[] = [];
		const { harness, run } = await engine(
			"ask",
			(title, options) => {
				titles.push(title);
				offered.push(options);
				return options.find((o) => o.startsWith("Show the whole")) ?? options.find((o) => o === "Allow once");
			},
			(_title, text) => read.push(text ?? ""),
		);
		const body = Array.from({ length: 40 }, (_, i) => `- line ${i} with \`code\` in it`).join("\n");
		const command = `cat >> ${join(harness.tempDir, "journal.md")} << 'EOF'\n${body}\nEOF\necho ok`;
		await run(command);
		expect(offered[0]).not.toContain("Allow once");
		expect(offered[0]?.[0]).toBe("Show the whole command first");
		// The choices stay on screen: the question shows a bounded start and end of the command.
		expect(titles[0]?.split("\n").length).toBeLessThan(25);
		expect(titles[0]).toContain("echo ok");
		expect(read).toEqual([command]);
		expect(offered[1]).toContain("Allow once");
		expect(readFileSync(join(harness.tempDir, "journal.md"), "utf8")).toContain("- line 39 with");
	});

	it("M7: a short command is allowed as before, without the extra step", async () => {
		const offered: string[][] = [];
		const { run } = await engine("ask", (_title, options) => {
			offered.push(options);
			return "Block this action once";
		});
		await run("touch short");
		expect(offered[0]).toContain("Allow once");
		expect(offered[0]).not.toContain("Show the whole command first");
	});

	it("H1: safe mode without the sandbox refuses what the classifier could misread", async () => {
		const { harness, run } = await engine("safe", () => undefined);
		writeFileSync(join(harness.tempDir, "a"), "a\n");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: a shell expansion, not a template
		for (const command of ["cat a > out", "echo ${x@P}", "cat <(ls)", "ls $(pwd)"]) {
			expect(await run(command), command).toMatch(/Blocked by safe mode/);
		}
		expect(existsSync(join(harness.tempDir, "out"))).toBe(false);
		expect(await run("cat a 2>/dev/null")).toContain("a\\n");
		expect(readFileSync(join(harness.tempDir, "a"), "utf8")).toBe("a\n");
	});

	it("H2: harmless forms stay trusted", () => {
		expect(unseenCodeReason("printf '%s' x")).toBeUndefined();
		expect(unseenCodeReason("command -v npm && npm run test")).toBeUndefined();
		expect(unseenCodeReason("printf -v x '%s' y")).toBeDefined();
		expect(unseenCodeReason("command eval x")).toBeDefined();
	});
});
