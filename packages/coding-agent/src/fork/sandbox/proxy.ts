/**
 * fork: Prism's side of the sandbox network. For each
 * sandboxed command, a pair of pipes carries the relay's connections here; each one is an HTTP proxy
 * request (CONNECT for HTTPS, an absolute URL for plain HTTP), allowed or refused by host name.
 */

import { spawnSync } from "node:child_process";
import type { LookupAddress } from "node:dns";
import { constants, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, isIP, Socket } from "node:net";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { isReservedBrowserPort } from "../browser/bidi.ts";
import { hostProgram } from "../host-program.ts";
import { CONTAINERS_METHOD, serveContainers } from "./containers.ts";
import { DBUS_METHOD, serveDbus } from "./dbus.ts";
import {
	asciiHost,
	checkedLookup,
	DnsGuard,
	DnsRebindingError,
	HOST_ALIAS,
	isLocalAddress,
	isMachineAddress,
	isMachineName,
	isSandboxLoopback,
} from "./dns-guard.ts";
import { GIT_SIGN_METHOD, serveGitSign } from "./git-sign.ts";
import { GIT_SSH_METHOD, gitSshHostOf, serveGitSsh } from "./git-ssh.ts";
import { Mux } from "./mux.ts";
import type { HostRefusal } from "./notes.ts";

export interface NetworkSettings {
	/** Ask at the first connection to a host not listed (can be turned off). */
	askNewHosts: boolean;
	/** Hosts allowed without a question; `*.example.com` covers its subdomains. */
	allow: string[];
	/** Hosts always refused, even when questions are off. */
	deny: string[];
}

export const DEFAULT_NETWORK_SETTINGS: NetworkSettings = { askNewHosts: true, allow: [], deny: [] };

/**
 * What the user answered for a host: "command" lasts until the command ends, "session" covers matching
 * commands in this session, "project" is kept for the project, "task" for the task scope;
 * "scope" is a refusal without a question, outside the scope of a task the user left running.
 */
export type HostAnswer = "command" | "session" | "project" | "task" | "deny" | "unanswered" | "scope";

/** The command a network channel serves: answers for it go to it alone and last until it ends. */
export interface NetworkCommand {
	/** The tool call that ran it, when one did; its result reports the refusals. */
	toolCallId?: string;
	/** The command, as the question shows it. */
	command: string;
	/** Native network tools keep their session-wide host approvals. */
	nonCommand?: boolean;
	/** The `browser` tool's call: its question also offers every site for the session. */
	browser?: boolean;
}

export interface SessionHostGrant {
	host: string;
	/** Absent for a native network tool's session-wide approval. */
	command?: string;
}

/** A host the policy refused, and for which tool call (the command's result says so). */
export interface RecordedRefusal extends HostRefusal {
	toolCallId?: string;
}

const KEPT_REFUSALS = 100;

/**
 * fork: a port of this machine is allowed under this name, one port at a time,
 * whatever address or name reached it; `localhost` alone, or `127.0.0.1`, opens no port.
 */
export const localPortName = (port: number) => `localhost:${port}`;

/** The port a `localhost:<port>` name allows, or undefined. */
export function localPortOf(name: string): number | undefined {
	const match = /^localhost:(\d{1,5})$/i.exec(name);
	const port = Number(match?.[1]);
	return match && port > 0 && port < 65536 ? port : undefined;
}

/**
 * fork: a name whose checked addresses are private (local network, link-local,
 * Tailscale, ULA: {@link isLocalAddress}) and not this machine's is allowed under this name too, once per name and
 * addresses, as `nas.lan@192.168.1.10`: allowing a name does not by itself let it lead to a private network.
 * Undefined for an address written as such, which the user was asked about as it is, and for public addresses.
 */
export function privateAddressName(host: string, addresses: readonly LookupAddress[]): string | undefined {
	const bare = host.replace(/^\[|\]$/g, "");
	if (isIP(bare.replace(/%.*$/, ""))) return undefined;
	const found = addresses
		.map(({ address }) => address)
		.filter((address) => isLocalAddress(address) && !isMachineAddress(address));
	return found.length > 0 ? `${asciiHost(bare)}@${[...new Set(found)].sort().join(",")}` : undefined;
}

