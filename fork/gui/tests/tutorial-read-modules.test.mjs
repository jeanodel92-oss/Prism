// in the window, a tutorial module without an exercise was never marked done,
// while the terminal marks it done once its last page is shown.
// Run by hand: node --test --experimental-test-module-mocks fork/gui/tests/tutorial-read-modules.test.mjs
import assert from "node:assert/strict";
import { mock, test } from "node:test";

class FakeNode {
	constructor(tag, attrs = {}) {
		this.tagName = String(tag).toUpperCase();
		Object.assign(this, attrs);
		this.dataset = attrs.dataset ?? {};
		this.children = [];
		this.isConnected = false;
	}
	append(...children) {
		this.children.push(...children.filter(Boolean));
	}
	addEventListener() {}
	querySelector() {
		return null;
	}
	contains() {
		return false;
	}
	focus() {}
}
let panel;
class FakePanel {
	constructor() {
		this.el = new FakeNode("section");
		this.actions = [];
		panel = this;
	}
	setTitle() {}
	setBody() {}
	setActions(actions) {
		this.actions = actions.filter(Boolean);
	}
	done() {}
}
class FakeListBox {
	constructor() {
		this.el = new FakeNode("ul");
	}
	setItems(items) {
		this.items = items;
	}
}
mock.module(new URL("../ui/js/components.js", import.meta.url).href, { namedExports: { ListBox: FakeListBox, Panel: FakePanel } });
mock.module(new URL("../ui/js/dom.js", import.meta.url).href, {
	namedExports: { clear: (el) => (el.children = []), h: (tag, attrs, ...children) => Object.assign(new FakeNode(tag, attrs), { children }) },
});
mock.module(new URL("../ui/js/i18n.js", import.meta.url).href, { namedExports: { t: (key) => key } });
mock.module(new URL("../ui/js/keys.js", import.meta.url).href, { namedExports: { matches: () => false } });
globalThis.document = { activeElement: null };

const { tutorialScreen } = await import("../ui/js/tutorial-screen.js");

const labels = { back: "Back", next: "Next", nextModule: "Next module", skip: "Skip", restart: "Restart", docs: "Docs", try: "Try" };

async function open(modules, progress = { done: [], skipped: [] }) {
	const saved = [];
	const view = {
		app: { toast() {} },
		showPanel() {},
		engine: {
			request: async (command) => {
				if (command.type === "tutorial_get") return { state: { modules, labels, interrupt: { ids: [] }, progress } };
				saved.push({ done: command.done, skipped: command.skipped });
				return {};
			},
		},
	};
	await tutorialScreen(view);
	return saved;
}

const press = (place) => panel.actions.find((button) => button.dataset.place === place).onclick();

test("a module without an exercise is done once its last page is shown", async () => {
	const saved = await open([
		{ id: "basics", title: "Basics", doc: "x", pages: [["one"]], exercise: { kind: "command", command: "/x", notes: {} } },
		{ id: "further", title: "Going further", doc: "y", pages: [["first"], ["second"]] },
	], { done: ["basics"], skipped: [] });
	// Opened on the first unfinished module, its first page: not read yet.
	assert.deepEqual(saved, []);
	press("next");
	assert.deepEqual(saved.at(-1)?.done, ["basics", "further"]);
});

test("a one-page module without an exercise is done when it opens, and a skipped one is no longer skipped", async () => {
	const saved = await open([{ id: "only", title: "Only", doc: "z", pages: [["all of it"]] }], { done: [], skipped: ["only"] });
	assert.deepEqual(saved.at(-1), { done: ["only"], skipped: [] });
});
