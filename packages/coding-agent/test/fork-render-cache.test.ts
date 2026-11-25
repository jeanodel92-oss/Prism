// fork: finished transcript messages are decorated once, and the footer's context usage is
// computed once per session leaf, instead of on every frame.
import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, getModel, streamSimple } from "@earendil-works/pi-ai/compat";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { type RenderHooks, setRenderHooks } from "../src/fork/render-hooks.ts";
import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
} from "../src/modes/interactive/components/index.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

function assistant(text: string, tokens = 0, timestamp = 1): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: tokens,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: tokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

/** Hooks that count their calls; `env` stands for what the Prism hooks read besides the component. */
function countingHooks(env: { value: unknown[] | undefined }) {
	const calls = { user: 0, assistant: 0, tool: 0 };
	const hooks: RenderHooks = {
		userMessage: (width, renderDefault) => {
			calls.user++;
			return renderDefault(width).map((line) => `U ${line}`);
		},
		assistantMessage: (width, blocks) => {
			calls.assistant++;
			const lines: string[] = [];
			const layout = blocks.map(({ component }) => {
				const rendered = component.render(width);
				lines.push(...rendered);
				return { component, height: rendered.length };
			});
			return { lines, layout };
		},
		toolExecution: (view, width) => {
			calls.tool++;
			return [`T ${view.toolName} ${view.isPartial ? "running" : "done"}`, ...view.renderText(width)];
		},
	};
	if (env.value) hooks.cacheKey = () => env.value!;
	return { hooks, calls };
}

describe("fork: hooked transcript renders are cached", () => {
	beforeAll(() => initTheme("dark"));
	afterEach(() => setRenderHooks({}));

	const ui = { requestRender: () => {} } as unknown as TUI;

	it("decorates a user message once, again after a width, invalidate or cache key change", () => {
		const env = { value: ["dark", "simple"] as unknown[] | undefined };
		const { hooks, calls } = countingHooks(env);
		setRenderHooks(hooks);
		const message = new UserMessageComponent("hello");
		const first = message.render(40);
		expect(message.render(40)).toEqual(first);
		expect(calls.user).toBe(1);
		message.render(30);
		expect(calls.user).toBe(2);
		message.invalidate();
		message.render(30);
		expect(calls.user).toBe(3);
		env.value = ["dark", "advanced"];
		message.render(30);
		expect(calls.user).toBe(4);
		// New hooks (a reload) never reuse a render cached under the old ones.
		setRenderHooks({ ...hooks });
		message.render(30);
		expect(calls.user).toBe(5);
	});

	it("caches nothing when the hooks give no cache key", () => {
		const { hooks, calls } = countingHooks({ value: undefined });
		setRenderHooks(hooks);
		const message = new UserMessageComponent("hello");
		message.render(40);
		message.render(40);
		expect(calls.user).toBe(2);
	});

	it("decorates a streaming assistant message on every frame, a finished one once", () => {
		const { hooks, calls } = countingHooks({ value: ["k"] });
		setRenderHooks(hooks);
		const message = new AssistantMessageComponent();
		message.updateContent(assistant("partial"), true);
		message.render(40);
		message.render(40);
		expect(calls.assistant).toBe(2);
		message.updateContent(assistant("partial, then done"), false);
		const done = message.render(40);
		// render() adds the OSC 133 marks to its copy, never to the cached lines. it returns that same
		// marked array while nothing changes, so the screen skips it by reference.
		expect(message.render(40)).toBe(done);
		expect(message.render(40)).toBe(done);
		expect(done[0]!.split("\x1b]133;A").length).toBe(2);
		expect(calls.assistant).toBe(3);
		expect(done.join("\n")).toContain("partial, then done");
		message.setHideThinkingBlock(true);
		message.render(40);
		expect(calls.assistant).toBe(4);
	});

	it("decorates a running tool on every frame, a finished one once until it changes", () => {
		const { hooks, calls } = countingHooks({ value: ["k"] });
		setRenderHooks(hooks);
		const tool = new ToolExecutionComponent("probe", "call-1", {}, {}, undefined, ui, process.cwd());
		tool.render(40);
		tool.render(40);
		expect(calls.tool).toBe(2);
		tool.updateResult({ content: [{ type: "text", text: "output" }], isError: false }, false);
		const done = tool.render(40);
		expect(tool.render(40)).toBe(done);
		expect(calls.tool).toBe(3);
		expect(done[0]).toBe("T probe done");
		tool.setExpanded(true);
		tool.render(40);
		expect(calls.tool).toBe(4);
		tool.invalidate();
		tool.render(40);
		expect(calls.tool).toBe(5);
	});
});

describe("fork: context usage is computed once per session leaf", () => {
	async function createSession() {
		const sessionManager = SessionManager.inMemory();
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				streamFn: streamSimple,
				initialState: { model, systemPrompt: "You are a helpful assistant.", tools: [], thinkingLevel: "high" },
			}),
			sessionManager,
			settingsManager: SettingsManager.inMemory(),
			cwd: process.cwd(),
			modelRuntime: getModelRuntime(await createInMemoryModelRegistry(authStorage)),
			resourceLoader: createTestResourceLoader(),
		});
		return { session, sessionManager };
	}

	it("reuses the answer until an entry is appended or the leaf moves", async () => {
		const { session, sessionManager } = await createSession();
		try {
			const userId = sessionManager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
			sessionManager.appendMessage(assistant("hi", 200, 2));
			let projections = 0;
			const build = sessionManager.buildSessionProjection.bind(sessionManager);
			sessionManager.buildSessionProjection = () => {
				projections++;
				return build();
			};

			expect(session.getContextUsage()?.tokens).toBe(200);
			expect(session.getContextUsage()?.tokens).toBe(200);
			expect(projections).toBe(1);

			sessionManager.appendMessage({ role: "user", content: "more", timestamp: 3 });
			sessionManager.appendMessage(assistant("again", 500, 4));
			expect(session.getContextUsage()?.tokens).toBe(500);
			expect(projections).toBe(2);

			// Back to an earlier point of the tree: the usage of that branch.
			sessionManager.branch(userId);
			expect(session.getContextUsage()?.tokens).not.toBe(500);
			expect(projections).toBe(3);

			// Callers get a copy: changing it does not change the next answer.
			const usage = session.getContextUsage()!;
			usage.tokens = -1;
			expect(session.getContextUsage()?.tokens).not.toBe(-1);
		} finally {
			session.dispose();
		}
	});
});