/** The name and private addresses a {@link privateAddressName} allows, or undefined. */
export function privateAddressOf(name: string): { host: string; addresses: string[] } | undefined {
	const at = name.lastIndexOf("@");
	if (at <= 0) return undefined;
	const addresses = name.slice(at + 1).split(",");
	return addresses.every((address) => isIP(address.replace(/%.*$/, "")) !== 0)
		? { host: name.slice(0, at), addresses }
		: undefined;
}

/** `ssh://` names match only `ssh://` patterns: `*.example.com` opens no SSH. */
const SSH_SCHEME = /^ssh:\/\//i;

/** Wildcards cover subdomains only in allow lists; in deny lists they also cover the bare domain. */
export function matchesHost(host: string, patterns: readonly string[], deny = false): boolean {
	const ssh = SSH_SCHEME.test(host);
	// fork: an internationalized name matches in either form.
	const name = asciiHost(host.replace(SSH_SCHEME, ""));
	return patterns.some((pattern) => {
		if (SSH_SCHEME.test(pattern) !== ssh) return false;
		const wanted = asciiHost(pattern.replace(SSH_SCHEME, ""));
		return wanted.startsWith("*.")
			? name.endsWith(wanted.slice(1)) || (deny && name === wanted.slice(2))
			: name === wanted;
	});
}

/**
 * A blocked host; `localhost` among the blocked hosts blocks every port of this machine, and a blocked host
 * its Git over SSH too.
 */
export const isDenied = (host: string, settings: NetworkSettings) => {
	const sshHost = gitSshHostOf(host);
	return (
		matchesHost(host, settings.deny, true) ||
		(localPortOf(host) !== undefined && matchesHost("localhost", settings.deny, true)) ||
		// fork.11 (F2): the port that remote-controls the user's Firefox, which has no authentication.
		isReservedBrowserPort(localPortOf(host)) ||
		(sshHost !== undefined && matchesHost(sshHost, settings.deny, true))
	);
};

/**
 * Opened only when allowed, never because questions are off: a port of this machine, and Git over
 * SSH, which uses the user's SSH keys.
 */
const explicitOnly = (host: string) => localPortOf(host) !== undefined || gitSshHostOf(host) !== undefined;

/**
 * Decides per host and command: settings first, then this session's answers, then the command's own, then
 * the question. Each command gets a {@link CommandNetwork} from {@link open}.
 */
export class HostPolicy {
	readonly dnsGuard: DnsGuard;
	readonly sessionAllowed = new Set<SessionHostGrant>();
	/** Open questions by host, whichever command asked: another command waits for the answer first. */
	readonly asking = new Map<string, Promise<boolean>>();
	readonly getSettings: () => NetworkSettings;
	readonly ask: ((host: string, command: NetworkCommand) => Promise<HostAnswer>) | undefined;
	/** Whether the project gave this host to this command: to the commands of one rule, no other. */
	readonly allowedFor: (host: string, command: NetworkCommand) => boolean;
	private readonly refusals: RecordedRefusal[] = [];
	private readonly running = new Set<CommandNetwork>();
	private readonly callGrants = new Map<string, readonly string[]>();
	/** fork (SEC-07): hosts refused before a tool call's command started, refused to it without a new question. */
	private readonly callRefusals = new Map<string, readonly [string, HostRefusal["why"]][]>();
	/** The hosts `allowedFor` may give, so the ports of this machine among them can be served. */
	readonly grantedHosts: () => readonly string[];
	private readonly sameCommand: (approved: string, command: string) => boolean;

