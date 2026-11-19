// fork: a screen that opens a session in the middle of a turn (the other screen started it, or
// the PC kept the engine while the phone was away) shows each message once and misses none.
// Run by hand: node --test --experimental-test-module-mocks fork/gui/tests/late-screen.test.mjs
// session.js runs on a minimal document; its other modules are stand-ins, the engine a scripted one.
import assert from "node:assert/strict";
import { mock, test } from "node:test";

class FakeNode {
	constructor(tag) {
		this.tagName = String(tag).toUpperCase();
		this.children = [];
		this.parent = undefined;
		this.className = "";
		this.dataset = {};
		this.attributes = {};
		this.style = { setProperty() {} };
		this.textContent = "";
		this.classList = {
			add: (...names) => {
				for (const name of names) if (!this.#classes().includes(name)) this.className = `${this.className} ${name}`.trim();
			},
			toggle: () => {},
			contains: (name) => this.#classes().includes(name),
		};
	}
	#classes() {
		return this.className.split(/\s+/).filter(Boolean);
	}
	get firstChild() {
		return this.children[0];
	}
	get lastElementChild() {
		return this.children.at(-1);
	}
	get childElementCount() {
		return this.children.length;
	}
	get previousElementSibling() {
		return this.parent?.children[this.parent.children.indexOf(this) - 1];
	}
	append(...nodes) {
		for (const node of nodes.flat()) {
			if (node === undefined || node === null || node === false) continue;
			const child = node instanceof FakeNode ? node : Object.assign(new FakeNode("#text"), { textContent: String(node) });
			child.remove();
			child.parent = this;
			this.children.push(child);
		}
	}
	replaceChildren(...nodes) {
		for (const child of this.children) child.parent = undefined;
		this.children = [];
		this.append(...nodes);
	}
	remove() {
		if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
		this.parent = undefined;
	}
	replaceWith(node) {
		const parent = this.parent;
		if (!parent) return;
		node.remove();
		parent.children[parent.children.indexOf(this)] = node;
		node.parent = parent;
		this.parent = undefined;
	}
	/** Only what session.js asks: classes and an optional tag, alternatives separated by commas. */
	matches(selector) {
		return selector.split(",").some((one) => {
			const tag = /^[a-z]+/.exec(one.trim())?.[0];
			const classes = [...one.matchAll(/\.([\w-]+)/g)].map((match) => match[1]);
			return (!tag || this.tagName === tag.toUpperCase()) && classes.every((name) => this.#classes().includes(name));
		});
	}
	*all() {
		for (const child of this.children) {
			yield child;
			yield* child.all();
		}
	}
	querySelector(selector) {
		return [...this.all()].find((node) => node.matches(selector));
	}
	querySelectorAll(selector) {
		return [...this.all()].filter((node) => node.matches(selector));
	}
	contains(node) {
		return node === this || [...this.all()].includes(node);
	}
	text() {
		return [this.textContent, ...this.children.map((child) => child.text())].filter(Boolean).join(" ");
	}
	addEventListener() {}
	setAttribute(key, value) {
		this.attributes[key] = value;
	}
	getAttribute(key) {
		return this.attributes[key];
	}
	removeAttribute(key) {
		delete this.attributes[key];
	}
	focus() {}
}
globalThis.Node = FakeNode;
globalThis.document = {
	activeElement: undefined,
	createElement: (tag) => new FakeNode(tag),
	createTextNode: (text) => Object.assign(new FakeNode("#text"), { textContent: text }),
};
globalThis.requestAnimationFrame = (callback) => callback();

/** The engine as the view sees it: its requests wait for the test's answers, its events are the test's. */
class FakeEngine {
	constructor(onEvent) {
		this.onEvent = onEvent;
		this.alive = true;
		this.requests = [];
		this.answers = [];
	}
	async start() {
		this.id = 1;
	}
	request(command) {
		return new Promise((resolve) => this.requests.push({ command, resolve }));
	}
	answer(dialog, response) {
		this.answers.push({ dialog, response });
		return Promise.resolve();
	}
	async replay() {}
	/** Answers the oldest request of this type still waiting. */
	respond(type, data) {
		const index = this.requests.findIndex((request) => request.command.type === type);
		assert.notEqual(index, -1, `no ${type} request is waiting`);
		this.requests.splice(index, 1)[0].resolve(data);
	}
}
const stub = (names) => ({ namedExports: Object.fromEntries(names.map((name) => [name, () => {}])) });
const module = (name) => new URL(`../ui/js/${name}`, import.meta.url).href;
mock.module(module("attachments.js"), {
	namedExports: { promptWith() {}, sentChips: () => [], splitFiles: (text) => ({ text, files: [] }) },
});
mock.module(module("builtins.js"), stub(["builtin", "screen"]));
mock.module(module("components.js"), { namedExports: { ListBox: class {}, Panel: class {} } });
mock.module(module("custom-message.js"), stub(["agentStepCount", "agentStepLines", "customText"]));
mock.module(module("engine.js"), { namedExports: { Engine: FakeEngine } });
mock.module(module("generated-ui.js"), stub(["renderDocument", "setAnswerable"]));
mock.module(module("i18n.js"), { namedExports: { t: (key) => key } });
mock.module(module("markdown.js"), { namedExports: { renderMarkdown: (text) => document.createTextNode(text) } });
mock.module(module("view.js"), { namedExports: { TerminalView: class {} } });

const { SessionView } = await import("../ui/js/session.js");

const tick = () => new Promise((resolve) => setImmediate(resolve));
const app = {
	sessions: [],
	active: undefined,
	markdownOptions: {},
	sessionChanged() {},
	refreshHistory() {},
	render() {},
	toast() {},
	engineLanguage: async () => "en",
	languageShown() {},
	configureViews: async () => {},
	reportFocus() {},
	followTranscript() {},
	isTyping: () => true,
	focusAfterInteraction() {},
};

const user = (text, timestamp) => ({ role: "user", content: text, timestamp });
const reply = (text, timestamp, extra = {}) => ({ role: "assistant", content: [{ type: "text", text }], timestamp, stopReason: "stop", ...extra });
const calling = (id, timestamp) => ({
	role: "assistant",
	content: [{ type: "toolCall", id, name: "bash", arguments: { command: "ls" } }],
	timestamp,
	stopReason: "toolUse",
});
const result = (id, text, timestamp) => ({ role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text }], timestamp });
// The engine's updates carry a fragment, not the message (packages/coding-agent/src/modes/json-event.ts).
const update = (_message, delta) => ({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } });

