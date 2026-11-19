// fork: the Enter that confirms an input method's candidate (Japanese, Chinese)
// answered a text question with an unfinished value; an Escape that cancels a composition cancelled the question.
// Run by hand: node --test --experimental-test-module-mocks fork/gui/tests/ime-question.test.mjs
// session.js's other modules are stand-ins; dom.js and components.js run on a minimal document.
import assert from "node:assert/strict";
import { mock, test } from "node:test";

class FakeNode {
	constructor(tag) {
		this.tagName = String(tag).toUpperCase();
		this.children = [];
		this.parent = undefined;
		this.listeners = {};
		this.dataset = {};
		this.attributes = {};
		this.style = { setProperty() {} };
		this.value = "";
		this.textContent = "";
	}
	get firstChild() {
		return this.children[0];
	}
	addEventListener(type, listener) {
		(this.listeners[type] ??= []).push(listener);
	}
	dispatch(type, init = {}) {
		const event = { type, defaultPrevented: false, preventDefault() {}, stopPropagation() {}, ...init };
		for (const listener of this.listeners[type] ?? []) listener(event);
	}
	click() {
		this.dispatch("click");
	}
	append(...children) {
		for (const child of children) {
			child.parent = this;
			this.children.push(child);
		}
	}
	remove() {
		if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
	}
	setAttribute(key, value) {
		this.attributes[key] = value;
	}
	querySelector() {
		return undefined;
	}
	querySelectorAll() {
		return [];
	}
	focus() {}
}
globalThis.Node = FakeNode;
globalThis.document = {
	documentElement: { lang: "en" },
	activeElement: undefined,
	createElement: (tag) => new FakeNode(tag),
	createTextNode: (text) => Object.assign(new FakeNode("#text"), { textContent: text }),
};

const stub = (names) => ({ namedExports: Object.fromEntries(names.map((name) => [name, () => {}])) });
const module = (name) => new URL(`../ui/js/${name}`, import.meta.url).href;
mock.module(module("attachments.js"), stub(["promptWith", "sentChips", "splitFiles"]));
mock.module(module("builtins.js"), stub(["builtin", "screen"]));
mock.module(module("custom-message.js"), stub(["agentStepCount", "agentStepLines", "customText"]));
mock.module(module("engine.js"), { namedExports: { Engine: class {} } });
mock.module(module("generated-ui.js"), stub(["renderDocument", "setAnswerable"]));
mock.module(module("i18n.js"), { namedExports: { t: (key) => key } });
mock.module(module("markdown.js"), stub(["renderMarkdown"]));
mock.module(module("view.js"), { namedExports: { TerminalView: class {} } });

const { questionControls, ToolQuestion } = await import("../ui/js/session.js");
const { Panel } = await import("../ui/js/components.js");

function session() {
	const answers = [];
	return { answers, answer: (_dialog, response) => answers.push(response), app: { isTyping: () => false } };
}

test("the Enter that ends a composition does not answer a text question; the next one does", () => {
	const fake = session();
	const { body: field } = questionControls(fake, { request: { method: "input", title: "Name?" } });
	field.value = "にほ";
	field.dispatch("keydown", { key: "Enter", isComposing: true });
	assert.deepEqual(fake.answers, []);
	field.value = "日本";
	field.dispatch("keydown", { key: "Enter", isComposing: false });
	assert.deepEqual(fake.answers, [{ value: "日本" }]);
});

test("Ctrl+Enter during a composition does not answer an editor question", () => {
	const fake = session();
	const { body: field } = questionControls(fake, { request: { method: "editor", title: "Text?" } });
	field.dispatch("keydown", { key: "Enter", ctrlKey: true, isComposing: true });
	assert.deepEqual(fake.answers, []);
	field.dispatch("keydown", { key: "Enter", ctrlKey: true, isComposing: false });
	assert.equal(fake.answers.length, 1);
});

test("an Escape that cancels a composition leaves a tool's question and a panel open", () => {
	const fake = session();
	const question = new ToolQuestion(fake, { id: "q", method: "input", title: "Name?" });
	question.el.dispatch("keydown", { key: "Escape", isComposing: true });
	assert.deepEqual(fake.answers, []);
	question.el.dispatch("keydown", { key: "Escape", isComposing: false });
	assert.deepEqual(fake.answers, [{ cancelled: true }]);

	let cancelled = 0;
	const panel = new Panel({ title: "Question", onCancel: () => cancelled++ });
	panel.el.dispatch("keydown", { key: "Escape", isComposing: true });
	assert.equal(cancelled, 0);
	panel.el.dispatch("keydown", { key: "Escape", isComposing: false });
	assert.equal(cancelled, 1);
});

// fork: the risk a question's answer accepts is shown under its title, in its own
// element (red, style.css `.dialog-warning`); a question without one has none.
test("a question's warning is shown under its title", () => {
	const classes = (question) => question.el.children.map((child) => child.attributes.class ?? child.className);
	const warned = new ToolQuestion(session(), {
		id: "w",
		method: "select",
		title: "Let the agent in?\nIt opens the page.",
		options: ["Yes", "No"],
		warning: "It can run commands.",
	});
	const shown = classes(warned);
	assert.equal(shown.indexOf("dialog-warning"), shown.indexOf("dialog-title") + 1);
	assert.equal(warned.el.children[shown.indexOf("dialog-warning")].textContent, "It can run commands.");
	const plain = new ToolQuestion(session(), { id: "p", method: "select", title: "Let the agent in?", options: ["Yes", "No"] });
	assert.equal(classes(plain).includes("dialog-warning"), false);
});