	constructor(
		getSettings: () => NetworkSettings,
		ask: ((host: string, command: NetworkCommand) => Promise<HostAnswer>) | undefined,
		allowedFor: (host: string, command: NetworkCommand) => boolean = () => false,
		dnsGuard = new DnsGuard(),
		grantedHosts: () => readonly string[] = () => [],
		sameCommand: (approved: string, command: string) => boolean = (approved, command) => approved === command,
	) {
		this.dnsGuard = dnsGuard;
		this.getSettings = getSettings;
		this.ask = ask;
		this.allowedFor = allowedFor;
		this.grantedHosts = grantedHosts;
		this.sameCommand = sameCommand;
	}

	allowForSession(host: string, command: NetworkCommand): void {
		const grant = { host: host.toLowerCase(), command: command.nonCommand ? undefined : command.command };
		if (![...this.sessionAllowed].some((item) => item.host === grant.host && item.command === grant.command))
			this.sessionAllowed.add(grant);
	}

	allowsInSession(host: string, command: NetworkCommand): boolean {
		return [...this.sessionAllowed].some(
			(grant) =>
				grant.host === host.toLowerCase() &&
				(grant.command === undefined || (!command.nonCommand && this.sameCommand(grant.command, command.command))),
		);
	}

	/** The network decisions of one command; close it when the command ends. */
	open(command: NetworkCommand): CommandNetwork {
		const network = new CommandNetwork(this, command, () => this.running.delete(network));
		const granted = command.toolCallId === undefined ? undefined : this.callGrants.get(command.toolCallId);
		if (command.toolCallId !== undefined) this.callGrants.delete(command.toolCallId);
		for (const host of granted ?? []) network.grant(host);
		const refused = command.toolCallId === undefined ? undefined : this.callRefusals.get(command.toolCallId);
		if (command.toolCallId !== undefined) this.callRefusals.delete(command.toolCallId);
		for (const [host, why] of refused ?? []) network.refuseAnswered(host, why);
		this.running.add(network);
		return network;
	}

	/** Whether a connection of `command` to `host` would be asked about now. */
	wouldAsk(host: string, command: NetworkCommand): boolean {
		const settings = this.getSettings();
		// A port of this machine or Git over SSH is never open without an answer, questions on or off.
		return (
			(settings.askNewHosts || explicitOnly(host) || privateAddressOf(host) !== undefined) &&
			!isDenied(host, settings) &&
			!matchesHost(host, settings.allow) &&
			!this.allowsInSession(host, command) &&
			!this.allowedFor(host, command)
		);
	}

	/**
	 * The user allowed a tool call whose question showed these hosts: its command may reach them
	 * until it ends. Forgotten by {@link forgetCall} when the call runs nothing.
	 */
	grantForCall(toolCallId: string, hosts: readonly string[]): void {
		if (hosts.length > 0) this.callGrants.set(toolCallId, hosts);
	}

	/** fork (SEC-07): the user refused these hosts to a tool call before its command started. */
	refuseForCall(toolCallId: string, refused: readonly [string, HostRefusal["why"]][]): void {
		if (refused.length > 0) this.callRefusals.set(toolCallId, refused);
	}

	forgetCall(toolCallId: string): void {
		this.callGrants.delete(toolCallId);
		this.callRefusals.delete(toolCallId);
	}

	/** The hosts refused to a tool call's command, oldest first. */
	refusalsOf(toolCallId: string): RecordedRefusal[] {
		return this.refusals.filter((refusal) => refusal.toolCallId === toolCallId);
	}

	/** fork: whether a command still holds network decisions of this policy. */
	get inUse(): boolean {
		return this.running.size > 0;
	}

	/** Closes the open connections a change of the settings no longer allows (revocation). */
	recheck(): void {
		for (const network of this.running) network.recheck();
	}

	/** fork (SEC-07): tells the running commands' relays of a port given, without rechecking open connections. */
	pushPorts(): void {
		for (const network of this.running) network.pushPorts();
	}

	record(refusal: RecordedRefusal): void {
		this.refusals.push(refusal);
		if (this.refusals.length > KEPT_REFUSALS) this.refusals.shift();
	}
}

