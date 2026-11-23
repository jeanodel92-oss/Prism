/**
 * fork: Prism's own requests reach only what the network permissions checked.
 * One invariant: a local server that counts its connections receives none from a destination the policy refused,
 * whether the name answers otherwise the second time, the endpoint redirects, or the command ended meanwhile.
 */
import type { LookupAddress } from "node:dns";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { connect, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkInstalls, guardedFetch, parseInstalls } from "../src/fork/npm-guard.ts";
import type * as DnsGuardModule from "../src/fork/sandbox/dns-guard.ts";
import { DnsGuard, PinnedLookup } from "../src/fork/sandbox/dns-guard.ts";
import { HostPolicy, matchesHost, serveProxyStream } from "../src/fork/sandbox/proxy.ts";
import { checkDestination, type ToolNetworkGate } from "../src/fork/sandbox/tool-network.ts";
import { directFetch } from "../src/fork/web.ts";
import { searchProvider } from "../src/fork/web-search-providers.ts";

// As in fork-dns-rebinding.test.ts: 127.0.0.2 stands for a host of the network, so these tests stay on this machine.
vi.mock("../src/fork/sandbox/dns-guard.ts", async (importOriginal) => {
	const original = await importOriginal<typeof DnsGuardModule>();
	const network = new Set(["127.0.0.2"]);
	const isMachineAddress: typeof original.isMachineAddress = (address, ...rest) =>
		!network.has(address) && original.isMachineAddress(address, ...rest);
	const isSandboxLoopback: typeof original.isSandboxLoopback = (host) =>
		!network.has(host) && original.isSandboxLoopback(host);
	return { ...original, isMachineAddress, isSandboxLoopback };
});

const networkHost: LookupAddress = { address: "127.0.0.2", family: 4 };
const machine: LookupAddress = { address: "127.0.0.1", family: 4 };

const servers: Server[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
	for (const socket of sockets.splice(0)) socket.destroy();
	await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
	vi.unstubAllEnvs();
});

/** A server on `host` that counts the connections it receives. */
async function counting(host = "127.0.0.1", serve?: Parameters<typeof createHttpServer>[1]) {
	const server = serve ? createHttpServer(serve) : createServer((socket) => sockets.push(socket));
	const counter = { connections: 0, port: 0 };
	server.on("connection", (socket: Socket) => {
		counter.connections++;
		sockets.push(socket);
	});
	servers.push(server);
	server.listen(0, host);
	await once(server, "listening");
	counter.port = (server.address() as { port: number }).port;
	return counter;
}

/** A name that answers a network host first, then this machine: the check sees the first answer only. */
const rebinding = () => {
	let calls = 0;
	return vi.fn(async () => (calls++ === 0 ? [networkHost] : [machine]));
};

/** The permission of a tool call: only `allowed` may be reached, never a port of this machine. */
const gateFor = (allowed: string): ToolNetworkGate => ({
	destination: (url, resolve) => checkDestination(url, async (name) => name === allowed, resolve),
	provider: () => undefined,
	close: () => {},
});

