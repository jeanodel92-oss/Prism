// fork: pin a name's initial public/private scope and connect only to checked addresses.
import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { networkInterfaces } from "node:os";
import { domainToASCII } from "node:url";

const localAddresses = new BlockList();
for (const [address, prefix] of [
	["0.0.0.0", 32],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.168.0.0", 16],
] as const)
	localAddresses.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
	["::", 128],
	["::1", 128],
	["fc00::", 7],
	["fe80::", 10],
] as const)
	localAddresses.addSubnet(address, prefix, "ipv6");

export function isLocalAddress(address: string): boolean {
	const family = isIP(address);
	if (!family) throw new Error(`Invalid DNS address: ${address}`);
	// fork: BlockList also matches IPv4 subnets inside IPv4-mapped IPv6 addresses.
	return localAddresses.check(address, family === 4 ? "ipv4" : "ipv6");
}

const loopback = new BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("0.0.0.0", "ipv4");
loopback.addAddress("::1", "ipv6");
loopback.addAddress("::", "ipv6");

/**
 * fork: whether a connection to `address` reaches this machine: loopback, the
 * unspecified address, or an address of one of its interfaces, IPv4-mapped forms included.
 */
export function isMachineAddress(address: string, interfaces = networkInterfaces()): boolean {
	const bare = address.replace(/%.*$/, "");
	const family = isIP(bare);
	if (!family) return false;
	const type = family === 4 ? "ipv4" : "ipv6";
	if (loopback.check(bare, type)) return true;
	const own = new BlockList();
	for (const item of Object.values(interfaces).flat()) {
		if (item) own.addAddress(item.address.replace(/%.*$/, ""), item.family === "IPv4" ? "ipv4" : "ipv6");
	}
	return own.check(bare, type);
}

/**
 * fork: the name sandboxed commands reach this machine's allowed ports by;
 * `localhost` there is the sandbox's own (`session-net.ts`).
 */
export const HOST_ALIAS = "host.prism.internal";

/** `localhost` and the names under it (RFC 6761), and `host.prism.internal`: this machine. */
export const isMachineName = (host: string) =>
	/^(?:.+\.)?localhost\.?$/i.test(host) || host.toLowerCase().replace(/\.$/, "") === HOST_ALIAS;

/**
 * fork (SEC-07): a name or address that means the sandbox's own loopback for a sandboxed command: `localhost`,
 * 127.0.0.0/8, ::1 and the unspecified addresses; not `host.prism.internal`.
 */
export function isSandboxLoopback(host: string): boolean {
	if (/^(?:.+\.)?localhost\.?$/i.test(host)) return true;
	let bare = host.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
	// The forms a client also takes for an address: `127.1`, `2130706433`, `0x7f.1`, `0:0::1`.
	try {
		bare = new URL(`http://${bare.includes(":") ? `[${bare}]` : bare}/`).hostname.replace(/^\[|\]$/g, "");
	} catch {
		// Not an address or a name a URL takes: compared as it is.
	}
	const family = isIP(bare);
	return family !== 0 && loopback.check(bare, family === 4 ? "ipv4" : "ipv6");
}

export class DnsRebindingError extends Error {
	constructor(host: string, address: string) {
		super(`DNS rebinding blocked for ${host}: initially public, now resolves to local address ${address}.`);
		this.name = "DnsRebindingError";
	}
}

export type DnsResolver = (host: string) => Promise<LookupAddress[]>;

export class DnsGuard {
	private readonly initiallyPublic = new Map<string, boolean>();
	private readonly resolver: DnsResolver;

	constructor(resolver: DnsResolver = (host) => lookup(host, { all: true })) {
		this.resolver = resolver;
	}

