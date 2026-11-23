import { fauxAssistantMessage, fauxToolCall, type Tool, validateToolArguments } from "@earendil-works/pi-ai";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import generatedUi, {
	answerable,
	answerMessage,
	createUiPreviews,
	documentLines,
	submitAnswer,
	type UiDocument,
	validateDocument,
} from "../src/fork/generated-ui.ts";
import permissionsExtension from "../src/fork/permissions.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

function valid(raw: unknown): UiDocument {
	const checked = validateDocument(raw);
	if ("error" in checked) throw new Error(checked.error);
	return checked.document;
}

function invalid(raw: unknown): string {
	const checked = validateDocument(raw);
	if ("document" in checked) throw new Error("accepted");
	return checked.error;
}

describe("fork: generated UI documents", () => {
	test("a document is normalised: plain one-line text, padded rows, default labels", () => {
		const document = valid({
			title: "  Plans\ncompared ",
			blocks: [
				{ type: "table", columns: ["Plan", "Price"], rows: [["Free"], ["Pro", 12.5]] },
				{ type: "choices", options: ["Free", { label: "Pro", reply: "I take Pro" }] },
				// Fields outside the block's type are dropped; control characters become spaces.
				{ type: "list", ignored: true, items: ["a\u0007b"] },
			],
		});
		expect(document).toEqual({
			version: 1,
			title: "Plans compared",
			blocks: [
				{
					type: "table",
					columns: ["Plan", "Price"],
					rows: [
						["Free", ""],
						["Pro", 12.5],
					],
				},
				{
					type: "choices",
					options: [
						{ label: "Free", reply: "Free" },
						{ label: "Pro", reply: "I take Pro" },
					],
				},
				{ type: "list", ordered: false, items: ["a b"] },
			],
		});
	});

	test("what is outside the catalogue or its limits is refused with the reason", () => {
		expect(invalid({ blocks: [] })).toContain("at least 1");
		expect(invalid({ blocks: [{ type: "html", html: "<b>x</b>" }] })).toContain("must be one of");
		expect(invalid({ blocks: [{ type: "table", columns: ["a"], rows: [["1", "2"]] }] })).toContain("at most 1");
		expect(
			invalid({ blocks: [{ type: "chart", labels: ["a", "b"], series: [{ name: "s", values: [1] }] }] }),
		).toContain("at least 2");
		expect(
			invalid({ blocks: [{ type: "chart", labels: ["a"], series: [{ name: "s", values: [Number.NaN] }] }] }),
		).toContain("must be a number");
		expect(invalid({ blocks: [{ type: "list", items: Array(101).fill("x") }] })).toContain("at most 100");
		expect(
			invalid({
				blocks: [
					{ type: "choices", options: ["a"] },
					{ type: "form", fields: [{ label: "b" }] },
				],
			}),
		).toContain("at most one choices or form");
		expect(invalid({ blocks: [{ type: "form", fields: [{ label: "a" }, { label: "a" }] }] })).toContain("twice");
	});

	test("the terminal shows every string as written, within its width", () => {
		const style = { bold: (text: string) => text, muted: (text: string) => text };
		const document = valid({
			blocks: [
				{
					type: "table",
					columns: ["a|b", "Note"],
					rows: [["<script>alert(1)</script>", "[x](http://e.test) **bold** and a long tail of words"]],
				},
				{ type: "chart", labels: ["Mon"], series: [{ name: "Load", values: [0.123456789] }], unit: "%" },
				{ type: "choices", options: ["**bold**"] },
			],
		});
		const wide = documentLines(document, 200, style).join("\n");
		// Nothing is parsed or escaped: what the model wrote is what the user reads.
		expect(wide).toContain("<script>alert(1)</script>  [x](http://e.test) **bold** and a long tail of words");
		expect(wide).toContain("Mon    0.123457 %");
		expect(wide).toContain("1. **bold**");
		for (const width of [24, 40, 60]) {
			for (const line of documentLines(document, width, style))
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		// Too narrow for the columns: one record per row, every word still there.
		const narrow = documentLines(document, 24, style).join(" ");
		expect(narrow).toContain("Note: [x](http://e.test)");
		expect(narrow.replace(/\s+/g, " ")).toContain("long tail of words");
	});

	test("an answer is built from the document: a choice's reply, a form's checked values", () => {
		const choices = valid({
			blocks: [{ type: "choices", title: "Plan", options: [{ label: "Pro", reply: "/quit" }] }],
		});
		// A reply that looks like a command still opens with the fixed answer text.
		expect(answerMessage(choices, { choice: 0 })).toEqual({ message: "Answer to “Plan”: /quit" });
		expect(answerMessage(choices, { choice: 3 })).toEqual({ error: "Unknown choice" });

		const form = valid({
			blocks: [
				{
					type: "form",
					fields: [
						{ label: "Name", required: true },
						{ label: "Seats", kind: "number" },
						{ label: "Region", kind: "select", options: ["EU", "US"] },
						{ label: "Invoice", kind: "toggle" },
					],
				},
			],
		});
		expect(answerMessage(form, { values: { Name: " Ada ", Seats: "3", Region: "EU", Invoice: true } })).toEqual({
			message: "Answer:\n- Name: Ada\n- Seats: 3\n- Region: EU\n- Invoice: yes",
		});
		expect(answerMessage(form, { values: { Seats: "3" } })).toEqual({ error: "Name is required" });
		expect(answerMessage(form, { values: { Name: "a", Region: "Mars" } })).toEqual({
			error: "Region: not one of the options",
		});
		expect(answerMessage(form, { values: { Name: "a", Seats: "many" } })).toEqual({ error: "Seats: not a number" });
		// a precise number reaches the model as the user gave it.
		expect(answerMessage(form, { values: { Name: "a", Seats: " 0.123456789 " } })).toEqual({
			message: "Answer:\n- Name: a\n- Seats: 0.123456789\n- Region: —\n- Invoice: no",
		});
		expect(answerMessage(form, { values: { Name: "a", Seats: 1234.56789 } })).toEqual({
			message: "Answer:\n- Name: a\n- Seats: 1234.56789\n- Region: —\n- Invoice: no",
		});
		expect(answerMessage(form, { choice: 0 })).toEqual({ error: "No values" });
	});

	test("only the latest document, with no user message after it, can be answered", () => {
		const document = valid({ blocks: [{ type: "choices", options: ["a"] }] });
		const result = (id: string) => ({
			type: "message",
			message: { role: "toolResult", toolName: "show_ui", toolCallId: id, details: { document } },
		});
		const user = { type: "message", message: { role: "user" } };
		expect(answerable([result("old"), result("new")], "new")).toEqual(document);
		expect(answerable([result("old"), result("new")], "old")).toBeUndefined();
		expect(answerable([result("new"), user], "new")).toBeUndefined();
		// A document edited in the session file is validated again.
		const edited = { type: "message", message: { ...result("x").message, details: { document: { blocks: [] } } } };
		expect(answerable([edited], "x")).toBeUndefined();
	});
});

test("previews: one per completed block, validated, only for show_ui", () => {
	const preview = createUiPreviews();
	const delta = (name: string, args: Record<string, unknown>) =>
		preview({
			type: "message_update",
			message: { role: "assistant", content: [{ type: "toolCall", id: "c", name, arguments: args }] },
			assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "", partial: {} },
		} as never);
	const list = (item: string) => ({ type: "list", items: [item] });
	// The block being written is not shown: it may be incomplete.
	expect(delta("show_ui", { blocks: [list("a")] })).toBeUndefined();
	expect(delta("show_ui", { title: "T", blocks: [list("a"), list("b")] })).toEqual({
		type: "ui_preview",
		toolCallId: "c",
		document: { version: 1, title: "T", blocks: [{ type: "list", ordered: false, items: ["a"] }] },
	});
	expect(delta("show_ui", { blocks: [list("a"), list("bc")] })).toBeUndefined();
	// Complete blocks that do not validate are not previewed.
	expect(delta("show_ui", { blocks: [list("a"), { type: "html" }, list("c")] })).toBeUndefined();
	expect(delta("read", { blocks: [list("a"), list("b"), list("c"), list("d")] })).toBeUndefined();
});

