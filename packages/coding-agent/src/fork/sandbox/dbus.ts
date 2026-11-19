/**
 * fork: sandboxed commands read the state of the system's
 * services (`systemctl status`, `list-units`, `is-active`, `show`) without changing it. The relay serves D-Bus on
 * the sandbox's loopback (`DBUS_SYSTEM_BUS_ADDRESS`, which sd-bus and libdbus accept as `tcp:`); Prism
 * authenticates the command itself, opens its own connection to the system bus, and passes on only the method
 * calls of the read list below. Every other call gets a D-Bus error that says why, so `systemctl stop` prints
 * one clear line instead of waiting.
 */

import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { filterStateProperties, stateProperties } from "./dbus-properties.ts";
import type { CommandNetwork } from "./proxy.ts";

/** The proxy request method that opens a D-Bus connection from the relay. */
export const DBUS_METHOD = "PRISM-DBUS";

export const SYSTEM_BUS = "/run/dbus/system_bus_socket";

/** A method call the sandbox makes. Larger is refused: reading the state of services sends small calls. */
const MAX_CALL = 1024 * 1024;
const MAX_AUTH_LINE = 16 * 1024;
/** fork: calls waiting for the bus's reply, at most. */
const MAX_PENDING_CALLS = 1024;
/**
 * fork: Prism's connections to the system bus for sandboxed commands, open at
 * once, at most. The bus limits each user's connections; past it, the user's other programs lost the bus. Reading
 * the state of services takes one connection per `systemctl`; past the bound, a connection's calls get the reason.
 */
export const MAX_BUS_CONNECTIONS = 16;
let busConnections = 0;

const BUS = "org.freedesktop.DBus";
/** Not AccessDenied: sd-bus prints « Access denied » for that one, without the reason. */
export const REFUSED = "dev.prism.Sandbox.Refused";
const SYSTEMD = "org.freedesktop.systemd1";
const SYSTEMD_PATH = "/org/freedesktop/systemd1";

/** Read only, by destination and interface: the members passed on. */
const ALLOWED = new Map<string, Map<string, Set<string>>>([
	[BUS, new Map([[BUS, new Set(["Hello", "AddMatch", "RemoveMatch", "GetNameOwner", "NameHasOwner", "GetId"])]])],
	[
		SYSTEMD,
		new Map([
			[`${BUS}.Properties`, new Set(["Get", "GetAll"])],
			[`${BUS}.Introspectable`, new Set(["Introspect"])],
			[`${BUS}.Peer`, new Set(["Ping", "GetMachineId"])],
			[
				`${SYSTEMD}.Manager`,
				new Set([
					"GetUnit",
					"GetUnitByPID",
					"GetUnitByInvocationID",
					"LoadUnit",
					"ListUnits",
					"ListUnitsFiltered",
					"ListUnitsByPatterns",
					"ListUnitsByNames",
					"ListUnitFiles",
					"ListUnitFilesByPatterns",
					"GetUnitFileState",
					"GetDefaultTarget",
					"ListJobs",
				]),
			],
		]),
	],
]);

export interface DbusHeader {
	type: number;
	flags: number;
	serial: number;
	little: boolean;
	path?: string;
	interface?: string;
	member?: string;
	destination?: string;
	sender?: string;
	signature?: string;
	replySerial?: number;
	/** Where the body starts, and the whole message's length. */
	body: number;
	length: number;
}

const FIELD_TYPES = new Map([
	[1, "o"],
	[2, "s"],
	[3, "s"],
	[4, "s"],
	[5, "u"],
	[6, "s"],
	[7, "s"],
	[8, "g"],
	[9, "u"],
]);

const align = (offset: number, to: number) => Math.ceil(offset / to) * to;

/** The length of the message at the start of `data`, from its fixed header, or undefined while that is incomplete. */
function messageLength(data: Buffer): number | undefined {
	if (data.length < 16) return undefined;
	const little = data[0] === 0x6c;
	const u32 = (at: number) => (little ? data.readUInt32LE(at) : data.readUInt32BE(at));
	return align(16 + u32(12), 8) + u32(4);
}

/**
 * The header of the message at the start of `data`: undefined while it is incomplete, a string when it is not
 * a well-formed message. A field given twice is malformed: the bus and Prism could read different ones.
 */