/** What the transcript shows, one line per element: messages with their text, tool cards with their state. */
function shown(view) {
	return view.el.children.map((el) => {
		if (el.matches(".msg.user")) return `user: ${el.text()}`;
		if (el.matches(".msg.assistant")) {
			const parts = el.children.map((block) => (block.matches(".tool") ? `[${block.dataset.status}]` : block.text()));
			return `assistant: ${parts.join(" ")}`;
		}
		if (el.matches(".tool")) return `tool [${el.dataset.status}]`;
		return el.className;
	});
}

/**
 * Opens a session whose engine is in a turn: `attached` are the events written before the engine read its messages
 * for this screen, `messages` that reading, `after` the events written after it and before the screen showed it.
 */
async function open({ attached = [], messages, turns = [], after = [] }) {
	const view = new SessionView(app, "/tmp/session.jsonl", "A", "/tmp");
	const opened = view.open();
	const engine = view.engine;
	await tick();
	for (const event of attached) engine.onEvent(event);
	engine.respond("get_state", { isStreaming: true, sessionFile: "/tmp/session.jsonl" });
	await tick();
	engine.respond("get_messages", { messages });
	engine.respond("get_turns", { turns, last: turns.length ? "entry" : undefined });
	for (const event of after) engine.onEvent(event);
	for (const type of ["get_available_models", "get_available_thinking_levels", "get_commands", "get_keys", "get_display", "get_footer"])
		engine.respond(type, {});
	await opened;
	return { view, engine };
}

