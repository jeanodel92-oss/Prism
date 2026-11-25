// in a session without a network namespace of its own, the
// browser tool opens `localhost:<port>` of a server a running background task started, where it listens on the
// machine's loopback, without the host rule and without a relay. A port served by anything else stays under the rule.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "../src/core/extensions/types.ts";
import type { BackgroundTask } from "../src/fork/background.ts";
import browserExtension, { type BrowserDetails } from "../src/fork/browser/index.ts";
import { closeLocalPages, isLocalPage, localPage } from "../src/fork/browser/local-pages.ts";
import { taskPort } from "../src/fork/browser/task-ports.ts";
import { removeSessionTmpDir, sessionTmpDir } from "../src/fork/sandbox/runtime.ts";
import { destinationName, TOOL_NETWORK_EVENT, type ToolNetworkRequest } from "../src/fork/sandbox/tool-network.ts";

const state = vi.hoisted(() => ({
	tasks: [] as BackgroundTask[],
	/** The session the tasks belong to; every session's when undefined. */
	owner: undefined as string | undefined,
	requests: [] as Array<{ action: string; args: Record<string, unknown> }>,
	/** The URL the fake browser says the tab ended on; the URL it was given when undefined. */
	landed: undefined as string | undefined,
}));

vi.mock("../src/fork/background.ts", async (importOriginal) => {
	const original = await importOriginal<Record<string, unknown>>();
	return {
		...original,
		sessionBackgroundTasks: (id: string) => (state.owner === undefined || state.owner === id ? state.tasks : []),
	};
});

