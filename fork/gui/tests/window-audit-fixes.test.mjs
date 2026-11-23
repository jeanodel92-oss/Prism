// Audit of the public release, 2026-11-23: the window's zoom keys, the unknown command's suggestion
//, Tab out of a draft with nothing to complete and the French docs' anchors (DOC-23).
// Run by hand: node --test --experimental-test-module-mocks fork/gui/tests/window-audit-fixes.test.mjs
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { mock, test } from "node:test";

const element = () => ({ addEventListener() {}, scrollIntoView() {}, append() {}, replaceChildren() {} });
mock.module(new URL("../ui/js/dom.js", import.meta.url).href, {
	namedExports: { clear() {}, h: element, stripAnsi: (text) => text },
});
mock.module(new URL("../ui/js/components.js", import.meta.url).href, { namedExports: { ListBox: class {}, Panel: class {} } });
mock.module(new URL("../ui/js/markdown.js", import.meta.url).href, { namedExports: { renderMarkdown() {} } });
mock.module(new URL("../ui/js/search.js", import.meta.url).href, { namedExports: { findRanges: () => [] } });
const { matches, windowKeys } = await import("../ui/js/keys.js");
const { closestCommand, Completion } = await import("../ui/js/completion.js");
const { anchorTarget, headingId } = await import("../ui/js/docs-screen.js");

const key = (key, mods = {}) => ({ key, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...mods });

test("the zoom keys: Ctrl+=, Ctrl+Shift+= and the keypad's + zoom in, Ctrl+- out, Ctrl+0 back", () => {
	const zoomIn = windowKeys(undefined, "window.zoom.in");
	const pressed = (event, keys) => keys.some((id) => matches(event, id));
	assert.equal(pressed(key("=", { ctrlKey: true }), zoomIn), true);
	assert.equal(pressed(key("+", { ctrlKey: true, shiftKey: true }), zoomIn), true, "Ctrl+Shift+= types +");
	assert.equal(pressed(key("+", { ctrlKey: true }), zoomIn), true, "the keypad's +");
	assert.equal(pressed(key("+"), zoomIn), false, "+ alone types");
	assert.equal(pressed(key("-", { ctrlKey: true }), windowKeys(undefined, "window.zoom.out")), true);
	assert.equal(pressed(key("0", { ctrlKey: true }), windowKeys(undefined, "window.zoom.reset")), true);
	assert.equal(pressed(key("0", { ctrlKey: true }), zoomIn), false);
});

test("a binding the engine sends for a window key replaces its default", () => {
	const keys = { bindings: { "window.zoom.in": { keys: ["ctrl+alt+i"] } } };
	assert.deepEqual(windowKeys(keys, "window.zoom.in"), ["ctrl+alt+i"]);
	assert.deepEqual(windowKeys(keys, "window.zoom.out"), ["ctrl+-"]);
	assert.deepEqual(windowKeys(keys, "no.such.key"), []);
});

test("an unknown command suggests the one a typo away, and nothing for a word far from every command (FIN-27)", () => {
	const names = ["new", "resume", "model", "thinking", "settings", "help", "compact", "context", "doctor"];
	assert.equal(closestCommand("modle", names), "model", "two letters swapped");
	assert.equal(closestCommand("setings", names), "settings", "a letter dropped");
	assert.equal(closestCommand("hepl", names), "help");
	assert.equal(closestCommand("zzz", names), undefined);
	assert.equal(closestCommand("xyzzy", names), undefined);
	assert.equal(closestCommand("ne", names), "new", "a short name allows one edit");
	assert.equal(closestCommand("nw", ["new", "now"]), "new", "the first listed wins a tie");
});

/** A composer holding `text`, an engine that has nothing to complete, and where Tab sent the keyboard. */
function composer(text) {
	const moved = [];
	const engine = { request: async () => ({ items: [] }) };
	const input = { value: text, selectionStart: text.length, setSelectionRange() {}, dispatchEvent() {} };
	const app = { active: { ready: true, engine }, focusNext: (from) => moved.push(from), toast() {} };
	const list = { hidden: true, append() {}, children: [], firstElementChild: null };
	return { completion: new Completion(app, input, list), input, moved };
}

