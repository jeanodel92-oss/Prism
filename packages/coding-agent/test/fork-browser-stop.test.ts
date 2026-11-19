/**
 * fork: the user stops Prism's control from Chromium's debugging bar
 * while a click is under way. The click's next events reattached the debugger and were sent anyway. The extension's
 * real script runs here on a fake Chromium API; the stop arrives between two events of one click.
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

function fakeChromium() {
	const sent: string[] = [];
	const replies: Array<{ ok: boolean; code?: string }> = [];
	const onMessage = event();
	const onDetach = event();
	const attachedTabs = new Set<number>();
	const chrome = {
		runtime: {
			connectNative: () => ({
				onMessage,
				onDisconnect: event(),
				postMessage: (message: { type: string; ok: boolean; code?: string }) => {
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
			executeScript: async ({ func }: { func: { name: string } }) => [
				{ result: func.name === "locatePoint" ? { x: 10, y: 20 } : { ok: true } },
			],
		},
		debugger: {
			attach: async ({ tabId }: { tabId: number }) => {
				sent.push("attach");
				attachedTabs.add(tabId);
			},
			detach: async ({ tabId }: { tabId: number }) => {
				sent.push("detach");
				attachedTabs.delete(tabId);
			},
			sendCommand: async (_target: unknown, method: string, params: { type?: string }) => {
				sent.push(`${method}:${params.type}`);
				// The user presses Cancel on Chromium's debugging bar during the click's first event.
				if (params.type === "mouseMoved") {
					attachedTabs.clear();
					for (const listener of onDetach.listeners) listener({ tabId: 5 }, "canceled_by_user");
				}
				return {};
			},
			onDetach,
		},
	};
	const context = createContext({ chrome, navigator: {}, setTimeout, clearTimeout, console, URL });
	runInContext(readFileSync(join(browserExtensionDir(), "background.js"), "utf8"), context);
	const send = (message: object) => {
		for (const listener of onMessage.listeners) listener(message);
	};
	return { sent, replies, send, attachedTabs };
}

describe("fork: the browser extension's stop during an action", () => {
	it("sends none of a click's events after the user stopped control, and does not reattach", async () => {
		const browser = fakeChromium();
		browser.send({ id: 1, session: "s", cmd: "click", args: { tab: 5, x: 10, y: 20 } });
		await expect.poll(() => browser.replies.length, { timeout: 3000 }).toBe(1);
		expect(browser.replies[0]).toMatchObject({ ok: false, code: "stopped" });
		expect(browser.sent).toEqual(["attach", "Input.dispatchMouseEvent:mouseMoved"]);
		expect(browser.attachedTabs.size).toBe(0);
	});
});
