// the phone app's updates. Manual by default; in notify mode the
// app says at start, at most once an hour, that a newer version exists, and the download opens in the browser.
// Run by hand: node --test fork/gui/tests/android-update.test.mjs
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

const stored = new Map();
globalThis.localStorage = {
	getItem: (key) => (stored.has(key) ? stored.get(key) : null),
	setItem: (key, value) => stored.set(key, String(value)),
	removeItem: (key) => stored.delete(key),
};
const opened = [];
let latest = "";
let asked = 0;
globalThis.window = Object.assign(new EventTarget(), {
	__TAURI__: { core: { invoke: async () => {} } },
	PrismAndroid: {
		appVersion: () => "1.0.0-fork.11",
		// As MainActivity.kt: the answer comes later, as an event.
		checkLatest: () => {
			asked++;
			setTimeout(() => window.dispatchEvent(new CustomEvent("prism-latest", { detail: latest })), 1);
		},
		openUrl: (url) => opened.push(url),
	},
});

const { isNewer, latestRelease, startupUpdateCheck, updateMode } = await import("../ui/js/android-update.js");

beforeEach(() => {
	stored.clear();
	opened.length = 0;
	asked = 0;
	latest = "";
});

test("orders Prism versions as the site names them", () => {
	assert.equal(isNewer("1.0.0-fork.12", "1.0.0-fork.11"), true);
	assert.equal(isNewer("1.0.0-fork.10", "1.0.0-fork.9"), true);
	assert.equal(isNewer("1.0.0-fork.10.1", "1.0.0-fork.10"), true);
	assert.equal(isNewer("1.1.0-fork.1", "1.0.0-fork.12"), true);
	assert.equal(isNewer("1.0.0-fork.11", "1.0.0-fork.11"), false);
	assert.equal(isNewer("1.0.0-fork.9", "1.0.0-fork.10"), false);
});

test("reads the site's answer from the app, and undefined when it could not be reached", async () => {
	latest = "1.0.0-fork.12";
	assert.equal(await latestRelease(), "1.0.0-fork.12");
	latest = "";
	assert.equal(await latestRelease(), undefined);
});

test("asks the site nothing at start in manual mode, the default", async () => {
	latest = "1.0.0-fork.12";
	assert.equal(updateMode(), "manual");
	const shown = [];
	await startupUpdateCheck((text) => shown.push(text));
	assert.equal(asked, 0);
	assert.deepEqual(shown, []);
});

test("in notify mode, says a newer version once an hour and opens the download on request", async () => {
	stored.set("prism-update-mode", "notify");
	latest = "1.0.0-fork.12";
	const shown = [];
	await startupUpdateCheck((text, download) => shown.push([text, download]));
	assert.equal(shown.length, 1);
	assert.equal(shown[0][0], "Prism 1.0.0-fork.12 is available for the app.");
	shown[0][1]();
	assert.deepEqual(opened, ["https://prism.odelserver.space/releases/android/prism-android-arm64.apk"]);

	await startupUpdateCheck((text) => shown.push([text]));
	assert.equal(asked, 1);
	assert.equal(shown.length, 1);
});

test("in notify mode, says nothing when the app is up to date", async () => {
	stored.set("prism-update-mode", "notify");
	latest = "1.0.0-fork.11";
	const shown = [];
	await startupUpdateCheck((text) => shown.push(text));
	assert.equal(asked, 1);
	assert.deepEqual(shown, []);
});