export function parseHeader(data: Buffer, maxBody = MAX_CALL): DbusHeader | undefined | string {
	if (data.length < 16) return undefined;
	const little = data[0] === 0x6c;
	if (!little && data[0] !== 0x42) return "unknown byte order";
	if (data[3] !== 1) return "unknown protocol version";
	const u32 = (at: number) => (little ? data.readUInt32LE(at) : data.readUInt32BE(at));
	const bodyLength = u32(4);
	const fieldsLength = u32(12);
	if (fieldsLength > MAX_CALL || bodyLength > maxBody) return "message too large";
	const end = 16 + fieldsLength;
	const length = align(end, 8) + bodyLength;
	if (data.length < align(end, 8)) return undefined;
	const header: DbusHeader = { type: data[1]!, flags: data[2]!, serial: u32(8), little, body: align(end, 8), length };
	const seen = new Set<number>();
	let at = 16;
	while (at < end) {
		at = align(at, 8);
		if (at + 4 > end) return "truncated field";
		const code = data[at]!;
		const signatureLength = data[at + 1]!;
		const signature = data.toString("latin1", at + 2, at + 2 + signatureLength);
		at += 2 + signatureLength + 1;
		if (seen.has(code)) return "field given twice";
		seen.add(code);
		const expected = FIELD_TYPES.get(code);
		if (expected !== undefined && signature !== expected) return "field of the wrong type";
		let value: string | number;
		if (signature === "s" || signature === "o") {
			at = align(at, 4);
			if (at + 4 > end) return "truncated field";
			const size = u32(at);
			if (at + 4 + size + 1 > end || data[at + 4 + size] !== 0) return "truncated field";
			value = data.toString("utf8", at + 4, at + 4 + size);
			at += 4 + size + 1;
		} else if (signature === "g") {
			const size = data[at]!;
			if (at + 1 + size + 1 > end) return "truncated field";
			value = data.toString("latin1", at + 1, at + 1 + size);
			at += 1 + size + 1;
		} else if (signature === "u") {
			at = align(at, 4);
			if (at + 4 > end) return "truncated field";
			value = u32(at);
			at += 4;
		} else if (expected === undefined) {
			// An unknown field the bus ignores: Prism cannot read it, and needs none of them.
			return "unknown header field";
		} else return "field of the wrong type";
		if (code === 1) header.path = String(value);
		else if (code === 2) header.interface = String(value);
		else if (code === 3) header.member = String(value);
		else if (code === 5) header.replySerial = Number(value);
		else if (code === 6) header.destination = String(value);
		else if (code === 7) header.sender = String(value);
		else if (code === 8) header.signature = String(value);
	}
	if (at > end) return "truncated field";
	return header;
}

/** Why the sandbox may not make this call, or undefined when it may. */
export function refusal(header: DbusHeader, systemdOwner?: string): string | undefined {
	const what = `${header.interface ?? "?"}.${header.member ?? "?"} on ${header.destination ?? "?"}`;
	// Clients that resolve the name first (dbus-python) call systemd by its unique name.
	const destination = systemdOwner && header.destination === systemdOwner ? SYSTEMD : header.destination;
	if (header.type !== 1) return "commands in the sandbox only make method calls";
	if (!destination || !header.interface || !header.member || !header.path) {
		return `${what} names no destination, interface, member or path`;
	}
	const members = ALLOWED.get(destination)?.get(header.interface);
	if (!members?.has(header.member)) {
		return `commands in the sandbox only read the state of services (systemctl status, list-units, show); ${what} is refused`;
	}
	if (destination === BUS) return header.path === "/org/freedesktop/DBus" ? undefined : `${what} on ${header.path}`;
	if (header.path !== SYSTEMD_PATH && !header.path.startsWith(`${SYSTEMD_PATH}/`)) return `${what} on ${header.path}`;
	return undefined;
}

type Field = [code: number, type: "s" | "o" | "g" | "u", value: string | number];

