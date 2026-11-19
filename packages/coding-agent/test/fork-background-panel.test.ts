import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { KeybindingsManager as AppKeybindingsManager } from "../src/core/keybindings.ts";
import backgroundExtension, { type BackgroundTasksPanel } from "../src/fork/background.ts";
import { initTheme, type Theme, theme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, createTestUiContext, getToolResult, type Harness } from "./suite/harness.ts";

const plain = (text: string) => text.replace(/\x1b\[[0-9;:]*m/g, "");

describe("fork: background task panel", () => {
	const savedAgentDir = process.env[ENV_AGENT_DIR];
	const harnesses: Harness[] = [];
	let agentDir: string;
	let taskPid: number | undefined;

	afterEach(async () => {
		if (taskPid) {
			try {
				process.kill(-taskPid, "SIGTERM");
			} catch {}
			await new Promise((resolve) => setTimeout(resolve, 100));
			taskPid = undefined;
		}
		for (const harness of harnesses.splice(0)) harness.cleanup();
		if (savedAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = savedAgentDir;
		if (agentDir && existsSync(agentDir)) rmSync(agentDir, { recursive: true, force: true });
	});

	it("keeps two prompts responsive, shows live output, and stops the process from the panel", async () => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-background-panel-"));
		process.env[ENV_AGENT_DIR] = agentDir;
		initTheme("dark");
		const keybindings = new AppKeybindingsManager();
		setKeybindings(keybindings);
		let component: Component | undefined;
		const statuses: Array<string | undefined> = [];
		const fakeTui = { terminal: { rows: 16 }, requestRender: () => {} } as unknown as TUI;
		const ui = createTestUiContext({
			setStatus: (_key, value) => statuses.push(value),
			custom: async <T>(
				factory: (
					tui: TUI,
					theme: Theme,
					keybindings: AppKeybindingsManager,
					done: (result: T) => void,
				) => Component & { dispose?(): void },
			): Promise<T> => {
				component = factory(fakeTui, theme, keybindings, () => {});
				return undefined as T;
			},
		});
		const harness = await createHarness({
			extensionFactories: [{ name: "background", factory: backgroundExtension }],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: ui, mode: "tui" });

		const pidFile = join(harness.tempDir, "task.pid");
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("background", {
					action: "run",
					command: `echo panel-output; echo $$ > '${pidFile}'; sleep 30`,
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("started"),
		]);
		await harness.session.prompt("start long task");
		const startResult = getToolResult(harness, "background");
		expect(startResult.content.map((part) => ("text" in part ? part.text : "")).join("\n")).toContain("Started bg1");
		if (typeof startResult.details === "object" && startResult.details !== null && "pid" in startResult.details) {
			taskPid = typeof startResult.details.pid === "number" ? startResult.details.pid : undefined;
		}
		for (let attempt = 0; attempt < 40 && !existsSync(pidFile); attempt++)
			await new Promise((resolve) => setTimeout(resolve, 25));
		const pid = Number(readFileSync(pidFile, "utf8").trim());

		harness.setResponses([fauxAssistantMessage("first prompt complete")]);
		await harness.session.prompt("first prompt");
		harness.setResponses([fauxAssistantMessage("second prompt complete")]);
		await harness.session.prompt("second prompt");
		expect(harness.session.getLastAssistantText()).toBe("second prompt complete");

		await harness.session.prompt("/bg");
		expect(component).toBeDefined();
		const panel = component as BackgroundTasksPanel;
		let lines = panel.render(40).map(plain);
		expect(lines.join("\n")).toContain("running");
		expect(statuses).toContain("bg: 1 running");
		for (const line of panel.render(40)) expect(visibleWidth(line)).toBeLessThanOrEqual(40);

		panel.handleInput("\r");
		lines = panel.render(40).map(plain);
		for (let attempt = 0; attempt < 40 && !lines.join("\n").includes("panel-output"); attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 25));
			lines = panel.render(40).map(plain);
		}
		expect(lines.join("\n")).toContain("panel-output");
		for (const line of panel.render(40)) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
		// The confirmation is asked inside the panel (a dialog would open behind the overlay); Esc keeps the task.
		panel.handleInput("\r");
		expect(panel.render(40).map(plain).join("\n")).toContain("Stop this task?");
		panel.handleInput("\x1b");
		expect(panel.render(40).map(plain).join("\n")).not.toContain("Stop this task?");
		expect(() => process.kill(pid, 0)).not.toThrow();
		panel.handleInput("\r");
		panel.handleInput("\r");
		for (let attempt = 0; attempt < 40; attempt++) {
			try {
				process.kill(pid, 0);
			} catch {
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		expect(() => process.kill(pid, 0)).toThrow();
		// The task becomes "stopped" on the process's close event, which can come after its pid is gone.
		for (let attempt = 0; attempt < 200 && statuses.at(-1) !== undefined; attempt++)
			await new Promise((resolve) => setTimeout(resolve, 25));
		lines = panel.render(40).map(plain);
		expect(lines.join("\n")).toContain("stopped");
		expect(statuses.at(-1)).toBeUndefined();
		panel.dispose();
	});

	it("opens the task shown under the cursor: the newest is listed first", async () => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-background-panel-"));
		process.env[ENV_AGENT_DIR] = agentDir;
		initTheme("dark");
		setKeybindings(new AppKeybindingsManager());
		let component: Component | undefined;
		const fakeTui = { terminal: { rows: 16 }, requestRender: () => {} } as unknown as TUI;
		const harness = await createHarness({
			extensionFactories: [{ name: "background", factory: backgroundExtension }],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				custom: async <T>(
					factory: (
						tui: TUI,
						theme: Theme,
						keybindings: AppKeybindingsManager,
						done: (result: T) => void,
					) => Component,
				): Promise<T> => {
					component = factory(fakeTui, theme, new AppKeybindingsManager(), () => {});
					return undefined as T;
				},
			}),
			mode: "tui",
		});
		const pids: number[] = [];
		for (const name of ["older-task", "newer-task"]) {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("background", { action: "run", command: `sleep 30 # ${name}` }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("started"),
			]);
			await harness.session.prompt(`start ${name}`);
			const details = getToolResult(harness, "background").details as { pid?: number };
			if (details.pid) pids.push(details.pid);
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		try {
			await harness.session.prompt("/bg");
			const panel = component as BackgroundTasksPanel;
			const list = panel.render(60).map(plain).join("\n");
			expect(list.indexOf("newer-task")).toBeLessThan(list.indexOf("older-task"));
			panel.handleInput("\r");
			const detail = panel.render(60).map(plain).join("\n");
			expect(detail).toContain("newer-task");
			expect(detail).not.toContain("older-task");
			panel.dispose();
		} finally {
			for (const pid of pids) {
				try {
					process.kill(-pid, "SIGTERM");
				} catch {}
			}
		}
	});
});