describe("fork: Prism's requests reach only the checked destinations", () => {
	it("web_fetch connects to the addresses its check resolved, not to a later answer", async () => {
		for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) vi.stubEnv(name, "");
		const local = await counting();
		const guard = new DnsGuard(rebinding());
		await directFetch(
			`http://rebind.test:${local.port}/`,
			AbortSignal.timeout(3_000),
			guard,
			gateFor("rebind.test"),
		).catch(() => undefined);
		expect(local.connections).toBe(0);
	});

	it("the npm guard's request goes to the addresses its check resolved", async () => {
		for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) vi.stubEnv(name, "");
		const local = await counting();
		const pins = new PinnedLookup(new DnsGuard(rebinding()));
		const url = new URL(`http://registry.test:${local.port}/pkg`);
		// fork: the name leads to a private address, allowed too.
		const allowed = ["registry.test", "registry.test@127.0.0.2"];
		expect(await checkDestination(url, async (name) => allowed.includes(name), pins.resolve)).toBeUndefined();
		const registry = guardedFetch(pins.lookup);
		try {
			await registry
				.fetch(url.href, { signal: AbortSignal.timeout(3_000), redirect: "error" })
				.catch(() => undefined);
		} finally {
			await registry.close();
		}
		expect(local.connections).toBe(0);
	});

	it("a search endpoint that redirects is not followed to a refused port", async () => {
		const refused = await counting();
		const endpoint = await counting("127.0.0.1", (_request, response) => {
			response.writeHead(302, { location: `http://127.0.0.1:${refused.port}/admin` }).end();
		});
		const error = await searchProvider(
			"searxng",
			"query",
			5,
			undefined,
			`http://127.0.0.1:${endpoint.port}`,
			AbortSignal.timeout(3_000),
		).catch((failure: Error) => failure);
		expect(endpoint.connections).toBe(1);
		expect(refused.connections).toBe(0);
		expect(String(error)).toMatch(/redirects are not followed/);
	});

	it("opens no connection for a command whose network ended during its DNS lookup", async () => {
		const target = await counting(networkHost.address);
		let answer!: () => void;
		const resolving = new Promise<void>((done) => {
			answer = done;
		});
		const resolver = vi.fn(async () => {
			await resolving;
			return [networkHost];
		});
		const policy = new HostPolicy(
			() => ({ askNewHosts: false, allow: ["late.test"], deny: [] }),
			undefined,
			undefined,
			new DnsGuard(resolver),
		);
		const network = policy.open({ command: "curl" });
		const proxy = createServer((socket) => serveProxyStream(socket, network));
		servers.push(proxy);
		proxy.listen(0, "127.0.0.1");
		await once(proxy, "listening");
		const client = connect((proxy.address() as { port: number }).port, "127.0.0.1");
		sockets.push(client);
		client.on("error", () => {});
		client.write(`CONNECT late.test:${target.port} HTTP/1.1\r\n\r\n`);
		await vi.waitFor(() => expect(resolver).toHaveBeenCalled());
		network.close();
		answer();
		await new Promise((done) => setTimeout(done, 200));
		expect(target.connections).toBe(0);
	});

	it("sends nothing to a registry for a global npm install", async () => {
		expect(parseInstalls("npm install -g confidential-package")[0]?.unverifiable).toBe(true);
		expect(parseInstalls("npm i --location global confidential-package")[0]?.unverifiable).toBe(true);
		expect(parseInstalls("npm i --location=global confidential-package")[0]?.unverifiable).toBe(true);
		expect(parseInstalls("npm i confidential-package")[0]?.unverifiable).toBe(false);
		const fetch = vi.fn(async () => new Response("{}", { status: 404 }));
		const project = "/project";
		const files: Record<string, string> = {
			[join(project, "package.json")]: "{}",
			[join(project, ".npmrc")]: "registry=https://registry.npmjs.org/",
			"/home/.npmrc": "registry=https://npm.private.example/",
		};
		const read = (path: string) => files[path];
		for (const [command, env] of [
			["npm install -g confidential-package", {}],
			["npm install confidential-package", { npm_config_global: "true" }],
			["npm install confidential-package", { npm_config_location: "global" }],
		] as const) {
			const results = await checkInstalls(command, { cwd: project, home: "/home", read, fetch, now: Date.now, env });
			expect(results[0]?.reasons.join(" ")).toContain("could not be determined");
		}
		expect(fetch).not.toHaveBeenCalled();
	});

	it.each([
		["xn--espaol-zwa.example.com", "español.example.com"],
		["español.example.com", "xn--espaol-zwa.example.com"],
		["api.xn--espaol-zwa.example.com", "*.español.example.com"],
		["ssh://xn--espaol-zwa.example.com", "ssh://español.example.com"],
	])("matches %s against the rule %s, in either form (CR-365)", (host, rule) => {
		expect(matchesHost(host, [rule], true)).toBe(true);
		expect(matchesHost(host, [rule])).toBe(true);
	});

	it("keeps other names apart and rules that are not domains as written", () => {
		expect(matchesHost("xn--espaol-zwa.example.com", ["espanol.example.com"], true)).toBe(false);
		expect(matchesHost("localhost:3000", ["localhost:3000"])).toBe(true);
		expect(matchesHost("example.com", ["ssh://example.com"])).toBe(false);
	});
});