test("a message that ends while the screen reads the session shows once", async () => {
	const first = reply("first answer", 20);
	const second = reply("second answer", 30);
	const { view } = await open({
		// The first reply ended before the reading: the reading holds it, and its events were kept.
		attached: [
			{ type: "message_start", message: { ...first, content: [] } },
			update(first, "first answer"),
			{ type: "message_end", message: first },
		],
		messages: [user("go", 10), first, second],
		// The engine held the second reply before it wrote its end: the end arrives after the reading.
		after: [{ type: "message_end", message: second }],
	});
	assert.deepEqual(shown(view), ["user: go", "assistant: first answer", "assistant: second answer"]);
	// The same late end, when the screen is already open.
	view.engine.onEvent({ type: "message_end", message: second });
	assert.equal(shown(view).length, 3);
});

test("what happens between the reading and its display is not lost", async () => {
	const call = calling("t1", 20);
	const done = result("t1", "a.txt", 21);
	const answer = reply("one file", 30);
	const { view } = await open({
		messages: [user("go", 10)],
		after: [
			{ type: "message_start", message: { ...call, content: [] } },
			{ type: "message_end", message: call },
			{ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } },
			{ type: "tool_execution_end", toolCallId: "t1", result: done, isError: false },
			{ type: "message_end", message: done },
			{ type: "message_start", message: user("and then?", 25) },
			{ type: "message_start", message: { ...answer, content: [] } },
			update(answer, "one "),
			update(answer, "file"),
			{ type: "message_end", message: answer },
			{ type: "agent_end" },
		],
	});
	assert.deepEqual(shown(view), ["user: go", "assistant: [done]", "user: and then?", "assistant: one file", "turn-slot"]);
	assert.equal(view.tools.get("t1").startedAt, undefined, "no duration for a call whose start this screen did not time");
});

test("a reply in progress is followed from the start the host gives, every fragment once", async () => {
	const partial = { role: "assistant", content: [], timestamp: 20 };
	const { view } = await open({
		// The host gives a screen that attaches the reply's start and its fragments so far, then the stream goes on;
		// the start's message may already hold the first fragment, which must not show twice.
		attached: [{ type: "message_start", message: { ...partial, content: [{ type: "text", text: "a" }] } }, update(partial, "a"), update(partial, "b")],
		messages: [user("go", 10)],
		after: [update(partial, "c")],
	});
	assert.deepEqual(shown(view), ["user: go", "assistant: abc"]);
	view.engine.onEvent(update(partial, "d"));
	assert.deepEqual(shown(view), ["user: go", "assistant: abcd"]);
	view.engine.onEvent({ type: "message_end", message: reply("abcd.", 20) });
	assert.deepEqual(shown(view), ["user: go", "assistant: abcd."]);
});

test("a reply that ended while the session opened is not drawn again from its kept fragments", async () => {
	const answer = reply("abc", 20);
	const { view } = await open({
		attached: [{ type: "message_start", message: { ...answer, content: [] } }, update(answer, "a"), update(answer, "bc"), { type: "message_end", message: answer }],
		messages: [user("go", 10), answer],
	});
	assert.deepEqual(shown(view), ["user: go", "assistant: abc"]);
});

test("a user message started before the reading and ended after it shows once", async () => {
	const steer = user("stop there", 25);
	// Started while this screen was attached: its start is kept, the reading does not hold it yet.
	const kept = await open({ attached: [{ type: "message_start", message: steer }], messages: [user("go", 10)], after: [{ type: "message_end", message: steer }] });
	assert.deepEqual(shown(kept.view), ["user: go", "user: stop there"]);
	// Started before this screen attached: only its end is seen.
	const ended = await open({ messages: [user("go", 10)], after: [{ type: "message_end", message: steer }] });
	assert.deepEqual(shown(ended.view), ["user: go", "user: stop there"]);
	// Held by the reading: neither its start nor its end adds it.
	const read = await open({ attached: [{ type: "message_start", message: steer }], messages: [user("go", 10), steer], after: [{ type: "message_end", message: steer }] });
	assert.deepEqual(shown(read.view), ["user: go", "user: stop there"]);
});