/** One command's side of the policy: its answers, its open questions and its open connections. */
export class CommandNetwork {
	readonly dnsGuard: DnsGuard;
	readonly command: NetworkCommand;
	private readonly policy: HostPolicy;
	private readonly onClose: () => void;
	private readonly allowed = new Set<string>();
	/** Asked once per command: a refused host stays refused until the command ends. */
	private readonly refused = new Map<string, HostRefusal["why"]>();
	private readonly pending = new Map<string, Promise<boolean>>();
	private readonly tunnels = new Set<{ host: string; close: () => void }>();
	/** fork (SEC-07): the relay's listeners of this machine's ports, told each change (`watchPorts`). */
	private readonly portWatchers = new Set<(ports: number[]) => void>();
	private sentPorts = "";
	/** fork: the command's network ended; nothing it asked for is opened after. */
	private ended = false;
	/** fork: whether this command's sandbox can change a path, set once its layout is known (`ssh-provenance.ts`). */
	sandboxWrites: ((path: string) => boolean) | undefined;
	/** fork: whether Git may sign with the user's key (`git-sign.ts`), from the settings when the command starts. */
	gitSigning = false;
	/** fork: whether commands see the user's containers (`containers.ts`), from the settings when the command starts. */
	containers = false;
	/** fork: whether commands read the state of the system's services over D-Bus (`dbus.ts`). */
	serviceState = false;

	constructor(policy: HostPolicy, command: NetworkCommand, onClose: () => void) {
		this.dnsGuard = policy.dnsGuard;
		this.policy = policy;
		this.command = command;
		this.onClose = onClose;
	}

	grant(host: string): void {
		this.allowed.add(host.toLowerCase());
	}

	/** fork (SEC-07): an answer given before the command started; asked once per command, as any other. */
	refuseAnswered(host: string, why: HostRefusal["why"]): void {
		this.refused.set(host.toLowerCase(), why);
	}

	private refuse(host: string, why: HostRefusal["why"]): false {
		this.policy.record({ host, why, toolCallId: this.command.toolCallId });
		return false;
	}

	/**
	 * fork: the first of `addresses` the blocked hosts name, recorded as refused for
	 * `host`. Blocking `192.168.1.1` blocks every name that leads there, as it blocks the address written as such.
	 */
	blockedAddress(host: string, addresses: readonly LookupAddress[]): string | undefined {
		const settings = this.policy.getSettings();
		const blocked = addresses.find(({ address }) => isDenied(address, settings))?.address;
		if (blocked !== undefined) this.refuse(host, "blocked");
		return blocked;
	}

	/**
	 * fork: for a program that resolves `host` itself (ssh, for Git over SSH), the
	 * checks the proxy makes after resolving: a blocked address, then a private one, allowed as `<name>@<addresses>`
	 * (`ssh://nas@192.168.1.10`). Why it may not reach `host`, or undefined. An address written as such was asked
	 * about as it is; a name that does not resolve is left to the program, which reports it.
	 */
	async reachesResolved(name: string, host: string): Promise<string | undefined> {
		const bare = host.replace(/^\[|\]$/g, "");
		if (isIP(bare.replace(/%.*$/, "")))
			return isDenied(bare, this.policy.getSettings()) ? `${host} is blocked` : undefined;
		let addresses: LookupAddress[];
		try {
			addresses = await this.dnsGuard.resolve(bare);
		} catch (error) {
			return error instanceof DnsRebindingError ? (error as Error).message : undefined;
		}
		const blocked = this.blockedAddress(name, addresses);
		if (blocked !== undefined) return `${host} leads to ${blocked}, which the user blocked`;
		const lan = privateAddressOf(privateAddressName(bare, addresses) ?? "");
		if (!lan) return undefined;
		const grant = `${name}@${lan.addresses.join(",")}`;
		return (await this.allows(grant))
			? undefined
			: `${host} leads to ${lan.addresses.join(", ")}, a private address, which is not allowed. Ask the user to allow ${grant}.`;
	}

