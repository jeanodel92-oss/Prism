/**
 * fork: `browser type` without ref types into the focused element, but on a
 * focused select it passed the missing ref on to chooseOption, which failed with "Unknown or stale ref undefined".
 * The extension's real script runs here on a fake Chromium API; its page functions run on a fake document.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { browserExtensionDir } from "../src/fork/browser/setup.ts";

type Listener = (...args: unknown[]) => void;
const event = () => {
	const listeners: Listener[] = [];
	return { listeners, addListener: (listener: Listener) => listeners.push(listener) };
};

interface Reply {
	ok: boolean;
	result?: { chosen?: string };
	error?: string;
}

function fakeSelect() {
	const events: string[] = [];
	return {
		events,
		tagName: "SELECT",
		isConnected: true,
		value: "r",
		options: [
			{ text: "Red", value: "r" },
			{ text: " Blue ", value: "b" },
		],
		scrollIntoView: () => {},
		dispatchEvent: (e: { type: string }) => events.push(e.type),
	};
}

function fakeChromium(focused: unknown) {
	const replies: Reply[] = [];
	const onMessage = event();
	const chrome = {
		runtime: {
			connectNative: () => ({
				onMessage,
				onDisconnect: event(),
				postMessage: (message: Reply & { type: string }) => {
					if (message.type === "reply") replies.push(message);
				},
			}),
			getManifest: () => ({ version: "0" }),
			onStartup: event(),
			onInstalled: event(),
		},
		storage: { session: { get: async () => ({ owners: [[5, "s"]] }), set: async () => {} } },
		tabs: {
			get: async (id: number) => ({ id, url: "https://example.test/", title: "t", status: "complete" }),
			onRemoved: event(),
		},
		scripting: {
			// The page functions that read the document run for real; the pointer drawing is skipped.
			executeScript: async ({ func, args }: { func: (...a: unknown[]) => unknown; args: unknown[] }) => [
				{ result: ["focusForTyping", "chooseOption"].includes(func.name) ? func(...args) : { ok: true } },
			],
		},
	};
	const context = createContext({
		chrome,
		navigator: {},
		document: { activeElement: focused },
		Event,
		setTimeout,
		clearTimeout,
		console,
		URL,
	});
	runInContext(readFileSync(join(browserExtensionDir(), "background.js"), "utf8"), context);
	const send = (message: object) => {
		for (const listener of onMessage.listeners) listener(message);
	};
	return { replies, send };
}

describe("fork: browser type on the focused select", () => {
	it("chooses the option of the focused select without ref", async () => {
		const select = fakeSelect();
		const browser = fakeChromium(select);
		browser.send({ id: 1, session: "s", cmd: "type", args: { tab: 5, text: "Blue" } });
		await expect.poll(() => browser.replies.length, { timeout: 3000 }).toBe(1);
		expect(browser.replies[0]).toMatchObject({ ok: true, result: { chosen: "Blue" } });
		expect(select.value).toBe("b");
		expect(select.events).toEqual(["input", "change"]);
	});

	it("says so when nothing has the focus", async () => {
		const browser = fakeChromium(null);
		browser.send({ id: 1, session: "s", cmd: "type", args: { tab: 5, text: "Blue" } });
		await expect.poll(() => browser.replies.length, { timeout: 3000 }).toBe(1);
		expect(browser.replies[0]).toMatchObject({ ok: false, error: "No focused element." });
	});
});