test("a question about a tool call asked while the session opens is in that call's card", async () => {
	const call = calling("t1", 20);
	const { view, engine } = await open({
		attached: [{ type: "extension_ui_request", id: "q1", method: "confirm", title: "Run ls?", toolCallId: "t1" }],
		messages: [user("go", 10), call],
	});
	assert.deepEqual(shown(view), ["user: go", "assistant: [awaiting]"]);
	const dialog = view.dialogs.get("q1");
	assert.ok(view.tools.get("t1").el.contains(dialog.el), "the question is in the card on screen");
	view.answer(dialog, { confirmed: true }, "yes", { force: true });
	assert.deepEqual(engine.answers, [{ dialog: "q1", response: { confirmed: true } }]);
	// One answered on the other screen before this one showed it never shows.
	const gone = await open({
		attached: [
			{ type: "extension_ui_request", id: "q2", method: "confirm", title: "Run ls?", toolCallId: "t1" },
			{ type: "extension_ui_dismissed", id: "q2", reason: "answered" },
		],
		messages: [user("go", 10), call],
	});
	assert.equal(gone.view.dialogs.size, 0);
	assert.deepEqual(shown(gone.view), ["user: go", "assistant: [running]"]);
});

test("a tool running when the screen arrives is shown running, and one the reading holds as done stays done", async () => {
	const call = calling("t1", 20);
	const running = await open({
		attached: [{ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } }],
		messages: [user("go", 10), call],
	});
	assert.deepEqual(shown(running.view), ["user: go", "assistant: [running]"]);
	const done = result("t1", "a.txt", 21);
	const ended = await open({
		attached: [
			{ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } },
			{ type: "tool_execution_end", toolCallId: "t1", result: done, isError: false },
			{ type: "message_end", message: done },
		],
		messages: [user("go", 10), call, done],
	});
	assert.deepEqual(shown(ended.view), ["user: go", "assistant: [done]"]);
});

test("a turn that ends while the session opens gets its closing line, once", async () => {
	const answer = reply("done", 20);
	const { view, engine } = await open({
		attached: [{ type: "agent_end" }, { type: "agent_settled" }],
		messages: [user("go", 10), answer],
	});
	// The line is asked for after the reading: the engine has one more turn than the reading held.
	engine.respond("get_turns", { turns: [{ text: "1 turn" }], last: "entry-2" });
	await tick();
	assert.deepEqual(shown(view), ["user: go", "assistant: done", "turn-summary enter"]);
	assert.equal(view.streaming, false);
});

const bashMessage = (command, output, timestamp) => ({ role: "bashExecution", command, output, exitCode: 0, cancelled: false, truncated: false, timestamp });

test("a ! command another screen runs shows here as it runs and when it ends, once", async () => {
	const { view } = await open({ messages: [user("go", 10)] });
	view.streaming = false;
	view.engine.onEvent({ type: "bash_execution_start", command: "make", excludeFromContext: false });
	assert.deepEqual(shown(view), ["user: go", "tool [running]"]);
	assert.ok(view.bash, "a command runs: this screen cannot start another and can stop this one");
	view.engine.onEvent({ type: "bash_execution_update", delta: "built\n" });
	view.engine.onEvent({ type: "bash_execution_end", message: bashMessage("make", "built", 30) });
	assert.deepEqual(shown(view), ["user: go", "tool [done]"]);
	assert.equal(view.bash, undefined);
	assert.equal(view.tools.get("bash-1").output, "built");
	// A command an extension ran itself has no start: its end shows it.
	view.engine.onEvent({ type: "bash_execution_end", message: bashMessage("ls", "a.txt", 40) });
	assert.deepEqual(shown(view), ["user: go", "tool [done]", "tool [done]"]);
	// One that could not run ends without a message.
	view.engine.onEvent({ type: "bash_execution_start", command: "nope", excludeFromContext: false });
	view.engine.onEvent({ type: "bash_execution_end" });
	assert.deepEqual(shown(view), ["user: go", "tool [done]", "tool [done]", "tool [error]"]);
	assert.equal(view.bash, undefined);
});

