// Prism says when a browser runs the extension of another Prism
// version. The copy /browser setup writes carries the build of the extension Prism ships; the extension sends it.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { extensionMismatch } from "../src/fork/browser/index.ts";
import {
	browserExtensionDir,
	extensionBuild,
	shippedExtensionVersion,
	writeChromiumExtension,
	writeFirefoxExtension,
} from "../src/fork/browser/setup.ts";

let dir: string | undefined;
afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
});

function source(name: string, script: string): string {
	const path = join(dir!, name);
	mkdirSync(path, { recursive: true });
	writeFileSync(join(path, "manifest.json"), JSON.stringify({ version: "1", background: { scripts: ["b.js"] } }));
	writeFileSync(join(path, "b.js"), script);
	return path;
}

describe("fork: the extension's build", () => {
	it("changes with the extension's files, and each copy carries the build of its source", () => {
		dir = mkdtempSync(join(tmpdir(), "prism-ext-build-"));
		const one = source("one", "// one");
		const two = source("two", "// two");
		const same = source("same", "// one");
		expect(extensionBuild(one)).not.toBe(extensionBuild(two));
		expect(extensionBuild(same)).toBe(extensionBuild(one));
		const chromium = writeChromiumExtension(join(dir, "home"), two);
		expect(JSON.parse(readFileSync(join(chromium, "prism-build.json"), "utf8"))).toEqual({
			build: extensionBuild(two),
		});
		const firefox = writeFirefoxExtension(join(dir, "home"), two);
		expect(JSON.parse(readFileSync(join(firefox, "prism-build.json"), "utf8"))).toEqual({
			build: extensionBuild(two),
		});
		// The stamp is not part of what it stamps: a copy has the same build as its source.
		expect(extensionBuild(chromium)).toBe(extensionBuild(two));
	});

	it("tells a copy of another Prism from a store install of another version", () => {
		const shipped = { build: "abc", version: "0.1.1" };
		const differs = (build: string, extension: string) => extensionMismatch({ build, extension }, shipped);
		// A copy /browser setup wrote: its build decides, whatever its version.
		expect(differs("abc", "0.1.0")).toBeUndefined();
		expect(differs("old", "0.1.1")).toEqual({ kind: "copy" });
		// A store install (AMO, Chrome Web Store) has no build: its version decides.
		expect(differs("", "0.1.1")).toBeUndefined();
		expect(differs("", "0.1.0")).toEqual({ kind: "older", version: "0.1.0", expected: "0.1.1" });
		expect(differs("", "0.2.0")).toEqual({ kind: "newer", version: "0.2.0", expected: "0.1.1" });
	});

	// A store install is compared by its version only: any change to the extension must come with a new version, which
	// the stores then publish. When this fails, raise "version" in browser-extension/manifest.json and pin its build.
	it("has a new manifest version for each change to the extension", () => {
		const builds: Record<string, string> = { "0.1.1": "376631929278ef5e", "0.1.2": "2489e35faaa9812c" };
		expect({ version: shippedExtensionVersion(), build: extensionBuild() }).toEqual({
			version: shippedExtensionVersion(),
			build: builds[shippedExtensionVersion()],
		});
	});

	it("is sent by the extension in its hello, empty when its copy has none", async () => {
		const hello = async (file: unknown) => {
			const messages: Array<Record<string, unknown>> = [];
			const event = () => ({ addListener: () => {} });
			const chrome = {
				runtime: {
					connectNative: () => ({
						onMessage: event(),
						onDisconnect: event(),
						postMessage: (message: Record<string, unknown>) => messages.push(message),
					}),
					getManifest: () => ({ version: "0.1.0" }),
					getURL: (path: string) => `chrome-extension://id/${path}`,
					onStartup: event(),
					onInstalled: event(),
				},
				storage: { session: { get: async () => ({}), set: async () => {} } },
				tabs: { onRemoved: event() },
				debugger: { attach: async () => {}, onDetach: event() },
			};
			const fetch = async (url: string) => {
				if (url !== "chrome-extension://id/prism-build.json" || file === undefined) throw new Error("missing");
				return new Response(JSON.stringify(file));
			};
			const context = createContext({ chrome, fetch, navigator: {}, setTimeout, clearTimeout, console, URL });
			runInContext(readFileSync(join(browserExtensionDir(), "background.js"), "utf8"), context);
			await expect.poll(() => messages.find((message) => message.type === "hello")).toBeDefined();
			return messages.find((message) => message.type === "hello")!;
		};
		expect((await hello({ build: "abc123" })).build).toBe("abc123");
		expect((await hello(undefined)).build).toBe("");
	});
});