	/** true when allowed without a question, why when refused, undefined when only a question can tell. */
	private settled(host: string): true | HostRefusal["why"] | undefined {
		const settings = this.policy.getSettings();
		if (isDenied(host, settings)) return "blocked";
		if (
			matchesHost(host, settings.allow) ||
			this.policy.allowsInSession(host, this.command) ||
			this.allowed.has(host) ||
			this.policy.allowedFor(host, this.command)
		)
			return true;
		// fork (AS-023): a name's private address is asked about, questions on or off.
		if (privateAddressOf(host) !== undefined) return this.refused.get(host);
		const unasked = !explicitOnly(host) ? true : localPortOf(host) === undefined ? "ssh" : "port";
		return this.refused.get(host) ?? (settings.askNewHosts ? undefined : unasked);
	}

	/**
	 * fork: the ports of this machine this command may reach now. The relay serves them on the
	 * sandbox's loopback, for the programs that connect without the proxy.
	 */
	localPorts(): number[] {
		const names = [
			...this.policy.getSettings().allow,
			...[...this.policy.sessionAllowed].map((grant) => grant.host),
			...this.allowed,
			...this.policy.grantedHosts(),
		];
		const ports = new Set<number>();
		for (const name of names) {
			const port = localPortOf(name);
			if (port !== undefined && this.settled(localPortName(port)) === true) ports.add(port);
		}
		return [...ports].sort((a, b) => a - b);
	}

	/** Whether `name` is allowed now without a question, for Prism's own checks before a command runs. */
	allowsNow(name: string): boolean {
		return this.settled(name.toLowerCase()) === true;
	}

	async allows(name: string): Promise<boolean> {
		const host = name.toLowerCase();
		for (;;) {
			const settled = this.settled(host);
			if (settled === true) return true;
			if (settled) return this.refuse(host, settled);
			if (!this.policy.ask) return this.refuse(host, "unanswered");
			// Parallel connections of this command to one new host (npm opens several) share one question.
			const mine = this.pending.get(host);
			if (mine) return mine;
			// Another command's question for this host may end in an answer for the session: wait, then decide.
			const other = this.policy.asking.get(host);
			if (other) {
				await other;
				continue;
			}
			const answer = this.policy
				.ask(name, this.command)
				.catch((): HostAnswer => "deny")
				.then((choice) => {
					if (choice === "session") this.policy.allowForSession(host, this.command);
					// "project" and "task": the asker kept it for the project or the task, where `allowedFor` finds it;
					// taken back there, it ends here too.
					if (choice === "command") this.grant(host);
					if (choice === "deny" || choice === "unanswered" || choice === "scope") {
						const why = choice === "deny" ? "user" : choice;
						this.refused.set(host, why);
						return this.refuse(host, why);
					}
					// A block added while the user was asked wins over the answer to the older question.
					if (isDenied(host, this.policy.getSettings())) return this.refuse(host, "blocked");
					// fork (SEC-07): a port given now is served at once to every command its approval covers.
					this.policy.pushPorts();
					return true;
				})
				.finally(() => {
					this.pending.delete(host);
					this.policy.asking.delete(host);
				});
			this.pending.set(host, answer);
			this.policy.asking.set(host, answer);
			return answer;
		}
	}

	/** Keeps an open connection to `host`, closed if its permission goes away; returns the untrack function. */
	track(host: string, close: () => void): () => void {
		const tunnel = { host: host.toLowerCase(), close };
		// Allowed before an await (a DNS lookup) that a block may have come during: closed now, not at the next change.
		if (this.ended || this.settled(tunnel.host) !== true) {
			close();
			return () => false;
		}
		this.tunnels.add(tunnel);
		return () => this.tunnels.delete(tunnel);
	}

	recheck(): void {
		for (const tunnel of [...this.tunnels]) {
			if (this.settled(tunnel.host) === true) continue;
			this.tunnels.delete(tunnel);
			tunnel.close();
		}
		this.pushPorts();
	}

	/** fork (SEC-07): sends the relay the ports of this machine it serves, when they changed. */
	pushPorts(): void {
		const ports = this.localPorts();
		if (ports.join(",") === this.sentPorts) return;
		this.sentPorts = ports.join(",");
		for (const watcher of this.portWatchers) watcher(ports);
	}