/** A little-endian message: header fields, and a body of one string when there is one. */
export function buildMessage(type: number, flags: number, serial: number, fields: Field[], body?: string): Buffer {
	const parts: Buffer[] = [];
	let at = 16;
	const push = (part: Buffer) => {
		parts.push(part);
		at += part.length;
	};
	const pad = (to: number) => push(Buffer.alloc(align(at, to) - at));
	const u32 = (value: number) => {
		const part = Buffer.alloc(4);
		part.writeUInt32LE(value);
		return part;
	};
	const all = body === undefined ? fields : [...fields, [8, "g", "s"] as Field];
	for (const [code, kind, value] of all) {
		pad(8);
		push(Buffer.from([code, 1, kind.charCodeAt(0), 0]));
		if (kind === "u") push(u32(Number(value)));
		else if (kind === "g")
			push(Buffer.concat([Buffer.from([String(value).length]), Buffer.from(`${value}\0`, "latin1")]));
		else {
			const text = Buffer.from(String(value), "utf8");
			push(Buffer.concat([u32(text.length), text, Buffer.from([0])]));
		}
	}
	const fieldsLength = at - 16;
	pad(8);
	const content = body === undefined ? Buffer.alloc(0) : Buffer.from(body, "utf8");
	const payload = body === undefined ? content : Buffer.concat([u32(content.length), content, Buffer.from([0])]);
	const head = Buffer.alloc(16);
	head.set([0x6c, type, flags, 1]);
	head.writeUInt32LE(payload.length, 4);
	head.writeUInt32LE(serial, 8);
	head.writeUInt32LE(fieldsLength, 12);
	return Buffer.concat([head, ...parts, payload]);
}

/** Prism's error reply to the call `header`, with the reason. */
export function refuse(header: DbusHeader, serial: number, why: string): Buffer {
	return buildMessage(
		3,
		1,
		serial,
		[
			[5, "u", header.serial],
			[4, "s", REFUSED],
		],
		`Prism's sandbox: ${why}`,
	);
}

/** The one string of a message's body (`s`), as in the replies to Hello and GetNameOwner. */
function bodyString(data: Buffer, header: DbusHeader): string | undefined {
	if (header.length - header.body < 5) return undefined;
	const size = header.little ? data.readUInt32LE(header.body) : data.readUInt32BE(header.body);
	return header.body + 4 + size < header.length
		? data.toString("utf8", header.body + 4, header.body + 4 + size)
		: undefined;
}

/** Deliberately small match grammar: no escaping or duplicate keys that the bus could interpret differently. */
function serviceMatch(message: Buffer, header: DbusHeader): Map<string, string> | undefined {
	if (header.signature !== "s") return undefined;
	const rule = bodyString(message, header);
	if (
		rule === undefined ||
		header.length !== header.body + 5 + Buffer.byteLength(rule) ||
		message[header.length - 1] !== 0
	)
		return undefined;
	const fields = new Map<string, string>();
	for (const part of rule.split(",")) {
		const match = /^\s*(type|sender|interface|member|path|path_namespace|arg0)='([^'\\\x00-\x1f]*)'\s*$/.exec(part);
		if (!match || fields.has(match[1]!)) return undefined;
		fields.set(match[1]!, match[2]!);
	}
	if (fields.get("type") !== "signal") return undefined;
	if (fields.get("sender") === SYSTEMD) return fields;
	if (
		fields.get("sender") === BUS &&
		fields.get("interface") === BUS &&
		fields.get("member") === "NameOwnerChanged" &&
		fields.get("arg0") === SYSTEMD
	)
		return fields;
	return undefined;
}

/**
 * The server side of D-Bus's authentication, for the command: EXTERNAL or ANONYMOUS, which over TCP prove nothing,
 * and need not to: Prism, not the command, authenticates to the bus. Returns what follows BEGIN, or undefined on failure.
 */
function authenticate(stream: Duplex, first: Buffer): Promise<Buffer | undefined> {
	const guid = randomBytes(16).toString("hex");
	let buffered = first;
	let started = false;
	return new Promise((resolve) => {
		const finish = (rest: Buffer | undefined) => {
			// Held until Prism's connection to the bus is open.
			stream.pause();
			stream.off("data", onData);
			stream.off("close", onClose);
			resolve(rest);
		};
		// fork: a reply the command does not read pauses the reading of its lines.
		let blocked = false;
		const reply = (text: string) => {
			if (stream.write(text)) return;
			blocked = true;
			stream.pause();
			stream.once("drain", () => {
				blocked = false;
				stream.resume();
				step();
			});
		};
		const step = () => {
			if (!started) {
				if (buffered.length === 0) return;
				if (buffered[0] !== 0) return finish(undefined);
				buffered = buffered.subarray(1);
				started = true;
			}
			while (!blocked) {
				const end = buffered.indexOf("\r\n");
				if (end < 0) {
					if (buffered.length > MAX_AUTH_LINE) finish(undefined);
					return;
				}
				const line = buffered.toString("latin1", 0, end);
				buffered = buffered.subarray(end + 2);
				const [command = "", mechanism, initial] = line.split(" ");
				if (command === "BEGIN") return finish(buffered);
				if (command === "AUTH" && mechanism === "EXTERNAL")
					reply(initial === undefined ? "DATA\r\n" : `OK ${guid}\r\n`);
				// GLib's clients offer ANONYMOUS over TCP, where EXTERNAL has no credentials to give.
				else if (command === "AUTH" && mechanism === "ANONYMOUS") reply(`OK ${guid}\r\n`);
				else if (command === "DATA") reply(`OK ${guid}\r\n`);
				else if (command === "NEGOTIATE_UNIX_FD") reply("ERROR file descriptors do not cross the sandbox\r\n");
				else reply("REJECTED EXTERNAL ANONYMOUS\r\n");
			}
		};
		const onData = (chunk: Buffer) => {
			buffered = Buffer.concat([buffered, chunk]);
			step();
		};
		const onClose = () => resolve(undefined);
		stream.on("data", onData);
		stream.on("close", onClose);
		stream.resume();
		step();
	});
}

