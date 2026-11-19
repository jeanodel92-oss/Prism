// fork: the window's work that outlived the state it was started for.
// Run by hand: node --test --experimental-test-module-mocks fork/gui/tests/window-generations.test.mjs
// CR-103 (a conversation woken while it was going to sleep), CR-275 (a command given up opening its panel later),
// CR-278 (searches of the completion list nobody waits for), CR-332 (the scene's animation running twice).
import assert from "node:assert/strict";
import { mock, test } from "node:test";

class FakeNode {
	constructor(tag) {
		this.tagName = String(tag).toUpperCase();
		this.children = [];
		this.hidden = false;
		this.value = "";
		this.selectionStart = 0;
		this.style = {};
	}
	append(...children) {
		this.children.push(...children);
	}
	replaceChildren() {
		this.children = [];
	}
	addEventListener() {}
}

// session.js's other modules are not what is tested: stand-ins.
const engines = [];
class FakeEngine {
	constructor(onEvent, onExit) {
		this.onEvent = onEvent;
		this.onExit = onExit;
		this.alive = true;
		this.requests = [];
		this.stopped = 0;
		engines.push(this);
	}
	request(command) {
		return new Promise((resolve, reject) => this.requests.push({ command, resolve, reject }));
	}
	send(command) {
		this.requests.push({ command });
		return Promise.resolve();
	}
	async stop() {
		this.stopped++;
		this.alive = false;
	}
}
const stub = (names) => ({ namedExports: Object.fromEntries(names.map((name) => [name, () => {}])) });
const module = (name) => new URL(`../ui/js/${name}`, import.meta.url).href;
mock.module(module("attachments.js"), stub(["promptWith", "sentChips", "splitFiles"]));
mock.module(module("builtins.js"), stub(["builtin", "screen"]));
mock.module(module("components.js"), { namedExports: { ListBox: class {}, Panel: class {} } });
mock.module(module("custom-message.js"), stub(["agentStepCount", "agentStepLines", "customText"]));
mock.module(module("dom.js"), {
	namedExports: { clear: (el) => el.replaceChildren(), copyText() {}, formatDuration() {}, h: (tag) => new FakeNode(tag), stripAnsi: (s) => s },
});
mock.module(module("engine.js"), { namedExports: { Engine: FakeEngine } });
mock.module(module("generated-ui.js"), stub(["renderDocument", "setAnswerable"]));
mock.module(module("i18n.js"), { namedExports: { t: (key) => key } });
mock.module(module("markdown.js"), stub(["renderMarkdown"]));
mock.module(module("view.js"), { namedExports: { TerminalView: class {} } });

const { SessionView } = await import("../ui/js/session.js");
const { Interactions } = await import("../ui/js/surface.js");
const { Completion } = await import("../ui/js/completion.js");
const { WelcomeScene } = await import("../ui/js/optics.js");

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("a conversation opened while it goes to sleep stops its old engine, then wakes on a new one with its grants", async () => {
	engines.length = 0;
	const app = { sessionChanged() {}, refreshHistory() {}, active: undefined, render() {} };
	const view = new SessionView(app, "/tmp/session.jsonl", "A", "/tmp");
	view.ready = true;
	view.open = async () => {
		view.ready = true;
	};
	const old = view.engine;
	const sleeping = view.sleep();
	// Asleep from now: nothing is sent to the engine about to stop.
	assert.equal(view.ready, false);
	const exported = old.requests.find((r) => r.command.type === "perm_export");
	assert.ok(exported);
	// The user opens it before the old engine handed its grants over.
	const waking = view.wake();
	assert.equal(view.wake(), waking, "one wake at a time");
	await tick();
	assert.equal(engines.length, 1, "no new engine before the old one stopped");
	exported.resolve({ grants: ["bash:rm"] });
	await sleeping;
	await tick();
	assert.equal(old.stopped, 1);
	assert.equal(engines.length, 2);
	const fresh = view.engine;
	assert.notEqual(fresh, old);
	assert.equal(fresh.stopped, 0, "the new engine is not the one the sleep stops");
	const imported = fresh.requests.find((r) => r.command.type === "perm_import");
	assert.deepEqual(imported?.command.grants, ["bash:rm"]);
	imported.resolve({ imported: true });
	await waking;
	// The old engine's exit, arriving late, is not the new one's.
	old.onExit({ code: 0 });
	assert.equal(view.exit, undefined);
	assert.equal(view.suspended, false);
});