	/**
	 * fork (SEC-07): calls `watcher` with the ports of this machine this command may reach, now and at each change,
	 * so that a port allowed while the command runs is served at once and one taken back closes.
	 */
	watchPorts(watcher: (ports: number[]) => void): () => void {
		const ports = this.localPorts();
		this.sentPorts = ports.join(",");
		this.portWatchers.add(watcher);
		watcher(ports);
		return () => this.portWatchers.delete(watcher);
	}

	get closed(): boolean {
		return this.ended;
	}

	close(): void {
		this.ended = true;
		this.tunnels.clear();
		this.onClose();
	}
}

const MAX_HEADER = 64 * 1024;

/** fork (SEC-07): the relay's stream on which Prism sends the ports of this machine to serve, one line per change. */
export const PORTS_METHOD = "PRISM-PORTS";

/** Where `localhost` and its subdomains lead, whatever the resolver says (RFC 6761). */
const LOOPBACK: LookupAddress[] = [
	{ address: "127.0.0.1", family: 4 },
	{ address: "::1", family: 6 },
];

function reply(stream: Duplex, status: string, body: string): void {
	stream.end(
		`HTTP/1.1 ${status}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
	);
}

/** host and port of a CONNECT target or an absolute http URL; undefined when malformed. */
function target(method: string, uri: string): { host: string; port: number; path?: string } | undefined {
	if (method === "CONNECT") {
		const match = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(uri);
		if (!match) return undefined;
		const port = Number(match[2]);
		return port > 0 && port < 65536 ? { host: match[1]!, port } : undefined;
	}
	try {
		const url = new URL(uri);
		if (url.protocol !== "http:") return undefined;
		return {
			host: url.hostname.replace(/^\[|\]$/g, ""),
			port: Number(url.port || 80),
			path: `${url.pathname}${url.search}`,
		};
	} catch {
		return undefined;
	}
}

/** Serves one proxy request arriving from the relay. */
export function serveProxyStream(stream: Duplex, network: CommandNetwork): void {
	let head: Buffer = Buffer.alloc(0);
	stream.on("error", () => stream.destroy());
	const onData = (chunk: Buffer) => {
		head = Buffer.concat([head, chunk]);
		const end = head.indexOf("\r\n\r\n");
		if (end < 0) {
			if (head.length > MAX_HEADER) reply(stream, "431 Request Header Fields Too Large", "");
			return;
		}
		stream.off("data", onData);
		stream.pause();
		// fork: a request that fails closes its own channel, never the engine.
		handle(head.subarray(0, end).toString("latin1"), head.subarray(end + 4)).catch(() => stream.destroy());
	};
	stream.on("data", onData);

	const handle = async (header: string, rest: Buffer) => {
		const [requestLine = "", ...headerLines] = header.split("\r\n");
		const [method = "", uri = "", version = ""] = requestLine.split(" ");
		// fork: Git over SSH, from git-ssh-client.ts; Prism runs ssh for it.
		if (method === GIT_SSH_METHOD && version === "HTTP/1.1") {
			return serveGitSsh(stream, uri, rest, network).catch(() => stream.destroy());
		}
		// fork: the user's containers, read only, from the relay's container API port.
		if (method === CONTAINERS_METHOD && version === "HTTP/1.1") return serveContainers(stream, rest, network);
		// fork: the system bus, filtered to reading the state of services.
		if (method === DBUS_METHOD && version === "HTTP/1.1") return serveDbus(stream, rest, network);
		if (method === PORTS_METHOD && version === "HTTP/1.1") {
			const unwatch = network.watchPorts((ports) => stream.write(`${ports.join(",") || "-"}\n`));
			stream.on("close", unwatch);
			stream.resume();
			return;
		}
		// fork: commit and tag signing, from git-sign-client.ts; Prism signs with the user's key.
		if (method === GIT_SIGN_METHOD && version === "HTTP/1.1") {
			return serveGitSign(stream, uri, headerLines, rest, network).catch(() => stream.destroy());
		}
		const destination = /^HTTP\/1\.[01]$/.test(version) ? target(method, uri) : undefined;
		if (!destination) return reply(stream, "400 Bad Request", "Prism's sandbox proxy: malformed request.\n");
		// fork: this machine is allowed port by port, by any of its names or addresses.
		const port = localPortName(destination.port);
		const refused = (name: string) => {
			const lan = privateAddressOf(name);
			reply(
				stream,
				"403 Forbidden",
				name === port
					? `Prism's sandbox refused the connection to port ${destination.port} of this machine (${destination.host}): this port is not allowed. Ask the user to allow ${port}.\n`
					: lan
						? `Prism's sandbox refused the connection to ${destination.host}: it leads to ${lan.addresses.join(", ")}, a private address, which is not allowed. Ask the user to allow ${name}.\n`
						: `Prism's sandbox refused the connection to ${destination.host}: this host is not allowed. Ask the user to allow it.\n`,
			);
		};
		// fork: the sandbox's own loopback is not this machine's. A client that
		// sends it to the proxy (it ignores NO_PROXY, or the proxy is forced) is refused, never led to this machine.
		const sandboxLoopback = (host: string) =>
			reply(
				stream,
				"403 Forbidden",
				`Prism's sandbox refused to proxy ${destination.host}${host === destination.host ? "" : ` (${host})`}: this is the sandbox's own localhost, which the proxy does not reach. Connect to it without the proxy (NO_PROXY=localhost,127.0.0.1,::1, or curl --noproxy '*'). This machine's services are at ${HOST_ALIAS}:<port>, on the ports the user allows.\n`,
			);
		if (isSandboxLoopback(destination.host)) return sandboxLoopback(destination.host);
		const machine = isMachineName(destination.host) || isMachineAddress(destination.host);
		const names = machine ? [port] : [destination.host];
		if (!(await network.allows(names[0]!))) return refused(names[0]!);
		let addresses: LookupAddress[];
		try {
			// fork: resolve once; net.connect must never resolve the allowed name again.
			addresses = isMachineName(destination.host) ? LOOPBACK : await network.dnsGuard.resolve(destination.host);
		} catch (error) {
			return reply(
				stream,
				error instanceof DnsRebindingError ? "403 Forbidden" : "502 Bad Gateway",
				`Prism's sandbox refused the connection to ${destination.host}: ${(error as Error).message}\n`,
			);
		}
		// fork: an address the user blocked, whatever name leads to it.
		const blockedAt = network.blockedAddress(destination.host, addresses);
		if (blockedAt !== undefined)
			return reply(
				stream,
				"403 Forbidden",
				`Prism's sandbox refused the connection to ${destination.host}: it leads to ${blockedAt}, which the user blocked.\n`,
			);
		// A name that leads to loopback (`localtest.me`) means the sandbox's own too.
		const looped = addresses.find(({ address }) => isSandboxLoopback(address));
		if (!isMachineName(destination.host) && looped) return sandboxLoopback(looped.address);
		// A name that leads to this machine reaches its services: the port must be allowed too.
		if (!machine && addresses.some(({ address }) => isMachineAddress(address))) {
			names.push(port);
			if (!(await network.allows(port))) return refused(port);
		}
		// fork (AS-023): a name that leads to a private network needs that address allowed too.
		const lan = privateAddressName(destination.host, addresses);
		if (lan !== undefined) {
			names.push(lan);
			if (!(await network.allows(lan))) return refused(lan);
		}
		// fork: the command may have ended during the waits above.
		if (stream.destroyed || network.closed) {
			stream.destroy();
			return;
		}
		// fork: upstream EOF must still let the command finish sending.
		const upstream = connect({
			host: destination.host,
			port: destination.port,
			allowHalfOpen: true,
			lookup: checkedLookup(addresses),
		});
		upstream.on("error", (error) => {
			if (upstream.connecting) reply(stream, "502 Bad Gateway", `Prism's sandbox proxy: ${error.message}\n`);
			else stream.destroy();
		});
		// a permission withdrawn while the command runs closes its open connections too.
		const close = () => {
			stream.destroy();
			upstream.destroy();
		};
		const untracks = names.map((name) => network.track(name, close));
		const untrack = () => {
			for (const each of untracks) each();
		};
		stream.on("close", () => {
			if (!stream.readableEnded || !stream.writableFinished) upstream.destroy();
		});
		upstream.on("close", () => {
			untrack();
			if (!upstream.readableEnded || !upstream.writableFinished) stream.destroy();
		});
		upstream.once("connect", () => {
			if (method === "CONNECT") stream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			else {
				const headers = headerLines.filter((line) => !/^proxy-/i.test(line));
				upstream.write(`${method} ${destination.path} ${version}\r\n${headers.join("\r\n")}\r\n\r\n`, "latin1");
			}
			if (rest.length) upstream.write(rest);
			stream.pipe(upstream).pipe(stream);
			stream.resume();
		});
	};
}

