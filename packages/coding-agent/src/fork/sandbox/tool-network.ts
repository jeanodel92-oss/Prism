/**
 * fork: Prism's own network tools (`web_fetch`, `web_search`) follow the
 * host policy of the sandboxed commands. Allowing the tool is not allowing its destinations: each destination is
 * checked before anything is sent to it, or to a provider that would fetch it in its place.
 *
 * The permissions extension answers {@link TOOL_NETWORK_EVENT} with a gate for one tool call; without that
 * extension (or in unrestricted mode) there is no gate and the tools behave as before.
 */
import type { LookupAddress } from "node:dns";
import type { EventBus } from "../../core/event-bus.ts";
import { isMachineAddress, isMachineName, isSandboxLoopback } from "./dns-guard.ts";
import { localPortName, localPortOf, privateAddressName, privateAddressOf } from "./proxy.ts";

export const TOOL_NETWORK_EVENT = "prism:tool-network";

/** Emitted by a tool for one call; the permissions extension sets `gate`. */
export interface ToolNetworkRequest {
	toolCallId: string;
	/** The call as a question shows it, e.g. `web_fetch https://example.com/`. */
	command: string;
	/** The `browser` tool: its host question also offers every site for the session. */
	browser?: boolean;
	gate?: ToolNetworkGate;
}

export interface ToolNetworkGate {
	/**
	 * Whether the call may reach `url`: undefined when allowed, the refusal otherwise. Asks when the policy asks;
	 * nothing is sent before the answer. `resolve` is the tool's own DNS guard, so that the addresses checked are
	 * the ones it connects to.
	 */
	destination(url: URL, resolve: (host: string) => Promise<LookupAddress[]>): Promise<string | undefined>;
	/** A provider endpoint the user configured (search, Exa): refused only when the user blocked its host. */
	provider(url: URL): string | undefined;
	/** The call is over: its answers end with it. */
	close(): void;
}

/** The gate for one tool call, or undefined when no permissions extension gives one. */
export function toolNetworkGate(
	events: EventBus,
	toolCallId: string,
	command: string,
	browser = false,
): ToolNetworkGate | undefined {
	const request: ToolNetworkRequest = { toolCallId, command, ...(browser ? { browser } : {}) };
	events.emit(TOOL_NETWORK_EVENT, request);
	return request.gate;
}

/** A JSON-encoded list of URLs, as some models send it in the string form of `urls`; else the string. */
export function parseUrlList(value: string): string[] {
	if (!value.trim().startsWith("[")) return [value];
	try {
		const parsed: unknown = JSON.parse(value);
		if (Array.isArray(parsed)) return parsed.map(String);
	} catch {
		// Not JSON: split like any other string.
	}
	return [value];
}

/**
 * The URLs a `web_fetch` call asks for, as the tool reads them. Models routinely pass several URLs as one comma-
 * or space-separated string despite the array schema, so split that string rather than treat it as one URL;
 * or as a JSON-encoded list in that string.
 */
export function webFetchUrls(urls: unknown): string[] {
	// fork: a list element is one URL, commas in its path or query included. Only a plain
	// string is split, on whitespace and on a comma that starts another http(s) URL, and loses trailing punctuation.
	const list = typeof urls === "string" ? parseUrlList(urls) : Array.isArray(urls) ? urls.map(String) : [];
	const plain = typeof urls === "string" && list.length === 1 && list[0] === urls;
	const split = plain
		? urls.split(/\s+|,+(?=\s*https?:\/\/)/i).map((url) => url.trim().replace(/[.,;]+$/, ""))
		: list.flatMap((entry) => entry.trim().split(/\s+/));
	return split.filter((url) => /^https?:\/\/\S+$/i.test(url)).slice(0, 5);
}

/** The names the policy checks first for a `web_fetch` call's URLs, as its question shows them. */
export function webFetchDestinations(urls: unknown): string[] {
	const names = new Set<string>();
	for (const url of webFetchUrls(urls)) {
		try {
			names.add(destinationName(new URL(url)));
		} catch {
			// Not a URL: the tool reports it.
		}
	}
	return [...names];
}

const bareHost = (url: URL) =>
	url.hostname
		.replace(/^\[|\]$/g, "")
		.toLowerCase()
		.replace(/\.$/, "");
const portOf = (url: URL) => Number(url.port) || (url.protocol === "https:" ? 443 : 80);

/**
 * The name the policy allows a destination under. Prism's own process is on this machine, so its loopback and
 * addresses are this machine's services: allowed port by port, as `host.prism.internal` for a command.
 */
export function destinationName(url: URL): string {
	const host = bareHost(url);
	return isMachineName(host) || isMachineAddress(host) || isSandboxLoopback(host) ? localPortName(portOf(url)) : host;
}

const refusal = (url: URL, name: string) => {
	const lan = privateAddressOf(name);
	return localPortOf(name) !== undefined
		? `Refused by Prism's network permissions: port ${portOf(url)} of this machine (${bareHost(url)}) is not allowed. Nothing was sent. Ask the user to allow ${name}.`
		: lan
			? `Refused by Prism's network permissions: ${bareHost(url)} leads to ${lan.addresses.join(", ")}, a private address, which is not allowed. Nothing was sent. Ask the user to allow ${name}.`
			: `Refused by Prism's network permissions: ${name} is not allowed. Nothing was sent. Ask the user to allow it.`;
};

/**
 * Checks `url` as the sandbox proxy checks a command's connection: its host (or this machine's port) first,
 * before any DNS query; then, for a name leading to this machine, its port too; for a name leading to a private
 * network, that name at those addresses.
 */
export async function checkDestination(
	url: URL,
	allows: (name: string) => Promise<boolean>,
	resolve: (host: string) => Promise<LookupAddress[]>,
	/** fork: whether the user blocked this address; a name that leads to it is refused too. */
	blocked: (address: string) => boolean = () => false,
): Promise<string | undefined> {
	if (url.protocol !== "http:" && url.protocol !== "https:") return `Refused: ${url.protocol} is not http(s).`;
	const name = destinationName(url);
	if (!(await allows(name))) return refusal(url, name);
	if (localPortOf(name) !== undefined) return undefined;
	let addresses: LookupAddress[];
	try {
		addresses = await resolve(bareHost(url));
	} catch {
		// The fetch fails on its own, with the resolver's or the DNS guard's reason.
		return undefined;
	}
	const blockedAt = addresses.find(({ address }) => blocked(address))?.address;
	if (blockedAt !== undefined)
		return `Refused by Prism's network permissions: ${bareHost(url)} leads to ${blockedAt}, which is blocked. Nothing was sent.`;
	const port = localPortName(portOf(url));
	if (addresses.some(({ address }) => isMachineAddress(address)) && !(await allows(port))) return refusal(url, port);
	const lan = privateAddressName(bareHost(url), addresses);
	if (lan !== undefined && !(await allows(lan))) return refusal(url, lan);
	return undefined;
}
