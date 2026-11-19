import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type Component, Container, MouseRegion, Text, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { TuiMainScreen } from "../../tui/src/tui-main-screen.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import { applyExpansion } from "../src/fork/expand-all.ts";
import { createHeaderFactory } from "../src/fork/prism/header.ts";
import { createState } from "../src/fork/prism/lib/state.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { BashExecutionComponent } from "../src/modes/interactive/components/bash-execution.ts";
import { BranchSummaryMessageComponent } from "../src/modes/interactive/components/branch-summary-message.ts";
import { CompactionSummaryMessageComponent } from "../src/modes/interactive/components/compaction-summary-message.ts";
import { CustomEntryComponent } from "../src/modes/interactive/components/custom-entry.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { SkillInvocationMessageComponent } from "../src/modes/interactive/components/skill-invocation-message.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const agentDir = mkdtempSync(join(tmpdir(), "prism-expand-all-"));
const ui = new TuiMainScreen(new VirtualTerminal(80, 24));
const thinkingMessage: AssistantMessage = {
	role: "assistant",
	content: [
		{ type: "thinking", thinking: "first reasoning" },
		{ type: "text", text: "answer" },
		{ type: "thinking", thinking: "second reasoning" },
	],
	api: "openai-completions",
	provider: "fake",
	model: "scripted",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 0,
};

function rendered(component: Component, width = 80): string {
	return stripAnsi(component.render(width).join("\n"));
}

function click(component: Component, label: string): void {
	const lines = component.render(80);
	const row = lines.findIndex((line) => stripAnsi(line).includes(label));
	expect(row).toBeGreaterThanOrEqual(0);
	const event: TuiMouseEvent = {
		type: "click",
		button: "left",
		x: 2,
		y: row,
		screenX: 2,
		screenY: row,
		width: 80,
		height: lines.length,
		shift: false,
		alt: false,
		ctrl: false,
		clickCount: 1,
	};
	expect(component.handleMouse?.(event)?.handled).toBe(true);
}

function tool(id: string): ToolExecutionComponent {
	const component = new ToolExecutionComponent(
		"read",
		id,
		{ path: `${id}.txt` },
		{ showImages: false },
		createReadToolDefinition(agentDir),
		ui,
		agentDir,
	);
	component.updateResult({ content: [{ type: "text", text: `${id} full output` }], isError: false });
	return component;
}

// Exercise the real handlers without constructing a session or reading credentials.
function createMode(hideThinkingBlock = true) {
	const mode = {
		toolOutputExpanded: false,
		hideThinkingBlock,
		thinkingExpansionOverride: undefined as boolean | undefined,
		chatContainer: new Container(),
		loadedResourcesContainer: new Container(),
		pendingBashComponents: [] as BashExecutionComponent[],
		builtInHeader: { setExpanded: vi.fn() },
		ui,
		isInitialized: true,
		footer: { invalidate: vi.fn() },
		streamingComponent: undefined as AssistantMessageComponent | undefined,
		streamingMessage: undefined as AssistantMessage | undefined,
		hiddenThinkingLabel: "Thinking...",
		outputPad: 1,
		getMarkdownThemeWithSettings: getMarkdownTheme,
		getMarkdownTransformers: () => [],
		settingsManager: { setHideThinkingBlock: vi.fn() },
		showStatus: vi.fn(),
		setToolsExpanded(expanded: boolean): void {
			const method = Reflect.get(InteractiveMode.prototype, "setToolsExpanded") as (
				this: typeof mode,
				expanded: boolean,
			) => void;
			method.call(this, expanded);
		},
		updateThinkingBlockVisibility(): void {
			const method = Reflect.get(InteractiveMode.prototype, "updateThinkingBlockVisibility") as (
				this: typeof mode,
			) => void;
			method.call(this);
		},
		toggleThinkingBlockVisibility(): void {
			const method = Reflect.get(InteractiveMode.prototype, "toggleThinkingBlockVisibility") as (
				this: typeof mode,
			) => void;
			method.call(this);
		},
		toggleToolOutputExpansion(): void {
			const method = Reflect.get(InteractiveMode.prototype, "toggleToolOutputExpansion") as (
				this: typeof mode,
			) => void;
			method.call(this);
		},
		toggleExpandAll(): void {
			const method = Reflect.get(InteractiveMode.prototype, "toggleExpandAll") as (this: typeof mode) => void;
			method.call(this);
		},
		addMessageToChat(message: AgentMessage): void {
			const method = Reflect.get(InteractiveMode.prototype, "addMessageToChat") as (
				this: typeof mode,
				message: AgentMessage,
			) => void;
			method.call(this, message);
		},
		async handleEvent(event: AgentSessionEvent): Promise<void> {
			const method = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
				this: typeof mode,
				event: AgentSessionEvent,
			) => Promise<void>;
			await method.call(this, event);
		},
	};
	return mode;
}