describe("fork: generated UI in a session", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function sessionWithUi() {
		const boom = vi.fn();
		const harness = await createHarness({
			extensionFactories: [
				{ name: "permissions", factory: permissionsExtension },
				{ name: "generated-ui", factory: generatedUi },
				{
					name: "boom",
					factory: (pi: ExtensionAPI) =>
						pi.registerCommand("boom", { description: "test", handler: async () => boom() }),
				},
			],
		});
		harnesses.push(harness);
		return { harness, boom };
	}

	test("show_ui shows the validated document, refuses an invalid one, and needs no permission", async () => {
		const { harness } = await sessionWithUi();
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("show_ui", { blocks: [{ type: "list", items: ["one"] }] }, { id: "ok" }),
					// Within the tool's schema, outside the catalogue's rules: one value for two labels.
					fauxToolCall(
						"show_ui",
						{ blocks: [{ type: "chart", labels: ["a", "b"], series: [{ name: "s", values: [1] }] }] },
						{ id: "bad" },
					),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("show");
		const ends = harness.eventsOfType("tool_execution_end");
		const ok = ends.find((e) => e.toolCallId === "ok");
		const bad = ends.find((e) => e.toolCallId === "bad");
		expect(ok?.isError).toBe(false);
		expect(ok?.result.details).toEqual({
			document: { version: 1, blocks: [{ type: "list", ordered: false, items: ["one"] }] },
		});
		expect(bad?.isError).toBe(true);
		expect(JSON.stringify(bad?.result.content)).toContain("Invalid UI document");
		// the refusal shows the model one example of each block.
		expect(JSON.stringify(bad?.result.content)).toContain("Each block, by type");
	});

	// the description gives one example of each block, and each is a valid block.
	test("the description shows a valid example of each block type", () => {
		let tool: Tool | undefined;
		generatedUi({
			registerTool: (registered: Tool) => {
				tool = registered;
			},
		} as unknown as ExtensionAPI);
		const examples = tool!.description
			.split("\n")
			.filter((line) => line.startsWith("- "))
			.map((line) => JSON.parse(line.slice(line.indexOf("{"))));
		expect(examples.map((block) => block.type)).toEqual(["table", "list", "facts", "chart", "choices", "form"]);
		for (const block of examples) expect(validateDocument({ blocks: [block] })).toHaveProperty("document");
	});

	// maintainer's QA, 2026-11-05: Qwen on llama.cpp sent charts with a unit but no labels or series, seven times in a row.
	// The server's grammar keeps the schema's property order: once `unit` was written, `labels` could not follow.
	test("a chart's unit comes before its labels and series in the schema, the order models write them", () => {
		let tool: Tool | undefined;
		generatedUi({
			registerTool: (registered: Tool) => {
				tool = registered;
			},
		} as unknown as ExtensionAPI);
		const block = (tool!.parameters as { properties: { blocks: { items: { properties: object } } } }).properties
			.blocks.items;
		const order = Object.keys(block.properties);
		expect(order.indexOf("kind")).toBeLessThan(order.indexOf("unit"));
		expect(order.indexOf("unit")).toBeLessThan(order.indexOf("labels"));
		expect(order.indexOf("labels")).toBeLessThan(order.indexOf("series"));
		// The document Qwen meant, in that order, is shown.
		const args = validateToolArguments(tool!, {
			type: "toolCall",
			id: "1",
			name: "show_ui",
			arguments: {
				blocks: [
					{
						type: "chart",
						kind: "line",
						unit: "k€",
						labels: ["Jan", "Fév"],
						series: [
							{ name: "2024", values: [30, 34] },
							{ name: "2025", values: [42, 48] },
						],
					},
				],
			},
		});
		expect("document" in validateDocument(args)).toBe(true);
	});

	test("ui_submit sends the answer as a plain message, once, never as a command", async () => {
		const { harness, boom } = await sessionWithUi();
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall(
						"show_ui",
						{ blocks: [{ type: "choices", options: [{ label: "Go", reply: "/boom" }] }] },
						{ id: "q" },
					),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("asked"),
			fauxAssistantMessage("thanks"),
		]);
		await harness.session.prompt("ask me");
		const first = submitAnswer(harness.session, "q", { choice: 0 });
		// A second click before the answer has started is refused, not sent twice.
		await expect(submitAnswer(harness.session, "q", { choice: 0 })).rejects.toThrow("can no longer be answered");
		await expect(first).resolves.toEqual({ disposition: "started" });
		await vi.waitFor(() => expect(harness.getPendingResponseCount()).toBe(0));
		await vi.waitFor(() => expect(harness.session.isStreaming).toBe(false));
		const users = harness.session.messages.filter((m) => m.role === "user");
		expect(JSON.stringify(users.at(-1)?.content)).toContain("Answer: /boom");
		expect(boom).not.toHaveBeenCalled();
		expect(users).toHaveLength(2);
		// Answered: the question is closed.
		await expect(submitAnswer(harness.session, "q", { choice: 0 })).rejects.toThrow("can no longer be answered");
	});

	test("a later question with the same call id (some providers reuse them) can be answered", async () => {
		const { harness } = await sessionWithUi();
		const ask = () => [
			fauxAssistantMessage(
				[fauxToolCall("show_ui", { blocks: [{ type: "choices", options: ["Go"] }] }, { id: "same" })],
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage("asked"),
		];
		harness.setResponses([...ask(), fauxAssistantMessage("thanks"), ...ask(), fauxAssistantMessage("thanks")]);
		await harness.session.prompt("ask me");
		await submitAnswer(harness.session, "same", { choice: 0 });
		await vi.waitFor(() => expect(harness.getPendingResponseCount()).toBe(3));
		await vi.waitFor(() => expect(harness.eventsOfType("agent_settled")).toHaveLength(2));
		await harness.session.prompt("ask again");
		await expect(submitAnswer(harness.session, "same", { choice: 0 })).resolves.toEqual({ disposition: "started" });
		await vi.waitFor(() => expect(harness.getPendingResponseCount()).toBe(0));
	});

	test("no answer while a reply runs", async () => {
		const { harness } = await sessionWithUi();
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("show_ui", { blocks: [{ type: "choices", options: ["Go"] }] }, { id: "q" })],
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage("asked"),
			// The next reply waits until the answer has been tried.
			() => tried.then(() => fauxAssistantMessage("busy")),
		]);
		let release = () => {};
		const tried = new Promise<void>((resolve) => {
			release = resolve;
		});
		await harness.session.prompt("ask me");
		await vi.waitFor(() => expect(harness.eventsOfType("agent_settled")).toHaveLength(1));
		const running = harness.session.prompt("something else");
		await vi.waitFor(() => expect(harness.session.isStreaming).toBe(true));
		await expect(submitAnswer(harness.session, "q", { choice: 0 })).rejects.toThrow("Wait for the current reply");
		release();
		await running;
	});
});
