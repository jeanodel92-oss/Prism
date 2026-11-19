// fork: the built-in permission gate (src/fork/permissions.ts).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME, ENV_AGENT_DIR } from "../src/config.ts";
import type { InlineExtension } from "../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import backgroundExtension from "../src/fork/background.ts";
import permissionsExtension from "../src/fork/permissions.ts";
import { readProjectGrants } from "../src/fork/project-permissions.ts";
import { createHarness, createTestUiContext, getToolResult, type Harness } from "./suite/harness.ts";

// These tests run a real `npm test` in the sandbox, whose private /tmp hides test.sh's npm cache: npm would then
// look for its own update on the network and the sandbox would ask about registry.npmjs.org.
process.env.NPM_CONFIG_UPDATE_NOTIFIER = "false";

interface SelectCall {
	title: string;
	options: string[];
}

describe("fork: permission gate", () => {
	let agentDir: string;
	const savedAgentDir = process.env[ENV_AGENT_DIR];
	const harnesses: Harness[] = [];

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-permissions-"));
		process.env[ENV_AGENT_DIR] = agentDir;
		// These tests start in ask mode; without a configured mode Prism starts in broad.
		writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode: "ask" }));
	});

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		if (savedAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = savedAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	});

	/** A session with the gate; `answer` picks the dialog option, or `withUI: false` for a run without UI. */
	async function start(options: {
		answer?: (call: SelectCall) => string | undefined;
		withUI?: boolean;
		sessionManager?: SessionManager;
		extensions?: InlineExtension[];
	}): Promise<{ harness: Harness; selects: SelectCall[] }> {
		const harness = await createHarness({
			extensionFactories: [{ name: "permissions", factory: permissionsExtension }, ...(options.extensions ?? [])],
			sessionManager: options.sessionManager,
		});
		harnesses.push(harness);
		const selects: SelectCall[] = [];
		await harness.session.bindExtensions(
			options.withUI === false
				? {}
				: {
						uiContext: createTestUiContext({
							select: async (title, selectOptions) => {
								const call = { title, options: selectOptions };
								selects.push(call);
								return options.answer?.(call);
							},
						}),
					},
		);
		return { harness, selects };
	}

	async function runToolCall(
		harness: Harness,
		tool: string,
		input: Parameters<typeof fauxToolCall>[1],
	): Promise<void> {
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall(tool, input), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
	}

	it("is loaded even with --no-extensions or --safe (inline, not a `builtin:` resource), and replaceable", () => {
		const entry = builtInExtensions.find(
			(extension) => typeof extension !== "function" && extension.name === "permissions",
		);
		expect(entry).toEqual({
			name: "permissions",
			factory: permissionsExtension,
			replaceable: true,
			userReplaceableOnly: true,
		});
	});

	it("cannot be replaced by a project extension, only by a user one", async () => {
		const cwd = join(agentDir, "project");
		const replacement = `export default function (pi) {
  pi.registerCommand("perm", { description: "replacement", handler: async () => {} });
}`;
		const userExtension = join(agentDir, "extensions", "perm.ts");
		const gate = builtInExtensions.find(
			(extension) => typeof extension !== "function" && extension.name === "permissions",
		)!;
		const load = async () => {
			const loader = new DefaultResourceLoader({ cwd, agentDir, extensionFactories: [gate] });
			await loader.reload();
			return loader.getExtensions();
		};

		mkdirSync(join(cwd, CONFIG_DIR_NAME, "extensions"), { recursive: true });
		writeFileSync(join(cwd, CONFIG_DIR_NAME, "extensions", "perm.ts"), replacement);
		const fromProject = await load();
		expect(fromProject.extensions.map((extension) => extension.path)).toEqual(["<inline:permissions>"]);
		expect(JSON.stringify(fromProject.warnings)).toContain("only a user extension can replace");

		rmSync(join(cwd, CONFIG_DIR_NAME), { recursive: true });
		mkdirSync(dirname(userExtension), { recursive: true });
		writeFileSync(userExtension, replacement);
		const fromUser = await load();
		expect(fromUser.extensions.map((extension) => extension.path)).toEqual([userExtension]);
	});

	it("blocks configuration writes and asks for other danger despite broad allow rules", async () => {
		writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ allow: ["write(**)", "bash(*)"] }));
		const { harness, selects } = await start({ answer: () => "Block this action once" });
		await runToolCall(harness, "write", { path: join(agentDir, "settings.json"), content: "{}" });
		// "$UNSET": a target the gate cannot know (dangerous), which never reaches outside the test directory if run.
		await runToolCall(harness, "bash", { command: 'rm -rf "$UNSET"important' });
		expect(selects.map((call) => call.title.split("\n")[0])).toEqual(["Potentially dangerous action: bash"]);
		expect(existsSync(join(agentDir, "settings.json"))).toBe(false);
		// The broad rule still allows ordinary calls.
		await runToolCall(harness, "write", { path: "note.txt", content: "hello" });
		expect(selects).toHaveLength(1);
		expect(readFileSync(join(harness.tempDir, "note.txt"), "utf-8")).toBe("hello");
	});

	it("classifies the background command like a bash command, in yolo mode too", async () => {
		const { harness, selects } = await start({
			answer: () => "Block this action once",
			extensions: [{ name: "background", factory: backgroundExtension }],
		});
		mkdirSync(join(harness.tempDir, "important"));
		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("/perm mode yolo");
		await runToolCall(harness, "background", { action: "run", command: 'rm -rf "$UNSET"important' });
		expect(selects.map((call) => call.title.split("\n")[0])).toEqual(["Potentially dangerous action: background"]);
		expect(selects[0]!.options).toContain(
			`Always block "run rm"; save in ${join(harness.tempDir, CONFIG_DIR_NAME, "permissions.json")}`,
		);
		expect(existsSync(join(harness.tempDir, "important"))).toBe(true);
	});

	it("does not ask, in ask mode, for extension tools with no effect", async () => {
		const noEffect = (name: string): InlineExtension => ({
			name,
			factory: (pi) =>
				pi.registerTool({
					name,
					label: name,
					description: name,
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "answered" }], details: {} }),
				}),
		});
		const { harness, selects } = await start({
			answer: () => "Block this action once",
			extensions: [
				{ name: "background", factory: backgroundExtension },
				noEffect("ask_user_question"),
				noEffect("plan_mode_question"),
				noEffect("plan_mode_complete"),
			],
		});
		await runToolCall(harness, "ask_user_question", {});
		await runToolCall(harness, "plan_mode_question", {});
		await runToolCall(harness, "plan_mode_complete", {});
		await runToolCall(harness, "background", { action: "status" });
		await runToolCall(harness, "background", { action: "logs", id: "none" });
		expect(selects).toEqual([]);
		// An effect still asks.
		await runToolCall(harness, "background", { action: "run", command: "npm test" });
		expect(selects.map((call) => call.title.split("\n")[0])).toEqual(["Allow this action? background"]);
	});

	it("does not run a tool call the user denies (ask mode)", async () => {
		const { harness, selects } = await start({ answer: () => "Block this action once" });
		await runToolCall(harness, "write", { path: "note.txt", content: "hello" });

		expect(selects).toHaveLength(1);
		expect(selects[0]!.title).toContain("Allow this action? write");
		expect(existsSync(join(harness.tempDir, "note.txt"))).toBe(false);
		const result = getToolResult(harness, "write");
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain(
			"Denied by the user (permission system). This is intended. Do not retry this action or a variant",
		);
	});

	// nobody answered is not a refusal by the user; the model goes on without it.
	it("tells the model when nobody answered the question", async () => {
		const { harness } = await start({ answer: () => undefined });
		await runToolCall(harness, "write", { path: "note.txt", content: "hello" });
		const result = getToolResult(harness, "write");
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain("the user may be away. Do not retry this action or a variant");
		expect(JSON.stringify(result.content)).toContain("tell the user what is left and which permission it needs");
	});

	// `cd x &&` or an assignment before the command allows nothing; the rule covers what asked.
	it("suggests a rule for the part of the command that needs the permission", async () => {
		const { harness, selects } = await start({ answer: () => "Block this action once" });
		const rules = async (command: string) => {
			selects.length = 0;
			await runToolCall(harness, "bash", { command });
			return selects.flatMap((call) => call.options).filter((option) => option.startsWith('Allow "'));
		};
		expect((await rules("cd sub && npm test"))[0]).toContain('"run npm test"');
		expect((await rules("S=/tmp/storage; ls $S; npm run build"))[0]).toContain('"run npm run build"');
		expect((await rules("npm test"))[0]).toContain('"run npm test"');
	});

	// the choices say what they allow in words, and "in this project"
	// replaces saving the rule in permissions.json.
	it("keeps a permission given for this project for the next calls, in Prism's folder", async () => {
		const { harness, selects } = await start({
			answer: (call) => call.options.find((option) => option.endsWith("in this project")),
		});
		await runToolCall(harness, "bash", { command: "npm test --silent; true" });
		expect(selects[0]!.options).toEqual([
			"Allow once",
			'Allow "run npm test" for 15 minutes',
			'Allow "run npm test" in this session',
			'Allow "run npm test" in this project',
			"Block this action once",
			'Block "run npm test" in this project',
		]);
		expect(readProjectGrants(harness.tempDir, agentDir).allow).toEqual(["bash(npm test*)"]);
		expect(existsSync(join(harness.tempDir, CONFIG_DIR_NAME, "permissions.json"))).toBe(false);
		await runToolCall(harness, "bash", { command: "npm test --silent; true" });
		expect(selects).toHaveLength(1);
	});

	it("says when a permission cannot be kept for the project and asks again, never widening or narrowing it", async () => {
		const picks = ["in this project", "Allow once"];
		const { harness, selects } = await start({
			answer: (call) => {
				const pick = picks.shift() ?? "Block this action once";
				return call.options.find((option) => option.endsWith(pick));
			},
		});
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "project-permissions.json"), "{ not json");
		await runToolCall(harness, "bash", { command: "npm test --silent; true" });
		expect(selects).toHaveLength(2);
		expect(selects[1]!.title).toContain("Could not keep it for this project:");
		expect(selects[1]!.title).toContain("Nothing was allowed. Choose again.");
		expect(selects[1]!.options).toEqual(selects[0]!.options);
		// Allowed once, as chosen the second time: the next call asks.
		await runToolCall(harness, "bash", { command: "npm test --silent; true" });
		expect(selects).toHaveLength(3);
	});

	it("runs an allowed call", async () => {
		const { harness } = await start({ answer: () => "Allow once" });
		await runToolCall(harness, "write", { path: "note.txt", content: "hello" });
		expect(readFileSync(join(harness.tempDir, "note.txt"), "utf-8")).toBe("hello");
	});

	it.each(["auth.json", "settings.json", "models.json", "permissions.json"])(
		"refuses a write or an edit to %s in the agent dir without a question (R5.4)",
		async (name) => {
			const file = join(agentDir, name);
			writeFileSync(file, "{}\n");
			for (const [tool, input] of [
				["write", { path: file, content: '{"x":1}' }],
				["edit", { path: file, edits: [{ oldText: "{}", newText: '{"x":1}' }] }],
			] as const) {
				const { harness, selects } = await start({ answer: () => "Block this action once" });
				await runToolCall(harness, tool, input);
				expect(selects).toHaveLength(0);
				expect(getToolResult(harness, tool).isError).toBe(true);
				expect(JSON.stringify(getToolResult(harness, tool).content)).toContain(
					name === "settings.json" ? "Use configure_prism" : "Only the user",
				);
				expect(readFileSync(file, "utf-8")).toBe("{}\n");
			}
		},
	);

	it("asks for a dangerous call even in yolo mode", async () => {
		const { harness, selects } = await start({ answer: () => "Block this action once" });
		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("/perm mode yolo");
		await runToolCall(harness, "write", { path: join(agentDir, "outside.env"), content: "{}" });
		expect(selects.map((call) => call.title.split("\n")[0])).toEqual(["Potentially dangerous action: write"]);
		expect(existsSync(join(agentDir, "outside.env"))).toBe(false);
	});

	// "yolo" became "broad" (dangerous calls still ask); "unrestricted" asks nothing, only
	// once its warning was accepted.
	describe("broad and unrestricted modes", () => {
		const outside = () => join(agentDir, "outside.txt");

		it("unrestricted asks nothing once accepted, dangerous calls and writes outside the project included", async () => {
			const { harness, selects } = await start({ answer: () => "Enable unrestricted mode" });
			harness.setResponses([fauxAssistantMessage("ok")]);
			await harness.session.prompt("/perm mode unrestricted");
			expect(selects.map((call) => call.title)).toEqual([
				expect.stringMatching(
					/^Unrestricted mode: no confirmation for anything, including rm -rf, sudo, writes outside/,
				),
			]);
			await runToolCall(harness, "write", { path: join(agentDir, "auth.json"), content: "{}" });
			expect(getToolResult(harness, "write").isError).toBe(true);
			await runToolCall(harness, "write", { path: outside(), content: "x" });
			expect(selects).toHaveLength(1);
			expect(existsSync(join(agentDir, "auth.json"))).toBe(false);
			expect(getToolResult(harness, "write").isError).not.toBe(true);
			expect(existsSync(outside())).toBe(true);
			expect(JSON.parse(readFileSync(join(agentDir, "permissions.json"), "utf-8")).unrestrictedAccepted).toBe(true);
		});

		it("explicit deny rules still apply in unrestricted mode", async () => {
			writeFileSync(
				join(agentDir, "permissions.json"),
				JSON.stringify({ unrestrictedAccepted: true, deny: [`write(${outside()})`] }),
			);
			const { harness, selects } = await start({});
			harness.setResponses([fauxAssistantMessage("ok")]);
			await harness.session.prompt("/perm mode unrestricted");
			await runToolCall(harness, "write", { path: outside(), content: "x" });
			expect(selects).toEqual([]);
			expect(existsSync(outside())).toBe(false);
		});

		it("cancelling the warning keeps the mode; without a UI /perm cannot enable it", async () => {
			const { harness } = await start({ answer: () => "Cancel" });
			harness.setResponses([fauxAssistantMessage("ok")]);
			await harness.session.prompt("/perm mode unrestricted");
			await runToolCall(harness, "write", { path: "note.txt", content: "x" });
			expect(existsSync(join(harness.tempDir, "note.txt"))).toBe(false);
			expect(JSON.parse(readFileSync(join(agentDir, "permissions.json"), "utf-8"))).toEqual({ mode: "ask" });

			const headless = await start({ withUI: false });
			headless.harness.setResponses([fauxAssistantMessage("ok")]);
			await headless.harness.session.prompt("/perm mode unrestricted");
			await runToolCall(headless.harness, "write", { path: "note.txt", content: "x" });
			expect(existsSync(join(headless.harness.tempDir, "note.txt"))).toBe(false);
		});

		it("the command line selects it explicitly, without a UI", async () => {
			const { harness } = await start({ withUI: false });
			const runner = harness.session.extensionRunner;
			runner.setFlagValue("perm-mode", "unrestricted");
			await runner.emit({ type: "session_start", reason: "startup" });
			await runToolCall(harness, "write", { path: outside(), content: "x" });
			expect(existsSync(outside())).toBe(true);
		});

		it("a configured unrestricted default counts only once accepted, never from a project", async () => {
			writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode: "unrestricted" }));
			let { harness, selects } = await start({ answer: () => "Block this action once" });
			await runToolCall(harness, "write", { path: join(agentDir, "outside.env"), content: "{}" });
			expect(selects.map((call) => call.title.split("\n")[0])).toEqual(["Potentially dangerous action: write"]);

			writeFileSync(
				join(agentDir, "permissions.json"),
				JSON.stringify({ mode: "unrestricted", unrestrictedAccepted: true }),
			);
			({ harness, selects } = await start({}));
			await runToolCall(harness, "write", { path: outside(), content: "x" });
			expect(selects).toEqual([]);
			expect(existsSync(outside())).toBe(true);
		});

		it("/perm default saves the default mode, and a new session starts in it", async () => {
			const { harness } = await start({});
			harness.setResponses([fauxAssistantMessage("ok")]);
			await harness.session.prompt("/perm default broad");
			expect(JSON.parse(readFileSync(join(agentDir, "permissions.json"), "utf-8")).mode).toBe("broad");
			const next = await start({});
			await runToolCall(next.harness, "write", { path: "note.txt", content: "x" });
			expect(next.selects).toEqual([]);
			expect(existsSync(join(next.harness.tempDir, "note.txt"))).toBe(true);
		});

		it("accepts yolo as the former name of broad", async () => {
			const { harness, selects } = await start({});
			harness.setResponses([fauxAssistantMessage("ok")]);
			await harness.session.prompt("/perm mode yolo");
			await runToolCall(harness, "write", { path: "note.txt", content: "x" });
			expect(selects).toEqual([]);
			expect(existsSync(join(harness.tempDir, "note.txt"))).toBe(true);
		});
	});

	it("blocks, without a UI, a call that would need a confirmation", async () => {
		const { harness } = await start({ withUI: false });
		await runToolCall(harness, "write", { path: "note.txt", content: "hello" });
		expect(existsSync(join(harness.tempDir, "note.txt"))).toBe(false);
		expect(JSON.stringify(getToolResult(harness, "write").content)).toContain("non-interactive");
	});

	// fork.9 QA: broad still asks for a dangerous call, so the refusal must not advise re-running in broad.
	it("blocks, without a UI, a dangerous call in broad mode without advising broad", async () => {
		const { harness } = await start({ withUI: false });
		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("/perm mode broad");
		await runToolCall(harness, "write", { path: join(agentDir, "outside.env"), content: "{}" });
		expect(existsSync(join(agentDir, "outside.env"))).toBe(false);
		const text = JSON.stringify(getToolResult(harness, "write").content);
		expect(text).toContain("Run it in an interactive session.");
		expect(text).not.toContain("--perm-mode broad");
	});

	it("keeps the chosen mode when the session is resumed", async () => {
		const sessionDir = join(agentDir, "sessions");
		mkdirSync(sessionDir);
		const cwd = join(agentDir, "ws");
		mkdirSync(cwd);
		const first = await start({ sessionManager: SessionManager.create(cwd, sessionDir) });
		first.harness.setResponses([fauxAssistantMessage("ok")]);
		await first.harness.session.prompt("/perm mode safe");
		await runToolCall(first.harness, "bash", { command: "touch made-by-bash" });
		const sessionFile = first.harness.session.sessionFile!;

		const resumed = await start({ sessionManager: SessionManager.open(sessionFile, sessionDir) });
		await runToolCall(resumed.harness, "bash", { command: "touch made-by-bash" });

		expect(first.selects).toHaveLength(0);
		expect(resumed.selects).toHaveLength(0);
		for (const harness of [first.harness, resumed.harness]) {
			expect(JSON.stringify(getToolResult(harness, "bash").content)).toContain("Blocked by safe mode");
		}
		expect(existsSync(join(resumed.harness.tempDir, "made-by-bash"))).toBe(false);
	});

	// A refusal reason that already ends with a point is not given a second one.
	it("ends a safe mode refusal with a single point", async () => {
		const { harness } = await start({});
		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("/perm mode safe");
		await runToolCall(harness, "bash", { command: "curl https://example.com" });
		const text = JSON.stringify(getToolResult(harness, "bash").content);
		expect(text).toContain("Blocked by safe mode: this action requires permission (curl). Do not retry");
		expect(text).not.toContain("..");
	});

	// a dangerous question also allows the call for the session,
	// never saved; an ordinary one also blocks in the project, saved like "in this project".
	it("allows a dangerous call for this session only, never saved", async () => {
		const sessionDir = join(agentDir, "sessions");
		mkdirSync(sessionDir);
		const cwd = join(agentDir, "ws");
		mkdirSync(cwd);
		const pick = (call: SelectCall) =>
			call.options.find((option) => option === "Allow this action in this session") ?? "Block this action once";
		const first = await start({ sessionManager: SessionManager.create(cwd, sessionDir), answer: pick });
		const dir = first.harness.tempDir;
		mkdirSync(join(dir, "build"));
		// An unset variable makes the target unknown, so dangerous, while the command only touches the test directory.
		await runToolCall(first.harness, "bash", { command: 'rm -rf "$UNSET"build' });
		expect(first.selects[0]!.title.split("\n")[0]).toBe("Potentially dangerous action: bash");
		expect(first.selects[0]!.options).toEqual([
			"Allow once",
			"Allow this action in this session",
			"Block this action once",
			`Always block "run rm"; save in ${join(dir, CONFIG_DIR_NAME, "permissions.json")}`,
		]);
		expect(existsSync(join(dir, "build"))).toBe(false);
		// The same call passes; another dangerous call still asks.
		mkdirSync(join(dir, "build"));
		await runToolCall(first.harness, "bash", { command: 'rm -rf "$UNSET"build' });
		expect(first.selects).toHaveLength(1);
		expect(existsSync(join(dir, "build"))).toBe(false);
		mkdirSync(join(dir, "dist"));
		await runToolCall(first.harness, "bash", { command: 'rm -rf "$UNSET"dist' });
		expect(first.selects).toHaveLength(2);
		expect(existsSync(join(agentDir, "project-permissions.json"))).toBe(false);

		// Resumed, the session asks again.
		const resumed = await start({
			sessionManager: SessionManager.open(first.harness.session.sessionFile!, sessionDir),
			answer: () => "Block this action once",
		});
		mkdirSync(join(resumed.harness.tempDir, "build"));
		await runToolCall(resumed.harness, "bash", { command: 'rm -rf "$UNSET"build' });
		expect(resumed.selects).toHaveLength(1);
		expect(existsSync(join(resumed.harness.tempDir, "build"))).toBe(true);
	});

	it("offers no session permission for a protected path", async () => {
		const { harness, selects } = await start({ answer: () => "Block this action once" });
		await runToolCall(harness, "write", { path: ".env", content: "KEY=1" });
		await runToolCall(harness, "bash", { command: "cat ./id_ed25519" });
		await runToolCall(harness, "write", { path: join(agentDir, "outside.txt"), content: "x" });
		expect(selects.map((call) => call.title.split("\n")[0])).toEqual([
			"Potentially dangerous action: write",
			"Potentially dangerous action: bash",
			"Potentially dangerous action: write",
		]);
		expect(selects[0]!.options).not.toContain("Allow this action in this session");
		expect(selects[1]!.options).not.toContain("Allow this action in this session");
		// Outside the project is dangerous but not protected.
		expect(selects[2]!.options).toContain("Allow this action in this session");
	});

	it("blocks an action in this project, saved in Prism's folder", async () => {
		const { harness, selects } = await start({
			answer: (call) => call.options.find((option) => option === 'Block "run npm test" in this project'),
		});
		await runToolCall(harness, "bash", { command: "npm test --silent; true" });
		expect(readProjectGrants(harness.tempDir, agentDir).deny).toEqual(["bash(npm test*)"]);
		expect(existsSync(join(harness.tempDir, CONFIG_DIR_NAME, "permissions.json"))).toBe(false);
		expect(JSON.stringify(getToolResult(harness, "bash").content)).toContain("Denied by the user");
		// The next call is blocked without a question, in this session and the next.
		await runToolCall(harness, "bash", { command: "npm test" });
		expect(selects).toHaveLength(1);
		expect(JSON.stringify(getToolResult(harness, "bash").content)).toContain('Denied by rule \\"bash(npm test*)\\"');
	});

	it("says in /perm help that it is not a sandbox", async () => {
		const { harness, selects } = await start({});
		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("/perm help");
		const help = selects[0]!.options.join("\n");
		expect(help).toContain("They are not a sandbox");
		expect(help).toContain("auth.json");
	});
});
