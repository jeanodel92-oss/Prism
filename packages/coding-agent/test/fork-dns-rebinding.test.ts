// fork: deterministic DNS rebinding regressions; all connections stay on loopback.
import type { LookupAddress } from "node:dns";
import { once } from "node:events";
import { createServer } from "node:http";
import { connect, createServer as createNetServer, type Server, type Socket } from "node:net";
import type { NetworkInterfaceInfo } from "node:os";
import { createServer as createTlsServer } from "node:tls";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type * as DnsGuardModule from "../src/fork/sandbox/dns-guard.ts";
import {
	DnsGuard,
	DnsRebindingError,
	isLocalAddress,
	isMachineAddress,
	isMachineName,
} from "../src/fork/sandbox/dns-guard.ts";
import { HostPolicy, serveProxyStream } from "../src/fork/sandbox/proxy.ts";
import webExtension, { directFetch } from "../src/fork/web.ts";
import * as webSearchConfig from "../src/fork/web-search-config.ts";
import { createHarness, createTestUiContext, getMessageText } from "./suite/harness.ts";

const { systemResolver } = vi.hoisted(() => ({
	systemResolver: vi.fn<(host: string, options: { all: true }) => Promise<LookupAddress[]>>(),
}));
vi.mock("node:dns/promises", () => ({ lookup: systemResolver }));
// fork (SEC-07): the proxy refuses the sandbox's loopback, so stand-ins keep these tests on this machine:
// 127.0.0.2 and 127.0.0.4 stand for hosts of the network, 127.0.0.3 for this machine's address on the network.
vi.mock("../src/fork/sandbox/dns-guard.ts", async (importOriginal) => {
	const original = await importOriginal<typeof DnsGuardModule>();
	const network = new Set(["127.0.0.2", "127.0.0.4"]);
	const isMachineAddress: typeof original.isMachineAddress = (address, ...rest) =>
		!network.has(address) && original.isMachineAddress(address, ...rest);
	const isSandboxLoopback: typeof original.isSandboxLoopback = (host) =>
		!network.has(host) && host !== "127.0.0.3" && original.isSandboxLoopback(host);
	return { ...original, isMachineAddress, isSandboxLoopback };
});

const publicAddress: LookupAddress = { address: "93.184.216.34", family: 4 };
const privateAddress: LookupAddress = { address: "127.0.0.1", family: 4 };
const networkAddress: LookupAddress = { address: "127.0.0.2", family: 4 };

describe("DNS address classification", () => {
	it.each([
		"0.0.0.0",
		"10.0.0.0",
		"10.255.255.255",
		"100.64.0.0",
		"100.127.255.255",
		"127.0.0.0",
		"127.255.255.255",
		"169.254.0.0",
		"169.254.255.255",
		"172.16.0.0",
		"172.31.255.255",
		"192.168.0.0",
		"192.168.255.255",
		"::",
		"::1",
		"fc00::",
		"fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
		"fe80::",
		"febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
		"fe80::1%lo",
		"::ffff:127.0.0.1",
		"::ffff:7f00:1",
		"::ffff:10.1.2.3",
		"::ffff:100.64.0.1",
		"::ffff:169.254.1.1",
		"::ffff:172.16.1.1",
		"::ffff:192.168.1.1",
		"::ffff:0.0.0.0",
	])("recognizes local address %s", (address) => expect(isLocalAddress(address)).toBe(true));

	it.each([
		"0.0.0.1",
		"9.255.255.255",
		"11.0.0.0",
		"100.63.255.255",
		"100.128.0.0",
		"126.255.255.255",
		"128.0.0.0",
		"169.253.255.255",
		"169.255.0.0",
		"172.15.255.255",
		"172.32.0.0",
		"192.167.255.255",
		"192.169.0.0",
		"::2",
		"2001:4860:4860::8888",
		"fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
		"fe00::",
		"fe7f:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
		"fec0::",
		"::ffff:93.184.216.34",
	])("recognizes address outside the guarded ranges %s", (address) => expect(isLocalAddress(address)).toBe(false));

	it("rejects invalid resolver addresses", () => expect(() => isLocalAddress("invalid")).toThrow("Invalid DNS"));
});

