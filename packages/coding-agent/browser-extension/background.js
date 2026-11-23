// Prism browser extension: the agent's hands in the user's browser.
// One file for Chromium (service worker) and Firefox (background script). It talks only to Prism's
// native messaging host, and acts only on the tabs each Prism session opened itself.
"use strict";

const HOST = "space.odelserver.prism";
const api = globalThis.browser ?? globalThis.chrome;
const hasDebugger = typeof api.debugger?.attach === "function";
const STOPPED_MESSAGE =
	"The user stopped Prism's control of this browser. Ask them to run /browser resume in Prism if they want you to continue.";

/** Tab id -> the Prism session that opened it. */
const owners = new Map();
/** Prism session -> the tab it used last, the default target. */
const lastTab = new Map();
/** Prism session -> its tab group. */
const groups = new Map();
const attached = new Set();
/** Firefox with WebDriver BiDi (F2): tab id -> its BiDi browsing context, for real input through the host. */
const contexts = new Map();
let bidi = false;
const bidiWaiters = new Map();
let bidiSequence = 0;
let stopped = false;
let port;

const ready = (async () => {
	try {
		const saved = await api.storage.session.get(["owners", "stopped", "contexts"]);
		for (const [tab, session] of saved.owners ?? []) owners.set(tab, session);
		for (const [tab, context] of saved.contexts ?? []) contexts.set(tab, context);
		stopped = saved.stopped === true;
	} catch {
		// No session storage: start empty.
	}
})();

function save() {
	api.storage.session.set({ owners: [...owners], stopped, contexts: [...contexts] }).catch(() => {});
}

async function browserInfo() {
	if (api.runtime.getBrowserInfo) {
		const info = await api.runtime.getBrowserInfo();
		return { name: info.name, version: info.version };
	}
	const brands = navigator.userAgentData?.brands ?? [];
	const brand =
		brands.find((b) => !/not.a.brand|chromium/i.test(b.brand)) ?? brands.find((b) => /chromium/i.test(b.brand));
	return { name: brand?.brand ?? "Chromium", version: brand?.version ?? "" };
}

function connect() {
	if (port) return;
	try {
		port = api.runtime.connectNative(HOST);
	} catch {
		port = undefined;
		return;
	}
	const current = port;
	current.onMessage.addListener((message) => void handle(message));
	current.onDisconnect.addListener(() => {
		if (port !== current) return;
		port = undefined;
		bidi = false;
		for (const waiter of bidiWaiters.values()) waiter.reject(new Error("The host disconnected"));
		bidiWaiters.clear();
	});
	void (async () => {
		await ready;
		const info = await browserInfo();
		current.postMessage({
			type: "hello",
			...info,
			extension: api.runtime.getManifest().version,
			build: await prismBuild(),
			realInput: hasDebugger,
			stopped,
		});
	})();
}

/** The build of this copy, from the prism-build.json Prism wrote into it, so Prism says when it differs; empty without. */
async function prismBuild() {
	try {
		const value = await (await fetch(api.runtime.getURL("prism-build.json"))).json();
		return String(value.build ?? "");
	} catch {
		return "";
	}
}

function send(message) {
	try {
		port?.postMessage(message);
	} catch {
		// The host is gone; the reply is lost with it.
	}
}

function failure(code, message) {
	const error = new Error(message);
	error.code = code;
	return error;
}

/**
 * fork: the user's stop ends the action under way too, at its next step: a click or a
 * key sends several events, and the ones after the stop are not sent.
 */
function checkControl() {
	if (stopped) throw failure("stopped", STOPPED_MESSAGE);
}

/** A WebDriver BiDi command, run by the host on the Firefox it controls (F2). */
function bidiCall(method, params) {
	checkControl();
	const id = ++bidiSequence;
	return new Promise((resolve, reject) => {
		bidiWaiters.set(id, { resolve, reject });
		send({ type: "bidi", id, method, params });
	});
}

async function handle(message) {
	if (message?.type === "bidi") {
		bidi = message.available === true;
		return;
	}
	if (message?.type === "bidi-reply") {
		const waiter = bidiWaiters.get(message.id);
		bidiWaiters.delete(message.id);
		if (message.ok) waiter?.resolve(message.result);
		else waiter?.reject(failure("bidi", String(message.error)));
		return;
	}
	if (!message || typeof message.id !== "number") return;
	await ready;
	try {
		const result = await run(String(message.session ?? ""), message.cmd, message.args ?? {});
		send({ type: "reply", id: message.id, ok: true, result });
	} catch (error) {
		send({ type: "reply", id: message.id, ok: false, error: String(error?.message ?? error), code: error?.code });
	}
}

// ---------- Tabs ----------

function own(tab, session) {
	owners.set(tab, session);
	lastTab.set(session, tab);
	save();
}

function sessionTabs(session) {
	return [...owners].filter(([, owner]) => owner === session).map(([tab]) => tab);
}