/** The pipes of one sandboxed command, opened on Prism's side; the relay gets them as fds 4 and 5. */
export interface NetworkChannel {
	/** Read by the relay (its fd 4). */
	toRelay: string;
	/** Written by the relay (its fd 5). */
	fromRelay: string;
	/** The ports of this machine the relay serves on the sandbox's loopback. */
	localPorts: readonly number[];
	/** fork (SEC-07): the command's own loopback address, where the relay serves those ports. */
	alias: string;
	/** fork (SEC-07): the command's /etc/hosts, naming `alias` host.prism.internal; undefined without one. */
	hosts?: string;
	network: CommandNetwork;
	close(): void;
}

let aliases = 0;

/** fork (SEC-07): a loopback address of its own for each command, so their relays never take each other's port. */
function nextAlias(): string {
	const n = aliases++ % (256 * 254);
	return `127.88.${Math.floor(n / 254)}.${(n % 254) + 1}`;
}

export function openNetworkChannel(runDir: string, network: CommandNetwork): NetworkChannel {
	mkdirSync(runDir, { recursive: true, mode: 0o700 });
	const dir = mkdtempSync(join(runDir, "net-"));
	const toRelay = join(dir, "to-relay");
	const fromRelay = join(dir, "from-relay");
	// fork: run at each session, never from where the sandbox writes.
	const mkfifo = hostProgram("mkfifo");
	const made = mkfifo ? spawnSync(mkfifo, ["-m", "600", toRelay, fromRelay], { stdio: "ignore" }) : undefined;
	if (made?.status !== 0) {
		rmSync(dir, { recursive: true, force: true });
		throw new Error("mkfifo failed: the sandbox network needs it (coreutils).");
	}
	// Read-write on our side: opening never blocks, and the relay's opens find a peer at once.
	const flags = constants.O_RDWR | constants.O_NONBLOCK;
	const output = new Socket({ fd: openSync(toRelay, flags), readable: false, writable: true });
	const input = new Socket({ fd: openSync(fromRelay, flags), readable: true, writable: false });
	// The command's process keeps Prism running while it lasts; the pipes alone must not.
	input.unref();
	output.unref();
	const mux = new Mux(input, output, (stream) => serveProxyStream(stream, network));
	const alias = nextAlias();
	let hosts: string | undefined = join(dir, "hosts");
	try {
		const system = readFileSync("/etc/hosts", "utf8");
		writeFileSync(hosts, `${system}${system.endsWith("\n") || !system ? "" : "\n"}${alias}\t${HOST_ALIAS}\n`, {
			mode: 0o644,
		});
	} catch {
		hosts = undefined;
	}
	let closed = false;
	return {
		toRelay,
		fromRelay,
		localPorts: network.localPorts(),
		alias,
		...(hosts ? { hosts } : {}),
		network,
		close: () => {
			if (closed) return;
			closed = true;
			mux.close();
			network.close();
			input.destroy();
			output.destroy();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
