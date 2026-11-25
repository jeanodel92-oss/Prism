// the browser tool shows the user's browser the project's files, served by Prism
// behind a secret, and the servers of the session, relayed from its own loopback.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "../src/core/extensions/types.ts";
import browserExtension, { type BrowserDetails } from "../src/fork/browser/index.ts";
import { closeLocalPages, isLocalPage, localHint, localPage } from "../src/fork/browser/local-pages.ts";
import { findBwrap, removeSessionTmpDir, sessionTmpDir } from "../src/fork/sandbox/runtime.ts";
import { prepareSessionNet, sessionNetPrefix } from "../src/fork/sandbox/session-net.ts";
import { closeSessionPorts, RELAY_PROBE_MS, relaysTo, sessionPort } from "../src/fork/sandbox/session-ports.ts";
import { destinationName, TOOL_NETWORK_EVENT, type ToolNetworkRequest } from "../src/fork/sandbox/tool-network.ts";
import { setProtectedSearch } from "../src/fork/search-protected.ts";

const browser = vi.hoisted(() => ({ requests: [] as Array<{ action: string; args: Record<string, unknown> }> }));

vi.mock("../src/fork/browser/client.ts", async (importOriginal) => {
	const original = await importOriginal<Record<string, unknown>>();
	const host = {
		path: "/fake/browser.sock",
		info: { name: "Chromium", version: "1", extension: "0", realInput: true, stopped: false, pid: 1 },
		request: async (action: string, _session: string, args: Record<string, unknown>) => {
			browser.requests.push({ action, args });
			return { tab: 7, url: String(args.url ?? ""), title: "t" };
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

const project = mkdtempSync(join(tmpdir(), "prism-local-pages-"));
mkdirSync(join(project, "sub"));
writeFileSync(join(project, "index.html"), "<h1>home</h1>");
writeFileSync(join(project, "style.css"), "h1 { color: red }");
writeFileSync(join(project, ".env"), "KEY=secret");
writeFileSync(join(project, "sub", "page.html"), "<p>sub</p>");

afterAll(() => {
	closeLocalPages("pages");
	setProtectedSearch(undefined);
	rmSync(project, { recursive: true, force: true });
});

/** Follows the tool's URL as the browser does: its secret becomes a cookie of that port. */
async function enter(url: URL): Promise<string> {
	const first = await fetch(url, { redirect: "manual" });
	expect(first.status).toBe(303);
	expect(first.headers.get("location")).not.toContain("prism-preview");
	return (first.headers.get("set-cookie") ?? "").split(";")[0]!;
}

describe("fork: local pages for the browser", () => {
	it("serves a project file behind a secret kept in a cookie, and nothing to a request without it", async () => {
		const page = await localPage("pages", project, join(project, "index.html"));
		if (!page || "error" in page) throw new Error(JSON.stringify(page));
		expect(page.url.hostname).toBe("127.0.0.1");
		expect(isLocalPage("pages", page.url)).toBe(true);
		const cookie = await enter(page.url);

		const home = await fetch(new URL("/index.html", page.url), { headers: { cookie } });
		expect(home.status).toBe(200);
		expect(home.headers.get("content-type")).toContain("text/html");
		expect(await home.text()).toBe("<h1>home</h1>");
		// A root-relative link and a folder's index work as on a web server.
		const css = await fetch(new URL("/style.css", page.url), { headers: { cookie } });
		expect(css.headers.get("content-type")).toContain("text/css");
		expect((await fetch(new URL("/", page.url), { headers: { cookie } })).status).toBe(200);

		expect((await fetch(new URL("/style.css", page.url))).status).toBe(403);
		expect((await fetch(new URL("/style.css", page.url), { headers: { cookie: "prism_preview_1=x" } })).status).toBe(
			403,
		);
		// Out of the project by an encoded path: refused.
		const out = await fetch(new URL("/%2E%2E%2F%2E%2E%2Fetc%2Fhostname", page.url), { headers: { cookie } });
		expect(out.status).not.toBe(200);
	});

	it("takes a file:// URL or a relative path, and refuses files out of the project or protected", async () => {
		const byUrl = await localPage("pages", project, `${pathToFileURL(join(project, "sub", "page.html")).href}#top`);
		if (!byUrl || "error" in byUrl) throw new Error(JSON.stringify(byUrl));
		expect(byUrl.url.pathname).toBe("/sub/page.html");
		expect(byUrl.url.hash).toBe("#top");
		const relative = await localPage("pages", project, "sub/page.html");
		expect(relative && "url" in relative && relative.url.pathname).toBe("/sub/page.html");

		const outside = await localPage("pages", project, "/etc/hostname");
		expect(outside && "error" in outside && outside.error).toContain("project folder");

		setProtectedSearch(() => (file) => (file.endsWith(".env") ? "protected path (.env)" : undefined));
		const env = await localPage("pages", project, join(project, ".env"));
		expect(env && "error" in env && env.error).toContain("protected");
		const cookie = await enter(byUrl.url);
		expect((await fetch(new URL("/.env", byUrl.url), { headers: { cookie } })).status).toBe(403);
		setProtectedSearch(undefined);
	});

	it("leaves other URLs to the host rule, and says what to do about a port of this machine", async () => {
		expect(await localPage("pages", project, "https://example.org/")).toBeUndefined();
		expect(await localPage("pages", project, "http://localhost:5173/")).toBeUndefined(); // no session network
		expect(localHint("Refused.", new URL("http://localhost:5173/"))).toContain("No server started by this session");
		expect(localHint("Refused.", new URL("https://example.org/"))).toBe("Refused.");
	});
});

describe("fork: the browser tool opens local pages", () => {
	const asked: string[] = [];
	let tool: ToolDefinition;
	const events = createEventBus();
	// The rule refuses every host: a local page must not need it.
	events.on(TOOL_NETWORK_EVENT, (data) => {
		(data as ToolNetworkRequest).gate = {
			destination: async (url) => {
				asked.push(destinationName(url));
				return `Refused by Prism's network permissions: ${destinationName(url)} is not allowed. Nothing was sent.`;
			},
			provider: () => undefined,
			close: () => {},
		};
	});
	browserExtension({
		events,
		registerTool: (definition: ToolDefinition) => {
			tool = definition;
		},
		registerCommand: () => {},
		on: () => {},
	} as unknown as ExtensionAPI);

	const call = async (url: string): Promise<{ text: string; error?: boolean }> => {
		asked.length = 0;
		browser.requests.length = 0;
		const ctx = { cwd: project, sessionManager: { getSessionId: () => "tool" } } as unknown as ExtensionToolContext;
		const result = (await tool.execute(
			"call",
			{ action: "open", url },
			undefined,
			undefined,
			ctx,
		)) as AgentToolResult<BrowserDetails>;
		const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
		return { text, error: result.isError };
	};

	afterAll(() => closeLocalPages("tool"));

	it("opens a project file through Prism's server, without the host rule", async () => {
		const result = await call(join(project, "index.html"));
		expect(result.error).toBeFalsy();
		expect(asked).toEqual([]);
		const sent = new URL(String(browser.requests[0]?.args.url));
		expect(sent.hostname).toBe("127.0.0.1");
		expect(sent.pathname).toBe("/index.html");
		expect(sent.searchParams.get("prism-preview")).toMatch(/^[0-9a-f]{48}$/);
	});

	it("refuses a file out of the project before anything reaches the browser", async () => {
		const result = await call("file:///etc/hostname");
		expect(result.error).toBe(true);
		expect(result.text).toContain("project folder");
		expect(browser.requests).toEqual([]);
	});

	it("leaves a port with no server of the session to the host rule, and says how to show one", async () => {
		const result = await call("http://localhost:5173/");
		expect(asked).toEqual(["localhost:5173"]);
		expect(result.error).toBe(true);
		expect(result.text).toContain("No server started by this session listens on port 5173");
	});
});

const bwrap = findBwrap();

describe.skipIf(!bwrap)("fork: a session's servers relayed to the browser", () => {
	const children: ChildProcess[] = [];
	afterEach(() => {
		for (const child of children.splice(0)) child.kill();
	});

	async function freePort(): Promise<number> {
		const server = createServer();
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		const port = (server.address() as { port: number }).port;
		await new Promise((done) => server.close(done));
		return port;
	}

	/** A web server in the session's own network, as `npm run dev` started by a command would be. */
	async function serveInside(tmp: string, port: number, host: string, text: string): Promise<ChildProcess> {
		const prefix = sessionNetPrefix(tmp);
		const child = spawn(
			prefix[0]!,
			[
				...prefix.slice(1),
				process.execPath,
				"-e",
				`require("http").createServer((q, r) => r.end(${JSON.stringify(text)})).listen(${port}, ${JSON.stringify(host)}, () => console.log("up"))`,
			],
			{ stdio: ["ignore", "pipe", "inherit"] },
		);
		children.push(child);
		await new Promise<void>((done, failed) => {
			child.stdout!.once("data", () => done());
			child.once("exit", (code) => failed(new Error(`server exited ${code}`)));
		});
		return child;
	}

	it("relays a server of the session, on its own port when free, and only while it listens", async () => {
		const tmp = sessionTmpDir("relay-session");
		try {
			await prepareSessionNet(tmp, bwrap!);
			if (sessionNetPrefix(tmp).length === 0) return; // no nsenter here: nothing to relay
			const port = await freePort();
			// Not reachable from the machine before: it lives in the session's loopback.
			await serveInside(tmp, port, "127.0.0.1", "from the session");
			await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();

			const page = await localPage("relay-session", project, `http://localhost:${port}/app?x=1`);
			if (!page || "error" in page) throw new Error(JSON.stringify(page));
			// The relay listens on 127.0.0.1 only: `localhost` could reach a server of the machine on [::1].
			expect(page.url.hostname).toBe("127.0.0.1");
			expect(page.url.port).toBe(String(port));
			expect(page.url.search).toBe("?x=1");
			expect(isLocalPage("relay-session", page.url)).toBe(true);
			expect(isLocalPage("relay-session", new URL(`http://localhost:${port}/`))).toBe(false);
			expect(isLocalPage("relay-session", new URL(`http://[::1]:${port}/`))).toBe(false);
			expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("from the session");

			// IPv6 only, as Vite listens on some systems.
			const six = await freePort();
			await serveInside(tmp, six, "::1", "on ::1");
			const relayed = await sessionPort(tmp, six);
			expect(await (await fetch(`http://127.0.0.1:${relayed}/`)).text()).toBe("on ::1");

			expect(await sessionPort(tmp, await freePort())).toBeUndefined();

			closeSessionPorts(tmp);
			await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();

			// Two ports opened at once by a session with no relay yet, as parallel tool calls do: both relays are kept,
			// and closed with the session.
			const [a, b] = [await freePort(), await freePort()];
			await serveInside(tmp, a, "127.0.0.1", "a");
			const stopping = await serveInside(tmp, b, "127.0.0.1", "b");
			const [hostA, hostB] = await Promise.all([sessionPort(tmp, a), sessionPort(tmp, b)]);
			expect(relaysTo(tmp, hostA!) && relaysTo(tmp, hostB!)).toBe(true);

			// A server that stops frees its relay after two missed checks.
			stopping.kill();
			const deadline = Date.now() + 4 * RELAY_PROBE_MS;
			while (relaysTo(tmp, hostB!) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
			expect(relaysTo(tmp, hostB!)).toBe(false);
			expect(relaysTo(tmp, hostA!)).toBe(true);

			closeSessionPorts(tmp);
			expect(relaysTo(tmp, hostA!)).toBe(false);
		} finally {
			closeSessionPorts(tmp);
			removeSessionTmpDir("relay-session");
		}
	});
});