test("this screen's own ! command is not shown a second time by the engine's events", async () => {
	const { view, engine } = await open({ messages: [user("go", 10)] });
	view.streaming = false;
	view.commands = [];
	const running = view.prompt("!make");
	await tick();
	assert.deepEqual(shown(view), ["user: go", "tool [running]"]);
	engine.onEvent({ type: "bash_execution_start", command: "make", excludeFromContext: false });
	engine.onEvent({ type: "bash_execution_end", message: bashMessage("make", "built", 30) });
	assert.deepEqual(shown(view), ["user: go", "tool [running]"], "its own request's answer ends it");
	engine.respond("bash", { output: "built", exitCode: 0 });
	await running;
	assert.deepEqual(shown(view), ["user: go", "tool [done]"]);
});

test("a ! command that ends while the session opens shows once, whether the reading holds it or not", async () => {
	const done = bashMessage("make", "built", 30);
	const events = [
		{ type: "bash_execution_start", command: "make", excludeFromContext: false },
		{ type: "bash_execution_end", message: done },
	];
	const read = await open({ attached: events, messages: [user("go", 10), done] });
	assert.deepEqual(shown(read.view), ["user: go", "tool [done]"]);
	assert.equal(read.view.bash, undefined);
	// Ended during a turn: the session does not hold it yet, the host gives its end to a screen that attaches.
	const pending = await open({ attached: [{ type: "bash_execution_end", message: done, pending: true }], messages: [user("go", 10)] });
	assert.deepEqual(shown(pending.view), ["user: go", "tool [done]"]);
	// Still running when the screen arrives: the host gives its start and its output so far.
	const running = await open({
		attached: [events[0], { type: "bash_execution_update", delta: "half" }],
		messages: [user("go", 10)],
	});
	assert.deepEqual(shown(running.view), ["user: go", "tool [running]"]);
	assert.equal(running.view.bash.output, "half");
});

test("what the extensions show and the queue are what the engine says now, not what the view kept", async () => {
	const view = new SessionView(app, "/tmp/session.jsonl", "A", "/tmp");
	view.statuses.set("plan", "Plan mode");
	view.widgets.set("goal", ["old"]);
	view.queue = ["old"];
	const opened = view.open();
	const engine = view.engine;
	await tick();
	// The host gives a screen that attaches the statuses, widgets and queue that hold: handled as they come.
	engine.onEvent({ type: "extension_ui_request", id: "s", method: "setStatus", statusKey: "goal", statusText: "1 of 3" });
	engine.onEvent({ type: "queue_update", steering: ["and then"], followUp: [] });
	assert.deepEqual([...view.statuses], [["goal", "1 of 3"]]);
	assert.equal(view.widgets.size, 0);
	assert.deepEqual(view.queue, ["and then"]);
	engine.respond("get_state", { isStreaming: false });
	await tick();
	engine.respond("get_messages", { messages: [] });
	for (const type of ["get_turns", "get_available_models", "get_available_thinking_levels", "get_commands", "get_keys", "get_display", "get_footer"])
		engine.respond(type, type === "get_turns" ? { turns: [] } : {});
	await opened;
	assert.deepEqual([...view.statuses], [["goal", "1 of 3"]]);
});

test("an opening that fails keeps no event", async () => {
	const view = new SessionView(app, undefined, "A", "/tmp");
	view.engine.start = async () => {
		throw new Error("no engine");
	};
	await assert.rejects(view.open(), /no engine/);
	assert.equal(view.held, undefined);
});
