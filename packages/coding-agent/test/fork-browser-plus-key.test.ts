/**
 * fork: the browser extension's key parser left an empty modifier when
 * the key was "+", so `key "+"` and `key "ctrl++"` failed with "Unknown modifier". The extension's real script runs
 * here on a stub Chromium API.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { browserExtensionDir } from "../src/fork/browser/setup.ts";

// Every property is a callable stub, so the script's start-up calls do nothing.
function stub(): unknown {
	return new Proxy(() => {}, {
		get: (_target, property) => (property === "then" ? undefined : stub()),
		apply: () => stub(),
	});
}

describe("fork: the browser extension's plus key", () => {
	it("parses the plus key alone and with modifiers", () => {
		const context = createContext({ chrome: stub(), navigator: {}, setTimeout, clearTimeout, console, URL });
		runInContext(readFileSync(join(browserExtensionDir(), "background.js"), "utf8"), context);
		const parseKey = context.parseKey as (spec: string) => { key: string; modifiers: number };
		expect(parseKey("+")).toMatchObject({ key: "+", modifiers: 0 });
		expect(parseKey("ctrl++")).toMatchObject({ key: "+", modifiers: 2 });
		expect(parseKey("ctrl+shift++")).toMatchObject({ key: "+", modifiers: 10 });
		expect(parseKey("ctrl+a")).toMatchObject({ key: "a", modifiers: 2 });
		expect(parseKey("ctrl+")).toMatchObject({ key: "+", modifiers: 2 });
		expect(() => parseKey("ctl++")).toThrow(/Unknown modifier/);
	});
});