// fork: this machine is allowed port by port, by any of its addresses.
describe("this machine's addresses and names", () => {
	const nic = (address: string, family: "IPv4" | "IPv6"): NetworkInterfaceInfo =>
		family === "IPv4"
			? { address, family, netmask: "255.255.255.0", mac: "00:00:00:00:00:00", internal: false, cidr: null }
			: { address, family, netmask: "ffff::", mac: "00:00:00:00:00:00", internal: false, cidr: null, scopeid: 2 };
	const interfaces = { eth0: [nic("192.168.1.20", "IPv4"), nic("fe80::1", "IPv6"), nic("fd7a::1a01", "IPv6")] };

	it.each([
		"127.0.0.1",
		"127.255.255.254",
		"0.0.0.0",
		"::1",
		"::",
		"::ffff:127.0.0.1",
		"::ffff:7f00:1",
		"::ffff:0.0.0.0",
		"192.168.1.20",
		"::ffff:192.168.1.20",
		"fe80::1",
		"fe80::1%eth0",
		"fd7a::1a01",
	])("recognizes %s", (address) => expect(isMachineAddress(address, interfaces)).toBe(true));

	it.each(["192.168.1.21", "10.0.0.1", "8.8.8.8", "fe80::2", "::2", "::ffff:8.8.8.8", "localhost", "invalid"])(
		"tells %s apart",
		(address) => expect(isMachineAddress(address, interfaces)).toBe(false),
	);

	it("takes localhost and the names under it for this machine, and no other name", () => {
		for (const name of ["localhost", "LOCALHOST.", "app.localhost", "a.b.localhost"])
			expect(isMachineName(name)).toBe(true);
		for (const name of ["localhost.example.com", "mylocalhost", "example.com", "127.0.0.1"])
			expect(isMachineName(name)).toBe(false);
	});
});

