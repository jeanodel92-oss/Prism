// Scripted checks (fork/gui/scripts/drive.sh). Active only in a binary built with `--features drive`:
// elsewhere `drive_script` does not exist and this module does nothing. Steps act through the page as a
// user would: typing in the composer, clicking visible buttons, pressing keys.

import { Panel } from "./components.js";
import { lifecycle } from "./lifecycle.js";

const { invoke } = window.__TAURI__.core;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let sceneTrace = []; // samples of the last "scene-trace" step
const log = (line) => invoke("drive_log", { line }).catch(() => {});

function find(selector, text) {
	for (const el of document.querySelectorAll(selector)) {
		if (el.closest("[hidden]") || el.getClientRects().length === 0 || getComputedStyle(el).visibility === "hidden") continue;
		// A field's text is what is typed in it, not its markup.
		const content = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement ? el.value : el.textContent;
		if (text === undefined || content.includes(text)) return el;
	}
	return undefined;
}

// A computed colour as [r, g, b, alpha], r g b on 0–255: rgb()/rgba(), color(srgb …) (a color-mix()), transparent.
function rgba(color) {
	const values = (color.match(/[\d.]+/g) ?? [0, 0, 0, 0]).map(Number);
	const scale = color.startsWith("color(") ? 255 : 1;
	return [values[0] * scale, values[1] * scale, values[2] * scale, values[3] ?? 1];
}

// `top` composed over the opaque colour `under`.
const over = (top, under) => [...[0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])), 1];

function luminance(color) {
	const [r, g, b] = color.slice(0, 3).map((v) => {
		const c = v / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fg, bg) {
	const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
	return (a + 0.05) / (b + 0.05);
}

async function waitFor(step) {
	// "sidebar": the target is in the sidebar; a narrow window shows it as an overlay that the user opens
	// with the menu button first.
	if (step.sidebar && !step.gone && matchMedia("(max-width: 760px)").matches && !document.body.classList.contains("sidebar-open")) {
		document.getElementById("toggle-sidebar").click();
	}
	// the target lies in a view of the side menu that is not shown; its icon shows it, as a user would.
	const hiddenView = step.sidebar && !step.gone && document.querySelector(step.selector)?.closest(".side-view[hidden]");
	if (hiddenView) document.querySelector(`.rail-button[data-view="${hiddenView.dataset.view}"]`).click();
	const until = performance.now() + (step.timeout ?? 10000);
	while (performance.now() < until) {
		const el = find(step.selector, step.text);
		if (step.gone ? !el : el) return el;
		await sleep(50);
	}
	throw new Error(`timeout: ${step.gone ? "still present" : "not found"} ${step.selector} ${step.text ?? ""}`);
}

function key(target, name, mods = {}) {
	target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...mods }));
}

const driveMarks = new Map();
let secondScreen; // the view the "second-screen" step opened

/**
 * What a conversation shows, one line per element, without what differs between two screens (animation, durations).
 * Every entry of the transcript, drawn in the page or not (transcript-list.js).
 */
function transcriptLines(view) {
	const texts = (el, selector) => [...el.querySelectorAll(selector)].map((part) => part.textContent).join(" | ");
	return view.list.entries.map((entry) =>
		view.list.peek(entry, (el) => {
			if (el.matches(".msg.user")) return `user: ${el.textContent}`;
			if (el.matches(".msg.assistant")) return `assistant: ${texts(el, ".thinking-body, .text, .tool-name, .tool-target, .tool-output, .msg-error")}`;
			if (el.matches(".tool")) return `tool ${el.dataset.status}: ${texts(el, ".tool-name, .tool-target, .tool-output")}`;
			if (el.matches(".turn-summary")) return `turn: ${el.firstElementChild?.textContent}`;
			return `${el.className.replace(/\benter\b/, "").trim()}: ${el.textContent}`;
		}),
	);
}

