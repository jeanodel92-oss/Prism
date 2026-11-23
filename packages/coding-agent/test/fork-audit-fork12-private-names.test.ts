// fork: a name the user allowed that leads to a private
// address (local network, link-local, Tailscale, ULA) asks once more, showing the address, before anything is sent;
// the answer is kept for that name and address. Same rule for Prism's network tools and the sandboxed commands' proxy.
// Stand-in resolvers only: no DNS query, and the proxy connects to 127.0.0.2 alone.
import type { LookupAddress } from "node:dns";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { EventBus } from "../src/core/event-bus.ts";
import permissionsExtension from "../src/fork/permissions.ts";
import type * as DnsGuardModule from "../src/fork/sandbox/dns-guard.ts";
import { DnsGuard } from "../src/fork/sandbox/dns-guard.ts";
import { serveGitSsh } from "../src/fork/sandbox/git-ssh.ts";
import { type HostAnswer, HostPolicy, type NetworkSettings, serveProxyStream } from "../src/fork/sandbox/proxy.ts";
import { overrideSshFiles } from "../src/fork/sandbox/ssh-provenance.ts";
import { checkDestination, toolNetworkGate } from "../src/fork/sandbox/tool-network.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

// The proxy refuses the sandbox's loopback: 127.0.0.2 stands for a host of the local network, as in
// fork-dns-rebinding.test.ts. It is private (`isLocalAddress`), not this machine's.
vi.mock("../src/fork/sandbox/dns-guard.ts", async (importOriginal) => {
	const original = await importOriginal<typeof DnsGuardModule>();
	const isMachineAddress: typeof original.isMachineAddress = (address, ...rest) =>
		address !== "127.0.0.2" && original.isMachineAddress(address, ...rest);
	const isSandboxLoopback: typeof original.isSandboxLoopback = (host) =>
		host !== "127.0.0.2" && original.isSandboxLoopback(host);
	return { ...original, isMachineAddress, isSandboxLoopback };
});

/** What each name answers, in order: the last answer repeats (the audit's probe, sonde-nom-local.test.ts). */
const ZONE: Record<string, string[][]> = {
	"docs.example.com": [["93.184.216.34"]],
	"loop.attacker.example": [["127.0.0.1"]],
	"router.attacker.example": [["192.168.1.1"]],
	"metadata.attacker.example": [["169.254.169.254"]],
	"cgnat.attacker.example": [["100.101.102.103"]],
	"ula.attacker.example": [["fd12:3456:789a::1"]],
	"rebind.attacker.example": [["93.184.216.34"], ["192.168.1.1"]],
	"moved.attacker.example": [["192.168.1.1"], ["192.168.1.2"]],
	"lan.invalid": [["127.0.0.2"]],
};

function resolver() {
	const asked = new Map<string, number>();
	return async (host: string): Promise<LookupAddress[]> => {
		const answers = ZONE[host];
		if (!answers) throw new Error(`ENOTFOUND ${host}`);
		const turn = asked.get(host) ?? 0;
		asked.set(host, turn + 1);
		return (answers[Math.min(turn, answers.length - 1)] ?? []).map((address) => ({
			address,
			family: address.includes(":") ? 6 : 4,
		}));
	};
}

const PRIVATE = [
	["router.attacker.example", "192.168.1.1"],
	["metadata.attacker.example", "169.254.169.254"],
	["cgnat.attacker.example", "100.101.102.103"],
	["ula.attacker.example", "fd12:3456:789a::1"],
] as const;