test("a command given up after the bound cannot open its panel over the next one", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const app = { active: undefined, render() {}, surface: { place() {} } };
	const session = { app, streaming: false, footerMenuOpen: false };
	const interactions = new Interactions(session);
	const dismissed = [];
	const entry = (owner) => ({ panel: { el: {} }, owner, onDismiss: () => dismissed.push(owner) });
	// /docs waits for an answer that comes late; another command replaces it.
	let answer;
	void interactions.run("docs", () => new Promise((resolve) => (answer = resolve)));
	const next = interactions.run("tree", () => new Promise(() => {}));
	await tick();
	t.mock.timers.tick(3000);
	await tick();
	assert.equal(interactions.command?.name, "tree");
	// Its answer arrives: the panel it opens is closed at once.
	interactions.open(entry("docs"));
	await tick();
	assert.deepEqual(dismissed, ["docs"]);
	// The tree's own panel opens normally.
	interactions.open(entry("tree"));
	await tick();
	assert.deepEqual(dismissed, ["docs"]);
	// The same command typed again waits for the given-up run to end, so their panels cannot be mixed up.
	let started = false;
	void interactions.run("docs", () => {
		started = true;
		return new Promise(() => {});
	});
	await tick();
	t.mock.timers.tick(3000);
	await tick();
	assert.equal(started, false);
	answer();
	await tick();
	await tick();
	assert.equal(started, true);
	void next;
});

test("the completion asks once for quick edits and stops the search it no longer waits for", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const engine = new FakeEngine();
	const app = { active: { ready: true, engine } };
	const input = new FakeNode("textarea");
	const completion = new Completion(app, input, new FakeNode("ul"));
	for (const text of ["@", "@s", "@sr"]) {
		input.value = text;
		input.selectionStart = text.length;
		completion.edited({ inputType: "insertText", data: text.at(-1) });
	}
	assert.equal(engine.requests.length, 0);
	t.mock.timers.tick(20);
	assert.deepEqual(
		engine.requests.map((r) => [r.command.type, r.command.text]),
		[["complete", "@sr"]],
	);
	// Escape: the search still running is stopped in the engine.
	completion.close();
	assert.deepEqual(
		engine.requests.map((r) => r.command.type),
		["complete", "complete_cancel"],
	);
	engine.requests[0].resolve({ items: [{ label: "src" }] });
	await tick();
	assert.equal(completion.open, false);
	// An edit grouped then closed asks nothing, and whoever waited on it goes on.
	input.value = "@x";
	completion.edited({ inputType: "insertText", data: "x" });
	const pending = completion.pending;
	completion.close();
	await pending;
	t.mock.timers.tick(20);
	assert.equal(engine.requests.length, 2);
});

test("the scene keeps one animation loop when it is shown again before its stopped frame ran", () => {
	const random = Math.random;
	const globals = Object.fromEntries(["window", "document", "ResizeObserver", "requestAnimationFrame", "getComputedStyle"].map((name) => [name, globalThis[name]]));
	try {
		const frames = [];
		const layer = (name) => ({ classList: [name], style: {} });
		const dust = { classList: ["ps-dust"], style: {}, getContext: () => ({ setTransform() {}, clearRect() {}, beginPath() {}, arc() {}, fill() {} }) };
		const svg = { setAttribute() {} };
		const art = {
			clientWidth: 1600,
			clientHeight: 900,
			children: [layer("ps-back"), layer("ps-fan"), dust, layer("ps-glass")],
			querySelector: (selector) => ({ ".ps-dust": dust, ".ps-fan-b": layer("ps-fan") })[selector],
			querySelectorAll: () => [svg],
		};
		const canvas = { style: {}, addEventListener() {} };
		const container = { clientWidth: 1600, clientHeight: 900, dataset: {}, classList: { toggle() {} } };
		container.querySelector = (selector) => (selector === ".prism-scene" ? art : selector === ".eclipse-scene" ? null : canvas);
		globalThis.window = { innerWidth: 1600, innerHeight: 900, devicePixelRatio: 1, addEventListener() {}, PrismOptics: { create: () => 1 } };
		globalThis.document = { hidden: false, documentElement: { dataset: { appearance: "dark" } }, addEventListener() {} };
		globalThis.ResizeObserver = class {
			observe() {}
		};
		globalThis.requestAnimationFrame = (frame) => frames.push(frame);
		globalThis.getComputedStyle = () => ({ getPropertyValue: () => "255 255 255", opacity: "1" });
		Math.random = () => 0.99;
		const scene = new WelcomeScene(container);
		scene.setVisible(true);
		scene.setAnimated(true);
		assert.ok(scene.running);
		assert.equal(frames.length, 1);
		// Hidden, then shown again before the frame asked earlier ran: two frames are pending, one loop must survive.
		scene.setVisible(false);
		scene.setVisible(true);
		assert.equal(frames.length, 2);
		for (const frame of frames.splice(0)) frame(1000);
		assert.equal(frames.length, 1);
		frames.shift()(2000);
		assert.equal(frames.length, 1);
	} finally {
		Math.random = random;
		Object.assign(globalThis, globals);
	}
});
