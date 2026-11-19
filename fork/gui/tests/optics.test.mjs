import assert from "node:assert/strict";
import { test } from "node:test";
import { WelcomeScene } from "../ui/js/optics.js";

test("without a drawing in the page, both boot choices animate on the shader, keep their aspect and pixel cap, and stop when hidden", () => {
	const random = Math.random;
	const globals = Object.fromEntries(["window", "document", "ResizeObserver", "requestAnimationFrame", "getComputedStyle", "setTimeout", "clearTimeout"].map((name) => [name, globalThis[name]]));
	try {
		for (const [choice, phase] of [[0, 1], [0.99, 4]]) {
			const frames = [];
			const timers = [];
			const draws = [];
			const released = [];
			const copies = [];
			const sources = [];
			const classes = new Set();
			const container = { clientWidth: 1600, clientHeight: 900, opacity: "1", dataset: {}, classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)) } };
			const makeCanvas = () => {
				const canvas = { style: {}, listeners: {} };
				canvas.addEventListener = (name, callback) => { canvas.listeners[name] = callback; };
				canvas.removeEventListener = (name) => { delete canvas.listeners[name]; };
				canvas.replaceWith = (next) => { container.canvas = next; };
				canvas.getContext = (kind) => (kind === "2d" ? { drawImage: (image) => copies.push([canvas, image]) } : null);
				return canvas;
			};
			container.canvas = makeCanvas();
			container.querySelector = (selector) => (selector.endsWith("-scene") ? null : container.canvas);
			const lose = (canvas) => canvas.listeners.webglcontextlost({ target: canvas, preventDefault() {} });
			let contexts = 0;
			const listeners = {};
			let resized;
			globalThis.window = {
				innerWidth: 1600, innerHeight: 900, devicePixelRatio: 2,
				addEventListener: (name, callback) => { listeners[name] = callback; },
				PrismOptics: { create: (canvas) => { sources.push(canvas); const id = ++contexts; return { draw: (state) => draws.push(state), gl: { getExtension: () => ({ loseContext: () => released.push(id) }) } }; } },
			};
			globalThis.document = { hidden: false, documentElement: { dataset: {} }, addEventListener() {}, createElement: makeCanvas };
			globalThis.ResizeObserver = class { constructor(callback) { resized = callback; } observe() {} };
			globalThis.requestAnimationFrame = (frame) => frames.push(frame);
			globalThis.getComputedStyle = (element) => ({ opacity: element.opacity });
			globalThis.setTimeout = (callback) => timers.push(callback);
			globalThis.clearTimeout = () => {};
			Math.random = () => choice;
			const scene = new WelcomeScene(container);
			assert.equal(scene.phase, phase);
			assert.equal(document.documentElement.dataset.scene, String(phase));
			scene.setVisible(true);
			scene.setAnimated(true);
			const canvas = scene.canvas;
			assert.ok(canvas.width * canvas.height <= 1_602_000);
			assert.ok(Math.abs(canvas.width / canvas.height - 1600 / 900) < 0.003);
			// the still image covers the black canvas until the first frame is on screen.
			assert.ok(classes.has("still"));
			frames.shift()(scene.start + 40);
			frames.shift()();
			assert.ok(!classes.has("still"));
			listeners.pointermove({ pointerType: "mouse", clientX: 1600, clientY: 900 });
			frames.shift()(scene.start + 140);
			assert.equal(draws.length, 2);
			assert.ok(draws.every((state) => state.s === phase));
			// the shader never draws on the page's canvas, whose WebGL buffers WebKitGTK shows stale
			// on alternate frames; each frame is copied from its own canvas to the page's, at the same size.
			assert.notEqual(sources[0], canvas);
			assert.deepEqual(copies, [[canvas, sources[0]], [canvas, sources[0]]]);
			assert.equal(sources[0].width, canvas.width);
			assert.equal(sources[0].height, canvas.height);
			assert.ok(draws[1].t > draws[0].t);
			assert.match(canvas.style.transform, /translate\([1-9]/);
			// a resized shader canvas keeps drawing at its old size; it is made again at the new one once the
			// size holds, and meanwhile its last frame is stretched over the page's canvas.
			container.clientWidth = 1200;
			resized();
			const at = performance.now();
			frames.shift()(at + 40);
			assert.equal(sources.length, 1);
			assert.notEqual(sources[0].width, canvas.width);
			assert.deepEqual(copies.at(-1), [canvas, sources[0]]);
			frames.shift()(at + 200);
			assert.equal(sources.length, 2);
			assert.deepEqual(released, [1]);
			assert.equal(sources[1].width, canvas.width);
			assert.equal(sources[1].height, canvas.height);
			assert.deepEqual(copies.at(-1), [canvas, sources[1]]);
			const drawn = draws.length;
			// Hidden and transparent: it stops and gives its context back, on a new canvas for the next showing.
			container.opacity = "0";
			scene.setVisible(false);
			frames.shift()(at + 300);
			assert.equal(draws.length, drawn);
			assert.equal(scene.running, false);
			assert.deepEqual(released, [1, 2]);
			assert.notEqual(scene.canvas, canvas);
			assert.ok(classes.has("still"));
			container.opacity = "1";
			scene.setVisible(true);
			assert.equal(contexts, 3);
			assert.ok(scene.running);
			// a lost context shows the still image, never black, and starts again a moment later on a new canvas.
			for (let loss = 1; loss <= 3; loss++) {
				frames.length = 0;
				frames.push(() => {});
				lose(scene.source);
				assert.ok(classes.has("still"));
				assert.equal(scene.running, false);
				if (loss < 3) {
					assert.equal(timers.length, 1);
					timers.shift()();
					assert.equal(contexts, 3 + loss);
					assert.ok(scene.running);
				}
			}
			// The third loss within a minute keeps the still image instead of flashing between the two.
			assert.equal(timers.length, 0);
			scene.setVisible(true);
			scene.setAnimated(true);
			assert.equal(scene.running, false);
			assert.equal(contexts, 5);
			assert.ok(classes.has("still"));
		}
	} finally {
		Math.random = random;
		Object.assign(globalThis, globals);
	}
});