vi.mock("../src/fork/browser/client.ts", async (importOriginal) => {
	const original = await importOriginal<Record<string, unknown>>();
	const host = {
		path: "/fake/browser.sock",
		info: { name: "Chromium", version: "1", extension: "0", realInput: true, stopped: false, pid: 1 },
		request: async (action: string, _session: string, args: Record<string, unknown>) => {
			state.requests.push({ action, args });
			return { tab: 7, url: state.landed ?? String(args.url ?? ""), title: "t" };
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

const project = mkdtempSync(join(tmpdir(), "prism-task-ports-"));
const children: ChildProcess[] = [];

afterEach(() => {
	for (const child of children.splice(0)) {
		// Each server leads its own process group: the shell and the server under it end together.
		try {
			if (child.pid) process.kill(-child.pid, "SIGKILL");
		} catch {}
	}
	state.tasks = [];
	state.owner = undefined;
	state.landed = undefined;
});

afterAll(() => {
	closeLocalPages("task-session");
	closeLocalPages("tool");
	rmSync(project, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const port = (server.address() as { port: number }).port;
	await new Promise((done) => server.close(done));
	return port;
}

/**
 * A web server started as a background task without a sandbox starts it: a shell leading its own process group, the
 * server its child (not exec'd), on `host`.
 */
async function serve(port: number, host: string, text: string): Promise<ChildProcess> {
	const script = `require("http").createServer((q, r) => r.end(${JSON.stringify(text)})).listen(${port}, ${JSON.stringify(host)}, () => console.log("up"))`;
	const child = spawn("/bin/sh", ["-c", `"$0" -e "$1"; exit $?`, process.execPath, script], {
		detached: true,
		stdio: ["ignore", "pipe", "inherit"],
	});
	children.push(child);
	await new Promise<void>((done, failed) => {
		child.stdout!.once("data", () => done());
		child.once("exit", (code) => failed(new Error(`server exited ${code}`)));
	});
	return child;
}

const asTask = (child: ChildProcess, status: BackgroundTask["status"] = "running"): BackgroundTask => ({
	id: "bg1",
	command: "serve",
	cwd: project,
	pid: child.pid,
	status,
	startedAt: Date.now(),
	logPath: "/dev/null",
});

describe("fork: a background task's server on the machine's loopback", () => {
	it("finds the task's listener in /proc, by its process group or its ancestry", async () => {
		const port = await freePort();
		const server = await serve(port, "127.0.0.1", "task");
		expect(taskPort(port, [server.pid!])).toEqual({ hosts: ["127.0.0.1"], shared: false });
		// Another task's tree (a sibling of the server's shell): not its server.
		const sibling = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
		children.push(sibling);
		expect(taskPort(port, [sibling.pid!])).toBeUndefined();
		expect(taskPort(await freePort(), [server.pid!])).toBeUndefined();
	});

	it("reads IPv4-mapped and IPv6 listeners, and a process that left the task's tree but kept its group", () => {
		const proc = mkdtempSync(join(tmpdir(), "prism-fake-proc-"));
		try {
			mkdirSync(join(proc, "net"));
			const header =
				"  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
			const rest = (inode: number) =>
				`00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000013649c42 100 0 0 10 0`;
			// Port 0x0D96 = 3478: ::ffff:127.0.0.1 (inode 11), ::1 (inode 12); 0x0D97 a connection, not a listener.
			writeFileSync(
				join(proc, "net", "tcp6"),
				`${header}   0: 0000000000000000FFFF00000100007F:0D96 00000000000000000000000000000000:0000 0A ${rest(11)}\n` +
					`   1: 00000000000000000000000001000000:0D96 00000000000000000000000000000000:0000 0A ${rest(12)}\n` +
					`   2: 00000000000000000000000001000000:0D97 00000000000000000000000001000000:9C40 01 ${rest(13)}\n`,
			);
			// 192.168.1.5:3478, out of the loopback's reach.
			writeFileSync(join(proc, "net", "tcp"), `${header}   0: 0501A8C0:0D96 00000000:0000 0A ${rest(14)}\n`);
			// Process 500, reparented to init (ppid 1), still in the task's group 400; it holds both sockets.
			for (const [pid, stat] of [
				["400", "400 (sh) S 1 400 400 0"],
				["500", "500 (python3 (x)) S 1 400 400 0"],
			] as const) {
				mkdirSync(join(proc, pid, "fd"), { recursive: true });
				writeFileSync(join(proc, pid, "stat"), stat);
			}
			symlinkSync("socket:[11]", join(proc, "500", "fd", "3"));
			symlinkSync("socket:[12]", join(proc, "500", "fd", "4"));
			symlinkSync("socket:[14]", join(proc, "500", "fd", "5"));
			expect(taskPort(3478, [400], proc)).toEqual({ hosts: ["127.0.0.1", "[::1]"], shared: false });
			expect(taskPort(3478, [401], proc)).toBeUndefined();
			expect(taskPort(3479, [400], proc)).toBeUndefined();
		} finally {
			rmSync(proc, { recursive: true, force: true });
		}
	});

	it("opens the task's server where it listens, without a relay, and leaves other ports to the host rule", async () => {
		const port = await freePort();
		const server = await serve(port, "0.0.0.0", "from the task");
		// The QA's case: the task is there, but the session has no network of its own.
		expect(await localPage("task-session", project, `http://localhost:${port}/page.html`)).toBeUndefined();
		state.tasks = [asTask(server, "done")];
		expect(await localPage("task-session", project, `http://localhost:${port}/page.html`)).toBeUndefined();
		state.tasks = [asTask(server)];
		// The task of another session of the same process opens nothing here.
		state.owner = "another-session";
		expect(await localPage("task-session", project, `http://localhost:${port}/page.html`)).toBeUndefined();
		expect(isLocalPage("task-session", new URL(`http://127.0.0.1:${port}/`))).toBe(false);
		state.owner = "task-session";

		const page = await localPage("task-session", project, `http://localhost:${port}/page.html?x=1#top`);
		if (!page || "error" in page) throw new Error(JSON.stringify(page));
		expect(page.url.href).toBe(`http://127.0.0.1:${port}/page.html?x=1#top`);
		expect(await (await fetch(page.url)).text()).toBe("from the task");
		for (const asked of ["0.0.0.0", "127.0.0.1", "[::1]"]) {
			const again = await localPage("task-session", project, `http://${asked}:${port}/`);
			expect(again && "url" in again && again.url.hostname).toBe("127.0.0.1");
		}
		// A redirect to the same server, by any name that reaches it only.
		expect(isLocalPage("task-session", new URL(`http://localhost:${port}/next`))).toBe(true);
		expect(isLocalPage("task-session", new URL(`http://127.0.0.1:${port}/next`))).toBe(true);
		expect(isLocalPage("task-session", new URL(`http://[::1]:${port}/next`))).toBe(false);
		expect(isLocalPage("task-session", new URL(`https://localhost:${port}/next`))).toBe(false);

		// A port no task listens on, and a server that is not a task's.
		expect(await localPage("task-session", project, `http://localhost:${await freePort()}/`)).toBeUndefined();
		const other = await freePort();
		await serve(other, "127.0.0.1", "not a task");
		expect(await localPage("task-session", project, `http://localhost:${other}/`)).toBeUndefined();
		expect(isLocalPage("task-session", new URL(`http://localhost:${other}/`))).toBe(false);
	});

	it("names [::1] for a server on ::1 only, and refuses `localhost` when another server shares the port", async () => {
		const port = await freePort();
		const server = await serve(port, "::1", "on ::1");
		state.tasks = [asTask(server)];
		const page = await localPage("task-session", project, `http://localhost:${port}/`);
		if (!page || "error" in page) throw new Error(JSON.stringify(page));
		expect(page.url.hostname).toBe("[::1]");
		expect(await (await fetch(page.url)).text()).toBe("on ::1");
		expect(isLocalPage("task-session", new URL(`http://localhost:${port}/`))).toBe(true);

		// Something else answers at 127.0.0.1 on the same port: `localhost` may lead there.
		await serve(port, "127.0.0.1", "someone else");
		expect(isLocalPage("task-session", new URL(`http://localhost:${port}/x`))).toBe(false);
		expect(isLocalPage("task-session", new URL(`http://127.0.0.1:${port}/x`))).toBe(false);
		expect(isLocalPage("task-session", new URL(`http://[::1]:${port}/x`))).toBe(true);
		const again = await localPage("task-session", project, `http://127.0.0.1:${port}/`);
		expect(again && "url" in again && again.url.hostname).toBe("[::1]");
	});

	it("does the same for a session whose sandbox could not make its network", async () => {
		const tmp = sessionTmpDir("tmp-session");
		try {
			const port = await freePort();
			state.tasks = [asTask(await serve(port, "127.0.0.1", "task"))];
			const page = await localPage("tmp-session", project, `http://localhost:${port}/`);
			expect(page && "url" in page && page.url.host).toBe(`127.0.0.1:${port}`);
			expect(tmp).toBeTruthy();
		} finally {
			closeLocalPages("tmp-session");
			removeSessionTmpDir("tmp-session");
		}
	});
});

describe("fork: the browser tool opens a background task's server", () => {
	const asked: string[] = [];
	let tool: ToolDefinition;
	const events = createEventBus();
	// The rule refuses every host: the task's server must not need it.
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
		state.requests.length = 0;
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

	it("opens it without the host rule, follows its redirect, and still asks for another server's port", async () => {
		const port = await freePort();
		state.tasks = [asTask(await serve(port, "0.0.0.0", "task"))];
		state.landed = `http://localhost:${port}/after-redirect`;
		const opened = await call(`http://localhost:${port}/page.html`);
		expect(opened.error).toBeFalsy();
		expect(asked).toEqual([]);
		expect(String(state.requests[0]?.args.url)).toBe(`http://127.0.0.1:${port}/page.html`);
		state.landed = undefined;

		const other = await freePort();
		await serve(other, "127.0.0.1", "not a task");
		const refused = await call(`http://localhost:${other}/`);
		expect(refused.error).toBe(true);
		expect(asked).toEqual([`localhost:${other}`]);
		expect(state.requests).toEqual([]);
	});
});