interface Bus {
	socket: Duplex;
	/** Prism's unique name on the bus: the command's, since Prism answers its Hello. */
	unique: string;
	/** systemd's unique name, which some clients call it by. */
	systemd?: string;
	/** What the bus sent after those replies. */
	rest: Buffer;
}

/** How long Prism waits for the system bus to accept it and name it. */
const BUS_NEGOTIATION_MS = 10_000;

/**
 * Prism's own connection to the system bus: EXTERNAL, as the user, then Hello and systemd's unique name. A bus that
 * hangs up or stays silent before then gives the reason; a command that leaves first gives undefined.
 */
function openBus(path: string, client: Duplex): Promise<Bus | string | undefined> {
	return new Promise((resolve) => {
		if (client.destroyed) return resolve(undefined);
		const socket = connect(path);
		let buffered = Buffer.alloc(0);
		let authenticated = false;
		let unique: string | undefined;
		let systemd: string | undefined;
		let answers = 0;
		let settled = false;
		// The command's calls meanwhile are held, so that its leaving is seen: a paused stream reports no end.
		let held = Buffer.alloc(0);
		const settle = (outcome: Bus | string | undefined) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.off("end", onEnd);
			socket.off("close", onEnd);
			client.off("data", onClientData);
			client.off("end", onClientGone);
			client.off("close", onClientGone);
			client.pause();
			if (typeof outcome !== "object") socket.destroy();
			else if (held.length > 0) client.unshift(held);
			resolve(outcome);
		};
		const fail = (why: string) => settle(why);
		const onEnd = () => fail("the system bus closed Prism's connection before naming it");
		const onClientGone = () => settle(undefined);
		const onClientData = (chunk: Buffer) => {
			held = Buffer.concat([held, chunk]);
			if (held.length > MAX_CALL) settle(undefined);
		};
		const timer = setTimeout(() => fail("the system bus did not answer Prism in time"), BUS_NEGOTIATION_MS);
		const onData = (chunk: Buffer) => {
			buffered = Buffer.concat([buffered, chunk]);
			if (!authenticated) {
				const end = buffered.indexOf("\r\n");
				if (end < 0) return;
				const line = buffered.toString("latin1", 0, end);
				if (!line.startsWith("OK ")) return fail(`the system bus refused Prism: ${line}`);
				authenticated = true;
				buffered = buffered.subarray(end + 2);
				socket.write(
					Buffer.concat([
						Buffer.from("BEGIN\r\n"),
						buildMessage(1, 0, 1, [
							[1, "o", "/org/freedesktop/DBus"],
							[6, "s", BUS],
							[2, "s", BUS],
							[3, "s", "Hello"],
						]),
						buildMessage(
							1,
							0,
							2,
							[
								[1, "o", "/org/freedesktop/DBus"],
								[6, "s", BUS],
								[2, "s", BUS],
								[3, "s", "GetNameOwner"],
							],
							SYSTEMD,
						),
					]),
				);
			}
			for (;;) {
				const header = parseHeader(buffered);
				if (header === undefined || (typeof header !== "string" && buffered.length < header.length)) return;
				if (typeof header === "string") return fail(`the system bus sent a malformed message: ${header}`);
				const message = buffered.subarray(0, header.length);
				buffered = buffered.subarray(header.length);
				if ((header.type === 2 || header.type === 3) && (header.replySerial === 1 || header.replySerial === 2)) {
					answers++;
					const value = header.type === 2 ? bodyString(message, header) : undefined;
					if (header.replySerial === 1) unique = value;
					else systemd = value;
				}
				if (answers < 2) continue;
				socket.off("data", onData);
				socket.pause();
				if (!unique) return fail("the system bus gave Prism no name");
				return settle({ socket, unique, systemd, rest: buffered });
			}
		};
		socket.on("data", onData);
		socket.on("end", onEnd);
		socket.on("close", onEnd);
		client.on("data", onClientData);
		client.on("end", onClientGone);
		client.on("close", onClientGone);
		client.resume();
		socket.once("error", (error) => fail(`cannot reach the system bus: ${error.message}`));
		socket.once("connect", () => {
			const uid = Buffer.from(String(process.getuid?.() ?? 0)).toString("hex");
			socket.write(`\0AUTH EXTERNAL ${uid}\r\n`);
		});
	});
}

