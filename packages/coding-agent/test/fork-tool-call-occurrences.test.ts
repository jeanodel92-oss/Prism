/**
 * fork: turns and branches may reuse a tool call id. The HTML export,
 * /state and the RPC session tree pair each result with its own call, not with the first or last call of that id.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportSessionToHtml } from "../src/core/export-html/index.ts";
import type { ToolHtmlRenderer } from "../src/core/export-html/tool-renderer.ts";
import { type SessionEntry, SessionManager } from "../src/core/session-manager.ts";
import { handleInspectCommand } from "../src/fork/rpc-inspect.ts";
import { sessionStateData } from "../src/fork/session-state.ts";
import { type pairToolCalls as PairToolCalls, pairToolCalls } from "../src/fork/tool-call-occurrences.ts";
import { createHarness } from "./suite/harness.ts";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function call(name: string, path: string, id = "c"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: { path } }],
		api: "faux",
		provider: "faux",
		model: "faux",
		usage,
		stopReason: "toolUse",
		timestamp: 1,
	};
}

function result(name: string, text: string, id = "c"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1,
	};
}

/** Two turns call `name` with the same id on A then on B; a second branch from the first user message reads C. */
function sessionWithReusedIds(manager: SessionManager, name: string) {
	const user = manager.appendMessage({ role: "user", content: "go", timestamp: 1 });
	const callA = manager.appendMessage(call(name, "A"));
	const resultA = manager.appendMessage(result(name, "content of A"));
	const callB = manager.appendMessage(call(name, "B"));
	const resultB = manager.appendMessage(result(name, "content of B"));
	manager.branch(user);
	const callC = manager.appendMessage(call(name, "C"));
	const resultC = manager.appendMessage(result(name, "content of C"));
	return { callA, resultA, callB, resultB, callC, resultC };
}

/** The browser copy of the pairing in the export template. */
function templatePairing(): typeof PairToolCalls {
	const template = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf-8");
	const source = /\/\/ BEGIN pairToolCalls\n([\s\S]*?)\/\/ END pairToolCalls/.exec(template)?.[1];
	if (!source) throw new Error("pairToolCalls not found in template.js");
	return new Function(`${source}\nreturn pairToolCalls;`)() as typeof PairToolCalls;
}

describe("tool call ids reused across turns and branches", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fork-tool-call-ids-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it.each([
		["the engine", pairToolCalls],
		["the export template", templatePairing()],
	])("pairs each result with its own call in %s", (_label, pair) => {
		const manager = SessionManager.inMemory(dir);
		const ids = sessionWithReusedIds(manager, "read");
		const { ownerOfResult, resultOfCall } = pair(manager.getEntries());
		expect(Object.fromEntries(ownerOfResult)).toEqual({
			[ids.resultA]: ids.callA,
			[ids.resultB]: ids.callB,
			[ids.resultC]: ids.callC,
		});
		expect(Object.fromEntries(resultOfCall)).toEqual({
			[`${ids.callA}:c`]: ids.resultA,
			[`${ids.callB}:c`]: ids.resultB,
			[`${ids.callC}:c`]: ids.resultC,
		});
	});

	it("renders each occurrence of a custom tool with its own arguments and result", async () => {
		const manager = SessionManager.create(dir, join(dir, "sessions"));
		const ids = sessionWithReusedIds(manager, "custom_read");
		const renderer: ToolHtmlRenderer = {
			renderCall: (_id, _name, args) => `call ${(args as { path: string }).path}`,
			renderResult: (_id, _name, content) => ({ collapsed: content[0]?.text, expanded: content[0]?.text }),
		};
		const html = readFileSync(
			await exportSessionToHtml(manager, undefined, { outputPath: join(dir, "out.html"), toolRenderer: renderer }),
			"utf-8",
		);
		const encoded = /<script[^>]*id="session-data"[^>]*>([^<]+)<\/script>/.exec(html)?.[1];
		const data = JSON.parse(Buffer.from(encoded ?? "", "base64").toString("utf-8")) as {
			renderedTools: Record<string, { callHtml?: string; resultHtmlCollapsed?: string }>;
		};
		expect(data.renderedTools).toEqual({
			[`${ids.callA}:c`]: {
				callHtml: "call A",
				resultHtmlCollapsed: "content of A",
				resultHtmlExpanded: "content of A",
			},
			[`${ids.callB}:c`]: {
				callHtml: "call B",
				resultHtmlCollapsed: "content of B",
				resultHtmlExpanded: "content of B",
			},
			[`${ids.callC}:c`]: {
				callHtml: "call C",
				resultHtmlCollapsed: "content of C",
				resultHtmlExpanded: "content of C",
			},
		});
	});

	it("looks results, renders and anchors up by occurrence in the template", () => {
		const template = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf-8");
		expect(template).toContain("renderToolCall(block, entry.id)");
		expect(template).toContain("renderedTools?.[toolCallKey(ownerEntryId, call.id)]");
		expect(template).toContain(["tool-call-$", "{escapeHtml(ownerEntryId)}-$", "{escapeHtml(call.id)}"].join(""));
		expect(template).not.toContain("toolCallMap");
	});

	it("keeps an interrupted call in /state when a later turn reuses its id", () => {
		const manager = SessionManager.inMemory(dir);
		manager.appendMessage({ role: "user", content: "go", timestamp: 1 });
		manager.appendMessage(call("read", "A"));
		manager.appendMessage({ role: "user", content: "again", timestamp: 1 });
		manager.appendMessage(call("read", "B"));
		manager.appendMessage(result("read", "content of B"));
		const branch: SessionEntry[] = manager.getBranch();
		expect(sessionStateData(branch, []).calls).toEqual([{ name: "read", args: '{"path":"A"}', entryIndex: 1 }]);
	});
});

describe("fork: the RPC session tree labels each result with its own call", () => {
	it("a second result of an earlier call is not labelled with a later call of the same id", async () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "go", timestamp: 1 });
		const callA = manager.appendMessage(call("read", "alpha.txt"));
		manager.appendMessage(result("read", "content of alpha"));
		manager.appendMessage(call("read", "beta.txt"));
		const resultB = manager.appendMessage(result("read", "content of beta"));
		// A second result for the first call, on a side branch listed after the current one.
		manager.branch(callA);
		const retry = manager.appendMessage(result("read", "alpha again"));
		manager.branch(resultB);
		const harness = await createHarness({ sessionManager: manager });
		try {
			const tree = (await handleInspectCommand({ type: "get_tree" }, harness.session)) as {
				nodes: { id: string; text: string }[];
			};
			const label = tree.nodes.find((node) => node.id === retry)?.text;
			expect(label).toContain("alpha.txt");
			expect(label).not.toContain("beta.txt");
		} finally {
			harness.cleanup();
		}
	});
});