test("Tab in a draft with nothing to complete moves the keyboard on; with an empty draft the window lets Tab go", async () => {
	const draft = composer("hello wor");
	assert.equal(draft.completion.key(key("Tab")), true);
	await draft.completion.pending;
	assert.deepEqual(draft.moved, [draft.input]);
	assert.equal(draft.completion.open, false);

	const empty = composer("");
	assert.equal(empty.completion.key(key("Tab")), false, "the browser moves the focus itself");
	assert.deepEqual(empty.moved, []);
});

test("a link names a heading without its accents or with its apostrophe as a hyphen (DOC-23)", () => {
	const ids = ["exécuter-prism-dans-docker-standard", "sauthentifier-avec-oauth", "contrôler-lexposition-des-outils", "plain"];
	assert.equal(headingId("Exécuter Prism dans Docker (standard)"), "exécuter-prism-dans-docker-standard");
	assert.equal(headingId("S’authentifier avec OAuth"), "sauthentifier-avec-oauth");
	assert.equal(anchorTarget(ids, "executer-prism-dans-docker-standard"), ids[0]);
	assert.equal(anchorTarget(ids, "s-authentifier-avec-oauth"), ids[1]);
	assert.equal(anchorTarget(ids, "controler-lexposition-des-outils"), ids[2]);
	assert.equal(anchorTarget(ids, "contr%C3%B4ler-lexposition-des-outils"), ids[2], "an encoded fragment");
	assert.equal(anchorTarget(ids, "plain"), "plain");
	assert.equal(anchorTarget(ids, "missing"), undefined);
});

/** Every heading id of a page, as the reader computes it (its text without Markdown marks), and its <a id> anchors. */
function pageIds(markdown) {
	const ids = [];
	let fenced = false;
	for (const line of markdown.split("\n")) {
		if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
		if (fenced) continue;
		const heading = /^#{1,4}\s+(.*?)\s*#*\s*$/.exec(line)?.[1];
		if (heading !== undefined) {
			const text = heading.replace(/<[^>]+>/g, "").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*_]/g, "");
			ids.push(headingId(text));
		}
		for (const [, id] of line.matchAll(/<a\s+(?:id|name)="([\w-]+)"><\/a>/g)) ids.push(id);
	}
	return ids;
}

// A link whose words differ from its heading's, which no reading of the id can find: the page must change (the heading
// is "Terminal intégré d’IntelliJ IDEA"). Remove the entry once the page is fixed.
const KNOWN_BROKEN = new Set();

test("every anchor link of the shipped docs, French included, leads to a heading of its page (DOC-23)", () => {
	const root = new URL("../../../packages/coding-agent/docs/", import.meta.url);
	const unresolved = [];
	let checked = 0;
	for (const dir of ["", "fr/"]) {
		const pages = readdirSync(new URL(dir, root)).filter((name) => name.endsWith(".md"));
		const ids = new Map(pages.map((name) => [name, pageIds(readFileSync(new URL(dir + name, root), "utf8"))]));
		for (const name of pages) {
			const text = readFileSync(new URL(dir + name, root), "utf8");
			for (const [, target, fragment] of text.matchAll(/\]\(([\w./-]*?\.md|)#([^)\s]+)\)/g)) {
				if (target.includes("/")) continue; // another folder's page: checked with that folder
				const page = ids.get(target || name);
				if (!page) continue;
				checked++;
				const link = `${dir}${name} → ${target}#${fragment}`;
				if (!anchorTarget(page, fragment) && !KNOWN_BROKEN.has(link)) unresolved.push(link);
			}
		}
	}
	assert.ok(checked > 100, `only ${checked} anchor links found`);
	assert.deepEqual(unresolved, []);
});
