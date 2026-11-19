// fork: the maintainer's choices among the art direction proposals:
// B, consecutive one-line tool calls form one block; C, a line with the turn's figures ends each turn;
// D, markdown tables in hairlines.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, getModel } from "@earendil-works/pi-ai/compat";
import { Container, Markdown, setMarkdownTokenHook, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { setLanguage } from "../src/fork/i18n/index.ts";
import { createState, type PrismState } from "../src/fork/prism/lib/state.ts";
import { markdownTokenHook, transcriptHooks } from "../src/fork/prism/transcript.ts";
import {
	formatDuration,
	installTurnSummary,
	TURN_ENTRY,
	type TurnFigures,
	turnFigures,
	turnText,
} from "../src/fork/prism/turn-summary.ts";
import { setRenderHooks } from "../src/fork/render-hooks.ts";
import { AssistantMessageComponent, ToolExecutionComponent } from "../src/modes/interactive/components/index.ts";
import { getMarkdownTheme, initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const model = getModel("anthropic", "claude-sonnet-4-5")!;
const ui = { requestRender: () => {} } as unknown as TUI;

function assistant(content: AssistantMessage["content"], input = 0, output = 0, cost = 0): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input,
			output,
			cacheRead: 500,
			cacheWrite: 0,
			totalTokens: input + output,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

function prismState(mode: "simple" | "advanced" = "simple"): PrismState {
	const state = createState();
	state.theme = theme;
	state.animates = () => false;
	state.interfaceMode = () => mode;
	return state;
}

describe("fork: art direction, the maintainer's choices", () => {
	beforeAll(() => initTheme("prism"));
	afterEach(() => {
		setRenderHooks({});
		setMarkdownTokenHook(undefined);
		setLanguage("en");
	});

	it("draws a table in hairlines: header in ink 3, a line under it and between rows, no vertical lines", () => {
		setMarkdownTokenHook(markdownTokenHook(prismState()));
		const table = "| Surface | Before |\n|---|---|\n| Footer | two grey lines |\n| Tools | boxes |";
		const lines = new Markdown(table, 0, 0, getMarkdownTheme()).render(60);
		const plain = lines.map((line) => stripAnsi(line).trimEnd());
		expect(plain).toEqual([
			"Surface   Before",
			"────────────────────────",
			"Footer    two grey lines",
			"────────────────────────",
			"Tools     boxes",
		]);
		const [r, g, b] = [0x9c, 0x9c, 0x97]; // ink 3 of the prism theme
		expect(lines[0]).toContain(`\x1b[38;2;${r};${g};${b}m`);
		expect(lines[0]).not.toContain("\x1b[1m");
		for (const line of plain) expect(line).not.toMatch(/[│┌┐└┘├┤┬┴┼]/);
	});

	it("keeps a table too narrow for a box as raw markdown", () => {
		setMarkdownTokenHook(markdownTokenHook(prismState()));
		const table = "| a | b | c | d |\n|---|---|---|---|\n| 1 | 2 | 3 | 4 |";
		const plain = new Markdown(table, 0, 0, getMarkdownTheme()).render(13).map((l) => stripAnsi(l).trimEnd());
		expect(plain.join("\n")).toContain("| a | b |");
	});

	describe("tool calls", () => {
		function chat(mode: "simple" | "advanced" = "simple") {
			setRenderHooks(transcriptHooks(prismState(mode)));
			const container = new Container();
			const add = (component: AssistantMessageComponent | ToolExecutionComponent) => {
				container.addChild(component);
				if (component instanceof ToolExecutionComponent) component.setChatSlot(container);
				return component;
			};
			const text = (value: string) =>
				add(new AssistantMessageComponent(assistant([{ type: "text", text: value }]), false, getMarkdownTheme()));
			const read = (path: string) => {
				const tool = add(new ToolExecutionComponent("read", path, { path }, {}, undefined, ui, process.cwd()));
				(tool as ToolExecutionComponent).updateResult(
					{ content: [{ type: "text", text: `contents of ${path}` }], isError: false },
					false,
				);
				return tool as ToolExecutionComponent;
			};
			const render = () =>
				container
					.render(60)
					.map((line) => stripAnsi(line).trimEnd())
					.join("\n");
			return { add, text, read, render };
		}

		it("puts consecutive one-line calls in one block, and keeps the blank line around text", () => {
			const { text, read, render } = chat();
			text("Looking around.");
			read("a.ts");
			read("b.ts");
			read("c.ts");
			text("Done.");
			expect(render()).toMatch(
				/Looking around\.\n\n● \S+ Read file a\.ts\n● \S+ Read file b\.ts\n● \S+ Read file c\.ts\n\n─ Done\./,
			);
		});

		it("joins calls across a turn that only made tool calls", () => {
			const { add, read, render } = chat();
			read("a.ts");
			add(
				new AssistantMessageComponent(
					assistant([{ type: "toolCall", id: "b", name: "read", arguments: { path: "b.ts" } }]),
					false,
					getMarkdownTheme(),
				),
			);
			read("b.ts");
			expect(render()).toMatch(/Read file a\.ts\n● \S+ Read file b\.ts/);
		});

		it("keeps the blank lines around a call whose details are shown", () => {
			const { read, render } = chat();
			read("a.ts");
			read("b.ts").setExpanded(true);
			read("c.ts");
			const out = render();
			expect(out).toMatch(/Read file a\.ts\n\n/);
			expect(out).toMatch(/contents of b\.ts\n\n● \S+ Read file c\.ts/);
		});

		it("does not join calls without their place in the chat", () => {
			setRenderHooks(transcriptHooks(prismState()));
			const container = new Container();
			for (const path of ["a.ts", "b.ts"]) {
				const tool = new ToolExecutionComponent("read", path, { path }, {}, undefined, ui, process.cwd());
				tool.updateResult({ content: [{ type: "text", text: "x" }], isError: false }, false);
				container.addChild(tool);
			}
			expect(container.render(60).map((line) => stripAnsi(line).trimEnd())).toEqual([
				"",
				expect.stringMatching(/Read file a\.ts$/),
				"",
				expect.stringMatching(/Read file b\.ts$/),
			]);
		});
	});

	describe("end of turn", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "go", timestamp: 0 },
			assistant([{ type: "toolCall", id: "1", name: "read", arguments: {} }], 6000, 400, 0.02),
			{ role: "toolResult", toolCallId: "1", toolName: "read", content: [], isError: false, timestamp: 1 },
			{ role: "toolResult", toolCallId: "2", toolName: "grep", content: [], isError: true, timestamp: 1 },
			assistant([{ type: "text", text: "done" }], 40, 1000, 0.018),
		];

		it("counts the run's calls, failures, tokens sent without the cache, and cost", () => {
			const figures = turnFigures(messages, 14_200);
			expect(figures).toMatchObject({ ms: 14_200, tools: 2, failed: 1, input: 6040, output: 1400 });
			expect(figures.cost).toBeCloseTo(0.038, 6);
		});

		it("says them in the interface's words and language", () => {
			const figures: TurnFigures = { ms: 14_200, tools: 8, failed: 3, input: 6040, output: 1400, cost: 0.038 };
			expect(turnText(figures, false)).toBe("14 s · 8 tools · 3 failures · sent 6.0k · received 1.4k · $0.038");
			expect(turnText(figures, true)).toBe("14 s · 8 tools · 3 failures · ↑6.0k ↓1.4k · $0.038");
			setLanguage("fr");
			expect(turnText(figures, false)).toBe("14 s · 8 outils · 3 échecs · envoyés 6.0k · reçus 1.4k · $0.038");
			expect(turnText({ ...figures, tools: 1, failed: 1 }, false)).toContain("1 outil · 1 échec");
			expect(turnText({ ms: 900, tools: 0, failed: 0, input: 0, output: 0, cost: 0 }, false)).toBe("1 s");
			expect(turnText({ ...figures, cost: 0 }, false)).toBe(
				"14 s · 8 outils · 3 échecs · envoyés 6.0k · reçus 1.4k",
			);
			expect(formatDuration(125_000)).toBe("2 min 5 s");
			expect(formatDuration(3_720_000)).toBe("1 h 2 min");
		});

		it("records the run as a session entry the model never sees, and draws it as a hairline", async () => {
			const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
			let renderer: ((entry: { data: TurnFigures }, options: unknown, theme: unknown) => any) | undefined;
			const appendEntry = vi.fn();
			const pi = {
				on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => handlers.set(name, handler),
				registerEntryRenderer: (_type: string, render: typeof renderer) => {
					renderer = render;
				},
				appendEntry,
			} as unknown as ExtensionAPI;
			installTurnSummary(pi, prismState());

			await handlers.get("agent_start")!({ type: "agent_start" }, { hasUI: true });
			await handlers.get("agent_end")!({ type: "agent_end", messages }, { hasUI: true });
			expect(appendEntry).toHaveBeenCalledTimes(1);
			const [type, data] = appendEntry.mock.calls[0]!;
			expect(type).toBe(TURN_ENTRY);
			expect(data).toMatchObject({ tools: 2, failed: 1, input: 6040, output: 1400 });

			await handlers.get("agent_start")!({ type: "agent_start" }, { hasUI: false });
			await handlers.get("agent_end")!({ type: "agent_end", messages }, { hasUI: false });
			expect(appendEntry).toHaveBeenCalledTimes(1);

			const component = renderer!({ data }, {}, theme);
			for (const width of [100, 60, 30]) {
				const [line] = component.render(width).map(stripAnsi);
				expect([...line].length).toBeLessThanOrEqual(width);
				if (width === 100)
					expect(line).toMatch(/^ {2}── \d+ s · 2 tools · 1 failure · sent 6\.0k · received 1\.4k · \$0\.038 ─+$/);
				// Narrower: the token counts, also in the footer, give way first.
				if (width === 60) expect(line).toMatch(/^ {2}\d+ s · 2 tools · 1 failure · \$0\.038$/);
			}
		});
	});
});
