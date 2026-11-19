// fork: screens of the window that acted on an answer meant
// for an earlier state. Run by hand: node --test --experimental-test-module-mocks fork/gui/tests/stale-answers.test.mjs
// The window's components are replaced by small stand-ins; dom.js runs on a minimal document.
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
		this.checked = false;
		this.disabled = false;
		this.scrollTop = 0;
	}
	get firstChild() {
		return this.children[0];
	}
	addEventListener(type, listener) {
		(this.listeners[type] ??= []).push(listener);
	}
	dispatch(type) {
		for (const listener of this.listeners[type] ?? []) listener({ preventDefault() {}, stopPropagation() {} });
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
		this.parent = undefined;
	}
	setAttribute(key, value) {
		this.attributes[key] = value;
		if (key === "checked" || key === "selected" || key === "disabled" || key === "required") this[key] = true;
		else if (key === "value" || key === "name" || key === "type") this[key] = value;
	}
	*all() {
		for (const child of this.children) {
			yield child;
			yield* child.all();
		}
	}
	text() {
		return [this.textContent, ...this.children.map((child) => child.text())].join(" ");
	}
	querySelector() {
		return undefined;
	}
	querySelectorAll(selector) {
		if (selector === "input[name='tool']:checked")
			return [...this.all()].filter((node) => node.name === "tool" && node.checked);
		return [];
	}
	requestSubmit() {
		this.dispatch("submit");
	}
	focus() {}
}
globalThis.Node = FakeNode;
globalThis.document = {
	documentElement: { lang: "en" },
	createElement: (tag) => new FakeNode(tag),
	createTextNode: (text) => Object.assign(new FakeNode("#text"), { textContent: text }),
};
globalThis.Event = class {
	constructor(type) {
		this.type = type;
	}
};
FakeNode.prototype.dispatchEvent = function (event) {
	this.dispatch(event.type);
};

const panels = [];
const lists = [];
const segments = [];
mock.module(new URL("../ui/js/components.js", import.meta.url).href, {
	namedExports: {
		Panel: class {
			constructor() {
				panels.push(this);
			}
			setTitle(title) {
				this.title = title;
			}
			setBody(...body) {
				this.body = body.flat().filter(Boolean);
			}
			setActions(...actions) {
				this.actions = actions.filter(Boolean);
			}
			focus() {}
			done(value) {
				this.result = value;
			}
		},
		ListBox: class {
			constructor(options) {
				this.options = options;
				this.field = new FakeNode("input");
				this.el = new FakeNode("div");
				lists.push(this);
			}
		},
		Segmented: class {
			constructor(options) {
				this.options = options;
				this.el = new FakeNode("div");
				segments.push(this);
			}
		},
	},
});
mock.module(new URL("../ui/js/i18n.js", import.meta.url).href, {
	namedExports: { t: (key) => key },
});

const { sessionsScreen } = await import("../ui/js/sessions-screen.js");
const { agentsScreen } = await import("../ui/js/agents-screen.js");

/** An engine whose answers the test gives, in the order it chooses. */
function engine() {
	const requests = [];
	return {
		requests,
		request(command) {
			return new Promise((resolve) => requests.push({ command, resolve }));
		},
	};
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("the session list keeps the scope chosen last when an earlier answer arrives after it", async () => {
	const fake = engine();
	const view = {
		engine: fake,
		app: { sessions: [], toast() {}, refreshHistory() {}, openSession() {} },
		showPanel: () => new Promise(() => {}),
	};
	void sessionsScreen(view);
	await settle();
	const session = (name) => ({ path: `/${name}`, name, modified: 0, messageCount: 1, cwd: "/" });
	fake.requests[0].resolve({ sessions: [session("start")], current: null });
	await settle();
	const tabs = segments.at(-1);
	const panel = panels.at(-1);
	const listEl = panel.body.at(-1);
	tabs.options.onChange("all");
	tabs.options.onChange("here");
	await settle();
	const lists = fake.requests.filter((request) => request.command.type === "sessions_list");
	const [toAll, toHere] = lists.slice(-2);
	assert.equal(toAll.command.all, true);
	assert.equal(toHere.command.all, false);
	toHere.resolve({ sessions: [session("here-only")], current: null });
	await settle();
	toAll.resolve({ sessions: [session("from-all")], current: null });
	await settle();
	assert.match(listEl.text(), /here-only/);
	assert.doesNotMatch(listEl.text(), /from-all/);
});

test("cancelling an agent's deletion keeps the agent it edits, under a new name too", async () => {
	const fake = engine();
	const original = { name: "alpha", description: "reads", model: "", instructions: "read", tools: ["read"] };
	const data = {
		agents: [original],
		help: [],
		models: [],
		tools: ["read"],
		defaultTools: ["read"],
		running: [],
		invocation: { autonomous: true, explicitRequest: true, keyword: true, keywordText: "@agent" },
		policyHelp: [],
		offDetail: "",
	};
	const view = {
		engine: fake,
		app: { toast() {} },
		refreshResources: async () => {},
		showPanel: () => new Promise(() => {}),
	};
	void agentsScreen(view);
	await settle();
	fake.requests[0].resolve(data);
	await settle();
	const panel = panels.at(-1);
	lists.at(-1).options.onChoose({ value: original });
	const field = (name) => [...panel.body[0].all()].find((node) => node.name === name);
	const action = (name) => panel.actions.find((button) => button.dataset.action === name);
	field("name").value = "beta";
	action("delete").click();
	action("cancel").click();
	assert.equal(field("name").value, "beta");
	action("save").click();
	await settle();
	const save = fake.requests.find((request) => request.command.type === "agents_save");
	assert.equal(save.command.existingName, "alpha");
	assert.equal(save.command.agent.name, "beta");
});