describe("session DNS pins", () => {
	it.each([
		"127.0.0.1",
		"10.0.0.1",
		"100.64.0.1",
		"169.254.1.1",
		"172.16.0.1",
		"192.168.1.1",
		"0.0.0.0",
		"::",
		"::1",
		"fc00::1",
		"fe80::1",
		"::ffff:127.0.0.1",
	])("blocks public then %s at the second access", async (address) => {
		const resolver = vi
			.fn()
			.mockResolvedValueOnce([publicAddress])
			.mockResolvedValue([{ address, family: address.includes(":") ? 6 : 4 }]);
		const guard = new DnsGuard(resolver);
		expect(await guard.resolve("Example.invalid.")).toEqual([publicAddress]);
		await expect(guard.resolve("example.invalid")).rejects.toThrow(DnsRebindingError);
		await expect(guard.resolve("EXAMPLE.INVALID")).rejects.toThrow("initially public");
		expect(resolver).toHaveBeenCalledWith("example.invalid");
		expect(resolver).toHaveBeenNthCalledWith(1, "Example.invalid.");
	});

	it("keeps private-first names private-capable even after a public answer", async () => {
		const resolver = vi
			.fn()
			.mockResolvedValueOnce([privateAddress])
			.mockResolvedValueOnce([publicAddress])
			.mockResolvedValue([privateAddress]);
		const guard = new DnsGuard(resolver);
		await expect(guard.resolve("self.invalid")).resolves.toEqual([privateAddress]);
		await expect(guard.resolve("self.invalid")).resolves.toEqual([publicAddress]);
		await expect(guard.resolve("self.invalid")).resolves.toEqual([privateAddress]);
	});

	it("allows changing public addresses and keeps hosts and sessions independent", async () => {
		const other: LookupAddress = { address: "1.1.1.1", family: 4 };
		const guard = new DnsGuard(
			vi
				.fn()
				.mockResolvedValueOnce([publicAddress])
				.mockResolvedValueOnce([other])
				.mockResolvedValue([privateAddress]),
		);
		await guard.resolve("public.invalid");
		await expect(guard.resolve("public.invalid")).resolves.toEqual([other]);
		await expect(guard.resolve("private.invalid")).resolves.toEqual([privateAddress]);
		await expect(new DnsGuard(async () => [privateAddress]).resolve("public.invalid")).resolves.toEqual([
			privateAddress,
		]);
	});

	it("rejects mixed answers containing a local address, including a non-first answer", async () => {
		const guard = new DnsGuard(
			vi.fn().mockResolvedValueOnce([publicAddress]).mockResolvedValue([publicAddress, privateAddress]),
		);
		await guard.resolve("mixed.invalid");
		await expect(guard.resolve("mixed.invalid")).rejects.toThrow("127.0.0.1");
		await expect(new DnsGuard(async () => [publicAddress, privateAddress]).resolve("mixed.invalid")).rejects.toThrow(
			DnsRebindingError,
		);
	});

	it("leaves IP literals and localhost unchanged", async () => {
		const resolver = vi.fn().mockResolvedValueOnce([publicAddress]).mockResolvedValue([privateAddress]);
		const guard = new DnsGuard(resolver);
		for (const host of ["127.0.0.1", "::1", "[::ffff:127.0.0.1]"]) await guard.resolve(host);
		expect(resolver).not.toHaveBeenCalled();
		await guard.resolve("localhost");
		await expect(guard.resolve("LOCALHOST.")).resolves.toEqual([privateAddress]);
	});

	it("does not pin empty answers or resolution failures", async () => {
		const guard = new DnsGuard(
			vi
				.fn()
				.mockRejectedValueOnce(new Error("DNS unavailable"))
				.mockResolvedValueOnce([])
				.mockResolvedValue([privateAddress]),
		);
		await expect(guard.resolve("retry.invalid")).rejects.toThrow("DNS unavailable");
		await expect(guard.resolve("retry.invalid")).rejects.toThrow("No DNS addresses");
		await expect(guard.resolve("retry.invalid")).resolves.toEqual([privateAddress]);
	});
});

