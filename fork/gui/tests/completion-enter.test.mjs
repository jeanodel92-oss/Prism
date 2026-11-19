// fork: Enter on the completion of an absolute path in the middle of the
// draft also sent the draft, because an absolute path starts with "/" like a command.
// Run by hand: node --test --experimental-test-module-mocks fork/gui/tests/completion-enter.test.mjs
import assert from "node:assert/strict";
import { mock, test } from "node:test";

const node = () => ({ addEventListener() {}, scrollIntoView() {} });
mock.module(new URL("../ui/js/dom.js", import.meta.url).href, {
	namedExports: { clear() {}, h: node },
});
const { Completion } = await import("../ui/js/completion.js");
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** A composer holding `text`, an engine that lists `items` for `prefix`, and the drafts the window sent. */
function composer(text, items, prefix) {
	const sent = [];
	const engine = {
		async request(command) {
			if (command.type === "complete") return { items: items.map((value) => ({ value, label: value })), prefix };
			const before = command.text.slice(0, command.cursor - command.prefix.length);
			const written = before + command.item.value + command.text.slice(command.cursor);
			return { text: written, cursor: before.length + command.item.value.length };
		},
	};
	const app = { active: { ready: true, engine }, submit: () => sent.push(input.value), toast() {} };
	const input = {
		value: text,
		selectionStart: text.length,
		setSelectionRange(start) {
			this.selectionStart = start;
		},
		dispatchEvent() {},
	};
	const list = { hidden: true, append() {}, children: [], firstElementChild: null };
	return { completion: new Completion(app, input, list), input, sent };
}

async function chooseWithEnter({ completion }) {
	completion.key({ key: "Tab" });
	await completion.pending;
	assert.equal(completion.open, true);
	completion.key({ key: "Enter" });
	await settle();
}

test("Enter writes an absolute path in the middle of the draft and keeps the draft", async () => {
	const window = composer("Consulte /tmp/proj", ["/tmp/proj-a/", "/tmp/proj-b/"], "/tmp/proj");
	await chooseWithEnter(window);
	assert.equal(window.input.value, "Consulte /tmp/proj-a/");
	assert.deepEqual(window.sent, []);
});

test("Enter still sends a command name", async () => {
	const window = composer("/mo", ["/model", "/mode"], "/mo");
	await chooseWithEnter(window);
	assert.deepEqual(window.sent, ["/model"]);
});
