// with no browser linked, the browser tool starts the browser /browser setup linked, on
// its usual profile, waits for its extension to link (about 20 s), then does the action. Without a browser set up it
// says what it said before. A script stands in for the browser; fake hosts for its extension.
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "../src/core/extensions/types.ts";
import browserExtension, {
	BROWSER_START,
	type BrowserDetails,
	PREFERRED_BROWSER_SETTING,
	SETUP_BROWSER_SETTING,
} from "../src/fork/browser/index.ts";
import type { FoundBrowser } from "../src/fork/browser/setup.ts";
import { saveGlobalSetting } from "../src/fork/global-settings.ts";

const root = mkdtempSync(join(tmpdir(), "prism-browser-start-"));
// Never the maintainer's settings: the module reads the global settings.json of this agent folder.
process.env.PRISM_CODING_AGENT_DIR = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = join(root, "agent");

const fake = vi.hoisted(() => ({
	/** Where the fake browser writes one line per start. */
	launches: "",
	/** Whether a started browser's extension links. */
	links: true,
	browsers: [] as FoundBrowser[],
	requests: [] as string[],
}));

vi.mock("../src/fork/browser/setup.ts", async (importOriginal) => {
	const original = await importOriginal<Record<string, unknown>>();
	return {
		...original,
		detectBrowsers: () => fake.browsers,
		isInstalledBrowser: () => true,
		browserCommand: () => [join(fake.launches, "..", "browser.sh")],
	};
});

vi.mock("../src/fork/browser/client.ts", async (importOriginal) => {
	const original = await importOriginal<Record<string, unknown>>();
	const host = {
		path: "/fake/browser.sock",
		info: { name: "Firefox", version: "1", extension: "0", realInput: false, stopped: false, pid: 1 },
		request: async (action: string) => {
			fake.requests.push(action);
			return { tabs: [], current: undefined };
		},
	};
	class FakeHosts {
		async list() {
			return fake.links && existsSync(fake.launches) ? [host] : [];
		}
		close() {}
	}
	return { ...original, BrowserHosts: FakeHosts };
});

fake.launches = join(root, "launches.txt");
const script = join(root, "browser.sh");
writeFileSync(script, `#!/bin/sh\necho "started $*" >> '${fake.launches}'\n`);
chmodSync(script, 0o755);

const FIREFOX: FoundBrowser = { name: "Firefox", family: "firefox", hostsDir: "/h/mozilla" };
const ZEN: FoundBrowser = { name: "Zen", family: "firefox", hostsDir: "/h/zen" };

let tool: ToolDefinition;
browserExtension({
	events: createEventBus(),
	registerTool: (definition: ToolDefinition) => {
		tool = definition;
	},
	registerCommand: () => {},
	on: () => {},
} as unknown as ExtensionAPI);

const ctx = { cwd: root, sessionManager: { getSessionId: () => "start" } } as unknown as ExtensionToolContext;

async function tabs(updates: string[] = []): Promise<{ text: string; error?: boolean }> {
	const result = (await tool.execute(
		"call",
		{ action: "tabs" },
		undefined,
		(partial) => updates.push(partial.content.map((part) => (part.type === "text" ? part.text : "")).join("")),
		ctx,
	)) as AgentToolResult<BrowserDetails>;
	return {
		text: result.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
		error: result.isError,
	};
}

const launches = async (): Promise<string[]> => {
	// The script runs detached: give it a moment to write.
	for (let waited = 0; waited < 2000 && !existsSync(fake.launches); waited += 20)
		await new Promise((resolve) => setTimeout(resolve, 20));
	return existsSync(fake.launches) ? readFileSync(fake.launches, "utf8").trim().split("\n") : [];
};

beforeEach(() => {
	rmSync(fake.launches, { force: true });
	rmSync(join(root, "agent"), { recursive: true, force: true });
	fake.links = true;
	fake.browsers = [FIREFOX, ZEN];
	fake.requests.length = 0;
	BROWSER_START.waitMs = 5_000;
	BROWSER_START.pollMs = 20;
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("fork: the browser tool starts the browser set up", () => {
	it("starts it once for calls made together, says so meanwhile, and does the action once it links", async () => {
		saveGlobalSetting([SETUP_BROWSER_SETTING], "Zen");
		saveGlobalSetting([PREFERRED_BROWSER_SETTING], "Firefox");
		const updates: string[] = [];
		const [first, second] = await Promise.all([tabs(updates), tabs()]);
		expect(first.error).toBeFalsy();
		expect(second.error).toBeFalsy();
		expect(first.text).toBe("No tabs open by this session. Use action open.");
		// The browser the setup found (Zen), not the name its extension gives (Firefox); on its usual profile.
		expect(await launches()).toEqual(["started"]);
		expect(updates).toEqual([
			"No browser was linked: Prism is starting Zen and waiting for its Prism extension to connect…",
		]);
		expect(fake.requests).toEqual(["tabs", "tabs"]);

		// Linked now: nothing is started again.
		await tabs();
		expect(await launches()).toEqual(["started"]);
	});

	it("takes a setup made before, which kept only the extension's name, when it names one browser", async () => {
		saveGlobalSetting([PREFERRED_BROWSER_SETTING], "Firefox");
		const updates: string[] = [];
		expect((await tabs(updates)).error).toBeFalsy();
		expect(updates[0]).toContain("starting Firefox");
		expect(await launches()).toEqual(["started"]);
	});

	it("says so when the extension does not link in time", async () => {
		saveGlobalSetting([SETUP_BROWSER_SETTING], "Firefox");
		fake.links = false;
		BROWSER_START.waitMs = 1000;
		const result = await tabs();
		expect(result.error).toBe(true);
		expect(result.text).toBe(
			"Prism started Firefox, but its Prism extension did not connect within 1 s. Do not retry: ask the user to check that the Prism extension is installed and turned on in Firefox (/browser setup checks it).",
		);
		expect(await launches()).toEqual(["started"]);
		expect(fake.requests).toEqual([]);
	});

	it("starts nothing when no browser was set up, or when the one set up is gone", async () => {
		const none = await tabs();
		expect(none.error).toBe(true);
		expect(none.text).toBe(
			"No browser is linked to Prism. Ask the user to run /browser setup in Prism and to add the Prism extension to their browser.",
		);
		saveGlobalSetting([SETUP_BROWSER_SETTING], "Zen");
		fake.browsers = [FIREFOX];
		expect((await tabs()).text).toContain("No browser is linked to Prism.");
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(existsSync(fake.launches)).toBe(false);
	});
});