describe("fork: global expansion overrides clicks", () => {
	beforeAll(() => {
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("PRISM_CODING_AGENT_DIR", agentDir);
		initTheme("dark");
	});
	afterAll(() => {
		vi.unstubAllEnvs();
		rmSync(agentDir, { recursive: true, force: true });
	});

	test("Ctrl+O forces both tools open or closed after individual clicks", () => {
		const mode = createMode();
		const first = tool("first");
		const second = tool("second");
		mode.chatContainer.addChild(first);
		mode.chatContainer.addChild(second);
		click(first, "first.txt");
		expect(rendered(first)).toContain("first full output");
		expect(rendered(second)).not.toContain("second full output");
		for (const [expanded, clickBefore] of [
			[true, false],
			[false, false],
			[true, true],
		] as const) {
			if (clickBefore) click(first, "first.txt");
			mode.toggleToolOutputExpansion();
			for (const [component, id] of [
				[first, "first"],
				[second, "second"],
			] as const) {
				expect(rendered(component).includes(`${id} full output`)).toBe(expanded);
			}
		}
		click(first, "first.txt");
		expect(rendered(first)).not.toContain("first full output");
		expect(rendered(second)).toContain("second full output");
	});

	test("Ctrl+O clears every thinking run override, including during streaming", () => {
		const mode = createMode();
		const first = new AssistantMessageComponent(thinkingMessage, true);
		const second = new AssistantMessageComponent(thinkingMessage, true);
		mode.chatContainer.addChild(first);
		mode.chatContainer.addChild(second);
		click(first, "Thinking...");
		expect(rendered(first)).toContain("first reasoning");
		expect(rendered(first)).not.toContain("second reasoning");
		for (const [expanded, clickBefore] of [
			[true, false],
			[false, false],
			[true, true],
		] as const) {
			if (clickBefore) click(first, "Thinking...");
			mode.toggleToolOutputExpansion();
			first.updateContent(thinkingMessage, true);
			first.invalidate();
			for (const component of [first, second]) {
				expect(rendered(component).includes("first reasoning")).toBe(expanded);
				expect(rendered(component).includes("second reasoning")).toBe(expanded);
				expect(rendered(component)).toContain("answer");
			}
		}
		click(first, "first reasoning");
		expect(rendered(first)).not.toContain("first reasoning");
		expect(rendered(first)).toContain("second reasoning");
		expect(rendered(second)).toContain("first reasoning");
		expect(mode.settingsManager.setHideThinkingBlock).not.toHaveBeenCalled();
	});

	test.each([false, true])("explicit state %s is forced again after clicks", (expanded) => {
		const mode = createMode();
		const read = tool("read");
		const thinking = new AssistantMessageComponent(thinkingMessage);
		mode.chatContainer.addChild(read);
		mode.chatContainer.addChild(thinking);
		mode.setToolsExpanded(expanded);
		click(read, "read.txt");
		click(thinking, expanded ? "first reasoning" : "Thinking...");
		mode.setToolsExpanded(expanded);
		expect(rendered(read).includes("read full output")).toBe(expanded);
		expect(rendered(thinking).includes("first reasoning")).toBe(expanded);
	});

	test("/expand forces thinking and tools when its chosen global value is unchanged", () => {
		const mode = createMode(true);
		const read = tool("read");
		const thinking = new AssistantMessageComponent(thinkingMessage, true);
		mode.chatContainer.addChild(read);
		mode.chatContainer.addChild(thinking);
		mode.toggleToolOutputExpansion();
		click(read, "read.txt");
		click(thinking, "first reasoning");
		mode.toggleExpandAll();
		expect(mode.toolOutputExpanded).toBe(true);
		expect(rendered(read)).toContain("read full output");
		expect(rendered(thinking)).toContain("first reasoning");
		expect(rendered(thinking)).toContain("second reasoning");
		mode.toggleExpandAll();
		expect(rendered(read)).not.toContain("read full output");
		expect(rendered(thinking)).not.toContain("first reasoning");
	});

	test.each([false, true])("new thinking respects configured hidden=%s before Ctrl+O", async (hidden) => {
		const mode = createMode(hidden);
		mode.addMessageToChat(thinkingMessage);
		expect(rendered(mode.chatContainer).includes("first reasoning")).toBe(!hidden);
		for (const expanded of [true, false]) {
			mode.toggleToolOutputExpansion();
			mode.addMessageToChat(thinkingMessage);
			expect(rendered(mode.chatContainer.children.at(-1)!).includes("first reasoning")).toBe(expanded);
			await mode.handleEvent({ type: "message_start", message: thinkingMessage });
			expect(rendered(mode.streamingComponent!).includes("first reasoning")).toBe(expanded);
		}
		expect(mode.hideThinkingBlock).toBe(hidden);
		expect(mode.settingsManager.setHideThinkingBlock).not.toHaveBeenCalled();
	});

	test("Ctrl+T and the thinking setting take precedence until the next Ctrl+O", () => {
		const mode = createMode(false);
		mode.addMessageToChat(thinkingMessage);
		const read = tool("read");
		mode.chatContainer.addChild(read);
		mode.toggleToolOutputExpansion();
		mode.toggleThinkingBlockVisibility();
		expect(rendered(mode.chatContainer)).not.toContain("first reasoning");
		expect(rendered(read)).toContain("read full output");
		expect(mode.settingsManager.setHideThinkingBlock).toHaveBeenCalledWith(true);
		mode.addMessageToChat(thinkingMessage);
		expect(rendered(mode.chatContainer.children.at(-1)!)).not.toContain("first reasoning");
		mode.hideThinkingBlock = false;
		mode.updateThinkingBlockVisibility();
		expect(rendered(mode.chatContainer)).toContain("first reasoning");
		mode.toggleToolOutputExpansion();
		expect(rendered(mode.chatContainer)).not.toContain("first reasoning");
		expect(rendered(read)).not.toContain("read full output");
	});

	test("forces summaries, skills, pending bash, loaded resources and the header", () => {
		const mode = createMode();
		const summaries = [
			new CompactionSummaryMessageComponent({
				role: "compactionSummary",
				summary: "summary body",
				tokensBefore: 10,
				timestamp: 0,
			}),
			new BranchSummaryMessageComponent({
				role: "branchSummary",
				summary: "summary body",
				fromId: null,
				timestamp: 0,
			}),
			new SkillInvocationMessageComponent({
				name: "skill",
				location: "/tmp/skill",
				content: "summary body",
				userMessage: undefined,
			}),
		];
		for (const component of summaries) mode.chatContainer.addChild(component);
		const bash = new BashExecutionComponent("example", ui);
		bash.appendOutput(Array.from({ length: 30 }, (_, i) => `bash line ${i}`).join("\n"));
		bash.setComplete(0, false);
		mode.pendingBashComponents.push(bash);
		const state = createState();
		state.theme = theme;
		const header = createHeaderFactory(state, false)(ui);
		mode.loadedResourcesContainer.addChild(header);
		click(summaries[0], "[conversation summary]");
		for (const expanded of [true, false, true]) {
			mode.toggleToolOutputExpansion();
			for (const component of summaries) expect(rendered(component).includes("summary body")).toBe(expanded);
			expect(rendered(bash).includes("bash line 0")).toBe(expanded);
			expect(rendered(header).includes("to change thinking level")).toBe(expanded);
			expect(mode.builtInHeader.setExpanded).toHaveBeenLastCalledWith(expanded);
			for (const component of [...summaries, bash, header]) {
				expect(() => component.render(40)).not.toThrow();
			}
		}
	});

	test("new bash transcript entries inherit the global state", () => {
		const mode = createMode();
		for (const expanded of [true, false]) {
			mode.toggleToolOutputExpansion();
			mode.addMessageToChat({
				role: "bashExecution",
				command: "example",
				output: Array.from({ length: 30 }, (_, i) => `bash line ${i}`).join("\n"),
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timestamp: 0,
			});
			expect(rendered(mode.chatContainer.children.at(-1)!).includes("bash line 0")).toBe(expanded);
		}
	});

	test("reapplies expansion to custom message and entry renderers after their own clicks", () => {
		const renderer = (_message: unknown, options: { expanded: boolean }): Component => {
			let expanded = options.expanded;
			const text = new Text(expanded ? "custom open" : "custom closed", 0, 0);
			return new MouseRegion(text, (event) => {
				if (event.type !== "click" || event.button !== "left") return undefined;
				expanded = !expanded;
				text.setText(expanded ? "custom open" : "custom closed");
				return { handled: true };
			});
		};
		const components = [
			new CustomMessageComponent(
				{ role: "custom", customType: "test", content: "", display: true, timestamp: 0 },
				renderer,
			),
			new CustomEntryComponent(
				{
					type: "custom",
					id: "entry",
					parentId: null,
					timestamp: "2026-10-13T00:00:00Z",
					customType: "test",
					data: {},
				},
				renderer,
			),
		];
		for (const expanded of [true, false]) {
			applyExpansion(expanded, components);
			for (const component of components) click(component, expanded ? "custom open" : "custom closed");
			applyExpansion(expanded, components);
			for (const component of components)
				expect(rendered(component)).toContain(expanded ? "custom open" : "custom closed");
		}
	});
});
