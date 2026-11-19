// exercise the real gate without starting a network namespace.
import { execFile } from "node:child_process";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { EventBus } from "../src/core/event-bus.ts";
import { emitSessionShutdownEvent } from "../src/core/extensions/runner.ts";
import permissionsExtension, { exportSessionGrants, importSessionGrants } from "../src/fork/permissions.ts";
import { readProjectGrants, removeProjectRule, watchProjectGrants } from "../src/fork/project-permissions.ts";
import { readSandboxSettings } from "../src/fork/sandbox/layout.ts";
import { serveProxyStream } from "../src/fork/sandbox/proxy.ts";
import * as runtime from "../src/fork/sandbox/runtime.ts";
import { toolNetworkGate } from "../src/fork/sandbox/tool-network.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

describe("fork: network approvals D14–D16", () => {
	let agentDir: string;
	const saved = process.env[ENV_AGENT_DIR];
	const harnesses: Harness[] = [];
	const servers: Server[] = [];
	const sockets = new Set<Socket>();
	const stops: (() => void)[] = [];

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-network-approvals-"));
		process.env[ENV_AGENT_DIR] = agentDir;
		// These tests expect ask mode; without a configured mode Prism starts in broad.
		writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode: "ask" }));
		// Only namespace startup is replaced. Decisions, persistence, watchers and proxy connections are real.
		vi.spyOn(runtime, "startSandbox").mockImplementation(async (settings, _cwd, policy, tmp) => ({
			bwrap: "/unused",
			settings,
			agentDir,
			seccomp: "/unused",
			policy,
			tmp: tmp ?? agentDir,
		}));
	});

	afterEach(async () => {
		for (const stop of stops.splice(0)) stop();
		for (const socket of sockets) socket.destroy();
		sockets.clear();
		await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
		for (const harness of harnesses.splice(0)) {
			await emitSessionShutdownEvent(harness.session.extensionRunner, { type: "session_shutdown", reason: "quit" });
			runtime.removeSessionTmpDir(harness.sessionManager.getSessionId());
			harness.cleanup();
		}
		vi.restoreAllMocks();
		if (saved === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = saved;
		rmSync(agentDir, { recursive: true, force: true });
	});

	async function start(
		pick: (options: string[]) => string | undefined = (options) => options.find((o) => o.endsWith("in this session")),
	) {
		let events: EventBus | undefined;
		const harness = await createHarness({
			extensionFactories: [
				{
					name: "permissions",
					factory: (pi) => {
						events = pi.events;
						permissionsExtension(pi);
					},
				},
			],
		});
		harnesses.push(harness);
		const questions: string[] = [];
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				select: async (title, options) => {
					questions.push(title);
					return pick(options);
				},
			}),
		});
		const sandbox = runtime.sessionSandbox(harness.sessionManager);
		if (!sandbox || "error" in sandbox) throw new Error("test sandbox missing");
		if (!events) throw new Error("test events missing");
		return { harness, questions, policy: sandbox.policy, events };
	}

	it("D14: shares a session host only with matching commands, including background, and revokes it after engine sleep", async () => {
		const first = await start();
		const host = "registry.npmjs.org";
		expect(await first.policy.open({ command: "npm install" }).allows(host)).toBe(true);
		expect(await first.policy.open({ command: "cd . && npm install --ignore-scripts" }).allows(host)).toBe(true);
		expect(first.policy.wouldAsk(host, { command: "npm install x" })).toBe(false);
		expect(first.policy.wouldAsk(host, { command: "npm test" })).toBe(true);
		expect(first.questions).toHaveLength(1);
		const grants = exportSessionGrants(first.harness.sessionManager);
		expect(grants?.hosts).toEqual([]);
		expect(grants?.commandHosts).toEqual([{ host, command: "npm install" }]);
		const woken = await start((options) => options.find((o) => o.startsWith("Block")));
		expect(importSessionGrants(woken.harness.sessionManager, JSON.parse(JSON.stringify(grants)))).toBe(true);
		const network = woken.policy.open({ command: "npm install --ignore-scripts" });
		expect(await network.allows(host)).toBe(true);
		expect(await woken.policy.open({ command: "curl https://registry.npmjs.org" }).allows(host)).toBe(false);
		expect(woken.questions).toHaveLength(1);
		let closed = false;
		network.track(host, () => {
			closed = true;
		});
		woken.policy.sessionAllowed.clear();
		woken.policy.recheck();
		expect(closed).toBe(true);
		expect(woken.policy.wouldAsk(host, { command: "npm install" })).toBe(true);
	});

	it("D14: an unmatchable command keeps only its exact text, and native tool approvals keep their existing session scope", async () => {
		const { harness, policy, questions, events } = await start();
		const command = "npm install && node postinstall.js";
		expect(await policy.open({ command }).allows("exact.test")).toBe(true);
		expect(policy.wouldAsk("exact.test", { command })).toBe(false);
		expect(policy.wouldAsk("exact.test", { command: "npm install" })).toBe(true);
		const gate = toolNetworkGate(events, "web", "web_fetch http://host.prism.internal:1234");
		if (!gate) throw new Error("tool gate missing");
		expect(await gate.destination(new URL("http://host.prism.internal:1234"), async () => [])).toBeUndefined();
		gate.close();
		expect(policy.wouldAsk("localhost:1234", { command: "curl http://host.prism.internal:1234" })).toBe(false);
		expect(questions).toHaveLength(2);
		expect(exportSessionGrants(harness.sessionManager)?.hosts).toEqual(["localhost:1234"]);
	});

	it.each(["bash", "background"] as const)(
		"D15: %s project approval saves its likely hosts with its rule, and removing the rule revokes them",
		async (toolName) => {
			const { harness, policy, questions } = await start((options) =>
				options.find((o) => o.startsWith("Allow") && o.endsWith("in this project")),
			);
			const command = "git clone https://example.test/repo";
			const rule = `${toolName}(git clone*)`;
			const call = (toolCallId: string) =>
				harness.session.extensionRunner.emitToolCall({
					type: "tool_call",
					toolName,
					toolCallId,
					input: { command, ...(toolName === "background" ? { action: "run" } : {}) },
				});
			expect(await call("one")).toBeUndefined();
			expect(questions[0]).toContain("Will probably connect to: example.test");
			expect(readProjectGrants(harness.tempDir)).toEqual({
				allow: [rule],
				deny: [],
				hosts: [{ host: "example.test", rule }],
			});
			const network = policy.open({ toolCallId: "one", command });
			expect(await network.allows("example.test")).toBe(true);
			expect(await call("two")).toBeUndefined();
			expect(await policy.open({ toolCallId: "two", command }).allows("example.test")).toBe(true);
			expect(questions).toHaveLength(1);
			expect(policy.wouldAsk("example.test", { command: "curl https://example.test" })).toBe(true);
			let closed = false;
			network.track("example.test", () => {
				closed = true;
			});
			await removeProjectRule(harness.tempDir, rule);
			// Without a free inotify instance the grants are read every GRANTS_POLL_MS (1 s), the default wait.
			await vi.waitFor(() => expect(closed).toBe(true), { timeout: 3000 });
			expect(readProjectGrants(harness.tempDir).hosts).toEqual([]);
			expect(policy.wouldAsk("example.test", { command })).toBe(true);
			expect(await call("three")).toBeUndefined();
			expect(questions).toHaveLength(2);
		},
	);

	async function listen(server: Server): Promise<number> {
		servers.push(server);
		server.on("connection", (socket) => {
			sockets.add(socket);
			socket.on("error", () => {});
		});
		await new Promise<void>((done, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", done);
		});
		return (server.address() as { port: number }).port;
	}

	it("D15: saves likely hosts already allowed in this session, while blocked hosts remain refused", async () => {
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ sandbox: { network: { deny: ["static.crates.io"] } } }),
		);
		const { harness, policy, questions } = await start((options) =>
			options.find((o) => o.startsWith("Allow") && o.endsWith("in this project")),
		);
		policy.allowForSession("index.crates.io", { command: "cargo build" });
		expect(
			await harness.session.extensionRunner.emitToolCall({
				type: "tool_call",
				toolName: "bash",
				toolCallId: "cargo",
				input: { command: "cargo build" },
			}),
		).toBeUndefined();
		expect(questions[0]).toContain("Will probably connect to: index.crates.io");
		expect(readProjectGrants(harness.tempDir).hosts).toEqual([
			{ host: "index.crates.io", rule: "bash(cargo build*)" },
		]);
		policy.sessionAllowed.clear();
		const network = policy.open({ toolCallId: "cargo", command: "cargo build" });
		expect(await network.allows("index.crates.io")).toBe(true);
		expect(await network.allows("static.crates.io")).toBe(false);
		expect(questions).toHaveLength(1);
	});

	it.for(["rename", "rewrite"])(
		"D16: external settings %s revokes an open proxy connection in every session and refuses the next connection",
		async (method, ctx) => {
			let target: number;
			try {
				target = await listen(createServer((socket) => socket.pipe(socket)));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EPERM") return ctx.skip();
				throw error;
			}
			const host = `localhost:${target}`;
			const file = join(agentDir, "settings.json");
			writeFileSync(file, JSON.stringify({ sandbox: { network: { allow: [host] } } }));
			const sessions = [await start(() => "Block for this command"), await start(() => "Block for this command")];
			const proxies: number[] = [];
			const connectTo = async (port: number) => {
				const socket = connect(port, "127.0.0.1");
				sockets.add(socket);
				socket.on("error", () => {});
				const head = new Promise<string>((done) => socket.once("data", (data) => done(String(data))));
				socket.write(`CONNECT host.prism.internal:${target} HTTP/1.1\r\n\r\n`);
				return { socket, head: await head };
			};
			const opened: Socket[] = [];
			for (const { policy } of sessions) {
				const network = policy.open({ command: "curl" });
				const port = await listen(createServer((socket) => serveProxyStream(socket, network)));
				proxies.push(port);
				const tunnel = await connectTo(port);
				expect(tunnel.head).toContain("200 Connection Established");
				opened.push(tunnel.socket);
			}
			// A separate Node process writes only the throwaway settings; no session API runs a recheck.
			await promisify(execFile)(process.execPath, [
				"-e",
				"const fs = require('node:fs'); const [file, method] = process.argv.slice(1); const temp = method === 'rename' ? file + '.tmp' : file; fs.writeFileSync(temp, JSON.stringify({ sandbox: { network: { allow: [] } } })); if (temp !== file) fs.renameSync(temp, file);",
				file,
				method,
			]);
			await vi.waitFor(() => expect(opened.every((socket) => socket.destroyed)).toBe(true));
			for (const port of proxies) expect((await connectTo(port)).head).toContain("403 Forbidden");
			for (const { questions } of sessions) expect(questions).toHaveLength(1);
		},
	);

	it("D16: retains last valid rules across incomplete writes and watches settings even without inotify", async () => {
		const file = join(agentDir, "settings.json");
		writeFileSync(file, JSON.stringify({ sandbox: { network: { allow: ["example.test"] } } }));
		const { policy } = await start();
		const network = policy.open({ command: "curl" });
		let closed = false;
		network.track("example.test", () => {
			closed = true;
		});
		writeFileSync(file, "{ incomplete");
		expect(readSandboxSettings().network.allow).toEqual(["example.test"]);
		policy.recheck();
		expect(closed).toBe(false);
		let changes = 0;
		stops.push(
			watchProjectGrants(
				() => changes++,
				agentDir,
				() => {
					throw new Error("EMFILE");
				},
				"settings.json",
			),
		);
		writeFileSync(`${file}.tmp`, JSON.stringify({ sandbox: { network: { allow: [] } } }));
		renameSync(`${file}.tmp`, file);
		await vi.waitFor(() => expect(changes).toBe(1), { timeout: 3000 });
		await vi.waitFor(() => expect(closed).toBe(true));
		expect(readSandboxSettings().network.allow).toEqual([]);
	});

	it("D16: an external settings edit revokes tracked connections in two live sessions without an explicit recheck", async () => {
		const file = join(agentDir, "settings.json");
		writeFileSync(file, JSON.stringify({ sandbox: { network: { allow: ["example.test"] } } }));
		const sessions = [await start(() => "Block for this command"), await start(() => "Block for this command")];
		const closed = [false, false];
		const networks = sessions.map(({ policy }, index) => {
			const network = policy.open({ command: "curl" });
			network.track("example.test", () => {
				closed[index] = true;
			});
			return network;
		});
		for (const network of networks) expect(await network.allows("example.test")).toBe(true);
		await promisify(execFile)(process.execPath, [
			"-e",
			"require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ sandbox: { network: { allow: [] } } }))",
			file,
		]);
		await vi.waitFor(() => expect(closed).toEqual([true, true]));
		for (const network of networks) expect(await network.allows("example.test")).toBe(false);
		for (const { questions } of sessions) expect(questions).toHaveLength(1);
	});

	// fork: a background task's tunnel opened before a /reload stayed
	// open when its host was blocked after it: the old instance's watchers had stopped, the new one did not know it.
	it("closes a tunnel opened before a /reload when its host is blocked after it", async (ctx) => {
		let target: number;
		try {
			target = await listen(createServer((socket) => socket.pipe(socket)));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EPERM") return ctx.skip();
			throw error;
		}
		const file = join(agentDir, "settings.json");
		writeFileSync(file, JSON.stringify({ sandbox: { network: { allow: [`localhost:${target}`] } } }));
		const { harness, policy } = await start(() => "Block for this command");
		// The background task's proxy and its open tunnel, through the real proxy stream.
		const network = policy.open({ command: "curl" });
		const proxy = await listen(createServer((socket) => serveProxyStream(socket, network)));
		const connectTo = async () => {
			const socket = connect(proxy, "127.0.0.1");
			sockets.add(socket);
			socket.on("error", () => {});
			const head = new Promise<string>((done) => socket.once("data", (data) => done(String(data))));
			socket.write(`CONNECT host.prism.internal:${target} HTTP/1.1\r\n\r\n`);
			return { socket, head: await head };
		};
		const tunnel = await connectTo();
		expect(tunnel.head).toContain("200 Connection Established");
		await harness.session.reload();
		const sandbox = runtime.sessionSandbox(harness.sessionManager);
		if (!sandbox || "error" in sandbox) throw new Error("test sandbox missing");
		expect(sandbox.policy).not.toBe(policy);
		await promisify(execFile)(process.execPath, [
			"-e",
			"require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ sandbox: { network: { allow: [] } } }))",
			file,
		]);
		await vi.waitFor(() => expect(tunnel.socket.destroyed).toBe(true));
		expect((await connectTo()).head).toContain("403 Forbidden");
	});
});