	async resolve(host: string): Promise<LookupAddress[]> {
		const name = host.toLowerCase().replace(/\.$/, "");
		const literal = host.replace(/^\[|\]$/g, "");
		const family = isIP(literal);
		if (family) return [{ address: literal, family }];
		const addresses = await this.resolver(host);
		if (addresses.length === 0) throw new Error(`No DNS addresses for ${name}`);
		if (name === "localhost") return addresses;
		const local = addresses.find(({ address }) => isLocalAddress(address));
		// fork: mixed answers start public too, so a later private-only answer cannot downgrade them.
		if (!this.initiallyPublic.has(name)) {
			this.initiallyPublic.set(
				name,
				addresses.some(({ address }) => !isLocalAddress(address)),
			);
		}
		if (this.initiallyPublic.get(name) && local) throw new DnsRebindingError(name, local.address);
		return addresses;
	}

	readonly lookup: LookupFunction = (host, options, callback) => {
		void this.resolve(host).then(
			(addresses) => answer(host, addresses, options, callback),
			(error: Error) => callback(error, []),
		);
	};
}

type LookupOptions = Parameters<LookupFunction>[1];
type LookupCallback = Parameters<LookupFunction>[2];

function answer(host: string, addresses: LookupAddress[], options: LookupOptions, callback: LookupCallback): void {
	const family = options.family === "IPv4" ? 4 : options.family === "IPv6" ? 6 : options.family;
	const eligible = family ? addresses.filter((address) => address.family === family) : addresses;
	const first = eligible[0];
	if (!first) callback(new Error(`No DNS addresses for ${host} in family ${family}`), []);
	else if (options.all) callback(null, eligible);
	else callback(null, first.address, first.family);
}

/** fork: a connection to a checked name that its check could not resolve. */
export class UncheckedAddressError extends Error {
	constructor(host: string) {
		super(`${host} could not be resolved when its destination was checked; it was not contacted.`);
		this.name = "UncheckedAddressError";
	}
}

/**
 * fork: one form for a host name: lower case, no final dot, and an internationalized
 * name in its ASCII form, the one a URL and a connection carry. `*.` keeps its place; a text that is not a domain
 * (`localhost:3000`, an address) is left as it is.
 */
export function asciiHost(host: string): string {
	const name = host.toLowerCase().replace(/\.$/, "");
	if (!/[^\x00-\x7f]/.test(name)) return name;
	const wildcard = name.startsWith("*.") ? "*." : "";
	return wildcard + (domainToASCII(name.slice(wildcard.length)) || name.slice(wildcard.length));
}

const hostKey = (host: string) => asciiHost(host.replace(/^\[|\]$/g, ""));

/**
 * fork: the addresses a policy check resolved, by name, for one request. A connection
 * to a name the check resolved goes to those addresses only, so the name cannot lead to a port of this machine the
 * check never allowed by answering otherwise the second time. A name the check never resolved (a proxy, this
 * machine's names, whose port was checked) is resolved by the guard, as before.
 */
export class PinnedLookup {
	private readonly guard: DnsGuard;
	private readonly pinned = new Map<string, LookupAddress[] | undefined>();

	constructor(guard: DnsGuard) {
		this.guard = guard;
	}

	/** Resolves `host` for a check; a connection to it then uses these addresses. */
	readonly resolve = async (host: string): Promise<LookupAddress[]> => {
		const key = hostKey(host);
		this.pinned.set(key, undefined);
		const addresses = await this.guard.resolve(host);
		this.pinned.set(key, addresses);
		return addresses;
	};

	readonly lookup: LookupFunction = (host, options, callback) => {
		const key = hostKey(host);
		if (!this.pinned.has(key)) return this.guard.lookup(host, options, callback);
		const addresses = this.pinned.get(key);
		if (addresses) answer(host, addresses, options, callback);
		else callback(new UncheckedAddressError(host), []);
	};
}

/**
 * A lookup that answers with addresses already checked, without resolving again: the connection keeps its
 * host name (TLS, logs) and still tries each address in turn (Node's happy eyeballs).
 */
export const checkedLookup =
	(addresses: LookupAddress[]): LookupFunction =>
	(host, options, callback) =>
		answer(host, addresses, options, callback);
