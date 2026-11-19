// the phone app's updates. Two modes: manual (default: the app asks
// the site nothing until "Check for an update") and notify (at start, at most once an hour, it says when a newer
// version exists). No automatic install: Android asks the user to install an app downloaded outside a store anyway,
// and F-Droid does not take apps that download their own updates. The download opens in the phone's browser
// (android-app.js). The version and the site's answer come from the app (MainActivity.kt): the page itself may only
// talk to the app.

import { h } from "./dom.js";
import { t } from "./i18n.js";
import { openAndroidApp } from "./android-app.js";

const MODE_KEY = "prism-update-mode";
const CHECKED_KEY = "prism-update-checked";
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const ANSWER_TIMEOUT_MS = 12000;

/** Whether this page runs in the Android app with the update bridge. */
export function canCheckUpdates() {
	return typeof window.PrismAndroid?.checkLatest === "function";
}

export function updateMode() {
	try {
		return localStorage.getItem(MODE_KEY) === "notify" ? "notify" : "manual";
	} catch {
		return "manual";
	}
}

function setUpdateMode(mode) {
	try {
		if (mode === "notify") localStorage.setItem(MODE_KEY, "notify");
		else localStorage.removeItem(MODE_KEY);
	} catch {
		// Not kept: manual at the next start.
	}
}

/** The app's version, as the Prism release named it; "" when unknown. */
export function appVersion() {
	try {
		return window.PrismAndroid?.appVersion?.() ?? "";
	} catch {
		return "";
	}
}

/** The latest stable release on the site, or undefined when it could not be reached. */
export function latestRelease() {
	return new Promise((resolve) => {
		const done = (value) => {
			window.removeEventListener("prism-latest", listener);
			clearTimeout(timer);
			resolve(value || undefined);
		};
		const listener = (event) => done(event.detail);
		const timer = setTimeout(() => done(undefined), ANSWER_TIMEOUT_MS);
		window.addEventListener("prism-latest", listener);
		try {
			window.PrismAndroid.checkLatest();
		} catch {
			done(undefined);
		}
	});
}

/** Whether version `a` comes after `b`. */
export function isNewer(a, b) {
	const parse = (version) => {
		const [core, pre = ""] = version.split(/-(.*)/s);
		return { core: core.split(".").map(Number), pre: pre ? pre.split(".") : [] };
	};
	const x = parse(a);
	const y = parse(b);
	for (let i = 0; i < 3; i++) if ((x.core[i] ?? 0) !== (y.core[i] ?? 0)) return (x.core[i] ?? 0) > (y.core[i] ?? 0);
	// A release without a pre-release part comes after the same one with one.
	if (!x.pre.length || !y.pre.length) return !x.pre.length && y.pre.length > 0;
	for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
		const p = x.pre[i];
		const q = y.pre[i];
		if (p === undefined || q === undefined) return q === undefined;
		if (p === q) continue;
		const numeric = /^\d+$/.test(p) && /^\d+$/.test(q);
		return numeric ? Number(p) > Number(q) : p > q;
	}
	return false;
}

/** What the check found, as one sentence, and whether a download is offered. */
async function check() {
	const current = appVersion();
	const latest = await latestRelease();
	if (!latest) return { text: t("updateUnreachable"), newer: false };
	if (current && !isNewer(latest, current)) return { text: t("updateUpToDate", current), newer: false };
	return { text: t("updateAvailable", latest), newer: true };
}

/** The updates block of the phone's settings: the mode, and a check on request. */
export function updatePanel() {
	const status = h("p", { class: "pair-note", text: appVersion() ? t("updateVersion", appVersion()) : "" });
	const download = h("button", { type: "button", class: "primary", text: t("pairUpdateApp"), onclick: openAndroidApp });
	download.hidden = true;
	const mode = h(
		"select",
		{ class: "field", "aria-label": t("updateMode"), onchange: (event) => setUpdateMode(event.target.value) },
		h("option", { value: "manual", text: t("updateManual") }),
		h("option", { value: "notify", text: t("updateNotify") }),
	);
	mode.value = updateMode();
	const button = h("button", {
		type: "button",
		text: t("updateCheck"),
		onclick: async () => {
			button.disabled = true;
			status.textContent = t("updateChecking");
			const found = await check();
			status.textContent = found.text;
			download.hidden = !found.newer;
			button.disabled = false;
		},
	});
	return h(
		"div",
		{ class: "pair-update" },
		h("h3", { class: "pair-heading", text: t("updates") }),
		h("label", { class: "pair-note" }, h("span", { text: t("updateModeHelp") }), mode),
		status,
		h("div", { class: "pair-actions" }, button, download),
	);
}

/** At start in notify mode, at most once an hour: `show(text, download)` when a newer version exists. */
export async function startupUpdateCheck(show) {
	if (!canCheckUpdates() || updateMode() !== "notify") return;
	try {
		const last = Number(localStorage.getItem(CHECKED_KEY) ?? 0);
		if (Date.now() - last < CHECK_INTERVAL_MS) return;
		localStorage.setItem(CHECKED_KEY, String(Date.now()));
	} catch {
		return;
	}
	const found = await check();
	if (found.newer) show(found.text, openAndroidApp);
}
