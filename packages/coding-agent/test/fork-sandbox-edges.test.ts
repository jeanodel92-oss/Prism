import { describe, expect, it } from "vitest";
import type { Args } from "../src/cli/args.ts";
import { startsFresh } from "../src/fork/sandbox/home-start.ts";
import { DEFAULT_SANDBOX_SETTINGS } from "../src/fork/sandbox/layout.ts";
import { describeSandbox } from "../src/fork/sandbox/notes.ts";
import { type SeccompArch, seccompFilter } from "../src/fork/sandbox/seccomp.ts";
import { webFetchDestinations, webFetchUrls } from "../src/fork/sandbox/tool-network.ts";

describe("web_fetch URL lists", () => {
	// a list element is one URL, commas in its path or query included.
	it("keeps commas inside each array element", () => {
		const url = "https://example.test/api?fields=name,email";
		expect(webFetchUrls([url])).toEqual([url]);
		expect(webFetchUrls(["https://example.test/a,b/c", "https://other.test/"])).toEqual([
			"https://example.test/a,b/c",
			"https://other.test/",
		]);
		expect(webFetchUrls(JSON.stringify([url]))).toEqual([url]);
		expect(webFetchDestinations([url])).toEqual(["example.test"]);
	});

	it("still splits a plain string listing several URLs", () => {
		expect(webFetchUrls("https://a.test/x, https://b.test/y")).toEqual(["https://a.test/x", "https://b.test/y"]);
		expect(webFetchUrls("https://a.test/x,https://b.test/y https://c.test/.")).toEqual([
			"https://a.test/x",
			"https://b.test/y",
			"https://c.test/",
		]);
		expect(webFetchUrls("https://example.test/api?fields=name,email")).toEqual([
			"https://example.test/api?fields=name,email",
		]);
	});
});

describe("home start with paths relative to the launch folder", () => {
	const args = (extra: Partial<Args>): Args =>
		({ messages: [], fileArgs: [], unknownFlags: new Map(), diagnostics: [], ...extra }) as Args;

	// moving to a new folder would reread these from the wrong place.
	it("does not start fresh with a relative prompt file or session folder", () => {
		// The tests run in the package folder, where package.json exists.
		expect(startsFresh(args({ appendSystemPrompt: ["./package.json"] }))).toBe(false);
		expect(startsFresh(args({ systemPrompt: "package.json" }))).toBe(false);
		expect(startsFresh(args({ sessionDir: "sessions" }))).toBe(false);
	});

	it("still starts fresh with literal prompts and absolute paths", () => {
		expect(startsFresh(args({ appendSystemPrompt: ["Answer in French."] }))).toBe(true);
		expect(startsFresh(args({ systemPrompt: "Be concise.", sessionDir: "/abs/sessions" }))).toBe(true);
		expect(startsFresh(args({ appendSystemPrompt: [`${process.cwd()}/package.json`] }))).toBe(true);
		expect(startsFresh(args({ sessionDir: "~/sessions" }))).toBe(true);
	});
});

/** Runs a classic BPF seccomp program on one system call, with only the instructions the filter uses. */
function runFilter(filter: Buffer, arch: number, nr: number, args: number[]): number {
	const data = Buffer.alloc(64);
	data.writeUInt32LE(nr, 0);
	data.writeUInt32LE(arch, 4);
	for (const [index, value] of args.entries()) data.writeUInt32LE(value, 16 + 8 * index);
	let accumulator = 0;
	for (let pc = 0; pc < filter.length / 8; pc++) {
		const code = filter.readUInt16LE(pc * 8);
		const jt = filter.readUInt8(pc * 8 + 2);
		const jf = filter.readUInt8(pc * 8 + 3);
		const k = filter.readUInt32LE(pc * 8 + 4);
		if (code === 0x20) accumulator = data.readUInt32LE(k);
		else if (code === 0x54) accumulator = (accumulator & k) >>> 0;
		else if (code === 0x06) return k;
		else if (code === 0x15) pc += accumulator === k ? jt : jf;
		else if (code === 0x35) pc += accumulator >= k ? jt : jf;
		else if (code === 0x45) pc += (accumulator & k) !== 0 ? jt : jf;
		else throw new Error(`unknown BPF code ${code}`);
	}
	throw new Error("the filter ran past its end");
}

describe("seccomp socket families", () => {
	const ALLOW = 0x7fff0000;
	const EPERM = 0x00050001;
	const cases: [SeccompArch, number, number][] = [
		["x64", 0xc000003e, 41],
		["arm64", 0xc00000b7, 198],
	];

	// fork: AF_VSOCK reached the machine's vsock services without the proxy.
	it.each(cases)("%s: allows IPv4, IPv6 and netlink sockets only", (arch, audit, socket) => {
		const filter = seccompFilter(arch);
		const run = (family: number) => runFilter(filter, audit, socket, [family, 1, 0, 0]);
		expect(run(2)).toBe(ALLOW);
		expect(run(10)).toBe(ALLOW);
		expect(run(16)).toBe(ALLOW);
		for (const family of [0, 1, 17, 31, 38, 40, 44]) expect(run(family)).toBe(EPERM);
	});
});

describe("seccomp socketpair types", () => {
	const ALLOW = 0x7fff0000;
	const EPERM = 0x00050001;
	const cases: [SeccompArch, number, number][] = [
		["x64", 0xc000003e, 53],
		["arm64", 0xc00000b7, 199],
	];

	// a datagram pair end can be connected again to a host socket on a visible path.
	it.each(cases)("%s: allows stream and seqpacket pairs, refuses datagram ones", (arch, audit, socketpair) => {
		const filter = seccompFilter(arch);
		const run = (type: number) => runFilter(filter, audit, socketpair, [1, type, 0, 0]);
		const CLOEXEC = 0x80000;
		const NONBLOCK = 0x800;
		expect(run(1)).toBe(ALLOW);
		expect(run(1 | CLOEXEC | NONBLOCK)).toBe(ALLOW);
		expect(run(5 | CLOEXEC)).toBe(ALLOW);
		expect(run(2)).toBe(EPERM);
		expect(run(2 | CLOEXEC)).toBe(EPERM);
		expect(run(3)).toBe(EPERM);
	});
});

describe("/sandbox and the system bus", () => {
	// with service state on, the system bus is filtered, not blocked.
	it("describes the system bus according to the service state setting", () => {
		const describe = (serviceState: boolean) =>
			describeSandbox({
				mode: "ask",
				active: true,
				settings: { ...DEFAULT_SANDBOX_SETTINGS, serviceState },
				settingsPath: "/settings",
			});
		expect(describe(false)).toContain("System D-Bus and Unix sockets: blocked");
		const on = describe(true);
		expect(on).not.toContain("System D-Bus and Unix sockets: blocked");
		expect(on).toContain(
			"System D-Bus: commands read the state of services, other calls are refused; Unix sockets: blocked",
		);
	});
});
