// fork: home extensions shipped as built-in extensions (src/fork/).
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import appendSystemExtension, { APPEND_SYSTEM_TEXT } from "../src/fork/append-system.ts";
import backgroundExtension, { backgroundTasks, END_MESSAGE } from "../src/fork/background.ts";
import checkpointsExtension from "../src/fork/checkpoints.ts";
import { setLanguage, t } from "../src/fork/i18n/index.ts";
import memoryExtension from "../src/fork/memory.ts";
import notifyExtension from "../src/fork/notify.ts";
import sessionSearchExtension from "../src/fork/session-search.ts";
import { EXTENSION_DESCRIPTIONS } from "../src/fork/settings-descriptions.ts";
import { settingsSections } from "../src/fork/settings-sections.ts";
import webExtension from "../src/fork/web.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import {
	createHarness,
	createTestUiContext,
	getAssistantTexts,
	getMessageText,
	getToolResult,
	type Harness,
} from "./suite/harness.ts";

describe("fork: home extensions", () => {
	let agentDir: string;
	const savedAgentDir = process.env[ENV_AGENT_DIR];
	const harnesses: Harness[] = [];

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-home-extensions-"));
		process.env[ENV_AGENT_DIR] = agentDir;
	});

	afterEach(async () => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		if (savedAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = savedAgentDir;
		// A background task's end notification is not waited for: the fake notify-send can still write in the folder
		// while it is removed. Retried between event loop turns, which the
		// notification's end needs.
		for (let left = 50; ; left--) {
			try {
				rmSync(agentDir, { recursive: true, force: true });
				break;
			} catch (error) {
				if (!left) throw error;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		}
	});

	async function start(name: string, factory: ExtensionFactory, ui: Parameters<typeof createTestUiContext>[0] = {}) {
		const harness = await createHarness({ extensionFactories: [{ name, factory }] });
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext(ui) });
		return harness;
	}

	async function runToolCall(harness: Harness, tool: string, input: Parameters<typeof fauxToolCall>[1]) {
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall(tool, input), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		return getToolResult(harness, tool);
	}

	function text(result: { content: unknown[] }): string {
		return result.content.map((part) => (part as { text?: string }).text ?? "").join("\n");
	}

	function entry(name: string) {
		return builtInExtensions.find((extension) => typeof extension !== "function" && extension.name === name);
	}

	describe("checkpoints", () => {
		it("is a replaceable built-in extension", () => {
			expect(entry("checkpoints")).toEqual({
				name: "checkpoints",
				factory: checkpointsExtension,
				replaceable: true,
				builtin: true,
			});
		});

		it("snapshots into the agent dir and /undo restores the file", async () => {
			const harness = await start("checkpoints", checkpointsExtension, { confirm: async () => true });
			const file = join(harness.tempDir, "note.txt");
			writeFileSync(file, "before\n");
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("write", { path: file, content: "after\n" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("go");
			expect(readFileSync(file, "utf-8")).toBe("after\n");
			expect(readdirSync(join(agentDir, "checkpoints"))).toHaveLength(1);

			await harness.session.prompt("/undo");
			expect(readFileSync(file, "utf-8")).toBe("before\n");
		});

		// Review 2026-10-20 (M6): the snapshot used to be taken of <cwd>/~/note.txt.
		it("/undo restores a file written through a ~/ path", async () => {
			const savedHome = process.env.HOME;
			process.env.HOME = join(agentDir, "home");
			try {
				mkdirSync(process.env.HOME);
				const harness = await start("checkpoints", checkpointsExtension, { confirm: async () => true });
				const file = join(process.env.HOME, "note.txt");
				writeFileSync(file, "before\n");
				harness.setResponses([
					fauxAssistantMessage(fauxToolCall("write", { path: "~/note.txt", content: "after\n" }), {
						stopReason: "toolUse",
					}),
					fauxAssistantMessage("done"),
				]);
				await harness.session.prompt("go");
				expect(readFileSync(file, "utf-8")).toBe("after\n");
				await harness.session.prompt("/undo");
				expect(readFileSync(file, "utf-8")).toBe("before\n");
			} finally {
				process.env.HOME = savedHome;
			}
		});

		it("/undo deletes a file the turn created", async () => {
			const harness = await start("checkpoints", checkpointsExtension, { confirm: async () => true });
			const file = join(harness.tempDir, "new.txt");
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("write", { path: file, content: "x" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("go");
			expect(existsSync(file)).toBe(true);
			await harness.session.prompt("/undo");
			expect(existsSync(file)).toBe(false);
		});
	});

	describe("background", () => {
		const savedPath = process.env.PATH;
		let notified: string;

		beforeEach(() => {
			// A fake notify-send first in PATH: records the notification instead of showing one.
			const bin = join(agentDir, "fake-bin");
			mkdirSync(bin);
			notified = join(agentDir, "notified.txt");
			writeFileSync(join(bin, "notify-send"), `#!/bin/sh\necho "$@" >> "${notified}"\n`);
			chmodSync(join(bin, "notify-send"), 0o755);
			process.env.PATH = `${bin}:${savedPath}`;
		});

		afterEach(() => {
			process.env.PATH = savedPath;
		});

		// a task's end comes back to the model by itself, without polling.
		function reports(harness: Harness): string[] {
			return harness.session.messages
				.filter((message) => message.role === "custom" && message.customType === "background-task-ended")
				.map((message) => getMessageText(message));
		}

		/** The model's context at its next call, then `reply`. */
		function capture(reply: string) {
			const seen: { context?: string } = {};
			const step: FauxResponseStep = (context) => {
				seen.context = context.messages.map((message) => getMessageText(message)).join("\n---\n");
				return fauxAssistantMessage(reply);
			};
			return { seen, step };
		}

		function status(id: string) {
			return backgroundTasks()?.find((task) => task.id === id)?.status;
		}

		/** The turn the task's end started is over. */
		async function settled(harness: Harness) {
			await expect.poll(() => reports(harness).length, { timeout: 10_000 }).toBe(1);
			await harness.session.waitForIdle();
		}

		it("is a replaceable built-in extension", () => {
			expect(entry("background")).toEqual({
				name: "background",
				factory: backgroundExtension,
				replaceable: true,
				builtin: true,
			});
		});

		it("logs what the task's processes write after its shell exits, before it shows as ended", async () => {
			const harness = await start("background", backgroundExtension);
			await runToolCall(harness, "background", { action: "run", command: "echo early; (sleep 0.3; echo late) &" });
			await expect.poll(() => existsSync(notified), { timeout: 10_000 }).toBe(true);
			const log = readdirSync(join(agentDir, "bg")).find((name) => !name.endsWith(".pid"))!;
			// `exit` comes before the late output: the log used to end there, and lose it.
			expect(readFileSync(join(agentDir, "bg", log), "utf-8")).toBe("early\nlate\n");
			await settled(harness);
			const logs = await runToolCall(harness, "background", { action: "logs", id: "bg1" });
			expect(text(logs)).toContain("[done exit=0]");
		});

		it("runs a command in the background, logs to the agent dir and reports it", async () => {
			const harness = await start("background", backgroundExtension);
			const started = await runToolCall(harness, "background", { action: "run", command: "echo hello-bg" });
			expect(text(started)).toContain("Started bg1");

			const logDir = join(agentDir, "bg");
			await expect.poll(() => existsSync(notified), { timeout: 10_000 }).toBe(true);
			// The log and its .pid file, which lets a later start prune the log once the task is gone.
			const [log, pid] = readdirSync(logDir).sort();
			expect(pid).toBe(`${log}.pid`);
			expect(readFileSync(join(logDir, log!), "utf-8")).toContain("hello-bg");
			expect(readFileSync(notified, "utf-8")).toContain("bg1: echo hello-bg");
			await settled(harness);

			const logs = await runToolCall(harness, "background", { action: "logs", id: "bg1" });
			expect(text(logs)).toContain("[done exit=0]");
			expect(text(logs)).toContain("hello-bg");
		});

		it("reports a missing id as an error", async () => {
			const harness = await start("background", backgroundExtension);
			const result = await runToolCall(harness, "background", { action: "logs", id: "bg9" });
			expect(result.isError).toBe(true);
			expect(text(result)).toContain("No such task: bg9");
		});

		it("hands the end of a task to a waiting model in a new turn: its state, its bounded output and its log", async () => {
			const harness = await start("background", backgroundExtension);
			const next = capture("noted");
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("background", {
						action: "run",
						command: "sleep 0.5; printf '%05000d\\n' 0; echo last-line; exit 3",
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("started"),
				next.step,
			]);
			await harness.session.prompt("go");
			await expect.poll(() => next.seen.context, { timeout: 10_000 }).toBeDefined();
			await harness.session.waitForIdle();

			const [report] = reports(harness);
			const log = join(agentDir, "bg", readdirSync(join(agentDir, "bg")).find((name) => name.endsWith(".log"))!);
			expect(report).toMatch(/^Background task ended: bg1 \[failed exit=3\] \d+s · sleep 0.5; printf/);
			expect(report).toContain("last-line");
			expect(report).toContain(`Full log: ${log}`);
			// The output it carries is bounded; the log keeps all of it.
			expect(report!.length).toBeLessThan(2400);
			expect(readFileSync(log, "utf-8").length).toBeGreaterThan(5000);
			expect(next.seen.context).toContain("Background task ended: bg1 [failed exit=3]");
			expect(getAssistantTexts(harness).at(-1)).toBe("noted");
		});

		it("hands the end of a task to a working model after its current work, without stopping it", async () => {
			const harness = await start("background", backgroundExtension);
			const next = capture("noted");
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("background", { action: "run", command: "echo quick" }), {
					stopReason: "toolUse",
				}),
				async () => {
					// Still working when the task ends.
					await expect.poll(() => status("bg1"), { timeout: 10_000 }).toBe("done");
					return fauxAssistantMessage("still working");
				},
				next.step,
			]);
			await harness.session.prompt("go");

			expect(getAssistantTexts(harness).filter(Boolean)).toEqual(["still working", "noted"]);
			expect(next.seen.context).toContain("Background task ended: bg1 [done exit=0]");
			expect(next.seen.context).toContain("quick");
		});

		it("shows the report's gist in the interface language, the report itself when expanded", async () => {
			const harness = await start("background", backgroundExtension);
			initTheme("prism");
			const render = harness.session.extensionRunner?.getMessageRenderer(END_MESSAGE);
			const message = {
				role: "custom" as const,
				customType: END_MESSAGE,
				content: "Background task ended: bg1 [failed exit=2] 3s · make\nFull log: /logs/bg1.log",
				display: true,
				details: { id: "bg1", status: "failed", exitCode: 2, logPath: "/logs/bg1.log" },
				timestamp: 0,
			};
			const shown = (expanded: boolean) =>
				stripAnsi(render!(message, { expanded, outputPad: 0 }, theme)!.render(80).join("\n"));
			setLanguage("fr");
			try {
				expect(shown(false)).toMatch(/Tâche de fond bg1 : échec\s+Log : \/logs\/bg1\.log/);
				expect(shown(false)).not.toContain("Background task ended");
				expect(shown(true)).toContain("Background task ended: bg1 [failed exit=2]");
			} finally {
				setLanguage("en");
			}
		});

		it("reports nothing to the model for a task it stopped itself", async () => {
			const harness = await start("background", backgroundExtension);
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("background", { action: "run", command: "sleep 30" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(fauxToolCall("background", { action: "kill", id: "bg1" }), { stopReason: "toolUse" }),
				async () => {
					// Still working when the stopped task ends.
					await expect.poll(() => status("bg1"), { timeout: 10_000 }).toBe("stopped");
					return fauxAssistantMessage("done");
				},
				fauxAssistantMessage("must not be asked"),
			]);
			await harness.session.prompt("go");
			await new Promise((resolve) => setTimeout(resolve, 300));
			await harness.session.waitForIdle();
			expect(reports(harness)).toEqual([]);
			expect(harness.getPendingResponseCount()).toBe(1);
		});

		// an optional limit, none by default; a task past it is stopped as kill
		// does (SIGTERM, then SIGKILL after the grace) and reported as timed_out, not failed or stopped.
		it("stops a task past its optional time limit, even one that ignores SIGTERM, and reports it timed out", async () => {
			const harness = await start("background", backgroundExtension);
			const next = capture("noted");
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("background", {
						action: "run",
						command: "trap '' TERM; echo begun; sleep 30",
						timeout: 0.5,
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("started"),
				next.step,
			]);
			await harness.session.prompt("go");
			await expect.poll(() => next.seen.context, { timeout: 15_000 }).toBeDefined();
			await harness.session.waitForIdle();

			expect(status("bg1")).toBe("timed_out");
			const [report] = reports(harness);
			expect(report).toMatch(/^Background task ended: bg1 \[timed_out\] \d+s · trap/);
			expect(report).toContain("begun");
			expect(report).toMatch(/Full log: .*bg1\.log/);
		}, 20_000);

		it("lets a task without a limit, or within its limit, end as usual", async () => {
			const harness = await start("background", backgroundExtension);
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("background", { action: "run", command: "sleep 1; echo one" }),
						fauxToolCall("background", { action: "run", command: "echo two", timeout: 60 }),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("started"),
				fauxAssistantMessage("noted"),
				fauxAssistantMessage("noted"),
			]);
			await harness.session.prompt("go");
			await expect.poll(() => [status("bg1"), status("bg2")], { timeout: 10_000 }).toEqual(["done", "done"]);
			const tasks = backgroundTasks() ?? [];
			expect(tasks.find((task) => task.id === "bg1")?.timeoutSeconds).toBeUndefined();
			expect(tasks.find((task) => task.id === "bg2")?.timeoutSeconds).toBe(60);
		});

		it("reports nothing, and throws nothing, once the session is disposed without closing", async () => {
			const harness = await start("background", backgroundExtension);
			const rejections: unknown[] = [];
			const onRejection = (reason: unknown) => void rejections.push(reason);
			process.on("unhandledRejection", onRejection);
			try {
				harness.setResponses([
					fauxAssistantMessage(fauxToolCall("background", { action: "run", command: "sleep 0.5" }), {
						stopReason: "toolUse",
					}),
					fauxAssistantMessage("done"),
				]);
				await harness.session.prompt("go");
				harness.session.dispose();
				await expect.poll(() => status("bg1"), { timeout: 10_000 }).toBe("done");
				await new Promise((resolve) => setTimeout(resolve, 300));
			} finally {
				process.off("unhandledRejection", onRejection);
			}
			expect(rejections).toEqual([]);
			expect(reports(harness)).toEqual([]);
		});

		it("reports nothing to the model once the session is closed", async () => {
			const harness = await start("background", backgroundExtension);
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("background", { action: "run", command: "sleep 1" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("go");
			await harness.session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
			harness.setResponses([fauxAssistantMessage("must not be asked")]);

			await expect.poll(() => status("bg1"), { timeout: 10_000 }).toBe("done");
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(reports(harness)).toEqual([]);
			expect(harness.getPendingResponseCount()).toBe(1);
		});
	});

	describe("memory", () => {
		it("is a replaceable built-in extension, off by default", () => {
			expect(entry("memory")).toEqual({
				name: "memory",
				factory: memoryExtension,
				replaceable: true,
				builtin: true,
				disabledByDefault: true,
			});
		});

		it.each([
			[undefined, []],
			[["+builtin:memory"], ["builtin:memory"]],
		])("loads a default-off built-in extension only when the extensions setting is %j", async (setting, expected) => {
			if (setting) writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: setting }));
			const loaded: string[] = [];
			const loader = new DefaultResourceLoader({
				cwd: agentDir,
				agentDir,
				extensionFactories: [
					{ name: "memory", builtin: true, disabledByDefault: true, factory: () => void loaded.push("memory") },
				],
			});
			await loader.reload();
			expect(loader.getExtensions().extensions.map((extension) => extension.path)).toEqual(expected);
			expect(loaded).toEqual(expected.length ? ["memory"] : []);
		});

		it("appends the global memory file from the agent dir to the system prompt", async () => {
			writeFileSync(join(agentDir, "MEMORY.md"), "# Memory\n\n- prefers tabs\n");
			const harness = await start("memory", memoryExtension);
			let systemPrompt = "";
			harness.setResponses([
				() => {
					systemPrompt = harness.session.systemPrompt;
					return fauxAssistantMessage("ok");
				},
			]);
			await harness.session.prompt("hi");
			expect(systemPrompt).toContain("## Memory (global)\n# Memory\n\n- prefers tabs");
		});

		// Review 2026-10-20 (M5): $EDITOR used to run through pi.exec, with no terminal.
		it("/memory-edit edits the global memory file in the editor dialog", async () => {
			writeFileSync(join(agentDir, "MEMORY.md"), "# Memory\n");
			let prefill: string | undefined;
			const harness = await start("memory", memoryExtension, {
				editor: async (_title, text) => {
					prefill = text;
					return "# Memory\n\n- edited";
				},
			});
			await harness.session.prompt("/memory-edit");
			expect(prefill).toBe("# Memory\n");
			expect(readFileSync(join(agentDir, "MEMORY.md"), "utf-8")).toBe("# Memory\n\n- edited\n");
		});
	});

	describe("session-search", () => {
		it("is a replaceable built-in extension", () => {
			expect(entry("session-search")).toEqual({
				name: "session-search",
				factory: sessionSearchExtension,
				replaceable: true,
				builtin: true,
				disabledByDefault: true,
			});
		});

		it("searches the sessions in the agent dir, scoped to the project by default", async () => {
			const harness = await start("session-search", sessionSearchExtension);
			const sessionsDir = join(agentDir, "sessions", "--project--");
			mkdirSync(sessionsDir, { recursive: true });
			const session = (cwd: string, text: string) =>
				[
					JSON.stringify({ type: "session", cwd, timestamp: "2026-10-01T10:00:00.000Z" }),
					JSON.stringify({ type: "message", message: { role: "user", content: text } }),
				].join("\n");
			writeFileSync(join(sessionsDir, "a.jsonl"), session(harness.tempDir, "we chose zebra-striping for the table"));
			writeFileSync(join(sessionsDir, "b.jsonl"), session("/elsewhere", "zebra-striping elsewhere too"));

			const project = await runToolCall(harness, "session_search", { query: "zebra-striping" });
			expect(text(project)).toContain("we chose zebra-striping");
			expect(text(project)).not.toContain("elsewhere too");

			const all = await runToolCall(harness, "session_search", { query: "zebra-striping", scope: "all" });
			expect(text(all)).toContain("elsewhere too");
		});

		// the tool searches the other sessions, and asks before their excerpts reach a cloud model.
		function writeSession(cwd: string, name: string, content: string) {
			const sessionsDir = join(agentDir, "sessions", "--other--");
			mkdirSync(sessionsDir, { recursive: true });
			writeFileSync(
				join(sessionsDir, name),
				[
					JSON.stringify({ type: "session", cwd, timestamp: "2026-10-01T10:00:00.000Z" }),
					JSON.stringify({ type: "message", message: { role: "user", content } }),
				].join("\n"),
			);
		}

		it("leaves the current session out of the search", async () => {
			const sessionsDir = join(agentDir, "sessions", "--current--");
			const harness = await createHarness({
				extensionFactories: [{ name: "session-search", factory: sessionSearchExtension }],
				sessionManager: SessionManager.create(agentDir, sessionsDir),
			});
			harnesses.push(harness);
			await harness.session.bindExtensions({ uiContext: createTestUiContext({}) });
			harness.setResponses([fauxAssistantMessage("noted")]);
			await harness.session.prompt("remember the word quokka-current");
			expect(readFileSync(harness.sessionManager.getSessionFile()!, "utf-8")).toContain("quokka-current");
			writeSession("/elsewhere", "old.jsonl", "quokka-current in an older session");

			const result = await runToolCall(harness, "session_search", { query: "quokka-current", scope: "all" });
			expect(text(result)).toContain("in an older session");
			expect(text(result)).not.toContain("remember the word");
		});

		it("asks before sending excerpts to a cloud model: once, for the session, or not at all", async () => {
			const answers = ["Do not send them", "Send them this time", "Send them for the rest of this session"];
			const questions: string[] = [];
			const harness = await start("session-search", sessionSearchExtension, {
				select: async (title: string) => {
					questions.push(title);
					return answers.shift();
				},
			});
			harness.getModel().baseUrl = "https://api.example.com/v1";
			writeSession("/elsewhere", "secret.jsonl", "the wombat-key lives in a private project");

			const refused = await runToolCall(harness, "session_search", { query: "wombat-key", scope: "all" });
			expect(text(refused)).not.toContain("private project");
			expect(text(refused)).toContain("did not allow");
			expect(questions[0]).toMatch(/^Send 1 excerpt\(s\) of 1 other session\(s\) to /);

			for (let i = 0; i < 3; i++) {
				const sent = await runToolCall(harness, "session_search", { query: "wombat-key", scope: "all" });
				expect(text(sent)).toContain("private project");
			}
			expect(questions).toHaveLength(3);
		});

		it("warns about privacy in its /settings description, in French too", () => {
			const description = EXTENSION_DESCRIPTIONS["session-search"]!;
			expect(description).toContain("Privacy: a cloud model then reads excerpts");
			setLanguage("fr");
			try {
				expect(t(description)).toBe(
					"Permet au modèle de chercher dans vos autres sessions. Confidentialité : un modèle cloud en lit alors des extraits, peut-être un travail privé mené avec un modèle local ; Prism vous demande d'abord.",
				);
			} finally {
				setLanguage("en");
			}
		});

		it("sends excerpts to a local model without asking", async () => {
			const harness = await start("session-search", sessionSearchExtension, {
				select: async () => {
					throw new Error("asked");
				},
			});
			harness.getModel().baseUrl = "http://127.0.0.1:8080/v1";
			writeSession("/elsewhere", "secret.jsonl", "the wombat-key lives in a private project");
			const result = await runToolCall(harness, "session_search", { query: "wombat-key", scope: "all" });
			expect(text(result)).toContain("private project");
		});
	});

	describe("notify", () => {
		const savedPath = process.env.PATH;
		const savedIsTTY = process.stdout.isTTY;
		let bin: string;

		beforeEach(() => {
			bin = join(agentDir, "fake-bin");
			mkdirSync(bin);
			process.env.PATH = bin;
		});

		afterEach(() => {
			process.env.PATH = savedPath;
			Object.defineProperty(process.stdout, "isTTY", { value: savedIsTTY, configurable: true });
			vi.restoreAllMocks();
		});

		// The Test notification row of Settings › Notifications (there is no /notify command).
		const sendTest = () =>
			settingsSections().find((s) => s.domain === "notifications")!.onChange!("notify-test", "send");

		it("is a replaceable built-in extension", () => {
			expect(entry("notify")).toEqual({
				name: "notify",
				factory: notifyExtension,
				replaceable: true,
				builtin: true,
			});
		});

		it("the Test notification setting calls notify-send", async () => {
			const notified = join(agentDir, "notified.txt");
			writeFileSync(join(bin, "notify-send"), `#!/bin/sh\necho "$@" >> "${notified}"\n`);
			chmodSync(join(bin, "notify-send"), 0o755);
			const reports: string[] = [];
			await start("notify", notifyExtension, { notify: (message) => reports.push(message) });
			sendTest();
			// The report comes once notify-send has exited: waiting for it keeps the callback inside this test.
			await expect.poll(() => reports.length, { timeout: 5000 }).toBe(1);
			expect(readFileSync(notified, "utf-8")).toContain("Notifications are working.");
		});

		it.each([
			[true, true],
			[false, false],
		])(
			"without notify-send, writes the terminal fallback only when stdout is a terminal (isTTY %s)",
			async (isTTY, written) => {
				Object.defineProperty(process.stdout, "isTTY", { value: isTTY, configurable: true });
				const writes: string[] = [];
				vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
					writes.push(String(chunk));
					return true;
				});
				await start("notify", notifyExtension);
				sendTest();
				await new Promise((resolve) => setTimeout(resolve, 300));
				expect(writes.some((chunk) => chunk.includes("Notifications are working."))).toBe(written);
			},
		);
	});

	describe("web", () => {
		const savedKey = process.env.EXA_API_KEY;
		let server: Server | undefined;

		beforeEach(() => {
			delete process.env.EXA_API_KEY;
		});

		afterEach(async () => {
			vi.restoreAllMocks();
			if (savedKey === undefined) delete process.env.EXA_API_KEY;
			else process.env.EXA_API_KEY = savedKey;
			await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
			server = undefined;
		});

		it("is a replaceable built-in extension", () => {
			expect(entry("web")).toEqual({ name: "web", factory: webExtension, replaceable: true, builtin: true });
		});

		/** Records Exa requests and answers them like the public MCP endpoint or the keyed API. */
		function fakeExa(publicStatus = 200) {
			const requests: { url: string; headers: Record<string, string>; body: string }[] = [];
			const realFetch = globalThis.fetch;
			vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
				const url = String(input);
				if (!url.includes("exa.ai")) return realFetch(input, init);
				requests.push({ url, headers: init?.headers as Record<string, string>, body: String(init?.body) });
				if (url.startsWith("https://api.exa.ai/")) {
					return Response.json({
						results: [{ title: "Keyed", url: "https://keyed.example/", text: "from the api" }],
					});
				}
				if (publicStatus !== 200) return new Response("too many", { status: publicStatus });
				const { id } = JSON.parse(String(init?.body)) as { id: string };
				const results =
					"Title: First page\nURL: https://one.example/\nPublished: N/A\nAuthor: N/A\nHighlights:\nfirst excerpt\n\n" +
					"Title: Second page\nURL: https://two.example/\nPublished: 2026-10-01\nAuthor: Someone\nHighlights:\nsecond excerpt";
				const message = { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: results }] } };
				return new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, {
					headers: { "content-type": "text/event-stream" },
				});
			});
			return requests;
		}

		it("without a key, registers web_search and web_fetch", async () => {
			const harness = await start("web", webExtension);
			expect(harness.session.systemPrompt).toContain("web_fetch");
			expect(harness.session.systemPrompt).toContain("web_search");
		});

		it("without a key, web_search uses Exa's public endpoint", async () => {
			const requests = fakeExa();
			const harness = await start("web", webExtension);
			const result = await runToolCall(harness, "web_search", { query: "prism", numResults: 2 });
			expect(result.isError).toBe(false);
			expect(text(result)).toContain("[1] First page\nhttps://one.example/\nfirst excerpt");
			expect(text(result)).toContain("[2] Second page\nhttps://two.example/\nSomeone · 2026-10-01\nsecond excerpt");
			expect(requests).toHaveLength(1);
			expect(requests[0].url).toBe("https://mcp.exa.ai/mcp?tools=web_search_exa");
			expect(JSON.parse(requests[0].body).params).toEqual({
				name: "web_search_exa",
				arguments: { query: "prism", numResults: 2 },
			});
		});

		it("without a key, a rate limit says how to add one", async () => {
			fakeExa(429);
			const harness = await start("web", webExtension);
			const result = await runToolCall(harness, "web_search", { query: "prism" });
			expect(result.isError).toBe(true);
			expect(text(result)).toContain("Save an Exa API key with /web-key");
		});

		it("uses the key from auth.json, never from exa.json", async () => {
			const requests = fakeExa();
			writeFileSync(join(agentDir, "exa.json"), JSON.stringify({ apiKey: "from-exa-json" }));
			await runToolCall(await start("web", webExtension), "web_search", { query: "prism" });
			expect(requests.at(-1)?.url).toBe("https://mcp.exa.ai/mcp?tools=web_search_exa");

			writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ exa: { type: "api_key", key: "test-key" } }));
			const result = await runToolCall(await start("web", webExtension), "web_search", { query: "prism" });
			expect(requests.at(-1)?.url).toBe("https://api.exa.ai/search");
			expect(requests.at(-1)?.headers["x-api-key"]).toBe("test-key");
			expect(text(result)).toContain("from the api");
		});

		it("/web-key saves the key in auth.json", async () => {
			const harness = await start("web", webExtension, { input: async () => "  saved-key  " });
			await harness.session.prompt("/web-key");
			expect(JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf-8")).exa).toEqual({
				type: "api_key",
				key: "saved-key",
			});
			await harness.session.prompt("/web-key remove");
			expect(JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf-8")).exa).toBeUndefined();
		});

		it("web_fetch reads a page directly without a key", async () => {
			server = createServer((_request, response) => {
				response.writeHead(200, { "content-type": "text/html" });
				response.end(
					"<html><head><title>Local page</title></head><body><h1>Hello</h1><p>from the fork</p></body></html>",
				);
			});
			await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
			const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
			const harness = await start("web", webExtension);
			const result = await runToolCall(harness, "web_fetch", { urls: url });
			expect(result.isError).toBe(false);
			expect(text(result)).toContain("# Local page");
			expect(text(result)).toContain("# Hello");
			expect(text(result)).toContain("from the fork");
			expect(text(result)).toContain("[direct (200)]");
		});

		// models pass a list of URLs JSON-encoded in the string form of `urls` (maintainer's QA
		// report, 2026-10-13: '["https://…"]' gave "No usable http(s) URL").
		it("web_fetch accepts a JSON-encoded list of URLs in a string", async () => {
			server = createServer((request, response) => {
				response.writeHead(200, { "content-type": "text/html" });
				response.end(`<html><head><title>Page ${request.url}</title></head><body><p>body</p></body></html>`);
			});
			await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
			const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
			const harness = await start("web", webExtension);
			const result = await runToolCall(harness, "web_fetch", { urls: JSON.stringify([`${base}/a`, `${base}/b`]) });
			expect(result.isError).toBe(false);
			expect(text(result)).toContain("# Page /a");
			expect(text(result)).toContain("# Page /b");
		});
	});

	// consult and delegate are gone; agent is the only delegation.
	it("ships no consult extension", () => {
		expect(entry("consult")).toBeUndefined();
	});

	describe("append-system", () => {
		it("is a built-in extension", () => {
			expect(entry("append-system")).toEqual({
				name: "append-system",
				factory: appendSystemExtension,
				builtin: true,
			});
		});

		it("appends the reference instructions to the system prompt, where APPEND_SYSTEM.md goes", async () => {
			// The reference copy is in the working repository only, not in the public export.
			const reference = join(__dirname, "../../../fork/reference/APPEND_SYSTEM.md");
			if (existsSync(reference)) expect(`${APPEND_SYSTEM_TEXT}\n`).toBe(readFileSync(reference, "utf-8"));
			const harness = await start("append-system", appendSystemExtension);
			let systemPrompt = "";
			harness.setResponses([
				() => {
					systemPrompt = harness.session.systemPrompt;
					return fauxAssistantMessage("ok");
				},
			]);
			await harness.session.prompt("hi");
			expect(systemPrompt.split(APPEND_SYSTEM_TEXT)).toHaveLength(2);
		});
	});
});