describe("fork: a name that leads to a private address", () => {
	/** The check of one URL; the user allows the names in `yes` and nothing else. */
	const check = async (url: string, yes: (asked: string) => boolean, guard = new DnsGuard(resolver())) => {
		const questions: string[] = [];
		const refusal = await checkDestination(
			new URL(url),
			async (asked) => {
				questions.push(asked);
				return yes(asked);
			},
			(host) => guard.resolve(host),
		);
		return { questions, refusal };
	};

	for (const [name, address] of PRIVATE) {
		it(`${name}: asks about ${address} after the name, and passes only once it is allowed`, async () => {
			const pseudo = `${name}@${address}`;
			const nameOnly = await check(`http://${name}/admin`, (asked) => asked === name);
			expect(nameOnly.questions).toEqual([name, pseudo]);
			expect(nameOnly.refusal).toContain(`${name} leads to ${address}, a private address`);
			expect(nameOnly.refusal).toContain(`Ask the user to allow ${pseudo}`);
			const both = await check(`http://${name}/admin`, (asked) => asked === name || asked === pseudo);
			expect(both).toEqual({ questions: [name, pseudo], refusal: undefined });
		});
	}

	it("controls: a public name, a name to this machine, rebinding and a numeric private address", async () => {
		const yes = () => true;
		expect(await check("http://docs.example.com/", yes)).toEqual({
			questions: ["docs.example.com"],
			refusal: undefined,
		});
		const loop = await check("http://loop.attacker.example/admin", (asked) => asked === "loop.attacker.example");
		expect(loop.questions).toEqual(["loop.attacker.example", "localhost:80"]);
		expect(loop.refusal).toContain("port 80 of this machine");
		// A numeric private address is asked about as it is, once.
		expect(await check("http://192.168.1.1/", yes)).toEqual({ questions: ["192.168.1.1"], refusal: undefined });
		expect(await check("http://[fd12:3456:789a::1]/", yes)).toEqual({
			questions: ["fd12:3456:789a::1"],
			refusal: undefined,
		});
		const guard = new DnsGuard(resolver());
		expect(await check("http://rebind.attacker.example/", yes, guard)).toEqual({
			questions: ["rebind.attacker.example"],
			refusal: undefined,
		});
		await expect(guard.resolve("rebind.attacker.example")).rejects.toThrow("DNS rebinding blocked");
	});

	describe("the host policy: remembered per name and address", () => {
		const policyWith = (settings: NetworkSettings, answer: HostAnswer | undefined) => {
			const asked: string[] = [];
			const guard = new DnsGuard(resolver());
			const policy = new HostPolicy(
				() => settings,
				answer === undefined
					? undefined
					: async (host) => {
							asked.push(host);
							return answer;
						},
				undefined,
				guard,
			);
			const reach = async (url: string) => {
				const network = policy.open({ toolCallId: "t", command: "web_fetch", nonCommand: true });
				try {
					return await checkDestination(new URL(url), (name) => network.allows(name), guard.resolve.bind(guard));
				} finally {
					network.close();
				}
			};
			return { asked, policy, reach };
		};

		it("asks once for the session, and again when the name leads to another private address", async () => {
			const { asked, reach } = policyWith({ askNewHosts: true, allow: [], deny: [] }, "session");
			expect(await reach("http://router.attacker.example/")).toBeUndefined();
			expect(await reach("http://router.attacker.example/other")).toBeUndefined();
			expect(asked).toEqual(["router.attacker.example", "router.attacker.example@192.168.1.1"]);
			expect(await reach("http://moved.attacker.example/")).toBeUndefined();
			expect(await reach("http://moved.attacker.example/")).toBeUndefined();
			expect(asked.slice(2)).toEqual([
				"moved.attacker.example",
				"moved.attacker.example@192.168.1.1",
				"moved.attacker.example@192.168.1.2",
			]);
		});

		it("with questions off, a name passes without a question but its private address is still asked about", async () => {
			const off = { askNewHosts: false, allow: [] as string[], deny: [] as string[] };
			const { asked, reach } = policyWith(off, "session");
			expect(await reach("http://docs.example.com/")).toBeUndefined();
			expect(await reach("http://cgnat.attacker.example/")).toBeUndefined();
			expect(asked).toEqual(["cgnat.attacker.example@100.101.102.103"]);
			// Nobody to ask: refused, never passed.
			const alone = policyWith(off, undefined);
			expect(await alone.reach("http://router.attacker.example/")).toContain("leads to 192.168.1.1");
			expect(alone.policy.refusalsOf("t")).toEqual([
				{ host: "router.attacker.example@192.168.1.1", why: "unanswered", toolCallId: "t" },
			]);
			// Listed in the allowed hosts, it passes without a question.
			const listed = policyWith({ ...off, allow: ["router.attacker.example@192.168.1.1"] }, undefined);
			expect(await listed.reach("http://router.attacker.example/")).toBeUndefined();
		});
	});

	describe("the sandboxed commands' proxy", () => {
		const servers: Server[] = [];
		const sockets: Socket[] = [];
		afterEach(async () => {
			for (const socket of sockets.splice(0)) socket.destroy();
			await Promise.all(
				servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
			);
		});
		async function listen(server: Server, host: string): Promise<number> {
			servers.push(server);
			server.listen(0, host);
			await once(server, "listening");
			return (server.address() as { port: number }).port;
		}

		it.each(["CONNECT", "GET"])(
			"%s: asks about the private address, refuses without it, keeps it once allowed",
			async (method) => {
				const reached = vi.fn((socket: Socket) => {
					sockets.push(socket);
					socket.end("lan service");
				});
				const target = await listen(createServer(reached), "127.0.0.2");
				const asked: string[] = [];
				let answer: HostAnswer = "deny";
				const policy = new HostPolicy(
					() => ({ askNewHosts: true, allow: ["lan.invalid"], deny: [] }),
					async (host) => {
						asked.push(host);
						return answer;
					},
					undefined,
					new DnsGuard(resolver()),
				);
				const network = policy.open({ toolCallId: "t", command: "curl" });
				const proxy = await listen(
					createServer((socket) => serveProxyStream(socket, network)),
					"127.0.0.1",
				);
				const request = async () => {
					const socket = connect(proxy, "127.0.0.1");
					sockets.push(socket);
					const chunks: Buffer[] = [];
					socket.on("data", (chunk: Buffer) => chunks.push(chunk));
					socket.write(
						method === "CONNECT"
							? `CONNECT lan.invalid:${target} HTTP/1.1\r\n\r\n`
							: `GET http://lan.invalid:${target}/ HTTP/1.1\r\nHost: lan.invalid\r\n\r\n`,
					);
					await once(socket, "close");
					return Buffer.concat(chunks).toString();
				};
				const refused = await request();
				expect(refused).toContain("403 Forbidden");
				expect(refused).toContain("it leads to 127.0.0.2, a private address");
				expect(refused).toContain("Ask the user to allow lan.invalid@127.0.0.2");
				expect(reached).not.toHaveBeenCalled();
				expect(asked).toEqual(["lan.invalid@127.0.0.2"]);
				// Refused once for this command; a new command asks again, and the session answer is kept.
				answer = "session";
				const next = policy.open({ toolCallId: "u", command: "curl" });
				const nextProxy = await listen(
					createServer((socket) => serveProxyStream(socket, next)),
					"127.0.0.1",
				);
				const viaNext = async () => {
					const socket = connect(nextProxy, "127.0.0.1");
					sockets.push(socket);
					const chunks: Buffer[] = [];
					socket.on("data", (chunk: Buffer) => chunks.push(chunk));
					socket.write(`CONNECT lan.invalid:${target} HTTP/1.1\r\n\r\n`);
					await once(socket, "close");
					return Buffer.concat(chunks).toString();
				};
				expect(await viaNext()).toContain("lan service");
				expect(await viaNext()).toContain("lan service");
				expect(asked).toEqual(["lan.invalid@127.0.0.2", "lan.invalid@127.0.0.2"]);
				expect(reached).toHaveBeenCalledTimes(2);
			},
		);
	});

	describe("a blocked address blocks the names that lead to it", () => {
		it("checkDestination: refused after the name's question, before any other; a public name still passes", async () => {
			const guard = new DnsGuard(resolver());
			const questions: string[] = [];
			const reach = (url: string) =>
				checkDestination(
					new URL(url),
					async (asked) => {
						questions.push(asked);
						return true;
					},
					(host) => guard.resolve(host),
					(address) => address === "192.168.1.1",
				);
			expect(await reach("http://router.attacker.example/admin")).toBe(
				"Refused by Prism's network permissions: router.attacker.example leads to 192.168.1.1, which is blocked. Nothing was sent.",
			);
			expect(questions).toEqual(["router.attacker.example"]);
			expect(await reach("http://docs.example.com/")).toBeUndefined();
			expect(await reach("http://cgnat.attacker.example/")).toBeUndefined();
		});

		it("the proxy: an allowed name that leads to a blocked address is refused, without a question", async () => {
			const sockets: Socket[] = [];
			const reached = vi.fn((socket: Socket) => {
				sockets.push(socket);
				socket.end("lan service");
			});
			const target = createServer(reached).listen(0, "127.0.0.2");
			await once(target, "listening");
			const asked: string[] = [];
			const policy = new HostPolicy(
				() => ({ askNewHosts: true, allow: ["lan.invalid", "lan.invalid@127.0.0.2"], deny: ["127.0.0.2"] }),
				async (host) => {
					asked.push(host);
					return "session";
				},
				undefined,
				new DnsGuard(resolver()),
			);
			const network = policy.open({ toolCallId: "t", command: "curl" });
			const proxy = createServer((socket) => serveProxyStream(socket, network)).listen(0, "127.0.0.1");
			await once(proxy, "listening");
			try {
				const socket = connect((proxy.address() as { port: number }).port, "127.0.0.1");
				sockets.push(socket);
				const chunks: Buffer[] = [];
				socket.on("data", (chunk: Buffer) => chunks.push(chunk));
				socket.write(`CONNECT lan.invalid:${(target.address() as { port: number }).port} HTTP/1.1\r\n\r\n`);
				await once(socket, "close");
				const reply = Buffer.concat(chunks).toString();
				expect(reply).toContain("403 Forbidden");
				expect(reply).toContain("it leads to 127.0.0.2, which the user blocked");
				expect(reached).not.toHaveBeenCalled();
				expect(asked).toEqual([]);
				expect(policy.refusalsOf("t")).toEqual([{ host: "lan.invalid", why: "blocked", toolCallId: "t" }]);
			} finally {
				for (const socket of sockets) socket.destroy();
				await Promise.all(
					[proxy, target].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
				);
			}
		});
	});

	// fork: ssh resolves the name itself, so its addresses are checked before ssh runs.
	describe("Git over SSH", () => {
		let dir: string;
		beforeEach(() => {
			dir = mkdtempSync(join(tmpdir(), "prism-ssh-private-"));
			overrideSshFiles({ home: join(dir, "home"), system: join(dir, "no-system-config") });
		});
		afterEach(() => rmSync(dir, { recursive: true, force: true }));

		/** A stand-in ssh: `-G` prints `config`; otherwise it leaves a marker, as a connection would. */
		const fakeSsh = (config: string) => {
			const ssh = join(dir, "ssh");
			writeFileSync(join(dir, "ssh-G"), `${config}\n`);
			writeFileSync(
				ssh,
				`#!/bin/sh\nfor a; do [ "$a" = -G ] && exec cat '${join(dir, "ssh-G")}'; done\ntouch '${join(dir, "ran")}'\n`,
				{ mode: 0o755 },
			);
			return ssh;
		};

		const serve = async (policy: HostPolicy, ssh: string) => {
			rmSync(join(dir, "ran"), { force: true });
			const network = policy.open({ toolCallId: "t", command: "git fetch" });
			network.sandboxWrites = () => false;
			const stream = new PassThrough();
			const chunks: Buffer[] = [];
			stream.on("data", (chunk: Buffer) => chunks.push(chunk));
			const request = { destination: "git@nas", command: "git-upload-pack '/srv/r.git'" };
			await serveGitSsh(
				stream,
				Buffer.from(JSON.stringify(request)).toString("base64url"),
				Buffer.alloc(0),
				network,
				ssh,
			);
			for (let wait = 0; wait < 40 && !existsSync(join(dir, "ran")) && !stream.writableEnded; wait++)
				await new Promise((resolve) => setTimeout(resolve, 50));
			const ran = existsSync(join(dir, "ran"));
			stream.destroy();
			network.close();
			return { ran, reply: Buffer.concat(chunks).toString() };
		};

		it("asks about the private address the configured host leads to, and runs ssh only once it is allowed", async () => {
			const asked: string[] = [];
			let answer: HostAnswer = "deny";
			const policy = new HostPolicy(
				() => ({ askNewHosts: true, allow: ["ssh://nas"], deny: [] }),
				async (host) => {
					asked.push(host);
					return answer;
				},
				undefined,
				new DnsGuard(resolver()),
			);
			const ssh = fakeSsh("user git\nhostname router.attacker.example\nproxyjump none");
			const refused = await serve(policy, ssh);
			expect(refused.ran).toBe(false);
			expect(refused.reply).toContain("router.attacker.example leads to 192.168.1.1, a private address");
			expect(refused.reply).toContain("Ask the user to allow ssh://nas@192.168.1.1");
			expect(asked).toEqual(["ssh://nas@192.168.1.1"]);
			answer = "session";
			expect((await serve(policy, ssh)).ran).toBe(true);
			expect((await serve(policy, ssh)).ran).toBe(true);
			expect(asked).toEqual(["ssh://nas@192.168.1.1", "ssh://nas@192.168.1.1"]);
		});

		it("controls: a public host, a jump host, and a blocked address", async () => {
			const asked: string[] = [];
			const settings: NetworkSettings = { askNewHosts: true, allow: ["ssh://nas"], deny: [] };
			const policy = new HostPolicy(
				() => settings,
				async (host) => {
					asked.push(host);
					return "deny";
				},
				undefined,
				new DnsGuard(resolver()),
			);
			expect((await serve(policy, fakeSsh("hostname docs.example.com"))).ran).toBe(true);
			// Through a jump host, the name is resolved there.
			expect((await serve(policy, fakeSsh("hostname router.attacker.example\nproxyjump bastion"))).ran).toBe(true);
			expect(asked).toEqual([]);
			settings.deny = ["192.168.1.1"];
			const blocked = await serve(policy, fakeSsh("hostname router.attacker.example\nproxyjump none"));
			expect(blocked.ran).toBe(false);
			expect(blocked.reply).toContain("router.attacker.example leads to 192.168.1.1, which the user blocked");
			expect(asked).toEqual([]);
		});
	});

	describe("the question of the permissions extension", () => {
		let agentDir: string;
		const harnesses: Harness[] = [];
		beforeEach(() => {
			agentDir = mkdtempSync(join(tmpdir(), "prism-private-names-"));
			vi.stubEnv(ENV_AGENT_DIR, agentDir);
			writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode: "broad" }));
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sandbox: { modes: { broad: false } } }));
		});
		afterEach(() => {
			for (const harness of harnesses.splice(0)) harness.cleanup();
			vi.unstubAllEnvs();
			rmSync(agentDir, { recursive: true, force: true });
		});

		it("shows the address, offers no browser-wide answer, and keeps a session answer", async () => {
			let events: EventBus | undefined;
			const harness = await createHarness({
				extensionFactories: [
					{ name: "permissions", factory: permissionsExtension },
					{
						name: "probe",
						factory: (pi) => {
							events = pi.events;
						},
					},
				],
			});
			harnesses.push(harness);
			const asked: Array<{ title: string; options: string[] }> = [];
			await harness.session.bindExtensions({
				uiContext: createTestUiContext({
					select: async (title, options) => {
						asked.push({ title, options });
						return options.find((option) => option.endsWith("in this session"));
					},
				}),
			});
			const guard = new DnsGuard(resolver());
			let calls = 0;
			const reach = async (url: string, browser: boolean) => {
				const gate = toolNetworkGate(
					events!,
					`call-${++calls}`,
					`${browser ? "browser open" : "web_fetch"} ${url}`,
					browser,
				);
				try {
					return await gate!.destination(new URL(url), (host) => guard.resolve(host));
				} finally {
					gate!.close();
				}
			};
			expect(await reach("http://router.attacker.example/", true)).toBeUndefined();
			expect(asked).toHaveLength(2);
			expect(asked[1]!.title).toContain(
				"router.attacker.example leads to 192.168.1.1, on your local or private network",
			);
			expect(asked[1]!.options.slice(0, 2)).toEqual([
				"Allow router.attacker.example@192.168.1.1 for this command",
				"Allow router.attacker.example@192.168.1.1 in this session",
			]);
			expect(asked[1]!.options.join("\n")).not.toContain("every site");
			// Kept for the session: neither question again, from the browser or web_fetch.
			expect(await reach("http://router.attacker.example/other", false)).toBeUndefined();
			expect(asked).toHaveLength(2);
		});

		it("refuses web_fetch and the browser on a name that leads to an address the user blocked", async () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ sandbox: { modes: { broad: false }, network: { deny: ["192.168.1.1"] } } }),
			);
			let events: EventBus | undefined;
			const harness = await createHarness({
				extensionFactories: [
					{ name: "permissions", factory: permissionsExtension },
					{
						name: "probe",
						factory: (pi) => {
							events = pi.events;
						},
					},
				],
			});
			harnesses.push(harness);
			const asked: string[] = [];
			await harness.session.bindExtensions({
				uiContext: createTestUiContext({
					select: async (title, options) => {
						asked.push(title);
						return options.find((option) => option.endsWith("in this session"));
					},
				}),
			});
			const guard = new DnsGuard(resolver());
			let calls = 0;
			const reach = async (url: string, browser: boolean) => {
				const gate = toolNetworkGate(events!, `call-${++calls}`, `web_fetch ${url}`, browser);
				try {
					return await gate!.destination(new URL(url), (host) => guard.resolve(host));
				} finally {
					gate!.close();
				}
			};
			for (const browser of [false, true])
				expect(await reach("http://router.attacker.example/", browser)).toContain(
					"router.attacker.example leads to 192.168.1.1, which is blocked",
				);
			// The name's question only: the address is never offered.
			expect(asked).toHaveLength(1);
			expect(await reach("http://docs.example.com/", false)).toBeUndefined();
		});
	});
});