/** Serves one D-Bus connection of the sandbox. */
export async function serveDbus(
	stream: Duplex,
	rest: Buffer,
	network: CommandNetwork,
	busPath = SYSTEM_BUS,
): Promise<void> {
	stream.on("error", () => stream.destroy());
	const after = await authenticate(stream, rest);
	if (after === undefined) return void stream.destroy();
	let bus: Bus | undefined;
	let full: string | undefined;
	if (network.serviceState && busConnections >= MAX_BUS_CONNECTIONS)
		full = `more than ${MAX_BUS_CONNECTIONS} D-Bus connections of sandboxed commands are open at once; close one and try again.`;
	else if (network.serviceState) {
		busConnections++;
		let counted = true;
		const release = () => {
			if (counted) busConnections--;
			counted = false;
		};
		const opened = await openBus(busPath, stream);
		if (opened === undefined) {
			release();
			return void stream.destroy();
		}
		if (typeof opened === "string") {
			release();
			// The command sees its connection closed; Prism's reason goes to its own log.
			process.stderr.write(`prism sandbox: ${opened}\n`);
			return void stream.destroy();
		}
		bus = opened;
		if (bus.socket.destroyed) release();
		else bus.socket.once("close", release);
	}
	// Prism's own serials, from the top: the bus counts from 1.
	let serial = 0x80000000;
	let greeted = false;
	let incoming = bus?.rest ?? Buffer.alloc(0);
	const pending = new Map<
		number,
		{ sender?: string; match?: Map<string, string>; remove?: boolean; fields?: ReadonlyMap<string, string> }
	>();
	const matches: Map<string, string>[] = [];
	// fork: a side that does not read pauses what writes to it. The command not reading
	// pauses both the bus's messages and the command's own calls (their refusals go to it); the bus not reading
	// pauses the command's calls. Each resumes when its side drains.
	let commandFull = false;
	let busFull = false;
	const flow = () => {
		if (commandFull || busFull) stream.pause();
		else stream.resume();
		if (commandFull) bus?.socket.pause();
		else bus?.socket.resume();
	};
	const toCommand = (message: Buffer) => {
		if (stream.write(message) || commandFull) return;
		commandFull = true;
		flow();
		stream.once("drain", () => {
			commandFull = false;
			flow();
			relay();
			step();
		});
	};
	const toBus = (message: Buffer) => {
		if (!bus || bus.socket.write(message) || busFull) return;
		busFull = true;
		flow();
		bus.socket.once("drain", () => {
			busFull = false;
			flow();
			step();
		});
	};
	// Whole messages only, once the command has its name: Prism's replies go between two of the bus's.
	const relay = () => {
		while (greeted && !commandFull) {
			// ListUnits can exceed the command limit; D-Bus itself caps messages at 128 MiB.
			const length = messageLength(incoming);
			if (length === undefined || incoming.length < length) return;
			const message = incoming.subarray(0, length);
			incoming = incoming.subarray(length);
			const header = parseHeader(message, 128 * 1024 * 1024);
			if (!header || typeof header === "string") return void stream.destroy();
			if (header.type === 2 || header.type === 3) {
				const request = pending.get(header.replySerial ?? 0);
				if (
					!request ||
					header.destination !== bus?.unique ||
					(header.sender !== request.sender && header.sender !== BUS)
				)
					continue;
				pending.delete(header.replySerial!);
				if (header.type === 2 && request.match) {
					if (request.remove) {
						const index = matches.findIndex(
							(rule) =>
								[...rule].every(([key, value]) => request.match?.get(key) === value) &&
								rule.size === request.match?.size,
						);
						if (index >= 0) matches.splice(index, 1);
					} else matches.push(request.match);
				}
				if (header.type === 2 && request.fields) {
					let filtered: Buffer;
					try {
						filtered = filterStateProperties(message, header, request.fields);
					} catch {
						filtered = refuse(
							{ ...header, serial: header.replySerial! },
							serial++,
							"invalid state property reply",
						);
					}
					toCommand(filtered);
				} else toCommand(message);
			} else if (
				header.type === 4 &&
				// Systemd signals can embed configuration or free-form status text; only owner-change signals pass.
				header.sender === BUS &&
				(!header.destination || header.destination === bus?.unique) &&
				matches.some((rule) =>
					[...rule].every(([key, value]) => {
						if (key === "type") return true;
						if (key === "sender") return header.sender === (value === SYSTEMD ? bus?.systemd : BUS);
						if (key === "arg0") return bodyString(message, header) === value;
						if (key === "path_namespace") return header.path === value || header.path?.startsWith(`${value}/`);
						return header[key as "interface" | "member" | "path"] === value;
					}),
				)
			)
				toCommand(message);
		}
	};
	if (bus) {
		const socket = bus.socket;
		socket.on("error", () => stream.destroy());
		socket.on("close", () => stream.destroy());
		stream.on("close", () => socket.destroy());
		socket.on("data", (chunk: Buffer) => {
			incoming = Buffer.concat([incoming, chunk]);
			relay();
		});
		flow();
	}
	let buffered = after;
	function step() {
		while (!commandFull && !busFull) {
			const header = parseHeader(buffered);
			if (header === undefined) return;
			if (typeof header === "string") return void stream.destroy();
			if (buffered.length < header.length) return;
			const message = buffered.subarray(0, header.length);
			buffered = buffered.subarray(header.length);
			if (header.type === 1 && header.destination === BUS && header.interface === BUS && header.member === "Hello") {
				// Prism said Hello already: the command gets Prism's name. Off, a name of its own, so that its first
				// real call gets the reason it is refused.
				if (!greeted) {
					const name = bus?.unique ?? ":prism.0";
					toCommand(
						buildMessage(
							2,
							1,
							serial++,
							[
								[5, "u", header.serial],
								[6, "s", name],
								[7, "s", BUS],
							],
							name,
						),
					);
					greeted = true;
					relay();
				}
				continue;
			}
			let why = bus
				? refusal(header, bus.systemd)
				: (full ??
					"commands do not read the state of services. Ask the user to turn on « Commands read the state of services » in /settings > Permissions & sandbox.");
			let fields: ReadonlyMap<string, string> | undefined;
			if (why === undefined && header.interface === `${BUS}.Properties`) {
				try {
					const allowed = stateProperties(message, header);
					if (header.member === "GetAll") fields = allowed;
				} catch (error) {
					why = error instanceof Error ? error.message : "invalid state property request";
				}
			}
			const matching =
				header.destination === BUS && (header.member === "AddMatch" || header.member === "RemoveMatch");
			const match = matching ? serviceMatch(message, header) : undefined;
			if (why === undefined && matching && !match)
				why =
					"match rules must select only systemd signals or NameOwnerChanged for org.freedesktop.systemd1; eavesdropping is refused";
			if (why === undefined && (header.serial === 0 || pending.has(header.serial)))
				why = "method calls need a nonzero serial with no pending reply";
			// fork: calls waiting for the bus's reply are bounded.
			if (why === undefined && (header.flags & 1) === 0 && pending.size >= MAX_PENDING_CALLS)
				why = `more than ${MAX_PENDING_CALLS} calls are waiting for a reply`;
			if (why === undefined) {
				if ((header.flags & 1) === 0)
					pending.set(header.serial, {
						sender: header.destination === BUS ? BUS : bus?.systemd,
						match,
						remove: header.member === "RemoveMatch",
						fields,
					});
				toBus(message);
			}
			// A reply the command does not wait for, or a signal: dropped.
			else if (header.type === 1 && (header.flags & 1) === 0) toCommand(refuse(header, serial++, why));
		}
	}
	stream.on("data", (chunk: Buffer) => {
		buffered = Buffer.concat([buffered, chunk]);
		step();
	});
	flow();
	step();
}