describe("guarded network paths", () => {
	const servers: Server[] = [];
	const sockets: Socket[] = [];
	async function listen(server: Server, host = "127.0.0.1"): Promise<number> {
		servers.push(server);
		server.listen(0, host);
		await once(server, "listening");
		return (server.address() as { port: number }).port;
	}
	afterEach(async () => {
		vi.restoreAllMocks();
		systemResolver.mockReset();
		for (const socket of sockets.splice(0)) socket.destroy();
		await Promise.all(
			servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
		);
	});

	it.each(["CONNECT", "GET"])("blocks rebinding through the real proxy %s path across commands", async (method) => {
		const resolver = vi.fn().mockResolvedValueOnce([publicAddress]).mockResolvedValue([privateAddress]);
		const guard = new DnsGuard(resolver);
		const policy = new HostPolicy(() => ({ askNewHosts: false, allow: [], deny: [] }), undefined, undefined, guard);
		// fork: seed the first public resolution without contacting a public server.
		await policy.open({ command: "first" }).dnsGuard.resolve("rebind.invalid");
		const network = policy.open({ command: "second" });
		const received = vi.fn((socket: Socket) => socket.end("unexpected connection"));
		const target = await listen(createNetServer(received));
		const proxy = await listen(createNetServer((socket) => serveProxyStream(socket, network)));
		const socket = connect(proxy, "127.0.0.1");
		sockets.push(socket);
		const response = once(socket, "data");
		const uri = method === "CONNECT" ? `rebind.invalid:${target}` : `http://rebind.invalid:${target}/`;
		socket.write(`${method} ${uri} HTTP/1.1\r\nHost: rebind.invalid\r\n\r\n`);
		const [data] = await response;
		expect(String(data)).toContain("403 Forbidden");
		expect(String(data)).toContain("DNS rebinding blocked for rebind.invalid");
		expect(received).not.toHaveBeenCalled();
		expect(resolver).toHaveBeenCalledTimes(2);
	});

	it("connects the proxy to the checked IP instead of resolving the name again", async () => {
		const resolver = vi.fn(async () => [networkAddress]);
		// fork: a name's private address is allowed explicitly, questions off or not.
		const settings = { askNewHosts: false, allow: ["self.invalid@127.0.0.2"], deny: [] };
		const policy = new HostPolicy(() => settings, undefined, undefined, new DnsGuard(resolver));
		const target = await listen(
			createNetServer((socket) => {
				sockets.push(socket);
				socket.pipe(socket);
			}),
			networkAddress.address,
		);
		const proxy = await listen(
			createNetServer((socket) => serveProxyStream(socket, policy.open({ command: "curl" }))),
		);
		const socket = connect(proxy, "127.0.0.1");
		sockets.push(socket);
		const response = once(socket, "data");
		socket.write(`CONNECT self.invalid:${target} HTTP/1.1\r\n\r\n`);
		expect(String((await response)[0])).toContain("200 Connection Established");
		const echo = once(socket, "data");
		socket.write("ping");
		expect(String((await echo)[0])).toBe("ping");
		expect(resolver).toHaveBeenCalledTimes(1);
	});

	it("tries every checked address, as a connection by name would", async () => {
		// Nothing listens on 127.0.0.4 at this port: the proxy must go on to 127.0.0.2, not fail on the first address.
		const resolver = vi.fn(async () => [{ address: "127.0.0.4", family: 4 }, networkAddress]);
		const settings = { askNewHosts: false, allow: ["dual.invalid@127.0.0.2,127.0.0.4"], deny: [] };
		const policy = new HostPolicy(() => settings, undefined, undefined, new DnsGuard(resolver));
		const target = await listen(
			createNetServer((socket) => {
				sockets.push(socket);
				socket.pipe(socket);
			}),
			networkAddress.address,
		);
		const proxy = await listen(
			createNetServer((socket) => serveProxyStream(socket, policy.open({ command: "curl" }))),
		);
		const socket = connect(proxy, "127.0.0.1");
		sockets.push(socket);
		const response = once(socket, "data");
		socket.write(`CONNECT dual.invalid:${target} HTTP/1.1\r\n\r\n`);
		expect(String((await response)[0])).toContain("200 Connection Established");
	});

	it("opens a port of this machine alone, by host.prism.internal, IPv4 and IPv6", async () => {
		const settings = { askNewHosts: false, allow: ["localhost", "127.0.0.1", "::1"], deny: [] as string[] };
		const policy = new HostPolicy(() => settings, undefined);
		const reached: string[] = [];
		const serve = async (name: string, host: string) => {
			const server = createNetServer((socket) => {
				sockets.push(socket);
				reached.push(name);
				socket.end(name);
			});
			servers.push(server);
			server.listen(0, host);
			await once(server, "listening");
			return (server.address() as { port: number }).port;
		};
		const v4 = await serve("v4", "127.0.0.1");
		const v6 = await serve("v6", "::1");
		const closed = await serve("closed", "127.0.0.1");
		const lan = await serve("lan", "127.0.0.3");
		settings.allow.push(`localhost:${v4}`, `localhost:${v6}`, `localhost:${lan}`);
		const network = policy.open({ toolCallId: "t", command: "curl" });
		const proxy = await listen(createNetServer((socket) => serveProxyStream(socket, network)));
		const ask = async (request: string) => {
			const socket = connect(proxy, "127.0.0.1");
			sockets.push(socket);
			const chunks: Buffer[] = [];
			socket.on("data", (chunk: Buffer) => chunks.push(chunk));
			socket.write(request);
			await once(socket, "close");
			return Buffer.concat(chunks).toString();
		};
		const tunnel = (target: string) => ask(`CONNECT ${target} HTTP/1.1\r\n\r\n`);
		// The allowed ports, by the alias, IPv4 and IPv6.
		for (const target of [`host.prism.internal:${v4}`, `Host.Prism.Internal.:${v4}`]) {
			expect(await tunnel(target)).toMatch(/200 Connection Established\r\n\r\nv4$/);
		}
		expect(await tunnel(`host.prism.internal:${v6}`)).toMatch(/200 Connection Established\r\n\r\nv6$/);
		// Any other port stays closed; `localhost` or `127.0.0.1` allowed alone opens none.
		expect(await tunnel(`host.prism.internal:${closed}`)).toContain(
			`refused the connection to port ${closed} of this machine`,
		);
		expect(
			await ask(`GET http://host.prism.internal:${closed}/ HTTP/1.1\r\nHost: host.prism.internal\r\n\r\n`),
		).toContain(`Ask the user to allow localhost:${closed}`);
		// The sandbox's own loopback never leads to this machine, allowed port or not.
		for (const target of [
			`127.0.0.1:${v4}`,
			`localhost:${v4}`,
			`LocalHost.:${v4}`,
			`app.localhost:${v4}`,
			`[::1]:${v6}`,
			`127.1.2.3:${closed}`,
			`[::ffff:127.0.0.1]:${closed}`,
			`0.0.0.0:${closed}`,
		]) {
			expect(await tunnel(target)).toContain("this is the sandbox's own localhost");
		}
		expect(reached).toEqual(["v4", "v4", "v6"]);
		expect(new Set(policy.refusalsOf("t").map(({ host, why }) => `${host} ${why}`))).toEqual(
			new Set([`localhost:${closed} port`]),
		);
		// A name that leads to this machine's address on the network needs the port too; one that leads to
		// loopback means the sandbox's own.
		const named = new HostPolicy(
			() => settings,
			undefined,
			undefined,
			new DnsGuard(async (host) => [host === "dev.invalid" ? privateAddress : { address: "127.0.0.3", family: 4 }]),
		);
		const namedProxy = await listen(
			createNetServer((socket) => serveProxyStream(socket, named.open({ command: "curl" }))),
		);
		const viaName = async (target: string) => {
			const socket = connect(namedProxy, "127.0.0.1");
			sockets.push(socket);
			const response = once(socket, "data");
			socket.write(`CONNECT ${target} HTTP/1.1\r\n\r\n`);
			return String((await response)[0]);
		};
		expect(await viaName(`lan.invalid:${lan}`)).toContain("200 Connection Established");
		expect(await viaName(`lan.invalid:${closed}`)).toContain(`port ${closed} of this machine`);
		expect(await viaName(`dev.invalid:${v4}`)).toContain("this is the sandbox's own localhost");
		// `localhost` blocked blocks every port of this machine.
		settings.deny = ["localhost"];
		expect(await tunnel(`host.prism.internal:${v4}`)).toContain(
			`refused the connection to port ${v4} of this machine`,
		);
	});

	it("keeps the user's HTTP proxy for direct fetches", async () => {
		const seen: (string | undefined)[] = [];
		const port = await listen(
			createServer((req, res) => {
				seen.push(req.url);
				res.end("through the proxy");
			}),
		);
		const saved = { HTTP_PROXY: process.env.HTTP_PROXY, NO_PROXY: process.env.NO_PROXY };
		process.env.HTTP_PROXY = `http://127.0.0.1:${port}`;
		process.env.NO_PROXY = "";
		try {
			const resolver = vi.fn(async () => [privateAddress]);
			const fetched = await directFetch("http://example.invalid/page", undefined, new DnsGuard(resolver));
			expect(fetched.text).toBe("through the proxy");
			// A forward proxy receives the absolute URL; the name is the proxy's to resolve.
			expect(seen).toEqual(["http://example.invalid/page"]);
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	it("fetches private-first names repeatedly, preserves Host, and checks redirects", async () => {
		const hosts: (string | undefined)[] = [];
		const port = await listen(
			createServer((req, res) => {
				hosts.push(req.headers.host);
				if (req.url === "/redirect") {
					res.writeHead(302, { location: `http://blocked.invalid:${port}/` });
					res.end();
				} else res.end("local page");
			}),
		);
		const resolver = vi.fn(async (host: string) => (host === "blocked.invalid" ? [publicAddress] : [privateAddress]));
		const guard = new DnsGuard(resolver);
		for (let i = 0; i < 2; i++)
			expect((await directFetch(`http://self.invalid:${port}/`, undefined, guard)).text).toBe("local page");
		expect(hosts).toEqual([`self.invalid:${port}`, `self.invalid:${port}`]);
		await guard.resolve("blocked.invalid");
		resolver.mockImplementation(async () => [privateAddress]);
		await expect(directFetch(`http://self.invalid:${port}/redirect`, undefined, guard)).rejects.toThrow(
			"DNS rebinding blocked for blocked.invalid",
		);
		expect(hosts).toHaveLength(3);
	});

	it("refuses a second direct fetch of a name first seen public before contacting localhost", async () => {
		const received = vi.fn();
		const port = await listen(
			createServer((_req, res) => {
				received();
				res.end("must not be read");
			}),
		);
		const guard = new DnsGuard(vi.fn().mockResolvedValueOnce([publicAddress]).mockResolvedValue([privateAddress]));
		await guard.resolve("rebind.invalid");
		await expect(directFetch(`http://rebind.invalid:${port}/`, undefined, guard)).rejects.toThrow(
			"initially public, now resolves to local address 127.0.0.1",
		);
		expect(received).not.toHaveBeenCalled();
	});

	it("keeps the TLS server name when direct fetch connects through the checked lookup", async () => {
		const names: string[] = [];
		const server = createTlsServer({
			SNICallback: (name, callback) => {
				names.push(name);
				callback(new Error("Test stops the handshake after inspecting SNI"));
			},
		});
		server.on("tlsClientError", () => {});
		const port = await listen(server);
		await expect(
			directFetch(`https://self.invalid:${port}/`, undefined, new DnsGuard(async () => [privateAddress])),
		).rejects.toThrow();
		expect(names).toEqual(["self.invalid"]);
	});

	it("shares web tool pins across calls and returns an explicit rebinding error result", async () => {
		const port = await listen(createServer((_req, res) => res.end("local test server")));
		vi.spyOn(SettingsManager, "create").mockReturnValue(SettingsManager.inMemory());
		vi.spyOn(webSearchConfig, "resolveWebSearchKey").mockResolvedValue({ source: "none" });
		const resolver = systemResolver.mockResolvedValueOnce([publicAddress]).mockResolvedValue([privateAddress]);
		const originalResolve = DnsGuard.prototype.resolve;
		vi.spyOn(DnsGuard.prototype, "resolve").mockImplementation(async function (this: DnsGuard, host) {
			const addresses = await originalResolve.call(this, host);
			// fork: record the public answer without allowing any public connection in this test.
			if (addresses[0]?.address === publicAddress.address) throw new Error("Public connection suppressed by test");
			return addresses;
		});
		const harness = await createHarness({ extensionFactories: [{ name: "web", factory: webExtension }] });
		try {
			await harness.session.bindExtensions({ uiContext: createTestUiContext() });
			const runner = harness.session.extensionRunner;
			const tool = runner.getToolDefinition("web_fetch")!;
			const context = runner.createToolContext("fetch", undefined);
			const params = { urls: `http://rebind.invalid:${port}/` };
			expect((await tool.execute("first", params, undefined, undefined, context)).isError).toBe(true);
			const result = await tool.execute("second", params, undefined, undefined, context);
			expect(result.isError).toBe(true);
			expect(getMessageText(result)).toContain("DNS rebinding blocked for rebind.invalid");
			expect(resolver).toHaveBeenCalledWith("rebind.invalid", { all: true });
			expect(resolver).toHaveBeenCalledTimes(2);
		} finally {
			harness.cleanup();
		}
	});
});