function targetTab(session, args) {
	const tab = args.tab === undefined || args.tab === null ? lastTab.get(session) : Number(args.tab);
	if (tab === undefined) {
		const mine = sessionTabs(session);
		if (mine.length === 1) return mine[0];
		throw failure("no_tab", "No tab given and no current tab: open one with action open, or pass tab.");
	}
	if (owners.get(tab) !== session) {
		throw failure("not_yours", `Tab ${tab} was not opened by this session: use action tabs, or open a new one.`);
	}
	lastTab.set(session, tab);
	return tab;
}

async function tabInfo(tab) {
	const t = await api.tabs.get(tab);
	return { tab: t.id, url: t.url, title: t.title, loading: t.status !== "complete" };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until the tab has finished loading, or the timeout. */
async function settle(tab, timeout, leaveBlank = false) {
	const end = Date.now() + timeout;
	await sleep(50);
	while (Date.now() < end) {
		let t;
		try {
			t = await api.tabs.get(tab);
		} catch {
			return;
		}
		if (t.status === "complete" && (leaveBlank || (t.url && t.url !== "about:blank"))) return;
		await sleep(100);
	}
}

/** The agent's pointer in the page (showPointer): a visual aid only, so a page that refuses scripts goes without. */
async function pointer(tab, func, args) {
	try {
		await exec(tab, func, args);
	} catch {
		// Restricted page (browser pages, store, PDF viewer): no pointer drawn.
	}
}

/** The tab's viewport as PNG, in CSS pixels. */
async function capture(tab, view) {
	if (hasDebugger) {
		const params = { format: "png" };
		if (view.dpr !== 1) {
			params.clip = { x: view.scrollX, y: view.scrollY, width: view.width, height: view.height, scale: 1 / view.dpr };
		}
		const shot = await cdp(tab, "Page.captureScreenshot", params);
		return { tab, data: shot.data, mimeType: "image/png", width: view.width, height: view.height };
	}
	if (typeof api.tabs.captureTab !== "function") throw failure("unsupported", "This browser cannot capture a tab.");
	const url = await api.tabs.captureTab(tab, { format: "png", scale: 1 / view.dpr });
	return { tab, data: url.slice(url.indexOf(",") + 1), mimeType: "image/png", width: view.width, height: view.height };
}

/** The tab before a click or a key, so that afterInput tells a navigation the input started from a page still loading. */
async function beforeInput(tab) {
	const t = await api.tabs.get(tab).catch(() => undefined);
	return { url: t?.url, loading: t?.status === "loading" };
}

function documentParsed() {
	return document.readyState !== "loading";
}

/**
 * After a click or a key: a navigation it started gets time to finish. fork: a page that never
 * stops loading (ads, long polls) cost every click 10 s; a page that was loading already and stayed where it was is not
 * waited for, and a new page is ready once its document is parsed, whatever images or ads still load.
 */
async function afterInput(tab, before) {
	await sleep(300);
	const end = Date.now() + 10000;
	while (Date.now() < end) {
		const t = await api.tabs.get(tab).catch(() => undefined);
		if (t?.status !== "loading") return;
		if (before?.loading && (t.pendingUrl || t.url) === before.url) return;
		if (t.url !== before?.url && (await exec(tab, documentParsed).catch(() => false))) return;
		await sleep(100);
	}
}

async function group(session, tab) {
	if (typeof api.tabs.group !== "function") return;
	try {
		const known = groups.get(session);
		let groupId;
		try {
			groupId = await api.tabs.group(known === undefined ? { tabIds: [tab] } : { tabIds: [tab], groupId: known });
		} catch {
			groupId = await api.tabs.group({ tabIds: [tab] });
		}
		groups.set(session, groupId);
		// The group colours are a fixed browser palette: grey is the closest to Prism's near-achromatic chart (audit FIN-12).
		await api.tabGroups?.update(groupId, { title: "Prism", color: "grey" });
	} catch {
		// Tab groups are a visual aid only.
	}
}

// ---------- Page scripts (run in the extension's isolated world; self-contained) ----------

async function exec(tab, func, args = []) {
	checkControl();
	const [result] = await api.scripting.executeScript({ target: { tabId: tab }, func, args, injectImmediately: true });
	if (result?.error) throw new Error(String(result.error.message ?? result.error));
	const value = result?.result;
	if (value && typeof value === "object" && typeof value.error === "string") throw failure("page", value.error);
	return value;
}

function snapshotPage(maxText, maxElements, scope, onlyVisible) {
	const refs = new Map();
	/** ref -> {role, name, nth}: what finds the element again once the page rebuilt it. */
	const marks = new Map();
	globalThis.__prismRefs = refs;
	const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
	const selector = [
		"a[href]",
		"button",
		"input:not([type=hidden])",
		"select",
		"textarea",
		"summary",
		"[contenteditable='']",
		"[contenteditable='true']",
		"[onclick]",
		"[tabindex]:not([tabindex='-1'])",
		...[
			"button",
			"link",
			"checkbox",
			"radio",
			"tab",
			"menuitem",
			"option",
			"switch",
			"combobox",
			"textbox",
			"searchbox",
			"slider",
		].map((role) => `[role=${role}]`),
	].join(",");
	const shown = (el) => {
		const r = el.getBoundingClientRect();
		if (r.width < 1 || r.height < 1) return false;
		const style = getComputedStyle(el);
		return !(style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0);
	};
	const describe = (el) => {
		const tag = el.tagName.toLowerCase();
		const type = (el.getAttribute("type") || "").toLowerCase();
		const role =
			el.getAttribute("role") ||
			(tag === "a"
				? "link"
				: tag === "input"
					? type || "text"
					: tag === "textarea" || el.isContentEditable
						? "textbox"
						: tag);
		const name =
			clean(el.getAttribute("aria-label")) ||
			clean(el.labels?.[0]?.innerText) ||
			clean(el.innerText) ||
			clean(el.getAttribute("placeholder")) ||
			clean(el.getAttribute("title")) ||
			clean(el.getAttribute("alt")) ||
			clean(el.querySelector?.("img")?.getAttribute("alt")) ||
			(tag === "input" && (type === "submit" || type === "button") ? clean(el.value) : "");
		return { tag, type, role, name: name.slice(0, 100) };
	};
	const rootOf = () => (scope ? document.querySelector(scope) : document.body ?? document.documentElement);
	const root = rootOf();
	if (!root) return { error: `No element matches the scope ${scope}.` };
	/**
	 * fork: a page that rebuilds its buttons (a game turn, a list refresh) left every ref stale.
	 * A stale ref is found again by the role, name and rank it had among same-named elements, when it had a name.
	 */
	globalThis.__prismFind = (ref) => {
		const known = refs.get(ref)?.deref();
		if (known?.isConnected) return { el: known };
		const mark = marks.get(ref);
		const base = rootOf();
		if (!mark?.name || !base) return {};
		let rank = 0;
		for (const el of base.querySelectorAll(selector)) {
			if (!shown(el)) continue;
			const seen = describe(el);
			if (seen.role !== mark.role || seen.name !== mark.name) continue;
			if (rank++ !== mark.nth) continue;
			refs.set(ref, new WeakRef(el));
			return { el, refound: true };
		}
		return {};
	};
	const width = innerWidth;
	const height = innerHeight;
	const elements = [];
	const ranks = new Map();
	let total = 0;
	for (const el of root.querySelectorAll(selector)) {
		if (!shown(el)) continue;
		const r = el.getBoundingClientRect();
		const offscreen = r.bottom < 0 || r.top > height || r.right < 0 || r.left > width;
		if (onlyVisible && offscreen) continue;
		total++;
		if (elements.length >= maxElements) continue;
		const ref = `e${elements.length + 1}`;
		refs.set(ref, new WeakRef(el));
		const { tag, type, role, name } = describe(el);
		const key = `${role}\u0000${name}`;
		const nth = ranks.get(key) ?? 0;
		ranks.set(key, nth + 1);
		marks.set(ref, { role, name, nth });
		const item = { ref, role, name };
		if (tag === "input" || tag === "textarea") {
			if (type === "checkbox" || type === "radio") item.checked = el.checked;
			else if (type === "password") item.value = el.value ? "(hidden)" : "";
			else if (el.value) item.value = el.value.slice(0, 100);
		}
		if (tag === "select") item.value = clean(el.selectedOptions?.[0]?.text);
		if (tag === "a" && el.href) item.href = el.href.slice(0, 200);
		if (el.disabled || el.getAttribute("aria-disabled") === "true") item.disabled = true;
		if (offscreen) item.offscreen = true;
		elements.push(item);
	}
	const body = root.innerText ?? "";
	return {
		url: location.href,
		title: document.title,
		scope: scope || undefined,
		text: body.slice(0, maxText),
		textLength: body.length,
		elements,
		totalElements: total,
		viewport: {
			width,
			height,
			scrollY: Math.round(scrollY),
			scrollHeight: document.documentElement.scrollHeight,
		},
	};
}

function locatePoint(ref, x, y) {
	const describe = (el) => {
		const text = (el.innerText || el.value || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
		return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${text ? ` "${text.slice(0, 40)}"` : ""}`;
	};
	if (ref) {
		// The element this ref named, or the one the page rebuilt in its place (snapshotPage's __prismFind).
		const { el, refound } = (globalThis.__prismFind?.(ref) ?? { el: globalThis.__prismRefs?.get(ref)?.deref() });
		if (!el || !el.isConnected) return { error: `Unknown or stale ref ${ref}: take a new snapshot.` };
		el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
		const r = el.getBoundingClientRect();
		const px = Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1);
		const py = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1);
		const hit = document.elementFromPoint(px, py);
		const covered = hit && hit !== el && !el.contains(hit) && !hit.contains(el) ? describe(hit) : undefined;
		return { x: px, y: py, target: describe(el), covered, refound };
	}
	if (typeof x !== "number" || typeof y !== "number") return { error: "click needs ref, or x and y." };
	if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) {
		return { error: `(${x}, ${y}) is outside the viewport (${innerWidth} x ${innerHeight}).` };
	}
	const hit = document.elementFromPoint(x, y);
	return { x, y, target: hit ? describe(hit) : undefined };
}

function syntheticClick(ref, x, y, count) {
	const el = ref ? (globalThis.__prismFind?.(ref) ?? { el: globalThis.__prismRefs?.get(ref)?.deref() }).el : document.elementFromPoint(x, y);
	if (!el) return { error: "Nothing to click there." };
	const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0 };
	for (let i = 1; i <= count; i++) {
		el.dispatchEvent(new PointerEvent("pointerdown", { ...init, buttons: 1 }));
		el.dispatchEvent(new MouseEvent("mousedown", { ...init, buttons: 1, detail: i }));
		el.focus?.();
		el.dispatchEvent(new PointerEvent("pointerup", init));
		el.dispatchEvent(new MouseEvent("mouseup", { ...init, detail: i }));
		el.click();
	}
	if (count > 1) el.dispatchEvent(new MouseEvent("dblclick", init));
	return { ok: true };
}

function focusForTyping(ref, clear) {
	const el = ref ? (globalThis.__prismFind?.(ref) ?? { el: globalThis.__prismRefs?.get(ref)?.deref() }).el : document.activeElement;
	if (!el || !el.isConnected) return { error: ref ? `Unknown or stale ref ${ref}: take a new snapshot.` : "No focused element." };
	el.scrollIntoView({ block: "center", behavior: "instant" });
	if (el.tagName === "SELECT") {
		return { select: [...el.options].map((o) => o.text.trim()).slice(0, 50) };
	}
	el.focus();
	if (clear) {
		if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
			try {
				el.select();
			} catch {
				el.value = "";
			}
		} else if (el.isContentEditable) {
			const range = document.createRange();
			range.selectNodeContents(el);
			const selection = getSelection();
			selection.removeAllRanges();
			selection.addRange(range);
		}
	}
	return { editable: el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable };
}

function chooseOption(ref, value) {
	// fork: without ref, the focused select, as focusForTyping found it.
	const el = ref ? (globalThis.__prismFind?.(ref) ?? { el: globalThis.__prismRefs?.get(ref)?.deref() }).el : document.activeElement;
	if (!el || !el.isConnected) return { error: ref ? `Unknown or stale ref ${ref}: take a new snapshot.` : "No focused element." };
	if (el.tagName !== "SELECT") return { error: "The element is no longer a select: take a new snapshot." };
	const option = [...el.options].find((o) => o.value === value || o.text.trim() === value);
	if (!option) return { error: `No option "${value}". Options: ${[...el.options].map((o) => o.text.trim()).join(" | ")}` };
	el.value = option.value;
	el.dispatchEvent(new Event("input", { bubbles: true }));
	el.dispatchEvent(new Event("change", { bubbles: true }));
	return { chosen: option.text.trim() };
}

function insertTextSynthetic(text) {
	const el = document.activeElement;
	let ok = false;
	try {
		ok = document.execCommand("insertText", false, text);
	} catch {
		ok = false;
	}
	if (!ok && el && "value" in el) {
		const start = el.selectionStart ?? el.value.length;
		const end = el.selectionEnd ?? start;
		el.value = el.value.slice(0, start) + text + el.value.slice(end);
		el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
		el.dispatchEvent(new Event("change", { bubbles: true }));
		ok = true;
	}
	return ok ? { ok } : { error: "Could not type here: focus an editable element first." };
}

function syntheticKey(key, modifiers) {
	const el = document.activeElement || document.body;
	const init = {
		key,
		bubbles: true,
		cancelable: true,
		altKey: (modifiers & 1) !== 0,
		ctrlKey: (modifiers & 2) !== 0,
		metaKey: (modifiers & 4) !== 0,
		shiftKey: (modifiers & 8) !== 0,
	};
	const proceed = el.dispatchEvent(new KeyboardEvent("keydown", init));
	if (proceed && key === "Enter" && el.form && el.tagName === "INPUT") el.form.requestSubmit();
	el.dispatchEvent(new KeyboardEvent("keyup", init));
	return { ok: true };
}

function scrollPage(ref, dx, dy) {
	if (ref) {
		const el = (globalThis.__prismFind?.(ref) ?? { el: globalThis.__prismRefs?.get(ref)?.deref() }).el;
		if (!el?.isConnected) return { error: `Unknown or stale ref ${ref}: take a new snapshot.` };
		el.scrollIntoView({ block: "center", behavior: "instant" });
	} else {
		// "instant": a page that scrolls smoothly (CSS scroll-behavior) would only start moving, and look unscrollable.
		const by = { left: dx, top: dy, behavior: "instant" };
		const root = document.scrollingElement || document.documentElement;
		const before = root.scrollTop + root.scrollLeft;
		root.scrollBy(by);
		if (root.scrollTop + root.scrollLeft === before) {
			// The page itself does not scroll: scroll the container under the middle of the viewport.
			let node = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
			while (node && node !== root) {
				const style = getComputedStyle(node);
				if (/(auto|scroll)/.test(style.overflowY + style.overflowX) && node.scrollHeight > node.clientHeight) {
					node.scrollBy(by);
					break;
				}
				node = node.parentElement;
			}
		}
	}
	return { scrollY: Math.round(scrollY), scrollHeight: document.documentElement.scrollHeight, height: innerHeight };
}

function viewportInfo() {
	return { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scrollX, scrollY };
}

/**
 * Draws the agent's pointer in the page, so the user sees where the agent acts: at (x, y), or at the centre of `ref`
 * (or of the focused element). `click` adds a ripple. The pointer ignores the mouse (pointer-events: none), so hit
 * tests and real clicks go through it; it sits outside <body>, so snapshots never read it. Built with DOM and CSSOM
 * calls only (no markup, no <style>, no style attribute), which a page's CSP does not block.
 */
function showPointer(ref, x, y, click) {
	const css = (el, styles) => {
		for (const [name, value] of Object.entries(styles)) el.style.setProperty(name, value, "important");
		return el;
	};
	let pointer = globalThis.__prismPointer;
	if (!pointer?.host.isConnected) {
		const host = css(document.createElement("prism-agent-pointer"), {
			all: "initial",
			position: "fixed",
			left: "0",
			top: "0",
			width: "0",
			height: "0",
			"z-index": "2147483647",
			"pointer-events": "none",
			display: "block",
		});
		const root = host.attachShadow({ mode: "closed" });
		const mark = css(document.createElement("div"), {
			position: "fixed",
			left: "0",
			top: "0",
			"pointer-events": "none",
			transition: "transform 120ms ease-out",
		});
		const ripple = css(document.createElement("div"), {
			position: "absolute",
			left: "-14px",
			top: "-14px",
			width: "28px",
			height: "28px",
			"border-radius": "50%",
			border: "2px solid #f0f0ee",
			"box-sizing": "border-box",
			opacity: "0",
		});
		const ns = "http://www.w3.org/2000/svg";
		const svg = document.createElementNS(ns, "svg");
		for (const [name, value] of Object.entries({ width: "20", height: "24", viewBox: "0 0 20 24" })) {
			svg.setAttribute(name, value);
		}
		css(svg, { display: "block", filter: "drop-shadow(0 1px 2px rgba(0, 0, 0, .45))" });
		const arrow = document.createElementNS(ns, "path");
		for (const [name, value] of Object.entries({
			d: "M1.5 1.5 L1.5 19 L6 14.6 L9.2 22 L12.4 20.6 L9.3 13.4 L15.6 13.4 Z",
			// Prism's ink on a dark outline, not a Tailwind violet (audit FIN-12): visible on light and dark pages.
			fill: "#f0f0ee",
			stroke: "#050505",
			"stroke-width": "1.6",
			"stroke-linejoin": "round",
		})) {
			arrow.setAttribute(name, value);
		}
		svg.append(arrow);
		mark.append(ripple, svg);
		root.append(mark);
		document.documentElement.append(host);
		pointer = { host, mark, ripple };
		globalThis.__prismPointer = pointer;
	}
	if (typeof x !== "number" || typeof y !== "number") {
		const el = ref ? (globalThis.__prismFind?.(ref) ?? { el: globalThis.__prismRefs?.get(ref)?.deref() }).el : document.activeElement;
		if (!el || el === document.body || !el.isConnected) return { ok: true };
		const r = el.getBoundingClientRect();
		x = r.left + r.width / 2;
		y = r.top + r.height / 2;
	}
	pointer.mark.style.setProperty("transform", `translate(${Math.round(x)}px, ${Math.round(y)}px)`, "important");
	pointer.host.dataset.x = String(Math.round(x));
	pointer.host.dataset.y = String(Math.round(y));
	if (click) {
		pointer.ripple.animate(
			[
				{ transform: "scale(.3)", opacity: 1 },
				{ transform: "scale(1.4)", opacity: 0 },
			],
			{ duration: 500, easing: "ease-out" },
		);
	}
	return { ok: true };
}

/** Hides or shows the agent's pointer without moving it: screenshots leave it out, as they leave the system cursor out. */
function pointerVisible(visible) {
	globalThis.__prismPointer?.host.style.setProperty("visibility", visible ? "visible" : "hidden", "important");
	return { ok: true };
}

/** Whether the page shows `text` (null: any) and has an element matching `selector` (null: any). */
function pageHas(text, selector) {
	if (text !== null && !(document.body?.innerText ?? "").includes(text)) return false;
	if (selector !== null) {
		try {
			return document.querySelector(selector) !== null;
		} catch {
			return { error: `Not a CSS selector: ${selector}` };
		}
	}
	return true;
}

async function pageEvaluate(expression) {
	const page = window.wrappedJSObject;
	if (!page) return { error: "evaluate is not available here." };
	let value = page.eval(expression);
	if (value && typeof value.then === "function") value = await value;
	try {
		return { value: JSON.parse(JSON.stringify(value) ?? "null") };
	} catch {
		return { value: String(value) };
	}
}

// ---------- Real input (Chromium, chrome.debugger) ----------

async function attach(tab) {
	try {
		await api.debugger.attach({ tabId: tab }, "1.3");
	} catch (error) {
		if (!/already attached/i.test(String(error?.message ?? error))) throw error;
	}
	// Stopped while attaching: the debugger the user removed does not stay.
	if (stopped) {
		await api.debugger.detach({ tabId: tab }).catch(() => {});
		checkControl();
	}
	attached.add(tab);
}

async function cdp(tab, method, params = {}) {
	checkControl();
	if (!attached.has(tab)) await attach(tab);
	return api.debugger.sendCommand({ tabId: tab }, method, params);
}

/**
 * fork: Chromium answers a mouse move only at the tab's next frame, and a background tab (where
 * the agent's tabs open) has none for 5 s: every real click cost 5 s. The move is sent first and not waited for; the
 * press flushes it, so the page still sees move, press, release in order.
 */
async function realClick(tab, x, y, count) {
	checkControl();
	if (!attached.has(tab)) await attach(tab);
	const moved = cdp(tab, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y }).then(
		() => undefined,
		(error) => error,
	);
	for (let i = 1; i <= count; i++) {
		await cdp(tab, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: i });
		await cdp(tab, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: i });
	}
	const failed = await moved;
	if (failed) throw failed;
}

const NAMED_KEYS = {
	enter: ["Enter", "Enter", 13, "\r"],
	tab: ["Tab", "Tab", 9],
	escape: ["Escape", "Escape", 27],
	esc: ["Escape", "Escape", 27],
	backspace: ["Backspace", "Backspace", 8],
	delete: ["Delete", "Delete", 46],
	arrowup: ["ArrowUp", "ArrowUp", 38],
	arrowdown: ["ArrowDown", "ArrowDown", 40],
	arrowleft: ["ArrowLeft", "ArrowLeft", 37],
	arrowright: ["ArrowRight", "ArrowRight", 39],
	up: ["ArrowUp", "ArrowUp", 38],
	down: ["ArrowDown", "ArrowDown", 40],
	left: ["ArrowLeft", "ArrowLeft", 37],
	right: ["ArrowRight", "ArrowRight", 39],
	home: ["Home", "Home", 36],
	end: ["End", "End", 35],
	pageup: ["PageUp", "PageUp", 33],
	pagedown: ["PageDown", "PageDown", 34],
	space: [" ", "Space", 32, " "],
};
const MODIFIERS = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, super: 4, shift: 8 };
const EDIT_COMMANDS = { a: "selectAll", c: "copy", v: "paste", x: "cut", z: "undo" };

function parseKey(spec) {
	// fork: "+" is also the plus key, so "+" and "ctrl++" end with it.
	const text = String(spec);
	const plus = text === "+" || text.endsWith("++");
	const parts = (plus ? text.slice(0, -1) : text).split("+");
	const name = plus ? "+" : parts.pop() || "+";
	if (plus) parts.pop();
	let modifiers = 0;
	for (const part of parts) {
		const bit = MODIFIERS[part.toLowerCase()];
		if (!bit) throw failure("bad_key", `Unknown modifier "${part}" in "${spec}".`);
		modifiers |= bit;
	}
	const named = NAMED_KEYS[name.toLowerCase()];
	if (named) return { key: named[0], code: named[1], vk: named[2], text: named[3], modifiers };
	if ([...name].length !== 1) throw failure("bad_key", `Unknown key "${name}": use a single character or a key name like Enter.`);
	const upper = name.toUpperCase();
	const code = /[a-z]/i.test(name) ? `Key${upper}` : /\d/.test(name) ? `Digit${name}` : "";
	const vk = /[a-z\d]/i.test(name) ? upper.charCodeAt(0) : 0;
	return { key: name, code, vk, text: name, modifiers };
}

async function realKey(tab, parsed) {
	const typing = parsed.text !== undefined && (parsed.modifiers & 7) === 0;
	const command = (parsed.modifiers & 2) !== 0 ? EDIT_COMMANDS[parsed.key.toLowerCase()] : undefined;
	const base = {
		key: parsed.key,
		code: parsed.code,
		windowsVirtualKeyCode: parsed.vk,
		nativeVirtualKeyCode: parsed.vk,
		modifiers: parsed.modifiers,
	};
	await cdp(tab, "Input.dispatchKeyEvent", {
		...base,
		type: typing ? "keyDown" : "rawKeyDown",
		...(typing ? { text: parsed.text, unmodifiedText: parsed.text } : {}),
		...(command ? { commands: [command] } : {}),
	});
	await cdp(tab, "Input.dispatchKeyEvent", { ...base, type: "keyUp" });
}

// ---------- Real input (Firefox, WebDriver BiDi through the host, F2) ----------

const BIDI_KEYS = {
	Enter: "\uE007",
	Tab: "\uE004",
	Escape: "\uE00C",
	Backspace: "\uE003",
	Delete: "\uE017",
	ArrowLeft: "\uE012",
	ArrowUp: "\uE013",
	ArrowRight: "\uE014",
	ArrowDown: "\uE015",
	Home: "\uE011",
	End: "\uE010",
	PageUp: "\uE00E",
	PageDown: "\uE00F",
	" ": " ",
};
const BIDI_MODIFIERS = [
	[1, "\uE00A"],
	[2, "\uE009"],
	[4, "\uE03D"],
	[8, "\uE008"],
];

/** Whether this tab gets real input from BiDi. */
const bidiTab = (tab) => bidi && contexts.has(tab);

async function bidiClick(tab, x, y, count) {
	const actions = [{ type: "pointerMove", x: Math.round(x), y: Math.round(y) }];
	for (let i = 0; i < count; i++) actions.push({ type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 });
	await bidiCall("input.performActions", {
		context: contexts.get(tab),
		actions: [{ type: "pointer", id: "prism-mouse", parameters: { pointerType: "mouse" }, actions }],
	});
}

async function bidiKeys(tab, values, modifiers = 0) {
	const held = BIDI_MODIFIERS.filter(([bit]) => (modifiers & bit) !== 0).map(([, value]) => value);
	const actions = [
		...held.map((value) => ({ type: "keyDown", value })),
		...values.flatMap((value) => [
			{ type: "keyDown", value },
			{ type: "keyUp", value },
		]),
		...held.reverse().map((value) => ({ type: "keyUp", value })),
	];
	await bidiCall("input.performActions", { context: contexts.get(tab), actions: [{ type: "key", id: "prism-keys", actions }] });
}

/** Opens a tab whose BiDi context is known: first on a page of this extension with a unique mark, found in the tree. */
async function openBidiTab(url, active) {
	const mark = `prism-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const tab = await api.tabs.create({ url: `${api.runtime.getURL("blank.html")}#${mark}`, active });
	await settle(tab.id, 5000, true);
	try {
		const tree = await bidiCall("browsingContext.getTree", { maxDepth: 0 });
		const context = tree.contexts.find((entry) => String(entry.url).endsWith(`#${mark}`));
		if (context) contexts.set(tab.id, context.context);
	} catch {
		// Without the context, this tab gets input by script.
	}
	await api.tabs.update(tab.id, { url });
	// Wait until the tab has left this extension's page, so the caller waits for the real page.
	const end = Date.now() + 5000;
	while (Date.now() < end) {
		const current = await api.tabs.get(tab.id).catch(() => undefined);
		if (!current?.url?.includes(mark)) break;
		await sleep(50);
	}
	return tab;
}

if (hasDebugger) {
	api.debugger.onDetach.addListener((source, reason) => {
		if (source.tabId !== undefined) attached.delete(source.tabId);
		if (reason === "canceled_by_user") {
			stopped = true;
			save();
			send({ type: "event", event: "stopped" });
		}
	});
}

// ---------- Commands ----------

function checkUrl(url) {
	let parsed;
	try {
		parsed = new URL(String(url));
	} catch {
		throw failure("bad_url", `Not a URL: ${url}`);
	}
	if (!["http:", "https:"].includes(parsed.protocol) && parsed.href !== "about:blank") {
		throw failure("bad_url", "Only http, https and about:blank pages can be opened.");
	}
	return parsed.href;
}

async function run(session, cmd, args) {
	switch (cmd) {
		case "ping":
			return { ...(await browserInfo()), realInput: hasDebugger || bidi, stopped };
		case "resume":
			stopped = false;
			save();
			return { stopped };
		case "release":
			for (const tab of sessionTabs(session)) {
				if (attached.delete(tab)) await api.debugger.detach({ tabId: tab }).catch(() => {});
			}
			return { released: true };
	}
	checkControl();
	switch (cmd) {
		case "open": {
			const url = checkUrl(args.url ?? "about:blank");
			const tab = bidi ? await openBidiTab(url, args.active === true) : await api.tabs.create({ url, active: args.active === true });
			own(tab.id, session);
			await group(session, tab.id);
			await settle(tab.id, 30000, url === "about:blank");
			return tabInfo(tab.id);
		}
		case "tabs":
			return { tabs: await Promise.all(sessionTabs(session).map(tabInfo)), current: lastTab.get(session) };
		case "navigate": {
			const tab = targetTab(session, args);
			await api.tabs.update(tab, { url: checkUrl(args.url) });
			await settle(tab, 30000);
			return tabInfo(tab);
		}
		case "back": {
			const tab = targetTab(session, args);
			const before = await beforeInput(tab);
			await api.tabs.goBack(tab);
			await afterInput(tab, before);
			return tabInfo(tab);
		}
		case "close": {
			const tab = targetTab(session, args);
			await api.tabs.remove(tab);
			owners.delete(tab);
			if (lastTab.get(session) === tab) lastTab.delete(session);
			save();
			return { closed: tab };
		}
		case "snapshot": {
			const tab = targetTab(session, args);
			const maxText = Math.min(Math.max(Number(args.maxText) || 8000, 0), 50000);
			const scope = args.scope ? String(args.scope) : null;
			return { tab, ...(await exec(tab, snapshotPage, [maxText, 300, scope, args.visible === true])) };
		}
		case "click": {
			const tab = targetTab(session, args);
			const count = args.double ? 2 : 1;
			const point = await exec(tab, locatePoint, [args.ref ?? null, args.x ?? null, args.y ?? null]);
			const real = hasDebugger || bidiTab(tab);
			const before = await beforeInput(tab);
			await pointer(tab, showPointer, [null, point.x, point.y, true]);
			if (hasDebugger) await realClick(tab, point.x, point.y, count);
			else if (real) await bidiClick(tab, point.x, point.y, count);
			else await exec(tab, syntheticClick, [args.ref ?? null, point.x, point.y, count]);
			await afterInput(tab, before);
			// A click that loaded another page took the pointer with the old one: it stays where it clicked.
			await pointer(tab, showPointer, [null, point.x, point.y, false]);
			return { ...(await tabInfo(tab)), clicked: point, real };
		}
		case "type": {
			const tab = targetTab(session, args);
			const focus = await exec(tab, focusForTyping, [args.ref ?? null, args.clear === true]);
			await pointer(tab, showPointer, [args.ref ?? null, null, null, false]);
			let real = hasDebugger || bidiTab(tab);
			if (focus.select) {
				const chosen = await exec(tab, chooseOption, [args.ref ?? null, String(args.text ?? "")]);
				return { ...(await tabInfo(tab)), ...chosen, real: false };
			}
			const text = String(args.text ?? "");
			if (text) {
				if (hasDebugger) await cdp(tab, "Input.insertText", { text });
				else if (real) await bidiKeys(tab, [...text]);
				else await exec(tab, insertTextSynthetic, [text]);
			}
			if (args.submit) {
				const before = await beforeInput(tab);
				const enter = parseKey("Enter");
				if (hasDebugger) await realKey(tab, enter);
				else if (real) await bidiKeys(tab, [BIDI_KEYS.Enter]);
				else {
					await exec(tab, syntheticKey, ["Enter", 0]);
					real = false;
				}
				await afterInput(tab, before);
			}
			return { ...(await tabInfo(tab)), typed: text.length, real };
		}
		case "key": {
			const tab = targetTab(session, args);
			const parsed = parseKey(args.key);
			const real = hasDebugger || bidiTab(tab);
			const before = await beforeInput(tab);
			if (hasDebugger) await realKey(tab, parsed);
			else if (real) await bidiKeys(tab, [BIDI_KEYS[parsed.key] ?? parsed.key], parsed.modifiers);
			else await exec(tab, syntheticKey, [parsed.key, parsed.modifiers]);
			await afterInput(tab, before);
			return { ...(await tabInfo(tab)), real };
		}
		case "scroll": {
			const tab = targetTab(session, args);
			const dy = Number(args.dy ?? (args.ref ? 0 : 600));
			return { tab, ...(await exec(tab, scrollPage, [args.ref ?? null, Number(args.dx ?? 0), dy])) };
		}
		case "screenshot": {
			const tab = targetTab(session, args);
			const view = await exec(tab, viewportInfo);
			await pointer(tab, pointerVisible, [false]);
			try {
				return await capture(tab, view);
			} finally {
				await pointer(tab, pointerVisible, [true]);
			}
		}
		case "evaluate": {
			const tab = targetTab(session, args);
			const expression = String(args.expression ?? "");
			if (hasDebugger) {
				const result = await cdp(tab, "Runtime.evaluate", {
					expression,
					returnByValue: true,
					awaitPromise: true,
					userGesture: true,
				});
				if (result.exceptionDetails) {
					throw failure(
						"page",
						result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Exception",
					);
				}
				return { tab, value: result.result?.value ?? null, type: result.result?.type };
			}
			return { tab, ...(await exec(tab, pageEvaluate, [expression])) };
		}
		case "wait": {
			const tab = targetTab(session, args);
			const timeout = Math.min(Math.max(Number(args.timeout) || 10000, 0), 60000);
			if (args.text || args.selector) {
				// fork: text or an element to appear, or with gone, to disappear.
				const want = [args.text ? String(args.text) : null, args.selector ? String(args.selector) : null];
				const gone = args.gone === true;
				const start = Date.now();
				const end = start + timeout;
				while (Date.now() < end) {
					// A page between two documents has no answer yet; a bad selector is the caller's error.
					const present = await exec(tab, pageHas, want).catch((error) => {
						if (error.code === "page") throw error;
						return undefined;
					});
					if (present !== undefined && present !== gone) {
						return { ...(await tabInfo(tab)), found: true, gone, waited: Date.now() - start };
					}
					await sleep(250);
				}
				return { ...(await tabInfo(tab)), found: false, gone, waited: Date.now() - start };
			}
			await sleep(Math.min(Number(args.ms) || 1000, 30000));
			return tabInfo(tab);
		}
		default:
			throw failure("bad_command", `Unknown command ${cmd}`);
	}
}

api.tabs.onRemoved.addListener((tab) => {
	attached.delete(tab);
	contexts.delete(tab);
	if (owners.delete(tab)) save();
	for (const [session, last] of lastTab) if (last === tab) lastTab.delete(session);
});

api.alarms?.create("prism-connect", { periodInMinutes: 1 });
api.alarms?.onAlarm.addListener((alarm) => {
	if (alarm.name === "prism-connect") connect();
});
api.runtime.onStartup?.addListener(connect);
api.runtime.onInstalled?.addListener(connect);
connect();