export async function runDrive(app) {
	let script;
	try {
		script = await invoke("drive_script");
	} catch {
		return; // normal binary
	}
	if (!script) return;
	// What the window's CSP refused since the scenario started (the "math" step).
	const refused = [];
	document.addEventListener("securitypolicyviolation", (event) => refused.push(`${event.violatedDirective} ${event.blockedURI || "inline"}`));
	let steps;
	try {
		steps = JSON.parse(script);
	} catch (error) {
		await log(`FAIL scenario: ${error.message}`);
		await invoke("drive_quit", { code: 1 });
		return;
	}
	const input = document.getElementById("input");
	for (const [index, step] of steps.entries()) {
		try {
			switch (step.do) {
				case "scene-pixels": {
					// Read two actual shader frames through the production clock, for each boot phase.
					const scene = app.scene;
					scene.setPhase(step.phase);
					if (scene.isVector && scene.container.dataset.art === "eclipse") {
						// The vector eclipse: its corona breathes and its bead twinkles.
						if (!scene.running) throw new Error("scene-pixels: vector scene is not running");
						const read = () => ["#scene .es-corona", "#scene .es-bead"].map((selector) => document.querySelector(selector).style.opacity);
						const first = read();
						await sleep(1000);
						const second = read();
						await log(`scene-pixels phase=${scene.phase} eclipse ${first.join(",")} -> ${second.join(",")}`);
						if (first[0] === second[0] || first[1] === second[1]) throw new Error("scene-pixels: vector scene did not animate");
						break;
					}
					if (scene.isVector) {
						// The vector prism: two frames of its dust a second apart, and the crossfade of its fans.
						if (!scene.running) throw new Error("scene-pixels: vector scene is not running");
						const dust = document.querySelector("#scene .ps-dust");
						const read = () => dust.getContext("2d").getImageData(0, 0, dust.width, dust.height).data;
						const fan = () => Number(document.querySelector("#scene .ps-fan-b").style.opacity);
						const [first, fanFirst] = [read(), fan()];
						await sleep(1000);
						const [second, fanSecond] = [read(), fan()];
						let changed = 0;
						for (let i = 0; i < first.length; i++) if (Math.abs(first[i] - second[i]) > 2) changed++;
						await log(`scene-pixels phase=${scene.phase} vector changed-channels=${changed} dust=${dust.width}x${dust.height} fan=${fanFirst.toFixed(3)}->${fanSecond.toFixed(3)}`);
						if (changed < 50 || fanFirst === fanSecond) throw new Error("scene-pixels: vector scene did not animate");
						break;
					}
					if (!scene.optics || !scene.running) throw new Error("scene-pixels: WebGL scene is not running");
					const draw = scene.optics.draw;
					const samples = [];
					let done;
					const completed = new Promise((resolve) => { done = resolve; });
					scene.optics.draw = (state) => {
						draw(state);
						if (samples.length === 2 || (samples.length && state.t - samples[0].time < 1)) return;
						const { gl } = scene.optics;
						const pixels = new Uint8Array(scene.canvas.width * scene.canvas.height * 4);
						gl.readPixels(0, 0, scene.canvas.width, scene.canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
						samples.push({ time: state.t, pixels });
						if (samples.length === 2) done();
					};
					try {
						await Promise.race([completed, sleep(5000).then(() => { throw new Error("scene-pixels: no second frame"); })]);
					} finally {
						scene.optics.draw = draw;
					}
					let changed = 0;
					for (let i = 0; i < samples[0].pixels.length; i++) if (Math.abs(samples[0].pixels[i] - samples[1].pixels[i]) > 2) changed++;
					await log(`scene-pixels phase=${scene.phase} changed-channels=${changed} canvas=${scene.canvas.width}x${scene.canvas.height}`);
					if (changed < 50) throw new Error("scene-pixels: image did not animate");
					break;
				}
				case "completion-race": {
					// Hold a real RPC answer: Enter must use the latest query, and a late apply must keep a newer draft.
					const engine = app.active.engine;
					const request = engine.request;
					const stage = step.stage ?? "suggestions";
					let release;
					const held = new Promise((resolve) => { release = resolve; });
					let waiting = false;
					let applied = false;
					engine.request = async function (command) {
						if (command.type === "apply_completion") applied = true;
						const answer = await request.call(this, command);
						if ((stage === "suggestions" && command.type === "complete" && command.text === "/session") || (stage === "apply" && command.type === "apply_completion")) {
							waiting = true;
							await held;
						}
						return answer;
					};
					const type = (text) => {
						input.focus();
						input.value = text;
						input.setSelectionRange(text.length, text.length);
						input.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: text.at(-1), bubbles: true }));
					};
					const until = async (ready) => {
						const deadline = performance.now() + 5000;
						while (!ready() && performance.now() < deadline) await sleep(20);
						if (!ready()) throw new Error("completion-race: RPC did not reach the test boundary");
					};
					try {
						type("/sessio");
						await until(() => app.completion.state?.text === "/sessio");
						type("/session");
						if (stage === "apply") await until(() => app.completion.state?.text === "/session");
						key(input, "Enter");
						await until(() => waiting);
						if (stage === "suggestions" && applied) throw new Error("completion-race: applied the stale list before the latest answer");
						if (stage === "apply") type("new draft");
						release();
						if (stage === "suggestions") await waitFor({ selector: ".panel.report .panel-title", text: "Session" });
						else {
							await sleep(100);
							if (input.value !== "new draft" || find(".panel.report") || find(".msg.user")) throw new Error("completion-race: a late answer changed or sent the new draft");
						}
					} finally {
						release();
						engine.request = request;
					}
					break;
				}
				case "type": {
					// The composer, or another field (the transcript search).
					const field = step.selector ? await waitFor({ selector: step.selector }) : input;
					field.focus();
					field.value = step.text;
					field.dispatchEvent(new Event("input", { bubbles: true }));
					break;
				}
				case "send":
					key(input, "Enter");
					break;
				case "key":
					key(step.selector ? await waitFor(step) : document.activeElement ?? document.body, step.key, step.mods);
					break;
				case "click":
					(await waitFor(step)).click();
					break;
				case "press": {
					// A real press of the pointer on an element, as the window's own listeners see it (pointerdown, then click).
					const el = await waitFor(step);
					const box = el.getBoundingClientRect();
					const at = { bubbles: true, cancelable: true, button: 0, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 };
					el.dispatchEvent(new PointerEvent("pointerdown", { ...at, pointerType: "mouse", isPrimary: true }));
					el.dispatchEvent(new MouseEvent("mouseup", at));
					el.dispatchEvent(new MouseEvent("click", at));
					break;
				}
				case "still-while-shown": {
					// Clicks `click`, then follows `selector` frame by frame for step.ms ms: it may move only once it no
					// longer shows (its opacity with its ancestors' under 0.02). The welcome rose above an opening panel
					// while it faded.
					const el = await waitFor(step);
					const shown = () => {
						let opacity = 1;
						for (let node = el; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
						return opacity;
					};
					const top = () => Math.round(el.getBoundingClientRect().top);
					const start = top();
					(await waitFor({ selector: step.click })).click();
					const until = performance.now() + (step.ms ?? 1000);
					let frames = 0;
					while (performance.now() < until) {
						await new Promise(requestAnimationFrame);
						frames++;
						const opacity = shown();
						if (top() !== start && opacity >= 0.02)
							throw new Error(`still-while-shown: moved ${top() - start}px at opacity ${opacity.toFixed(2)}, frame ${frames}`);
					}
					await log(`still-while-shown ${step.selector}: ${frames} frames, ends at opacity ${shown().toFixed(2)}`);
					break;
				}
				case "unasked-panel": {
					// A question on the surface that opened on its own (`owner`: agent or extension), as an extension's
					// select during a turn: the demo model cannot ask one there.
					const view = app.active;
					const panel = new Panel({ title: step.title, kind: "question unasked" });
					const entry = { panel, owner: step.owner ?? "agent", onDismiss: () => view.interactions.close(entry) };
					view.interactions.open(entry);
					break;
				}
				case "wide": {
					// The element is at least `min` px wide (a bar part sized by its share).
					const width = (await waitFor(step)).getBoundingClientRect().width;
					if (width < step.min) throw new Error(`wide ${step.selector}: ${Math.round(width)} px, under ${step.min}`);
					break;
				}
				case "apart": {
					// No visible element of `selector` covers `from` (a toast over an open panel), as painted: the
					// toasts follow the panel from a ResizeObserver, which runs after layout and before the paint.
					const target = await waitFor({ selector: step.from });
					await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
					const r = target.getBoundingClientRect();
					const over = [...document.querySelectorAll(step.selector)].filter((el) => {
						if (el.closest("[hidden]") || !el.getClientRects().length) return false;
						const b = el.getBoundingClientRect();
						return b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top;
					});
					if (over.length) throw new Error(`apart: ${over.length} ${step.selector} over ${step.from}: ${over.map((el) => el.textContent.slice(0, 40)).join(" | ")}`);
					break;
				}
				case "dblclick": {
					const el = await waitFor(step);
					el.click();
					el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
					break;
				}
				case "edit": {
					// Typed through the web view's own editing (execCommand), which also brings the caret into view as a
					// real key does: "\n" is the line break of Shift+Enter.
					input.focus();
					for (const char of step.text) document.execCommand("insertText", false, char);
					await sleep(step.wait ?? 100);
					break;
				}
				case "creep": {
					// Small steps up or down, about one a frame, as a touchpad or smooth scrolling sends them; then, after
					// `settle` ms, how far the view is from the end. `minGap`/`maxGap`: where it must be by then.
					const scroller = document.getElementById("scroller");
					// In tasks of their own, as input arrives: the scroll event of each comes before the frame's callbacks.
					for (let i = 0; i < (step.times ?? 20); i++) {
						scroller.scrollTop += step.px;
						await sleep(16);
					}
					await sleep(step.settle ?? 500);
					const gap = Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight);
					await log(`creep ${step.px}x${step.times ?? 20}: ${gap} px below the view, following ${app.stick}`);
					if (step.minGap !== undefined && gap < step.minGap) throw new Error(`creep: ${gap} px below the view, under ${step.minGap}: pulled back to the end`);
					if (step.maxGap !== undefined && gap > step.maxGap) throw new Error(`creep: ${gap} px below the view, over ${step.maxGap}: not following`);
					break;
				}
				case "scroll-by":
					// As the reader's wheel would: the transcript moved by `px` (negative: up).
					document.getElementById("scroller").scrollTop += step.px;
					await sleep(200);
					break;
				case "scroll-el": {
					// Any scrolled element (a dialog's body) put at `top` px.
					(await waitFor(step)).scrollTop = step.top;
					await sleep(200);
					break;
				}
				case "scrolled": {
					// An element still scrolled at least `min` px: a redraw did not send it back to its top.
					const el = await waitFor(step);
					await log(`scrolled ${step.selector}: ${Math.round(el.scrollTop)}`);
					if (el.scrollTop < step.min) throw new Error(`scrolled ${step.selector}: ${Math.round(el.scrollTop)} px, under ${step.min}`);
					break;
				}
				case "scrolls": {
					// Every scrolled element, and where the last message is (what a key moved).
					const scrolled = [document.scrollingElement, ...document.querySelectorAll("*")].filter(
						(el) => el && (el.scrollTop || el.scrollLeft),
					);
					const last = [...document.querySelectorAll(".msg")].at(-1)?.getBoundingClientRect();
					const scroller = document.getElementById("scroller");
					const gap = Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight);
					await log(
						`scrolls ${step.label ?? ""}: ${scrolled.map((el) => `${el.tagName.toLowerCase()}#${el.id}.${String(el.className).split(" ")[0]}=${Math.round(el.scrollTop)}`).join(" ") || "none"}; last message top ${last ? Math.round(last.top) : "-"}; ${gap} px below the view`,
					);
					if (step.maxGap !== undefined && gap > step.maxGap) throw new Error(`scrolls: ${gap} px of the transcript below the view, over ${step.maxGap}`);
					// The last message's place, for `sameAs` a later step: what the reader sees did not move.
					const top = last ? Math.round(last.top) : undefined;
					if (step.sameAs && driveMarks.get(step.sameAs) !== top) throw new Error(`scrolls: the last message moved from ${driveMarks.get(step.sameAs)} to ${top}`);
					if (step.mark) driveMarks.set(step.mark, top);
					break;
				}
				case "keys": {
					// Typed one character at a time, as from the keyboard: an input event per character.
					input.focus();
					for (const char of step.text) {
						const at = input.selectionStart;
						input.setRangeText(char, at, input.selectionEnd, "end");
						input.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: char, bubbles: true }));
						await sleep(step.delay ?? 0);
					}
					break;
				}
				case "paste": {
					// What a paste from the file manager (uris) or of a copied image (a 1×1 PNG the engine's image
					// normalization accepts) puts on the clipboard.
					const data = new DataTransfer();
					if (step.uris) data.setData("text/uri-list", step.uris.join("\r\n"));
					if (step.image) {
						const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
						data.items.add(new File([png], "image.png", { type: "image/png" }));
					}
					input.focus();
					input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
					break;
				}
				case "drop":
					// What the host's drop event hands over for files dropped from the file manager.
					await invoke("drive_drop", { paths: step.paths });
					break;
				case "attach-refused": {
					// The page cannot attach a file the picker did not return nor a drop give, either way (attach.rs).
					const engine = app.active.engine.id;
					const line = JSON.stringify({ type: "attach_files", id: "drive-send", paths: [step.path] });
					for (const attempt of [
						() => invoke("attach_picked", { engine, id: "drive-attach", paths: [step.path] }),
						() => invoke("engine_send", { engine, line }),
					]) {
						const sent = await attempt().then(
							() => true,
							() => false,
						);
						if (sent) throw new Error(`attach-refused: ${step.path} was sent`);
					}
					log("attach-refused");
					break;
				}
				case "focus":
					(await waitFor(step)).focus();
					break;
				case "wait":
					await waitFor(step);
					break;
				case "sleep":
					await sleep(step.ms);
					break;
				case "pref": {
					// `inside`: the select within the element found (a settings row found by its text).
					const found = step.selector ? await waitFor(step) : document.getElementById(step.id);
					const select = step.inside ? found.querySelector(step.inside) : found;
					select.value = step.value;
					select.dispatchEvent(new Event("change", { bubbles: true }));
					break;
				}
				case "shot":
					await sleep(step.settle ?? 300);
					await invoke("drive_shot", { name: step.name });
					break;
				case "metrics": {
					const times = app.renderTimes.map(([ms]) => ms).sort((a, b) => a - b);
					const pick = (q) => times[Math.min(times.length - 1, Math.floor(q * times.length))] ?? 0;
					const memory = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null;
					await log(
						`metrics ${step.label ?? ""} ${JSON.stringify({
							renders: times.length,
							p50: +pick(0.5).toFixed(2),
							p95: +pick(0.95).toFixed(2),
							max: +(times.at(-1) ?? 0).toFixed(2),
							nodes: document.getElementsByTagName("*").length,
							heapMB: memory,
							viewport: `${window.innerWidth}x${window.innerHeight}`,
						})}`,
					);
					app.renderTimes.length = 0;
					break;
				}
				case "scene-shader":
					// Without the page's drawings: the site's shader draws both phases (the fallback, optics.js).
					app.scene.arts = {};
					app.scene.setPhase(app.scene.phase);
					break;
				case "scene-phase":
					// Shows a boot phase instead of the one drawn at random: 1 the eclipse, 4 the prism.
					app.scene.setPhase(step.phase);
					await log(`scene-phase ${step.phase} vector=${app.scene.isVector} running=${app.scene.running}`);
					break;
				case "scene-lose": {
					// Loses the scene's WebGL context, as the driver or the GPU process can.
					const { gl } = app.scene.optics ?? {};
					if (!gl) throw new Error("scene-lose: WebGL scene is not running");
					gl.getExtension("WEBGL_lose_context").loseContext();
					await log(`scene-lose losses=${app.scene.losses + 1}`);
					break;
				}
				case "scene-trace": {
					// Starts a background trace of the welcome scene, one line per change, for step.ms ms.
					const scene = document.getElementById("scene");
					const canvas = scene.querySelector("canvas");
					const scroller = document.getElementById("scroller");
					const until = performance.now() + (step.ms ?? 3000);
					const t0 = performance.now();
					let last = "";
					sceneTrace = [];
					const tick = () => {
						// The vector prism recedes by a transform, which is meant to move its box: its layout box then.
						const r = app.scene.isVector
							? { top: scene.offsetTop, height: scene.offsetHeight, width: scene.offsetWidth }
							: scene.getBoundingClientRect();
						const sample = {
							top: Math.round(r.top),
							height: Math.round(r.height),
							width: Math.round(r.width),
							opacity: Number(getComputedStyle(scene).opacity),
							canvas: `${canvas.width}x${canvas.height}`,
							running: app.scene.running,
							vector: app.scene.isVector,
							visible: app.scene.visible,
							still: scene.classList.contains("still"),
							losses: app.scene.losses,
						};
						sceneTrace.push(sample);
						const now = `top=${sample.top} h=${sample.height} w=${sample.width} opacity=${sample.opacity.toFixed(2)} canvas=${sample.canvas} scrollTop=${Math.round(scroller.scrollTop)} running=${sample.running} visible=${app.scene.visible} still=${sample.still} losses=${sample.losses}`;
						if (now !== last) log(`scene ${Math.round(performance.now() - t0)}ms ${now}`);
						last = now;
						if (performance.now() < until) requestAnimationFrame(tick);
					};
					requestAnimationFrame(tick);
					break;
				}
				case "timed": {
					// Sends `text` (or presses `key`), then follows the screen frame by frame until `selector` shows (or is
					// gone) and nothing has moved for `settle` ms (300): the delay before it shows, before it settles, how often
					// the layout moved on the way, what left the transcript, when it shrank or scrolled back, and the long frames.
					// With `smooth`, it fails if the transcript shrank or scrolled back, or does not end at its bottom.
					const t0 = performance.now();
					if (step.text !== undefined) {
						input.focus();
						input.value = step.text;
						input.dispatchEvent(new Event("input", { bubbles: true }));
						key(input, "Enter");
					} else key(step.at ? await waitFor({ selector: step.at }) : document.activeElement ?? document.body, step.key);
					const surface = document.getElementById("surface");
					const composer = document.getElementById("composer");
					const scroller = document.getElementById("scroller");
					let first, last, settled = t0, moved = 0, previous = t0, removed = 0, shrunk = 0, jumped = 0;
					let height = scroller.scrollHeight;
					let top = scroller.scrollTop;
					const long = [];
					const mutations = [];
					const observer = new MutationObserver((records) => {
						for (const record of records) {
							removed += record.removedNodes.length;
							if (!step.detail) continue;
							const name = (node) => `${node.nodeName.toLowerCase()}.${node.className ?? ""}`.slice(0, 40);
							for (const node of record.addedNodes) if (node.nodeType === 1) mutations.push(`+${name(node)}`);
							for (const node of record.removedNodes) if (node.nodeType === 1) mutations.push(`-${name(node)}`);
						}
					});
					observer.observe(scroller, { childList: true, subtree: true });
					while (performance.now() - t0 < (step.timeout ?? 8000)) {
						await new Promise(requestAnimationFrame);
						const now = performance.now();
						if (now - previous > 34) long.push(Math.round(now - previous));
						previous = now;
						const el = find(step.selector, step.match);
						if (first === undefined && (step.gone ? !el : el)) first = now - t0;
						const panel = surface.querySelector(":scope > .panel:not(.view-measure)");
						const shape = [surface, composer, scroller, panel].map((box) => (box ? Math.round(box.getBoundingClientRect().height) : 0));
						const state = `${shape} ${panel?.textContent.length ?? 0} ${scroller.scrollHeight}`;
						if (step.detail && state !== last) {
							const top = (selector) => Math.round(document.querySelector(selector)?.getBoundingClientRect().top ?? -1);
							await log(`  ${Math.round(now - t0)}ms ${state} top=${scroller.scrollTop | 0} composer@${top("#composer")} ${mutations.splice(0).filter((m) => !/^.(p|li|ul|ol|h\d|code|strong|em|pre|a|span)\./.test(m)).slice(0, 8)}`);
						}
						if (state !== last) {
							if (last !== undefined) moved++;
							last = state;
							settled = now;
						}
						if (scroller.scrollHeight < height) shrunk++;
						if (scroller.scrollTop < top) jumped++;
						height = scroller.scrollHeight;
						top = scroller.scrollTop;
						if (first !== undefined && now - settled > (step.settle ?? 300)) break;
					}
					observer.disconnect();
					const below = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
					if (step.smooth && (shrunk || jumped || below > 1)) throw new Error(`timed ${step.label}: shrunk=${shrunk} jumped=${jumped} below=${below}`);
					await log(
						`timed ${step.label ?? step.text ?? step.key} first=${first === undefined ? "never" : Math.round(first)} settled=${Math.round(settled - t0)} moved=${moved} removed=${removed} shrunk=${shrunk} jumped=${jumped} long=[${long}]`,
					);
					break;
				}
				case "census": {
					// For `ms` ms, what the page rebuilds (nodes removed) outside the transcript, by the region they belong to:
					// a list rebuilt for nothing loses its hover and focus for a frame. It can type `text` while it counts, and
					// fails if a region of `still` was rebuilt.
					const counts = {};
					const census = new MutationObserver((records) => {
						for (const record of records) {
							const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
							if (!target || target.closest("#scroller")) continue;
							const region = target.closest("[id]")?.id ?? "?";
							const entry = (counts[region] ??= { batches: 0, removed: 0, chars: 0, attrs: 0 });
							entry.batches++;
							if (record.type === "childList") entry.removed += record.removedNodes.length;
							else if (record.type === "characterData") entry.chars++;
							else entry.attrs++;
						}
					});
					census.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
					if (step.text !== undefined) {
						input.value = step.text;
						input.dispatchEvent(new Event("input", { bubbles: true }));
					}
					await sleep(step.ms ?? 3000);
					census.disconnect();
					await log(`census ${step.label ?? ""} ${JSON.stringify(counts)}`);
					const rebuilt = (step.still ?? []).filter((region) => counts[region]?.removed);
					if (rebuilt.length) throw new Error(`census ${step.label ?? ""}: rebuilt ${rebuilt.join(", ")}`);
					break;
				}
				case "surface-trace": {
					// Starts a background trace of the interaction surface, one line per change, for step.ms ms.
					const surface = document.getElementById("surface");
					const composer = document.getElementById("composer");
					const scroller = document.getElementById("scroller");
					const until = performance.now() + (step.ms ?? 3000);
					const t0 = performance.now();
					let last = "";
					const tick = () => {
						const panels = [...surface.querySelectorAll(":scope > .panel:not(.view-measure)")].map(
							(el) => `${el.className}@${Number(getComputedStyle(el).opacity).toFixed(2)}:${Math.round(el.getBoundingClientRect().height)}`,
						);
						const now = `panels=[${panels.join(" ")}] surface=${Math.round(surface.getBoundingClientRect().height)} composer=${composer.hidden ? "hidden" : Math.round(composer.getBoundingClientRect().height)} scroller=${Math.round(scroller.getBoundingClientRect().height)} opacity=${getComputedStyle(scroller).opacity}`;
						if (now !== last) log(`surface ${Math.round(performance.now() - t0)}ms ${now}`);
						last = now;
						if (performance.now() < until) requestAnimationFrame(tick);
					};
					requestAnimationFrame(tick);
					break;
				}
				case "scene-check": {
					// Over the last scene-trace: the scene never moved or changed size, and, when animated, it never stood
					// still while still showing. The vector prism stands still once the welcome goes (prism-scene.js).
					// step.running, when given, is what every sample must show.
					const first = sceneTrace[0];
					const bad = sceneTrace.find(
						(x) =>
							x.top !== first.top ||
							x.height !== first.height ||
							x.width !== first.width ||
							x.canvas !== first.canvas ||
							(step.animated && (x.vector ? x.visible : x.opacity > 0.02) && !x.running) ||
							(step.running !== undefined && x.running !== step.running),
					);
					if (!first) throw new Error("scene-check: no trace");
					if (bad) throw new Error(`scene-check: ${JSON.stringify(first)} then ${JSON.stringify(bad)}`);
					break;
				}
				case "stable": {
					// Layout stability: after step.settle ms, the boxes of every element matching each selector
					// keep their geometry for step.ms ms (no resize loop, no flicker), and their count stays the same.
					await sleep(step.settle ?? 500);
					const selectors = [].concat(step.selector);
					const read = () =>
						selectors
							.map((selector) =>
								[...document.querySelectorAll(selector)]
									.filter((el) => el.getClientRects().length)
									.map((el) => {
										const r = el.getBoundingClientRect();
										return `${selector}:${Math.round(r.top)},${Math.round(r.height)},${Math.round(r.width)}`;
									})
									.join("|"),
							)
							.join(" ");
					const first = read();
					const until = performance.now() + (step.ms ?? 2000);
					let changes = 0;
					let last = first;
					while (performance.now() < until) {
						await new Promise(requestAnimationFrame);
						const now = read();
						if (now !== last) {
							changes++;
							if (changes <= 5) await log(`stable change ${changes}: ${now}`);
						}
						last = now;
					}
					await log(`stable ${selectors.join(",")}: ${changes} changes`);
					if (changes) throw new Error(`stable: ${changes} geometry changes, first ${first}`);
					break;
				}
				case "count": {
					// How many visible elements match: an interaction is open once, never duplicated.
					const n = [...document.querySelectorAll(step.selector)].filter((el) => !el.closest("[hidden]") && el.getClientRects().length).length;
					if (step.min !== undefined ? n < step.min : n !== step.count)
						throw new Error(`count ${step.selector}: ${n}, not ${step.min !== undefined ? `at least ${step.min}` : step.count}`);
					break;
				}
				case "in-view": {
					// The element is fully visible inside its scrolling container (a list scrolled to its selection), or `within`.
					const el = await waitFor(step);
					const box = (step.within ? document.querySelector(step.within) : el.parentElement).getBoundingClientRect();
					const r = el.getBoundingClientRect();
					if (r.top < box.top - 1 || r.bottom > box.bottom + 1) throw new Error(`in-view: ${Math.round(r.top)}..${Math.round(r.bottom)} outside ${Math.round(box.top)}..${Math.round(box.bottom)}`);
					break;
				}
				case "second-screen": {
					// fork: a second screen on the conversation shown, as the phone on a session of the
					// window: another view of the same session file, which the host attaches to the engine already running
					// it. "joined": it arrives in the middle of a reply and must show what that reply holds so far.
					const first = app.active;
					secondScreen = new first.constructor(app, first.path, first.title, first.cwd);
					await secondScreen.open();
					if (secondScreen.engine.id === first.engine.id) throw new Error("second-screen: the same attachment, not a second one");
					if (step.joined) {
						if (!first.streaming) throw new Error("second-screen: the reply ended before the second screen opened");
						const partial = () => secondScreen.el.querySelector(".msg.assistant .thinking-body, .msg.assistant .text")?.textContent ?? "";
						const until = performance.now() + 3000;
						while (!partial() && performance.now() < until) await sleep(50);
						await log(`second-screen: joined with ${partial().length} characters of the reply`);
						if (!partial()) throw new Error("second-screen: nothing of the reply in progress is shown");
					}
					// "running": it arrives while a ! command runs and must show it, with this much of its output.
					if (step.running !== undefined && !secondScreen.bash?.output.includes(step.running))
						throw new Error(`second-screen: the command running shows ${JSON.stringify(secondScreen.bash?.output)}, not ${step.running}`);
					break;
				}
				case "second-screen-same": {
					// Both screens show the same conversation: nothing twice, nothing missing.
					await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
					const [first, second] = [transcriptLines(app.active), transcriptLines(secondScreen)];
					await log(`second-screen-same: ${first.length} and ${second.length} elements`);
					const at = first.findIndex((line, index) => line !== second[index]);
					if (first.length !== second.length || at >= 0)
						throw new Error(`second-screen-same: ${first.length} and ${second.length} elements, first difference at ${at}: ${JSON.stringify(first[at])} / ${JSON.stringify(second[at])}`);
					if (step.min !== undefined && first.length < step.min) throw new Error(`second-screen-same: ${first.length} elements, fewer than ${step.min}`);
					// And the same statuses, widgets and queue, which the second screen was not there to see set.
					const around = (view) => JSON.stringify({ statuses: [...view.statuses], widgets: [...view.widgets], queue: view.queue ?? [] });
					await log(`second-screen-same: ${app.active.statuses.size} statuses`);
					if (around(app.active) !== around(secondScreen)) throw new Error(`second-screen-same: ${around(app.active)} / ${around(secondScreen)}`);
					if (step.statuses !== undefined && secondScreen.statuses.size < step.statuses)
						throw new Error(`second-screen-same: ${secondScreen.statuses.size} statuses, fewer than ${step.statuses}`);
					break;
				}
				case "second-screen-close":
					await secondScreen.engine.stop();
					secondScreen = undefined;
					break;
				case "transcript-clean": {
					// The transcript holds conversation only: no trace of a question's lifecycle (titles of
					// closed questions, "Answered: …").
					const transcript = app.active?.el;
					const traces = [...(transcript?.querySelectorAll(".dialog, .dialog-outcome") ?? [])].filter((el) => !el.closest(".tool"));
					if (traces.length) throw new Error(`transcript-clean: ${traces.length} interaction traces: ${traces.map((el) => el.textContent).join(" | ")}`);
					break;
				}
				case "pointer":
					// A mouse move at a fraction of the window (x, y in 0..1).
					window.dispatchEvent(
						new PointerEvent("pointermove", {
							pointerType: "mouse",
							clientX: step.x * window.innerWidth,
							clientY: step.y * window.innerHeight,
							bubbles: true,
						}),
					);
					break;
				case "parallax": {
					// The scene's light follows the pointer: after step.ms, it moved toward step.x/step.y (-1..1).
					const before = [...app.scene.mouse];
					const vector = app.scene.isVector;
					// The shader's time is held for the two shots; the vector prism's motion is too slight to need it.
					const draw = vector ? null : app.scene.optics.draw;
					const moving = vector
						? document.querySelector(app.scene.container.dataset.art === "eclipse" ? "#scene .es-disc" : "#scene .ps-glass")
						: app.scene.canvas;
					if (step.shots && !vector) {
						app.scene.optics.draw = (state) => draw({ ...state, t: 20 });
						await sleep(100);
						await invoke("drive_shot", { name: `${step.shots}-before` });
					}
					if (step.shots && vector) await invoke("drive_shot", { name: `${step.shots}-before` });
					const box = moving.getBoundingClientRect();
					await sleep(step.ms ?? 1500);
					const moved = moving.getBoundingClientRect();
					if (step.shots) await invoke("drive_shot", { name: `${step.shots}-after` });
					if (draw) app.scene.optics.draw = draw;
					const after = app.scene.mouse;
					await log(`parallax ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
					const toward = (axis, goal) => Math.abs(goal - after[axis]) < Math.abs(goal - before[axis]) - 0.1;
					if (!toward(0, step.x) || !toward(1, step.y)) throw new Error("parallax: the light did not follow the pointer");
					if (Math.abs(moved.x - box.x) < 0.5 || Math.abs(moved.y - box.y) < 0.5) throw new Error("parallax: the scene did not move");
					break;
				}
				case "toasts":
					for (const el of document.querySelectorAll("#toasts .toast")) await log(`toast ${el.className}: ${el.textContent}`);
					break;
				case "timings":
					for (const view of app.sessions) await log(`timings ${step.label ?? ""} ${JSON.stringify(view.timing)}`);
					break;
				case "log":
					await log(step.text);
					break;
				case "copied": {
					// What the window copies, kept here instead of on the maintainer's clipboard (the window runs in their
					// session): the first such step starts keeping it, the next ones check it holds `text`.
					if (!window.__driveCopied) {
						window.__driveCopied = [];
						navigator.clipboard.writeText = async (text) => void window.__driveCopied.push(text);
						break;
					}
					const until = performance.now() + (step.timeout ?? 3000);
					while (!window.__driveCopied.at(-1)?.includes(step.text) && performance.now() < until) await sleep(50);
					const last = window.__driveCopied.at(-1);
					if (!last?.includes(step.text)) throw new Error(`copied: ${JSON.stringify(last)}`);
					if (step.absent && last.includes(step.absent)) throw new Error(`copied: ${JSON.stringify(last)} holds ${step.absent}`);
					break;
				}
				case "html": {
					// The markup of an element, for an investigation (what a blank line on screen is).
					const el = await waitFor(step);
					await log(`html ${step.selector}: ${el.outerHTML.slice(0, step.max ?? 4000)}`);
					break;
				}
				case "select": {
					// Selects everything inside an element, as a drag over it would, to see what is selectable.
					const el = await waitFor(step);
					window.getSelection().selectAllChildren(el);
					const range = window.getSelection().getRangeAt(0);
					for (const r of range.getClientRects()) await log(`selected ${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`);
					break;
				}
				case "at": {
					// The elements under a point of the window (px), topmost first.
					const names = document.elementsFromPoint(step.x, step.y).map((el) => `${el.tagName.toLowerCase()}#${el.id}.${String(el.className).replaceAll(" ", ".")}`);
					await log(`at ${step.x},${step.y}: ${names.join(" < ")}`);
					break;
				}
				case "listen-pointer": {
					// Real pointer events (moved from outside the window) during `ms`: how many, of which type, and
					// where the scene's light went.
					const seen = [];
					const record = (event) => seen.push(`${event.type}:${event.pointerType ?? "-"}:${event.isTrusted}`);
					for (const type of ["pointermove", "mousemove"]) window.addEventListener(type, record, { capture: true });
					const before = [...app.scene.mouse];
					await log("listening");
					await sleep(step.ms ?? 4000);
					for (const type of ["pointermove", "mousemove"]) window.removeEventListener(type, record, { capture: true });
					const counts = {};
					for (const kind of seen) counts[kind] = (counts[kind] ?? 0) + 1;
					await log(`pointer events ${JSON.stringify(counts)} light ${JSON.stringify(before)} -> ${JSON.stringify(app.scene.mouse)} target ${JSON.stringify(app.scene.target)}`);
					break;
				}
				case "boxes": {
					// The boxes of the elements under `selector` that take room: tag, class, size.
					const root = await waitFor(step);
					for (const el of [root, ...root.querySelectorAll("*")]) {
						const r = el.getBoundingClientRect();
						if (r.height > 0 && getComputedStyle(el).display !== "none")
							await log(`box ${el.tagName.toLowerCase()}#${el.id}.${String(el.className).replaceAll(" ", ".")} ${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}${step.metrics ? ` client=${el.clientWidth} scroll=${el.scrollWidth} padding=${getComputedStyle(el).paddingInline} gutter=${getComputedStyle(el).scrollbarGutter}` : ""}`);
					}
					break;
				}
				case "focused": {
					// The keyboard is where a user would expect it (inside the matching element).
					const el = await waitFor(step);
					const until = performance.now() + (step.timeout ?? 2000);
					while (!el.contains(document.activeElement) && performance.now() < until) await sleep(50);
					if (!el.contains(document.activeElement))
						throw new Error(`focus is on ${document.activeElement?.tagName}#${document.activeElement?.id ?? ""}`);
					break;
				}
				case "contrast": {
					// WCAG contrast of the deepest element holding `text` against the background behind it.
					const host = await waitFor(step);
					const holders = [...host.querySelectorAll("*")].filter((el) => el.textContent.includes(step.text));
					const el = holders.at(-1) ?? host;
					// Behind it: its ancestors' translucent backgrounds composed over the first opaque one (the page's
					// white canvas when none is), then the text's own colour over that. Images and filters are not counted.
					const layers = [];
					for (let node = el; node; node = node.parentElement) {
						const layer = rgba(getComputedStyle(node).backgroundColor);
						if (layer[3] > 0) layers.push(layer);
						if (layer[3] >= 1) break;
					}
					const back = layers.reduceRight((under, layer) => over(layer, under), [255, 255, 255, 1]);
					const ratio = contrast(over(rgba(getComputedStyle(el).color), back), back);
					await log(`contrast ${step.text}: ${ratio.toFixed(2)}`);
					if (ratio < (step.min ?? 4.5)) throw new Error(`contrast ${ratio.toFixed(2)} below ${step.min ?? 4.5}`);
					break;
				}
				case "viewport": {
					// The page's size in CSS pixels, kept as `mark`; within 2 px of `width`×`height` when given (a size kept across launches)
					// , or of the size marked `sameAs` divided by `scale` (the page's zoom).
					const marked = step.sameAs && driveMarks.get(step.sameAs);
					const width = marked ? marked[0] / (step.scale ?? 1) : step.width;
					const height = marked ? marked[1] / (step.scale ?? 1) : step.height;
					const until = performance.now() + (step.timeout ?? 3000);
					const off = () => (width && Math.abs(window.innerWidth - width) > 2) || (height && Math.abs(window.innerHeight - height) > 2);
					while (off() && performance.now() < until) await sleep(50);
					await log(`viewport ${window.innerWidth}x${window.innerHeight}`);
					if (off()) throw new Error(`viewport ${window.innerWidth}x${window.innerHeight}, not ${Math.round(width) || "any"}x${Math.round(height) || "any"}`);
					if (step.mark) driveMarks.set(step.mark, [window.innerWidth, window.innerHeight]);
					break;
				}
				case "size": {
					// The element's box within `maxHeight` (FIN-30: the settings' sections take little room) and `minWidth`.
					const box = (await waitFor(step)).getBoundingClientRect();
					await log(`size ${step.selector}: ${Math.round(box.width)}x${Math.round(box.height)}`);
					if (step.maxHeight && box.height > step.maxHeight) throw new Error(`size ${step.selector}: ${Math.round(box.height)} px tall, over ${step.maxHeight}`);
					if (step.minWidth && box.width < step.minWidth) throw new Error(`size ${step.selector}: ${Math.round(box.width)} px wide, under ${step.minWidth}`);
					break;
				}
				case "fits": {
					// Nothing is cut on the right: the content is no wider than the box that shows it.
					const el = await waitFor(step);
					if (el.scrollWidth > el.clientWidth + 1) throw new Error(`overflows: ${el.scrollWidth} > ${el.clientWidth}`);
					break;
				}
				case "style": {
					// A computed style of the element: a colour as the page paints it, or a variable's value.
					const el = await waitFor(step);
					const read = () => getComputedStyle(el).getPropertyValue(step.property).trim();
					const deadline = Date.now() + (step.timeout ?? 5000);
					while (read() !== step.value && Date.now() < deadline) await new Promise(requestAnimationFrame);
					// A state style (:focus) needs the window in front: say whether it was.
					if (read() !== step.value) throw new Error(`style ${step.property}: ${read()}, not ${step.value} (window focused: ${document.hasFocus()}, :focus ${el.matches(":focus")})`);
					break;
				}
				case "open-sessions": {
					// New conversations until `count` are open, each engine ready before the next one starts.
					// An empty conversation is reused by "New conversation" (lifecycle.js): each one counts as used.
					for (const view of app.sessions) view.firstMessage ??= "drive";
					while (document.querySelectorAll("#open-list li").length < step.count) {
						document.getElementById("new-session").click();
						await waitFor({ selector: "#composer[data-starting='true']" });
						await waitFor({ selector: "#composer[data-starting='false']", timeout: 60000 });
						// Started, not failed: an engine that exits at start also ends "starting".
						const view = app.active;
						if (!view?.ready || view.error || view.exit)
							throw new Error(`open-sessions: engine ${view?.error ?? (view?.exit ? "exited" : "not ready")}`);
						view.firstMessage ??= "drive";
					}
					break;
				}
				case "idle-ms":
					lifecycle.idleMs = step.ms;
					break;
				case "max-awake":
					lifecycle.maxAwake = step.count;
					break;
				case "reclaim":
					await app.reclaim();
					break;
				case "awake": {
					// How many conversations have a running engine, and how many sleep.
					const awake = app.sessions.filter((view) => view.engine.alive).length;
					const asleep = app.sessions.filter((view) => view.suspended).length;
					if ((step.awake !== undefined && awake !== step.awake) || (step.asleep !== undefined && asleep !== step.asleep))
						throw new Error(`awake: ${awake} awake, ${asleep} asleep; expected ${step.awake ?? "any"} and ${step.asleep ?? "any"}`);
					log(`awake ${awake} asleep ${asleep}`);
					break;
				}
				case "grant": {
					// Gives the nth conversation's engine a host allowed "in this session" (kept while it sleeps).
					const view = app.sessions[step.index];
					if (!view) throw new Error(`grant: no conversation ${step.index}`);
					await view.engine.request({ type: "perm_import", grants: { danger: [], hosts: [step.host] } });
					break;
				}
				case "granted": {
					// The nth conversation's engine still holds that host.
					// The window gives the grants back just after the woken engine is ready: allow it a moment.
					const view = app.sessions[step.index];
					let data;
					for (const until = performance.now() + 5000; performance.now() < until; await sleep(100)) {
						data = await view?.engine.request({ type: "perm_export" });
						if (data?.grants?.hosts?.includes(step.host)) break;
					}
					if (!data?.grants?.hosts?.includes(step.host))
						throw new Error(`granted: ${step.host} missing from ${JSON.stringify(data?.grants)}`);
					log(`granted ${step.host}`);
					break;
				}
				case "open-nth": {
					// Opens the nth open conversation of the sidebar and waits until its engine is ready.
					const view = app.sessions[step.index];
					if (!view) throw new Error(`open-nth: no conversation ${step.index}`);
					app.activate(view);
					const until = performance.now() + (step.timeout ?? 60000);
					while (!(view.ready && view.engine.alive) && performance.now() < until) await sleep(50);
					if (!view.ready || view.error || view.exit) throw new Error(`open-nth: ${view.error ?? "not ready"}`);
					break;
				}
				case "never-shown": {
					// Clicks `click`, then follows `selector` frame by frame for step.ms ms: it must not show, even for one
					// frame (closing a conversation flashed the "engine stopped" banner).
					(await waitFor({ selector: step.click })).click();
					const until = performance.now() + (step.ms ?? 1500);
					let frames = 0;
					while (performance.now() < until) {
						await new Promise(requestAnimationFrame);
						frames++;
						if (find(step.selector, step.text)) throw new Error(`never-shown: ${step.selector} shown at frame ${frames}`);
					}
					await log(`never-shown ${step.selector}: ${frames} frames`);
					break;
				}
				case "close-sessions": {
					// Closes the first open conversation until `keep` are left, each close finished before the next.
					for (let open = document.querySelectorAll("#open-list li").length; open > step.keep; open--) {
						(await waitFor({ selector: "#open-list li .close" })).click();
						await waitFor({ selector: `#open-list li:nth-child(${open})`, gone: true, timeout: 30000 });
					}
					break;
				}
				case "scroll-hold": {
					// Scrolls the transcript by `by` px as the reader does, then the view stays there for `ms` ms while
					// the reply grows (it jumped to the top of a long reply being written).
					const scroller = document.getElementById("scroller");
					scroller.scrollTop += step.by;
					await new Promise(requestAnimationFrame);
					const target = scroller.scrollTop;
					let worst = 0;
					const samples = [];
					const until = performance.now() + (step.ms ?? 1500);
					while (performance.now() < until) {
						await new Promise(requestAnimationFrame);
						const off = scroller.scrollTop - target;
						if (Math.abs(off) > Math.abs(worst)) worst = off;
						if (samples.length < 12 && Math.abs(off) > 4) samples.push(`${Math.round(off)}/${scroller.scrollHeight}/${app.stick}`);
					}
					await log(`scroll-hold ${step.by}: anchor=${getComputedStyle(scroller).overflowAnchor} at ${Math.round(target)} of ${scroller.scrollHeight}, worst ${Math.round(worst)} [${samples}]`);
					if (Math.abs(worst) > (step.tolerance ?? 4)) throw new Error(`scroll-hold ${step.by}: moved ${Math.round(worst)}px`);
					break;
				}
				case "at-top": {
					// The nth element matching the selector (or the first holding `text`) sits at the top of the transcript's view.
					// The transcript's entries are counted whether drawn or not (transcript-list.js); other elements in the page.
					const list = app.active?.list;
					const entries = list ? list.entries.filter((entry) => list.peek(entry, (el) => el.matches(step.selector))).map((entry) => entry.el ?? document.createElement("div")) : [];
					const matching = entries.length ? entries : [...document.querySelectorAll(step.selector)];
					const el = step.text === undefined ? matching[step.index ?? 0] : matching.find((candidate) => candidate.textContent.includes(step.text));
					const gap = el && el.getBoundingClientRect().top - document.getElementById("scroller").getBoundingClientRect().top;
					if (!el || Math.abs(gap) > 2) throw new Error(`at-top ${step.selector}[${step.text ?? step.index ?? 0}]: ${el ? `${gap}px` : "none"}`);
					break;
				}
				case "transcript-window": {
					// fork: only the entries around the view are in the page (transcript-list.js). How many
					// entries the conversation has, how many are drawn, and the transcript's nodes; at most `maxDrawn` drawn.
					const list = app.active.list;
					const nodes = app.active.el.getElementsByTagName("*").length;
					const drawn = list.shown().length;
					const kept = [...list.elements()].length;
					await log(`transcript-window ${step.label ?? ""} entries=${list.size} drawn=${drawn} kept=${kept} nodes=${nodes} page=${document.getElementsByTagName("*").length}`);
					if (step.minEntries !== undefined && list.size < step.minEntries) throw new Error(`transcript-window: ${list.size} entries, fewer than ${step.minEntries}`);
					if (step.maxDrawn !== undefined && drawn > step.maxDrawn) throw new Error(`transcript-window: ${drawn} entries drawn, over ${step.maxDrawn}`);
					if (step.maxKept !== undefined && kept > step.maxKept) throw new Error(`transcript-window: ${kept} entries kept, over ${step.maxKept}`);
					break;
				}
				case "view-hold": {
					// Scrolls the transcript by `by` px as the reader does, then the entry under the view's middle stays
					// where it is on screen for `ms` ms, whatever is drawn or dropped around it (transcript-list.js).
					const scroller = document.getElementById("scroller");
					scroller.scrollTop += step.by;
					await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
					const box = scroller.getBoundingClientRect();
					const el = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest(".transcript > *");
					if (!el) throw new Error("view-hold: no entry under the view's middle");
					const start = el.getBoundingClientRect().top;
					let worst = 0;
					const until = performance.now() + (step.ms ?? 1500);
					while (performance.now() < until) {
						await new Promise(requestAnimationFrame);
						if (!el.isConnected) throw new Error("view-hold: the entry under the view left the page");
						const off = el.getBoundingClientRect().top - start;
						if (Math.abs(off) > Math.abs(worst)) worst = off;
					}
					await log(`view-hold ${step.by}: ${el.className.split(" ").slice(0, 2).join(".")} moved at most ${Math.round(worst)} px`);
					if (Math.abs(worst) > (step.tolerance ?? 2)) throw new Error(`view-hold ${step.by}: moved ${Math.round(worst)}px`);
					break;
				}
				case "scroll-to": {
					// The transcript's view put at `top` px (0: its start; "end": its end), as a drag of the scroll bar would.
					const scroller = document.getElementById("scroller");
					scroller.scrollTop = step.top === "end" ? scroller.scrollHeight : step.top;
					await sleep(step.settle ?? 300);
					break;
				}
				case "highlight": {
					// How many ranges a CSS highlight (the transcript search) marks, and the current one's text.
					const until = performance.now() + 5000;
					const ranges = () => [...(CSS.highlights?.get(step.name) ?? [])];
					while (ranges().length !== step.count && performance.now() < until) await sleep(50);
					const found = ranges();
					if (found.length !== step.count) throw new Error(`highlight ${step.name}: ${found.length} ranges, not ${step.count}`);
					if (step.text && !found.every((range) => range.toString().toLowerCase() === step.text.toLowerCase()))
						throw new Error(`highlight ${step.name}: ${found.map(String).join(" | ")}`);
					break;
				}
				case "math": {
					// fork: the formulas KaTeX drew (math.js) in `selector` are laid out, which needs the styles
					// it sets on its nodes through the CSSOM: a fraction's numerator above its bar and its denominator under it,
					// a superscript raised, a matrix's rows one under the other, a root's sign over what it covers. Their colour
					// is the text's. The CSP refused nothing since the scenario started, though it does refuse a style
					// attribute (checked here on a probe), which KaTeX's HTML string would rely on.
					const root = await waitFor(step);
					// Its fonts first (font-display: block hides the glyphs until they load): any that failed is reported.
					await document.fonts.ready;
					const fonts = [...document.fonts].filter((font) => font.family.includes("KaTeX"));
					const fontsFailed = fonts.filter((font) => font.status === "error").map((font) => font.family);
					const fontsLoaded = fonts.filter((font) => font.status === "loaded").length;
					const box = (el) => el.getBoundingClientRect();
					const middle = (rect) => (rect.top + rect.bottom) / 2;
					const content = (row) => row.querySelector(":scope > :not(.pstrut)") ?? row;
					const counts = { fractions: 0, scripts: 0, matrices: 0, roots: 0 };
					for (const frac of root.querySelectorAll(".katex-html .mfrac")) {
						const rows = frac.querySelector(".vlist").children;
						const [under, bar, over] = [box(content(rows[0])), box(frac.querySelector(".frac-line")), box(content(rows[rows.length - 1]))];
						// Their boxes are line boxes, taller than the glyphs: their middles are compared with the bar.
						if (!(bar.height > 0 && middle(over) < bar.top && middle(under) > bar.bottom))
							throw new Error(`math: fraction not laid out (over ${over.top}-${over.bottom}, bar ${bar.top}-${bar.bottom}, under ${under.top}-${under.bottom})`);
						counts.fractions++;
					}
					for (const scripts of root.querySelectorAll(".katex-html .msupsub")) {
						// Rows from the bottom: a subscript and a superscript (x_i^2), or one of them, off the base's middle.
						const base = scripts.previousElementSibling;
						const rows = [...(scripts.querySelector(".vlist")?.children ?? [])].map((row) => box(content(row)));
						if (!base || !rows.length) continue;
						const placed = rows.length > 1 ? middle(rows.at(-1)) < middle(rows[0]) - 2 : Math.abs(middle(rows[0]) - middle(box(base))) > 2;
						if (!placed) throw new Error(`math: scripts not placed (${rows.map((rect) => `${rect.top}-${rect.bottom}`).join(", ")})`);
						counts.scripts++;
					}
					for (const table of root.querySelectorAll(".katex-html .mtable")) {
						for (const column of table.querySelectorAll(":scope > [class^='col-align']")) {
							const middles = [...column.querySelector(".vlist").children].map((row) => middle(box(content(row))));
							if (middles.some((y, i) => i > 0 && y <= middles[i - 1] + 2)) throw new Error(`math: matrix rows overlap (${middles.join(", ")})`);
						}
						counts.matrices++;
					}
					for (const sqrt of root.querySelectorAll(".katex-html .sqrt")) {
						const sign = sqrt.querySelector("svg");
						const covered = sqrt.querySelector(".vlist > span:first-child > :not(.pstrut)");
						if (!(sign && covered && box(sign).height > 0 && box(sign).width >= box(covered).width - 1))
							throw new Error(`math: root sign not drawn over its content`);
						counts.roots++;
					}
					for (const [kind, min] of Object.entries(step.min ?? {})) if (counts[kind] < min) throw new Error(`math: ${counts[kind]} ${kind}, fewer than ${min}`);
					const formula = root.querySelector(".katex");
					const text = formula?.closest(".md");
					if (formula && getComputedStyle(formula).color !== getComputedStyle(text).color)
						throw new Error(`math: colour ${getComputedStyle(formula).color}, not the text's ${getComputedStyle(text).color}`);
					const wide = [...root.querySelectorAll(".math-display")].filter((el) => el.scrollWidth > el.clientWidth + 1).length;
					if (step.wide && !wide) throw new Error("math: no display formula scrolls sideways");
					const before = refused.splice(0);
					const probe = document.createElement("span");
					document.body.append(probe);
					probe.setAttribute("style", "color: rgb(1, 2, 3)");
					const probeColor = getComputedStyle(probe).color;
					probe.remove();
					await sleep(50);
					const probeRefused = refused.splice(0).filter((line) => line.startsWith("style-src"));
					await log(`math ${JSON.stringify(counts)} fonts=${fontsLoaded}/${fonts.length} loaded, failed=${JSON.stringify(fontsFailed)} wide=${wide} colour=${formula ? getComputedStyle(formula).color : "-"} probe=${probeColor} probe-refused=${probeRefused.length} refused-before=${JSON.stringify(before)}`);
					if (probeColor === "rgb(1, 2, 3)") throw new Error("math: the CSP applied a style attribute; the probe proves nothing");
					if (before.length) throw new Error(`math: the CSP refused ${before.join("; ")}`);
					if (fontsFailed.length) throw new Error(`math: fonts not loaded: ${fontsFailed.join(", ")}`);
					break;
				}
				case "katex-loaded": {
					// Whether KaTeX's script and stylesheet are in the page (math.js adds them on the first formula only).
					const loaded = document.querySelectorAll("script[src*='katex'], link[href*='katex']").length;
					await log(`katex-loaded ${loaded}`);
					if ((loaded > 0) !== step.loaded) throw new Error(`katex-loaded: ${loaded} of its files in the page`);
					break;
				}
				case "absent":
					if (find(step.selector, step.text)) throw new Error(`present: ${step.selector} ${step.text ?? ""}`);
					break;
				case "title":
					if (document.title.includes(step.excludes)) throw new Error(`title is ${document.title}`);
					break;
				case "stamp":
					// Wall-clock times, for start-up measurements made by the calling script.
					await log(`stamp ${step.label ?? ""} navigation=${Math.round(performance.timeOrigin)} now=${Date.now()}`);
					break;
				case "views-audit": {
					// Every command the engine lists, plus `extra`, opened then dismissed: none may show a terminal view
					//. Each one logs the panels and toasts it showed. `skip`: commands with effects outside the window.
					const view = app.active;
					const skip = new Set(step.skip ?? []);
					const names = [...new Set([...view.commands.map((c) => c.name), ...(step.extra ?? [])])].filter((n) => !skip.has(n)).sort();
					await log(`views-audit commands ${names.join(" ")}`);
					const shown = (selector) => [...document.querySelectorAll(selector)].filter((el) => el.getClientRects().length);
					const failed = [];
					for (const name of names) {
						const before = document.querySelectorAll("#toasts .toast").length;
						const done = view.prompt(`/${name}`).catch((error) => `error ${error}`);
						await sleep(step.ms ?? 2500);
						const terminal = shown(".view .view-lines").length;
						const panels = shown(".panel:not(.closing)").map((p) => `${p.className.replace(/\s+/g, ".")}[${p.querySelector(".panel-title")?.textContent ?? ""}]`);
						const toasts = [...document.querySelectorAll("#toasts .toast")].slice(before).map((el) => el.textContent.slice(0, 80));
						// Widgets are logged, not refused: an extension may write plain lines there.
						const widgets = shown("#widgets .widget").map((el) => el.dataset.key);
						await log(`views-audit /${name} terminal=${terminal} panels=${JSON.stringify(panels)} toasts=${JSON.stringify(toasts)} widgets=${JSON.stringify(widgets)}`);
						if (terminal) failed.push(name);
						view.interactions.dismissAll();
						const end = await Promise.race([done.then(() => "done"), sleep(5000).then(() => "pending")]);
						if (end === "pending") await log(`views-audit /${name} still pending after dismiss`);
						view.interactions.dismissAll();
						for (const el of document.querySelectorAll("#toasts .toast")) el.remove();
						await sleep(400);
					}
					if (failed.length) throw new Error(`views-audit: terminal views in ${failed.map((n) => `/${n}`).join(", ")}`);
					break;
				}
				case "closes":
					// A step before this one closes the window (/quit sent from the composer): that close comes later
					// than the step, so the scenario waits for it here; still open after step.ms ms is a failure.
					await new Promise((resolve) => setTimeout(resolve, step.ms ?? 10000));
					throw new Error("the window is still open");
				case "quit":
					await log("done");
					await invoke("drive_quit");
					return;
				default:
					throw new Error(`unknown step ${step.do}`);
			}
		} catch (error) {
			await log(`FAIL step ${index} ${JSON.stringify(step)}: ${error.message}`);
			await invoke("drive_shot", { name: "fail" }).catch(() => {});
			// VAL-001: a failed scenario exits non-zero, whatever reads only the exit code.
			await invoke("drive_quit", { code: 1 });
			return;
		}
	}
	await log("FAIL scenario: no quit step");
	await invoke("drive_quit", { code: 1 });
}