test("the prism and the light page draw the vector scene, which runs only while the welcome shows", () => {
	const random = Math.random;
	const globals = Object.fromEntries(["window", "document", "ResizeObserver", "requestAnimationFrame", "getComputedStyle"].map((name) => [name, globalThis[name]]));
	try {
		for (const [choice, appearance] of [[0.99, "dark"], [0, "light"]]) {
			const frames = [];
			const classes = new Set();
			let contexts = 0;
			let dots = 0;
			const layer = (name) => ({ classList: [name], style: {} });
			const dust = { classList: ["ps-dust"], style: {}, getContext: () => ({ setTransform() {}, clearRect() {}, beginPath() {}, arc() {}, fill: () => dots++ }) };
			const fanB = layer("ps-fan");
			const svg = { attrs: {}, setAttribute: (name, value) => (svg.attrs[name] = value) };
			const art = {
				clientWidth: 1600,
				clientHeight: 900,
				children: [layer("ps-back"), fanB, dust, layer("ps-glass")],
				querySelector: (selector) => ({ ".ps-dust": dust, ".ps-fan-b": fanB })[selector],
				querySelectorAll: () => [svg],
			};
			const canvas = { style: {}, addEventListener() {} };
			const container = { clientWidth: 1600, clientHeight: 900, dataset: {}, classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)) } };
			container.querySelector = (selector) => (selector === ".prism-scene" ? art : selector === ".eclipse-scene" ? null : canvas);
			globalThis.window = { innerWidth: 1600, innerHeight: 900, devicePixelRatio: 1, addEventListener() {}, PrismOptics: { create: () => ++contexts } };
			globalThis.document = { hidden: false, documentElement: { dataset: { appearance } }, addEventListener() {} };
			globalThis.ResizeObserver = class { observe() {} };
			globalThis.requestAnimationFrame = (frame) => frames.push(frame);
			globalThis.getComputedStyle = () => ({ getPropertyValue: () => "255 255 255", opacity: "1" });
			Math.random = () => choice;
			const scene = new WelcomeScene(container);
			// Reduced motion: drawn once, still, and never on WebGL.
			scene.setVisible(true);
			assert.equal(container.dataset.art, "prism");
			assert.ok(classes.has("vector"));
			assert.equal(document.documentElement.dataset.sceneVector, "true");
			assert.equal(scene.running, false);
			assert.ok(dots > 0);
			assert.equal(fanB.style.opacity, "0.5");
			assert.equal(frames.length, 0);
			scene.setAnimated(true);
			assert.ok(scene.running);
			frames.shift()(1000);
			frames.shift()(2000);
			assert.notEqual(fanB.style.opacity, "0.5");
			assert.equal(svg.attrs.viewBox, "0.00 0.00 1600.00 900.00");
			// A narrow window keeps the glass and the start of its spectrum (x 1010 on), not the frame's middle.
			art.clientWidth = 560;
			art.clientHeight = 800;
			frames.shift()(2100);
			const [x, , w] = svg.attrs.viewBox.split(" ").map(Number);
			assert.ok(x < 600 && x + w > 1150, svg.attrs.viewBox);
			art.clientWidth = 1600;
			art.clientHeight = 900;
			assert.match(art.children[3].style.transform, /scale\(1\.02\)/);
			assert.ok(!classes.has("still"), "the vector scene has no still image to wait behind");
			// The welcome goes: the next frame stops it, and it stays drawn, out of focus, behind the conversation.
			scene.setVisible(false);
			assert.equal(scene.running, false);
			assert.equal(frames.length, 1);
			const drawn = dots;
			frames.shift()(3000);
			assert.equal(dots, drawn);
			assert.equal(frames.length, 0);
			assert.equal(contexts, 0);
		}
		// The eclipse, on the dark page, is drawn the same way, and daylight shows the prism instead.
		globalThis.document.documentElement.dataset.appearance = "dark";
		Math.random = () => 0;
		const classes = new Set();
		const frames = [];
		globalThis.requestAnimationFrame = (frame) => frames.push(frame);
		const layer = (name) => ({ classList: [name], style: {} });
		const corona = { style: {} };
		const bead = layer("es-bead");
		const svg = { attrs: {}, setAttribute: (name, value) => (svg.attrs[name] = value) };
		const eclipse = {
			clientWidth: 1600,
			clientHeight: 900,
			children: [layer("es-back"), layer("es-streak"), layer("es-disc"), bead],
			querySelector: (selector) => ({ ".es-corona": corona, ".es-bead": bead })[selector],
			querySelectorAll: () => [svg],
		};
		const prism = { clientWidth: 1600, clientHeight: 900, children: [], querySelector: () => ({ style: {}, getContext: () => null }), querySelectorAll: () => [] };
		const canvas = { style: {}, addEventListener() {} };
		const container = { clientWidth: 1600, clientHeight: 900, dataset: {}, classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)) } };
		container.querySelector = (selector) => (selector === ".eclipse-scene" ? eclipse : selector === ".prism-scene" ? prism : canvas);
		const scene = new WelcomeScene(container);
		assert.equal(scene.phase, 1);
		scene.setVisible(true);
		assert.ok(classes.has("vector"));
		assert.equal(container.dataset.art, "eclipse");
		assert.equal(corona.style.opacity, "0.850");
		assert.equal(svg.attrs.viewBox, "0.00 0.00 1600.00 900.00");
		scene.setAnimated(true);
		frames.shift()(2500);
		assert.notEqual(corona.style.opacity, "0.850");
		assert.match(bead.style.transform, /scale\(1\.02\)/);
		globalThis.document.documentElement.dataset.appearance = "light";
		scene.setVisible(true);
		assert.equal(container.dataset.art, "prism");
	} finally {
		Math.random = random;
		Object.assign(globalThis, globals);
	}
});
