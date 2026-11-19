// two identical Mermaid diagrams waiting for the same drawing; only the last of
// their source blocks became a picture.
// Run by hand: node --test --experimental-test-module-mocks fork/gui/tests/diagram-shared.test.mjs
import assert from "node:assert/strict";
import { mock, test } from "node:test";

mock.module(new URL("../ui/js/dom.js", import.meta.url).href, { namedExports: { h: (tag) => ({ tag }) } });
mock.module(new URL("../ui/js/i18n.js", import.meta.url).href, { namedExports: { t: (key) => key } });
mock.module(new URL("../ui/js/theme.js", import.meta.url).href, { namedExports: { activeAppearance: () => "dark" } });
let renders = 0;
globalThis.document = {
	addEventListener() {},
	createElement: () => ({}),
	head: {
		append(script) {
			globalThis.mermaid = {
				initialize() {},
				render: async () => {
					renders++;
					return { svg: "<svg/>" };
				},
			};
			script.onload();
		},
	},
};
const { diagram } = await import("../ui/js/diagram.js");

const block = (connected = true) => ({
	isConnected: connected,
	replacedBy: undefined,
	replaceWith(node) {
		this.replacedBy = node;
	},
});

test("every block of a diagram waiting for the same drawing becomes its picture, once drawn", async () => {
	const source = "graph TD; A-->B";
	const first = block();
	const second = block();
	const detached = block(false);
	assert.equal(diagram(source, detached), detached);
	assert.equal(diagram(source, first), first);
	assert.equal(diagram(source, second), second);
	for (let i = 0; i < 10 && !second.replacedBy; i++) await new Promise((resolve) => setImmediate(resolve));
	assert.equal(renders, 1, "drawn once");
	assert.equal(first.replacedBy?.tag, "figure");
	assert.equal(second.replacedBy?.tag, "figure");
	assert.equal(detached.replacedBy, undefined);
	// Drawn: the next one is the picture at once.
	assert.equal(diagram(source, block()).tag, "figure");
});
