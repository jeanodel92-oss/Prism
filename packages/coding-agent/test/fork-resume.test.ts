import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { type Component, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import { checkpointDir } from "../src/fork/checkpoints.ts";
import sessionStateExtension, { formatSessionState } from "../src/fork/session-state.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

const sourceResolverUrl = pathToFileURL(resolve(__dirname, "../src/experimental/source-resolver.ts")).href;
const childPath = resolve(__dirname, "fixtures/fork-resume-child.ts");
const tempDirs: string[] = [];
const harnesses: Harness[] = [];
const savedAgentDir = process.env[ENV_AGENT_DIR];

afterEach(() => {
	if (savedAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = savedAgentDir;
	for (const harness of harnesses.splice(0)) harness.cleanup();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("fork: interrupted session resume", () => {
	it("shows a killed tool call and accepts the next prompt on the same session", async () => {
		const root = mkdtempSync(join(tmpdir(), "prism-resume-"));
		tempDirs.push(root);
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const sessionDir = join(agentDir, "sessions");
		const readyFile = join(root, "tool-running");
		mkdirSync(projectDir, { recursive: true });
		// This process reads the same agent dir (checkpoints), never the user's.
		process.env[ENV_AGENT_DIR] = agentDir;
		const env = { ...process.env, [ENV_AGENT_DIR]: agentDir };
		const child = spawn(process.execPath, ["--import", sourceResolverUrl, childPath, sessionDir, readyFile], {
			cwd: projectDir,
			env,
			stdio: "ignore",
		});
		await new Promise<void>((resolvePromise, reject) => {
			const timer = setTimeout(() => reject(new Error("Child tool did not start")), 10_000);
			const poll = setInterval(() => {
				if (existsSync(readyFile)) {
					clearInterval(poll);
					clearTimeout(timer);
					resolvePromise();
				}
			}, 20);
			child.once("error", (error) => {
				clearInterval(poll);
				clearTimeout(timer);
				reject(error);
			});
		});
		const sessionFile = readFileSync(readyFile, "utf8");
		const closed = new Promise<void>((resolvePromise) => child.once("close", () => resolvePromise()));
		child.kill("SIGKILL");
		await closed;

		const manager = SessionManager.open(sessionFile);
		const entries = manager.getBranch();
		const view = formatSessionState(entries, [], 40);
		expect(view.join("\n")).toContain("Last turn: interrupted");
		expect(view.join("\n")).toContain("wait_tool");
		expect(view.join("\n")).toContain("no result recorded");
		for (const line of view) expect(visibleWidth(line)).toBeLessThanOrEqual(40);

		// A checkpoint for the interrupted turn, where the checkpoints extension keeps it.
		const resumedManager = SessionManager.open(sessionFile);
		const checkpoints = checkpointDir(resumedManager)!;
		mkdirSync(checkpoints, { recursive: true });
		writeFileSync(join(checkpoints, "index.json"), JSON.stringify([{ seq: 1, turn: 1, path: "a.ts" }]));

		initTheme();
		const widgets = new Map<string, Component | undefined>();
		const resumed = await createHarness({
			sessionManager: resumedManager,
			extensionFactories: [{ name: "session-state", factory: sessionStateExtension }],
		});
		harnesses.push(resumed);
		await resumed.session.bindExtensions({
			uiContext: createTestUiContext({
				setWidget: (key: string, content: unknown) =>
					widgets.set(
						key,
						typeof content === "function"
							? (content as (tui: TUI, t: typeof theme) => Component)({} as TUI, theme)
							: undefined,
					),
			}),
		});
		const shown = widgets.get("session-state")?.render(40) ?? [];
		expect(shown.join("\n")).toContain("Last turn: interrupted");
		expect(shown.join("\n")).toContain("wait_tool");
		expect(shown.join("\n")).toContain("turn 1");
		for (const line of shown) expect(visibleWidth(line)).toBeLessThanOrEqual(40);

		resumed.setResponses([fauxAssistantMessage("Resumed successfully")]);
		await resumed.session.prompt("continue the task");
		expect(
			resumed.session.messages.some(
				(message) =>
					message.role === "assistant" &&
					message.content.some((part) => part.type === "text" && part.text === "Resumed successfully"),
			),
		).toBe(true);
		// The view goes away with the next prompt, and the old orphan call is no longer the last turn.
		expect(widgets.get("session-state")).toBeUndefined();
		await resumed.session.prompt("/state");
		expect(widgets.get("session-state")?.render(80).join("\n")).toContain("Last turn: completed");
		expect(
			builtInExtensions.some((extension) => typeof extension !== "function" && extension.name === "session-state"),
		).toBe(true);
	});

	// the last reply of the whole branch was read, even one to an earlier prompt.
	it("counts a prompt left without a reply, or tools without the next reply, as interrupted", () => {
		const status = (build: (manager: SessionManager) => void) => {
			const manager = SessionManager.inMemory();
			build(manager);
			return formatSessionState(manager.getBranch(), [], 80).find((line) => line.startsWith("Last turn"));
		};
		const user = (text: string) => ({ role: "user" as const, content: text, timestamp: Date.now() });
		expect(status((m) => m.appendMessage(user("first prompt")))).toBe("Last turn: interrupted");
		expect(
			status((m) => {
				m.appendMessage(user("earlier"));
				m.appendMessage(fauxAssistantMessage("done"));
				m.appendMessage(user("later"));
			}),
		).toBe("Last turn: interrupted");
		const call = fauxToolCall("read", { path: "a.ts" }, { id: "call-1" });
		expect(
			status((m) => {
				m.appendMessage(user("read it"));
				m.appendMessage(fauxAssistantMessage([call], { stopReason: "toolUse" }));
				m.appendMessage({
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: [{ type: "text", text: "ok" }],
					isError: false,
					timestamp: Date.now(),
				});
			}),
		).toBe("Last turn: interrupted");
		expect(
			status((m) => {
				m.appendMessage(user("say hi"));
				m.appendMessage(fauxAssistantMessage("hi"));
			}),
		).toBe("Last turn: completed");
		expect(status(() => {})).toBe("Last turn: completed");
	});

	it("truncates state lines safely at narrow widths", () => {
		expect(formatSessionState([], [], 40, 2).join("\n")).toContain("Running background tasks: 2 (/bg)");
		expect(formatSessionState([], [], 40).join("\n")).toContain("module off");
		const view = formatSessionState([], [], 40);
		expect(view.length).toBeGreaterThan(0);
		expect(view.every((line) => visibleWidth(line) <= 40)).toBe(true);
	});
});
