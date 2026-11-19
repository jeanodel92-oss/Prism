// QA 2026-11-13 (R8): the linked phones are listed in the settings, each with a revoke button, from the same code as the
// "Link a phone" panel. Run by hand: node --test fork/gui/tests/phones-list.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

class FakeNode {}
class FakeText extends FakeNode {
	constructor(data) {
		super();
		this.data = data;
	}
}
class FakeElement extends FakeNode {
	constructor(tag) {
		super();
		this.tag = tag;
		this.className = "";
		this.attributes = {};
		this.listeners = {};
		this.children = [];
		this.dataset = {};
	}
	set textContent(value) {
		this.children = [new FakeText(value)];
	}
	get textContent() {
		return this.children.map((child) => child.data ?? child.textContent).join("");
	}
	addEventListener(name, fn) {
		this.listeners[name] = fn;
	}
	setAttribute(name, value) {
		this.attributes[name] = value;
		if (name === "disabled") this.disabled = true;
	}
	append(...nodes) {
		this.children.push(...nodes);
	}
}
const find = (el, tag) => (el.tag === tag ? [el] : []).concat(...(el.children ?? []).filter((c) => c instanceof FakeElement).map((c) => find(c, tag)));

const calls = [];
globalThis.Node = FakeNode;
globalThis.document = { documentElement: {}, createElement: (tag) => new FakeElement(tag), createTextNode: (text) => new FakeText(text) };
globalThis.window = { __TAURI__: { core: { invoke: async (command, args) => calls.push([command, args]) } } };

const { phonesList, revokePhone } = await import("../ui/js/phone-link.js");
const { setLanguage } = await import("../ui/js/i18n.js");

test("no phone: one short line, no list", () => {
	setLanguage("en");
	const el = phonesList([], { onRevoke() {} });
	assert.equal(el.tag, "p");
	assert.equal(el.textContent, "No phone linked yet.");
});

test("each phone has a revoke button that passes its full fingerprint", async () => {
	const a = "a".repeat(64);
	const b = "b".repeat(64);
	const revoked = [];
	const el = phonesList([a, b], { onRevoke: (fingerprint) => revoked.push(fingerprint) });
	const rows = find(el, "li");
	assert.equal(rows.length, 2);
	assert.equal(find(rows[1], "code")[0].textContent, `${"b".repeat(16)}…`);
	const button = find(rows[1], "button")[0];
	assert.equal(button.textContent, "Revoke");
	button.listeners.click();
	assert.deepEqual(revoked, [b]);
	await revokePhone(a);
	assert.deepEqual(calls.at(-1), ["phone_link_revoke", { fingerprint: a }]);
});

test("the buttons are disabled while the panel works", () => {
	const el = phonesList(["c".repeat(64)], { busy: true, onRevoke() {} });
	assert.equal(find(el, "button")[0].disabled, true);
});
