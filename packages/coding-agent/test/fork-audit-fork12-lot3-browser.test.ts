// fork: the browser module.
// AS-025: the extension copies /browser setup writes in ~/Prism, the window's folder when it opens in the home folder,
// are read-only for sandboxed commands; a browser runs them outside the sandbox.
// AS-034: a page the agent opens that redirects to a host the rule would have asked about (a port of this machine)
// gets the question; refused, the tab is closed before it is read.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "../src/core/extensions/types.ts";
import browserExtension, { type BrowserDetails } from "../src/fork/browser/index.ts";
import { extensionCopies, writeChromiumExtension, writeFirefoxExtension } from "../src/fork/browser/setup.ts";
import { realPath } from "../src/fork/real-path.ts";
import { buildLayout, bwrapArgs, DEFAULT_SANDBOX_SETTINGS, prepareLayout } from "../src/fork/sandbox/layout.ts";
import { findBwrap } from "../src/fork/sandbox/runtime.ts";
import { destinationName, TOOL_NETWORK_EVENT, type ToolNetworkRequest } from "../src/fork/sandbox/tool-network.ts";

const browser = vi.hoisted(() => ({
	requests: [] as Array<{ action: string; args: Record<string, unknown> }>,
	/** The URL the tab ends on after open or navigate. */
	final: "",
}));

vi.mock("../src/fork/browser/client.ts", async (importOriginal) => {
	const original = await importOriginal<Record<string, unknown>>();
	const host = {
		path: "/fake/browser.sock",
		info: { name: "Chromium", version: "1", extension: "0", realInput: true, stopped: false, pid: 1 },
		request: async (action: string, _session: string, args: Record<string, unknown>) => {
			browser.requests.push({ action, args });
			if (action === "close") return { closed: args.tab };
			if (action === "snapshot") return { tab: 7, url: browser.final, title: "t", text: "LOCAL-SERVICE-CONTENT" };
			return { tab: 7, url: browser.final, title: "t" };
		},
	};
	class FakeHosts {
		async list() {
			return [host];
		}
		close() {}
	}
	return { ...original, BrowserHosts: FakeHosts };
});

describe("AS-025: the extension copies in ~/Prism are read-only for sandboxed commands", () => {
	let root: string;
	let home: string;
	let prism: string;

	beforeAll(() => {
		root = realPath(mkdtempSync(join(tmpdir(), "prism-lot3-extension-")));
		home = join(root, "home");
		prism = join(home, "Prism");
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		writeChromiumExtension(prism);
		writeFirefoxExtension(prism);
		writeFileSync(join(root, "unreadable"), "");
		chmodSync(join(root, "unreadable"), 0);
	});

	afterAll(() => rmSync(root, { recursive: true, force: true }));

	const layout = (cwd: string) =>
		buildLayout({ cwd, home, agentDir: join(home, ".pi", "agent"), settings: DEFAULT_SANDBOX_SETTINGS });

	it("protects both copies when the window works in ~/Prism, and not when it works elsewhere", () => {
		const copies = extensionCopies(home);
		expect(copies).toEqual([join(prism, "browser-extension"), join(prism, "browser-extension-firefox")]);
		expect(layout(prism).readOnly).toEqual(expect.arrayContaining(copies));
		expect(layout(prism).restrictions).toEqual([]);
		const elsewhere = join(home, "project");
		mkdirSync(elsewhere, { recursive: true });
		expect(layout(elsewhere).readOnly.filter((path) => copies.includes(path))).toEqual([]);
	});

	const bwrap = findBwrap();
	it.skipIf(!bwrap)("a command in ~/Prism cannot rewrite the Chromium copy's background script", () => {
		const plan = layout(prism);
		prepareLayout(plan);
		const script = join(prism, "browser-extension", "background.js");
		const before = readFileSync(script, "utf8");
		const isDirectory = (path: string) => {
			try {
				return statSync(path).isDirectory();
			} catch {
				return false;
			}
		};
		const result = spawnSync(
			bwrap!,
			[
				...bwrapArgs(plan, isDirectory, join(root, "unreadable")),
				"--",
				"sh",
				"-c",
				"echo ';stolen()' >> browser-extension/background.js; mv browser-extension moved; echo ok > written",
			],
			{ encoding: "utf8", timeout: 30_000 },
		);
		expect(result.status, result.stderr).toBe(0);
		// The rest of ~/Prism stays writable.
		expect(readFileSync(join(prism, "written"), "utf8")).toBe("ok\n");
		expect(readFileSync(script, "utf8")).toBe(before);
	});
});

describe("AS-034: a redirect from an opened page passes the host rule", () => {
	const asked: string[] = [];
	let tool: ToolDefinition;

	beforeAll(() => {
		const events = createEventBus();
		// The rule: the public site the agent asked for is allowed; anything else is refused.
		events.on(TOOL_NETWORK_EVENT, (data) => {
			const request = data as ToolNetworkRequest;
			request.gate = {
				destination: async (url) => {
					const name = destinationName(url);
					asked.push(name);
					return name === "public.example" || name === "other.example"
						? undefined
						: `Refused by Prism's network permissions: ${name} is not allowed. Nothing was sent.`;
				},
				provider: () => undefined,
				close: () => {},
			};
		});
		const pi = {
			events,
			registerTool: (definition: ToolDefinition) => {
				tool = definition;
			},
			registerCommand: () => {},
			on: () => {},
		} as unknown as ExtensionAPI;
		browserExtension(pi);
	});

	const call = async (action: string, url: string, final: string): Promise<AgentToolResult<BrowserDetails>> => {
		asked.length = 0;
		browser.requests.length = 0;
		browser.final = final;
		const ctx = { sessionManager: { getSessionId: () => "s" } } as unknown as ExtensionToolContext;
		return (await tool.execute(
			"call",
			{ action, url },
			undefined,
			undefined,
			ctx,
		)) as AgentToolResult<BrowserDetails>;
	};
	const text = (result: AgentToolResult<BrowserDetails>) =>
		result.content.map((part) => (part.type === "text" ? part.text : "")).join("");

	for (const action of ["open", "navigate"]) {
		it(`${action}: a redirect to a port of this machine is refused and the tab closed`, async () => {
			const result = await call(action, "https://public.example/go", "http://localhost:5432/");
			expect(asked).toEqual(["public.example", "localhost:5432"]);
			expect(result.isError).toBe(true);
			expect(text(result)).toContain("localhost:5432 is not allowed");
			expect(text(result)).toContain("closed the tab without reading it");
			expect(text(result)).not.toContain("Nothing was sent");
			expect(browser.requests.map((request) => request.action)).toEqual([action, "close"]);
			expect(browser.requests[1]?.args).toEqual({ tab: 7 });
		});
	}

	it("a page that stays on its host, or redirects to an allowed one, or ends on an error page, is not asked again", async () => {
		const same = await call("open", "https://public.example/go", "https://public.example/landing");
		expect(asked).toEqual(["public.example"]);
		expect(same.isError).toBeFalsy();
		const allowed = await call("navigate", "https://public.example/go", "https://other.example/");
		expect(asked).toEqual(["public.example", "other.example"]);
		expect(allowed.isError).toBeFalsy();
		const error = await call("open", "https://public.example/go", "chrome-error://chromewebdata/");
		expect(asked).toEqual(["public.example"]);
		expect(error.isError).toBeFalsy();
		expect(browser.requests.map((request) => request.action)).toEqual(["open"]);
	});
});
