import * as net from "node:net";
import { type Duplex, duplexPair } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildMessage, type DbusHeader, parseHeader, REFUSED, refusal, serveDbus } from "../src/fork/sandbox/dbus.ts";
import { parseSandboxSettings } from "../src/fork/sandbox/layout.ts";
import type { CommandNetwork } from "../src/fork/sandbox/proxy.ts";

vi.mock("node:net", { spy: true });

type Field = Parameters<typeof buildMessage>[3][number];
const call = (destination: string, path: string, iface: string, member: string, serial = 2, flags = 0) =>
	buildMessage(1, flags, serial, [
		[1, "o", path],
		[6, "s", destination],
		[2, "s", iface],
		[3, "s", member],
	]);
const header = (message: Buffer) => parseHeader(message) as DbusHeader;
const SYSTEMD = "org.freedesktop.systemd1";
const UNIT = "/org/freedesktop/systemd1/unit/dbus_2eservice";
const BUS = "org.freedesktop.DBus";
const matchCall = (rule: string, serial = 2, member = "AddMatch") =>
	buildMessage(
		1,
		0,
		serial,
		[
			[1, "o", "/org/freedesktop/DBus"],
			[6, "s", BUS],
			[2, "s", BUS],
			[3, "s", member],
		],
		rule,
	);

function propertyCall(member: "Get" | "GetAll", property: string, serial = 2, iface = `${SYSTEMD}.Service`): Buffer {
	const message = buildMessage(1, 0, serial, [
		[1, "o", UNIT],
		[6, "s", SYSTEMD],
		[2, "s", `${BUS}.Properties`],
		[3, "s", member],
		[8, "g", member === "Get" ? "ss" : "s"],
	]);
	const parts: Buffer[] = [];
	let size = 0;
	for (const value of member === "Get" ? [iface, property] : [iface]) {
		const padding = Buffer.alloc((4 - (size % 4)) % 4);
		const text = Buffer.from(`${value}\0`);
		const length = Buffer.alloc(4);
		length.writeUInt32LE(text.length - 1);
		parts.push(padding, length, text);
		size += padding.length + length.length + text.length;
	}
	message.writeUInt32LE(size, 4);
	return Buffer.concat([message, ...parts]);
}

type EncodedValue = { signature: string; encode(offset: number): Buffer };
type Property = [string, string | number | bigint | string[] | EncodedValue];

/** One systemd tuple, optionally inside an array, with synthetic arguments/credentials only. */
function tupleValue(signature: string, values: (string | number | bigint | string[] | Buffer)[]): EncodedValue {
	return {
		signature,
		encode(offset) {
			const parts: Buffer[] = [];
			let at = offset;
			const push = (bytes: Buffer) => {
				parts.push(bytes);
				at += bytes.length;
			};
			const pad = (to: number) => push(Buffer.alloc((to - (at % to)) % to));
			const word = (value: number) => {
				pad(4);
				const bytes = Buffer.alloc(4);
				bytes.writeUInt32LE(value);
				push(bytes);
			};
			const text = (value: string) => {
				const bytes = Buffer.from(`${value}\0`);
				word(bytes.length - 1);
				push(bytes);
			};
			const arrayLength = Buffer.alloc(4);
			if (signature[0] === "a") push(arrayLength);
			pad(8);
			const start = at;
			for (const value of values) {
				if (typeof value === "string") text(value);
				else if (typeof value === "number") word(value);
				else if (typeof value === "bigint") {
					pad(8);
					const bytes = Buffer.alloc(8);
					bytes.writeBigUInt64LE(value);
					push(bytes);
				} else {
					pad(4);
					const length = Buffer.alloc(4);
					push(length);
					const start = at;
					if (Buffer.isBuffer(value)) push(value);
					else for (const item of value) text(item);
					length.writeUInt32LE(at - start);
				}
			}
			arrayLength.writeUInt32LE(at - start);
			return Buffer.concat(parts);
		},
	};
}

function dictionaryReply(serial: number, properties: Property[]): Buffer {
	const message = buildMessage(2, 1, 100 + serial, [
		[5, "u", serial],
		[6, "s", ":1.42"],
		[7, "s", ":1.1"],
		[8, "g", "a{sv}"],
	]);
	const parts: Buffer[] = [Buffer.alloc(8)];
	let size = 8;
	for (const [key, value] of properties) {
		const padding = Buffer.alloc((8 - (size % 8)) % 8);
		const name = Buffer.from(`${key}\0`);
		const length = Buffer.alloc(4);
		length.writeUInt32LE(name.length - 1);
		const encoded = typeof value === "object" && !Array.isArray(value) ? value : undefined;
		const type = encoded
			? encoded.signature
			: typeof value === "number"
				? "u"
				: typeof value === "bigint"
					? "t"
					: Array.isArray(value)
						? "as"
						: "s";
		parts.push(padding, length, name, Buffer.from([type.length]), Buffer.from(`${type}\0`));
		size += padding.length + 4 + name.length + type.length + 2;
		const to = type === "t" || type[0] === "(" ? 8 : 4;
		const valuePadding = Buffer.alloc((to - (size % to)) % to);
		if (encoded) {
			const bytes = encoded.encode(size + valuePadding.length);
			parts.push(valuePadding, bytes);
			size += valuePadding.length + bytes.length;
			continue;
		}
		if (typeof value === "bigint") {
			const bytes = Buffer.alloc(8);
			bytes.writeBigUInt64LE(value);
			parts.push(valuePadding, bytes);
			size += valuePadding.length + 8;
			continue;
		}
		if (Array.isArray(value)) {
			const entries: Buffer[] = [];
			let bytes = 0;
			for (const item of value) {
				const padding = Buffer.alloc((4 - (bytes % 4)) % 4);
				const text = Buffer.from(`${item}\0`);
				const word = Buffer.alloc(4);
				word.writeUInt32LE(text.length - 1);
				entries.push(padding, word, text);
				bytes += padding.length + 4 + text.length;
			}
			const length = Buffer.alloc(4);
			length.writeUInt32LE(bytes);
			parts.push(valuePadding, length, ...entries);
			size += valuePadding.length + 4 + bytes;
			continue;
		}
		const bytes = typeof value === "number" ? Buffer.alloc(0) : Buffer.from(`${value}\0`);
		const word = Buffer.alloc(4);
		word.writeUInt32LE(typeof value === "number" ? value : bytes.length - 1);
		parts.push(valuePadding, word, bytes);
		size += valuePadding.length + 4 + bytes.length;
	}
	const body = Buffer.concat(parts);
	body.writeUInt32LE(size - 8);
	message.writeUInt32LE(size, 4);
	return Buffer.concat([message, body]);
}

function variantReply(serial: number, value: string | number): Buffer {
	const message = buildMessage(2, 1, 100 + serial, [
		[5, "u", serial],
		[6, "s", ":1.42"],
		[7, "s", ":1.1"],
		[8, "g", "v"],
	]);
	const text = typeof value === "number" ? Buffer.alloc(0) : Buffer.from(`${value}\0`);
	const body = Buffer.alloc(8);
	body.set([1, typeof value === "number" ? 0x75 : 0x73, 0]);
	body.writeUInt32LE(typeof value === "number" ? value : text.length - 1, 4);
	message.writeUInt32LE(body.length + text.length, 4);
	return Buffer.concat([message, body, text]);
}

/** These fixtures contain string request bodies or a dictionary of string/uint32 variants. */
function bigEndian(message: Buffer): Buffer {
	const result = Buffer.from(message);
	const parsed = header(message);
	const swap = (at: number) => result.writeUInt32BE(message.readUInt32LE(at), at);
	const stringEnd = (at: number) => {
		at = Math.ceil(at / 4) * 4;
		swap(at);
		return at + 5 + message.readUInt32LE(at);
	};
	result[0] = 0x42;
	for (const at of [4, 8, 12]) swap(at);
	let at = 16;
	while (at < 16 + message.readUInt32LE(12)) {
		at = Math.ceil(at / 8) * 8;
		const type = message[at + 2];
		at += 4;
		if (type === "u".charCodeAt(0)) {
			swap(at);
			at += 4;
		} else if (type === "g".charCodeAt(0)) at += message[at]! + 2;
		else at = stringEnd(at);
	}
	at = parsed.body;
	if (parsed.signature === "a{sv}") {
		swap(at);
		at += 8;
		while (at < parsed.length) {
			at = stringEnd(Math.ceil(at / 8) * 8);
			const type = message[at + 1];
			at = Math.ceil((at + 3) / 4) * 4;
			if (type === "u".charCodeAt(0)) {
				swap(at);
				at += 4;
			} else at = stringEnd(at);
		}
	} else while (at < parsed.length) at = stringEnd(at);
	return result;
}

// fork: the sandbox reads the state of services over D-Bus, and changes nothing.
describe("fork: the system's services from the sandbox", () => {
	it("keeps service reads disabled by default", () => {
		expect(parseSandboxSettings({}).serviceState).toBe(false);
	});
	it("passes reading calls to systemd only", () => {
		for (const [path, iface, member] of [
			[UNIT, "org.freedesktop.DBus.Properties", "GetAll"],
			[UNIT, "org.freedesktop.DBus.Properties", "Get"],
			["/org/freedesktop/systemd1", `${SYSTEMD}.Manager`, "ListUnits"],
			["/org/freedesktop/systemd1", `${SYSTEMD}.Manager`, "GetUnitFileState"],
		]) {
			expect(refusal(header(call(SYSTEMD, path!, iface!, member!))), member).toBeUndefined();
		}
		for (const [destination, path, iface, member] of [
			[SYSTEMD, "/org/freedesktop/systemd1", `${SYSTEMD}.Manager`, "StopUnit"],
			[SYSTEMD, "/org/freedesktop/systemd1", `${SYSTEMD}.Manager`, "GetUnitProcesses"],
			[SYSTEMD, UNIT, "org.freedesktop.DBus.Properties", "Set"],
			[SYSTEMD, UNIT, `${SYSTEMD}.Unit`, "Stop"],
			["org.freedesktop.login1", "/org/freedesktop/login1", "org.freedesktop.login1.Manager", "PowerOff"],
			["org.freedesktop.login1", "/org/freedesktop/login1", "org.freedesktop.DBus.Properties", "GetAll"],
			["org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "BecomeMonitor"],
			["org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus.Monitoring", "BecomeMonitor"],
			[SYSTEMD, "/elsewhere", "org.freedesktop.DBus.Properties", "GetAll"],
			[":1.1", UNIT, "org.freedesktop.DBus.Properties", "GetAll"],
		]) {
			expect(refusal(header(call(destination!, path!, iface!, member!))), `${destination} ${member}`).toContain(
				" on ",
			);
		}
		// systemd by its unique name, once Prism knows it.
		expect(refusal(header(call(":1.1", UNIT, "org.freedesktop.DBus.Properties", "GetAll")), ":1.1")).toBeUndefined();
		// No interface: the service would pick any method of that name.
		const bare = buildMessage(1, 0, 2, [
			[1, "o", "/org/freedesktop/systemd1"],
			[6, "s", SYSTEMD],
			[3, "s", "StopUnit"],
		]);
		expect(refusal(header(bare))).toContain("names no");
		// A signal or a reply from the command reaches no one.
		expect(
			refusal({ ...header(call(SYSTEMD, UNIT, "org.freedesktop.DBus.Properties", "GetAll")), type: 4 }),
		).toContain("only make method calls");
	});

	it("reads only well-formed headers, each field once", () => {
		const message = call(SYSTEMD, UNIT, "org.freedesktop.DBus.Properties", "GetAll");
		expect(parseHeader(message.subarray(0, 10))).toBeUndefined();
		expect(header(message)).toMatchObject({ destination: SYSTEMD, member: "GetAll", length: message.length });
		const twice: Field[] = [
			[1, "o", UNIT],
			[6, "s", SYSTEMD],
			[2, "s", "org.freedesktop.DBus.Properties"],
			[3, "s", "GetAll"],
			[3, "s", "SetAll"],
		];
		expect(parseHeader(buildMessage(1, 0, 2, twice))).toBe("field given twice");
		const wrong = Buffer.from(message);
		wrong[3] = 2;
		expect(parseHeader(wrong)).toBe("unknown protocol version");
		const typed = buildMessage(1, 0, 2, [[6, "u", 5]]);
		expect(parseHeader(typed)).toBe("field of the wrong type");
	});

	describe("serving the sandbox's connection", () => {
		let streams: Duplex[];
		let busPath: string;
		let seen: string[];
		let network: Pick<CommandNetwork, "serviceState">;
		let inject: Buffer[];
		let propertyReply: string | number;
		let properties: Property[];
		let replyTransform: (message: Buffer) => Buffer;

		/** A bus that answers Hello and GetNameOwner, and records the other calls it gets. */
		beforeEach(() => {
			streams = [];
			seen = [];
			inject = [];
			propertyReply = "ok";
			properties = [
				["ActiveState", "active"],
				["SubState", "running"],
				["MainPID", 42],
			];
			replyTransform = (message) => message;
			busPath = `\0prism-dbus-test-${process.pid}-${Math.random()}`;
			vi.mocked(net.connect).mockImplementation(() => {
				const [client, socket] = duplexPair();
				streams.push(client, socket);
				let buffered = Buffer.alloc(0);
				let begun = false;
				socket.on("data", (chunk: Buffer) => {
					queueMicrotask(() => {
						buffered = Buffer.concat([buffered, chunk]);
						if (!begun) {
							const end = buffered.indexOf("BEGIN\r\n");
							if (buffered.includes("AUTH EXTERNAL") && !buffered.includes("OK-SENT")) {
								socket.write("OK 0123456789abcdef0123456789abcdef\r\n");
								buffered = Buffer.concat([buffered, Buffer.from("OK-SENT")]);
							}
							if (end < 0) return;
							begun = true;
							buffered = buffered.subarray(end + 7);
						}
						for (;;) {
							const message = parseHeader(buffered);
							if (!message || typeof message === "string" || buffered.length < message.length) return;
							buffered = buffered.subarray(message.length);
							seen.push(String(message.member));
							const reply =
								message.member === "Hello"
									? ":1.42"
									: message.member === "GetNameOwner"
										? ":1.1"
										: propertyReply;
							if (message.member === "GetAll" || message.member === "ListUnits")
								for (const extra of inject) socket.write(extra);
							if (message.member === "GetAll") {
								socket.write(replyTransform(dictionaryReply(message.serial, properties)));
								continue;
							}
							if (message.member === "Get") {
								socket.write(variantReply(message.serial, propertyReply));
								continue;
							}
							socket.write(
								buildMessage(
									2,
									1,
									100 + seen.length,
									[
										[5, "u", message.serial],
										[6, "s", ":1.42"],
										[7, "s", message.destination === BUS ? BUS : ":1.1"],
									],
									String(reply),
								),
							);
						}
					});
				});
				queueMicrotask(() => client.emit("connect"));
				return client as net.Socket;
			});
			network = { serviceState: true };
		});
		afterEach(() => {
			for (const stream of streams) stream.destroy();
			vi.restoreAllMocks();
		});

		/** A client: authenticates, says Hello, makes `calls`, and returns the replies, by the serial they answer. */
		const session = (calls: Buffer[], signalCount = 0) =>
			new Promise<Map<number, { type: number; text: string }>>((done, fail) => {
				const replies = new Map<number, { type: number; text: string }>();
				const replyCount = new Set([1, ...calls.map((message) => header(message).serial)]).size;
				const [socket, relay] = duplexPair();
				streams.push(socket, relay);
				void serveDbus(relay, Buffer.alloc(0), network as CommandNetwork, busPath);
				let buffered = Buffer.alloc(0);
				socket.on("error", fail);
				socket.write("\0AUTH EXTERNAL\r\nDATA\r\nBEGIN\r\n");
				socket.write(call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "Hello", 1));
				for (const message of calls) socket.write(message);
				socket.on("data", (chunk: Buffer) => {
					buffered = Buffer.concat([buffered, chunk]);
					for (;;) {
						const ok = buffered.indexOf("OK ");
						if (ok === 0) {
							buffered = buffered.subarray(buffered.indexOf("\r\n") + 2);
							continue;
						}
						if (buffered.toString("latin1", 0, 6) === "DATA\r\n") {
							buffered = buffered.subarray(6);
							continue;
						}
						const message = parseHeader(buffered);
						if (!message || typeof message === "string" || buffered.length < message.length) return;
						const valueAt = message.body + (message.signature === "v" ? 4 : 0);
						const size = buffered.readUInt32LE(valueAt);
						replies.set(message.replySerial ?? 0, {
							type: message.type,
							text:
								message.signature === "a{sv}"
									? buffered.toString("latin1", message.body, message.length)
									: message.signature === "v" && buffered[message.body + 1] === 0x75
										? String(size)
										: buffered.toString("utf8", valueAt + 4, valueAt + 4 + size),
						});
						buffered = buffered.subarray(message.length);
						if (replies.size === replyCount + signalCount) {
							socket.end();
							done(replies);
						}
					}
				});
			});

		it("passes reading calls, answers the others itself with the reason, and greets with Prism's name", async () => {
			const replies = await session([
				propertyCall("GetAll", "", 2, ""),
				call(SYSTEMD, "/org/freedesktop/systemd1", `${SYSTEMD}.Manager`, "StopUnit", 3),
				propertyCall("Get", "MainPID", 4),
			]);
			expect(replies.get(1)).toEqual({ type: 2, text: ":1.42" });
			expect(replies.get(2)?.type).toBe(2);
			expect(replies.get(2)?.text).toContain("ActiveState");
			expect(replies.get(3)?.type).toBe(3);
			expect(replies.get(3)?.text).toContain("StopUnit on org.freedesktop.systemd1 is refused");
			expect(replies.get(4)).toEqual({ type: 2, text: "ok" });
			// Prism's own Hello and GetNameOwner, then the command's reading calls, and nothing else.
			expect(seen).toEqual(["Hello", "GetNameOwner", "GetAll", "Get"]);
			expect(REFUSED).not.toContain("AccessDenied");
		});

		it("reaches no bus while the setting is off, and says which setting", async () => {
			network.serviceState = false;
			const replies = await session([call(SYSTEMD, UNIT, "org.freedesktop.DBus.Properties", "GetAll", 2)]);
			expect(replies.get(1)?.type).toBe(2);
			expect(replies.get(2)?.text).toContain("Commands read the state of services");
			expect(seen).toEqual([]);
		});

		it.each([
			"",
			"type='signal'",
			"sender='org.freedesktop.login1',type='signal'",
			"type='signal',sender='org.freedesktop.systemd1',eavesdrop='true'",
			"type='method_return',sender='org.freedesktop.systemd1'",
			"type='signal',sender='org.freedesktop.systemd1',sender='org.freedesktop.login1'",
			"type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged'",
			"type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0='other.service'",
			"type='signal',sender='org.freedesktop.systemd1',arg1='secret'",
			"type='signal',sender='org.freedesktop.systemd1',member='bad\\'value'",
		])("refuses an unscoped or ambiguous match: %s", async (rule) => {
			for (const member of ["AddMatch", "RemoveMatch"]) {
				const replies = await session([matchCall(rule, 2, member)]);
				expect(replies.get(2)?.type).toBe(3);
				expect(replies.get(2)?.text).toContain("match rules must select only systemd signals");
			}
			expect(seen.filter((member) => member.endsWith("Match"))).toEqual([]);
		});

		it("allows scoped systemd and owner-change matches", async () => {
			const rules = [
				"type='signal',sender='org.freedesktop.systemd1',path_namespace='/org/freedesktop/systemd1'",
				"type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0='org.freedesktop.systemd1'",
			];
			const replies = await session(rules.map((rule, i) => matchCall(rule, i + 2)));
			expect([...replies.values()].every((reply) => reply.type === 2)).toBe(true);
			expect(seen).toEqual(["Hello", "GetNameOwner", "AddMatch", "AddMatch"]);
		});

		it.each(["missing body", "missing terminator", "trailing bytes"])(
			"refuses a match with %s",
			async (malformed) => {
				let message = matchCall("type='signal',sender='org.freedesktop.systemd1'");
				if (malformed === "missing body") message = call(BUS, "/org/freedesktop/DBus", BUS, "AddMatch");
				else if (malformed === "missing terminator") message[message.length - 1] = 1;
				else {
					message = Buffer.concat([message, Buffer.from([1])]);
					message.writeUInt32LE(message.readUInt32LE(4) + 1, 4);
				}
				const replies = await session([message]);
				expect(replies.get(2)?.text).toContain("match rules must select only systemd signals");
				expect(seen).toEqual(["Hello", "GetNameOwner"]);
			},
		);

		it("drops unsolicited replies, wrong recipients, wrong senders and unrelated signals", async () => {
			inject = [
				buildMessage(
					2,
					1,
					900,
					[
						[5, "u", 999],
						[6, "s", ":1.42"],
						[7, "s", ":1.1"],
					],
					"unrequested-canary",
				),
				buildMessage(
					2,
					1,
					901,
					[
						[5, "u", 2],
						[6, "s", ":1.99"],
						[7, "s", ":1.1"],
					],
					"other-recipient-canary",
				),
				buildMessage(
					2,
					1,
					902,
					[
						[5, "u", 2],
						[6, "s", ":1.42"],
						[7, "s", ":1.99"],
					],
					"other-sender-canary",
				),
				buildMessage(
					4,
					1,
					903,
					[
						[1, "o", UNIT],
						[2, "s", SYSTEMD],
						[3, "s", "Changed"],
						[7, "s", ":1.1"],
					],
					"unsubscribed-canary",
				),
			];
			const replies = await session([call(SYSTEMD, "/org/freedesktop/systemd1", `${SYSTEMD}.Manager`, "ListUnits")]);
			expect([...replies.keys()]).toEqual([1, 2]);
			expect(replies.get(2)).toEqual({ type: 2, text: "ok" });
		});

		it.each(
			[
				"Environment",
				"ExecStart",
				"ExecCondition",
				"ExecStartPre",
				"ExecStartPost",
				"ExecReload",
				"ExecStop",
				"ExecStopPost",
				"EnvironmentFiles",
				"LoadCredential",
				"LoadCredentialEncrypted",
				"ImportCredential",
				"SetCredential",
				"SetCredentialEncrypted",
				"StandardInputData",
				"ExecStartEx",
				"StatusText",
				"LoadError",
				"UnknownFutureProperty",
			].flatMap((property) => (["Get", "GetAll"] as const).map((member) => [property, member] as const)),
		)("blocks sensitive property %s through %s", async (property, member) => {
			propertyReply = `${property}=synthetic-secret-canary`;
			properties = [
				[property, propertyReply],
				["MainPID", 42],
			];
			const replies = await session([propertyCall(member, property)]);
			expect(replies.get(2)?.type).toBe(member === "Get" ? 3 : 2);
			expect(replies.get(2)?.text).not.toContain("synthetic-secret-canary");
			if (member === "GetAll") {
				expect(replies.get(2)?.text).not.toContain(property);
				expect(replies.get(2)?.text).toContain("MainPID");
			}
			expect(seen.filter((member) => member === "Get")).toEqual([]);
		});

		it.each([false, true])("returns only correctly typed state fields (big endian: %s)", async (big) => {
			properties = [
				["Environment", "synthetic-secret-canary"],
				["ActiveState", "active"],
				["ExecStart", "canary"],
				["SubState", "running"],
				["MainPID", 42],
				["SetCredential", "canary"],
			];
			if (big) replyTransform = bigEndian;
			const request = propertyCall("GetAll", "", 2, "");
			const replies = await session([big ? bigEndian(request) : request]);
			const expected = dictionaryReply(2, [
				["ActiveState", "active"],
				["SubState", "running"],
				["MainPID", 42],
			]);
			const encoded = big ? bigEndian(expected) : expected;
			expect(replies.get(2)).toEqual({ type: 2, text: encoded.subarray(header(encoded).body).toString("latin1") });
		});

		it.each(["ActiveState", "SubState", "MainPID"])("passes Get of state property %s", async (property) => {
			propertyReply = property === "MainPID" ? 42 : property === "ActiveState" ? "active" : "running";
			const iface = `${SYSTEMD}.${property === "MainPID" ? "Service" : "Unit"}`;
			const replies = await session([propertyCall("Get", property, 2, iface)]);
			expect(replies.get(2)).toEqual({ type: 2, text: String(propertyReply) });
			expect(seen).toEqual(["Hello", "GetNameOwner", "Get"]);
		});

		it("keeps Names arrays while removing Environment arrays", async () => {
			properties = [
				["Environment", ["synthetic-secret-canary", "OTHER=canary"]],
				["Names", ["dbus.service", "alias.service"]],
				["MainPID", 42],
			];
			const replies = await session([propertyCall("GetAll", "", 2, "")]);
			const expected = dictionaryReply(2, [
				["Names", ["dbus.service", "alias.service"]],
				["MainPID", 42],
			]);
			expect(replies.get(2)).toEqual({ type: 2, text: expected.subarray(header(expected).body).toString("latin1") });
		});

		it("keeps timer event timestamps used by list-timers", async () => {
			properties = [
				["Result", "success"],
				["NextElapseUSecRealtime", 1234567890123456n],
				["NextElapseUSecMonotonic", 987654321n],
				["LastTriggerUSec", 1234567890123400n],
				["LastTriggerUSecMonotonic", 987654300n],
			];
			const replies = await session([propertyCall("GetAll", "", 2, `${SYSTEMD}.Timer`)]);
			const expected = dictionaryReply(2, properties);
			expect(replies.get(2)).toEqual({ type: 2, text: expected.subarray(header(expected).body).toString("latin1") });
		});

		it("keeps signed service exit status fields", async () => {
			const status = Buffer.alloc(4);
			status.writeInt32LE(-1);
			properties = [["ExecMainStatus", { signature: "i", encode: () => status }]];
			const replies = await session([propertyCall("GetAll", "")]);
			const expected = dictionaryReply(2, properties);
			expect(replies.get(2)).toEqual({ type: 2, text: expected.subarray(header(expected).body).toString("latin1") });
		});

		it.each([
			[
				"ExecStart",
				tupleValue("a(sasbttttuii)", [
					"/synthetic/program",
					["program", "synthetic-secret-canary"],
					0,
					0n,
					0n,
					0n,
					0n,
					42,
					0,
					0,
				]),
			],
			["SetCredential", tupleValue("a(say)", ["token", Buffer.from("synthetic-secret-canary")])],
			["LoadError", tupleValue("(ss)", ["synthetic.error", "synthetic-secret-canary"])],
		] as const)("removes structured configuration property %s", async (name, value) => {
			properties = [
				[name, value],
				["MainPID", 42],
			];
			const replies = await session([propertyCall("GetAll", "", 2, "")]);
			const expected = dictionaryReply(2, [["MainPID", 42]]);
			expect(replies.get(2)).toEqual({ type: 2, text: expected.subarray(header(expected).body).toString("latin1") });
		});

		it("removes a state property with a configuration-shaped value", async () => {
			properties = [["MainPID", "synthetic-secret-canary"]];
			const replies = await session([propertyCall("GetAll", "")]);
			expect(replies.get(2)).toEqual({ type: 2, text: Buffer.alloc(8).toString("latin1") });
		});

		it.each(["Unit", "Service", "Manager"])("limits GetAll to the requested %s interface", async (kind) => {
			properties = [
				["ActiveState", "active"],
				["MainPID", 42],
				["SystemState", "running"],
			];
			let request = propertyCall("GetAll", "", 2, `${SYSTEMD}.${kind}`);
			if (kind === "Manager") {
				request = buildMessage(
					1,
					0,
					2,
					[
						[1, "o", "/org/freedesktop/systemd1"],
						[6, "s", SYSTEMD],
						[2, "s", `${BUS}.Properties`],
						[3, "s", "GetAll"],
					],
					`${SYSTEMD}.Manager`,
				);
			}
			const replies = await session([request]);
			const expected = dictionaryReply(
				2,
				properties.filter(
					([name]) => name === (kind === "Unit" ? "ActiveState" : kind === "Service" ? "MainPID" : "SystemState"),
				),
			);
			expect(replies.get(2)).toEqual({ type: 2, text: expected.subarray(header(expected).body).toString("latin1") });
		});

		it("filters property reads addressed to systemd's unique name", async () => {
			properties = [
				["MainPID", 42],
				["Environment", "synthetic-secret-canary"],
			];
			const request = buildMessage(
				1,
				0,
				2,
				[
					[1, "o", UNIT],
					[6, "s", ":1.1"],
					[2, "s", `${BUS}.Properties`],
					[3, "s", "GetAll"],
				],
				`${SYSTEMD}.Service`,
			);
			const replies = await session([request]);
			expect(replies.get(2)?.text).toContain("MainPID");
			expect(replies.get(2)?.text).not.toContain("synthetic-secret-canary");
		});

		it.each([
			"missing body",
			"missing terminator",
			"trailing bytes",
			"unknown interface",
			"wrong property interface",
			"manager path",
			"job path",
		])("refuses a property read with %s", async (malformed) => {
			let request = propertyCall("Get", "ActiveState", 2, `${SYSTEMD}.Unit`);
			if (malformed === "missing body") request = call(SYSTEMD, UNIT, `${BUS}.Properties`, "Get");
			else if (malformed === "missing terminator") request[request.length - 1] = 1;
			else if (malformed === "trailing bytes") {
				request = Buffer.concat([request, Buffer.from([1])]);
				request.writeUInt32LE(request.readUInt32LE(4) + 1, 4);
			} else if (malformed === "unknown interface")
				request = propertyCall("Get", "ActiveState", 2, "dev.prism.Unknown");
			else if (malformed === "wrong property interface") request = propertyCall("Get", "ActiveState");
			else {
				const path = malformed === "job path" ? "/org/freedesktop/systemd1/job/123" : "/org/freedesktop/systemd1";
				const original = header(request);
				const replaced = buildMessage(1, 0, 2, [
					[1, "o", path],
					[6, "s", SYSTEMD],
					[2, "s", `${BUS}.Properties`],
					[3, "s", "Get"],
					[8, "g", "ss"],
				]);
				replaced.writeUInt32LE(request.length - original.body, 4);
				request = Buffer.concat([replaced, request.subarray(original.body)]);
			}
			const replies = await session([request]);
			expect(replies.get(2)?.type).toBe(3);
			expect(seen).toEqual(["Hello", "GetNameOwner"]);
		});

		it.each(["wrong signature", "wrong length", "truncated value"])(
			"refuses an invalid property reply with %s",
			async (malformed) => {
				replyTransform = (message) => {
					const parsed = header(message);
					if (malformed === "wrong signature")
						return buildMessage(
							2,
							1,
							100,
							[
								[5, "u", 2],
								[6, "s", ":1.42"],
								[7, "s", ":1.1"],
							],
							"synthetic-secret-canary",
						);
					if (malformed === "wrong length") message.writeUInt32LE(0xffffffff, parsed.body);
					else message.writeUInt32LE(0xffffffff, parsed.body + 8);
					return message;
				};
				const replies = await session([propertyCall("GetAll", "", 2, "")]);
				expect(replies.get(2)).toEqual({ type: 3, text: "Prism's sandbox: invalid state property reply" });
			},
		);

		it("drops subscribed systemd property signals that could embed configuration", async () => {
			const rule =
				"type='signal',sender='org.freedesktop.systemd1',interface='org.freedesktop.DBus.Properties',member='PropertiesChanged',path_namespace='/org/freedesktop/systemd1'";
			const signal = (sender: string, path: string, member: string) =>
				buildMessage(
					4,
					1,
					900,
					[
						[1, "o", path],
						[2, "s", `${BUS}.Properties`],
						[3, "s", member],
						[7, "s", sender],
					],
					"Environment=synthetic-secret-canary",
				);
			inject = [
				signal(":1.99", UNIT, "PropertiesChanged"),
				signal(":1.1", "/elsewhere", "PropertiesChanged"),
				signal(":1.1", UNIT, "Other"),
				signal(":1.1", UNIT, "PropertiesChanged"),
			];
			const replies = await session([matchCall(rule), propertyCall("GetAll", "", 3)]);
			expect(replies.has(0)).toBe(false);
			const removed = await session([
				matchCall(rule),
				matchCall(rule, 3, "RemoveMatch"),
				propertyCall("GetAll", "", 4),
			]);
			expect(removed.has(0)).toBe(false);
		});

		it.each(["sender", "path", "member", "recipient"])(
			"drops a subscribed signal with the wrong %s",
			async (wrong) => {
				const rule =
					"type='signal',sender='org.freedesktop.systemd1',interface='org.freedesktop.DBus.Properties',member='PropertiesChanged',path='/org/freedesktop/systemd1/unit/dbus_2eservice'";
				inject = [
					buildMessage(
						4,
						1,
						900,
						[
							[1, "o", wrong === "path" ? "/elsewhere" : UNIT],
							[2, "s", `${BUS}.Properties`],
							[3, "s", wrong === "member" ? "Other" : "PropertiesChanged"],
							[6, "s", wrong === "recipient" ? ":1.99" : ":1.42"],
							[7, "s", wrong === "sender" ? ":1.99" : ":1.1"],
						],
						"forbidden-signal-canary",
					),
				];
				const replies = await session([matchCall(rule), propertyCall("GetAll", "", 3)]);
				expect(replies.has(0)).toBe(false);
			},
		);

		it.each(["BecomeMonitor", "RequestName", "StartServiceByName", "ListNames"])(
			"refuses bus capability %s",
			async (member) => {
				const replies = await session([call(BUS, "/org/freedesktop/DBus", BUS, member)]);
				expect(replies.get(2)?.text).toContain(`${member} on ${BUS} is refused`);
				expect(seen).toEqual(["Hello", "GetNameOwner"]);
			},
		);

		it("refuses a zero serial instead of forwarding an untrackable call", async () => {
			const replies = await session([propertyCall("GetAll", "", 0)]);
			expect(replies.get(0)?.text).toContain("nonzero serial with no pending reply");
			expect(seen).toEqual(["Hello", "GetNameOwner"]);
		});

		it("refuses reuse of a pending serial before it can replace the expected sender", async () => {
			await session([propertyCall("GetAll", "", 2), propertyCall("GetAll", "", 2), propertyCall("GetAll", "", 3)]);
			expect(seen).toEqual(["Hello", "GetNameOwner", "GetAll", "GetAll"]);
		});

		it("refuses the Monitoring interface before the bus can grant a monitor role", async () => {
			const replies = await session([call(BUS, "/org/freedesktop/DBus", `${BUS}.Monitoring`, "BecomeMonitor")]);
			expect(replies.get(2)?.text).toContain("BecomeMonitor on org.freedesktop.DBus is refused");
			expect(seen).toEqual(["Hello", "GetNameOwner"]);
		});

		it.each(["other.service", SYSTEMD])("limits NameOwnerChanged delivery for %s", async (name) => {
			const rule =
				"type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0='org.freedesktop.systemd1'";
			inject = [
				buildMessage(
					4,
					1,
					900,
					[
						[1, "o", "/org/freedesktop/DBus"],
						[2, "s", BUS],
						[3, "s", "NameOwnerChanged"],
						[7, "s", BUS],
					],
					name,
				),
			];
			const replies = await session([matchCall(rule), propertyCall("GetAll", "", 3)], name === SYSTEMD ? 1 : 0);
			expect(replies.get(0)).toEqual(name === SYSTEMD ? { type: 4, text: SYSTEMD } : undefined);
		});

		it.each([
			"StartUnit",
			"RestartUnit",
			"Reload",
			"Reexecute",
			"SetEnvironment",
			"SetUnitProperties",
			"StartTransientUnit",
			"EnableUnitFiles",
			"Subscribe",
		])("refuses the systemd capability %s before it reaches the bus", async (member) => {
			const replies = await session([call(SYSTEMD, "/org/freedesktop/systemd1", `${SYSTEMD}.Manager`, member)]);
			expect(replies.get(2)?.text).toContain(`${member} on ${SYSTEMD} is refused`);
			expect(seen).toEqual(["Hello", "GetNameOwner"]);
		});

		it("continues to allow LoadUnit to read an unloaded unit", async () => {
			const replies = await session([call(SYSTEMD, "/org/freedesktop/systemd1", `${SYSTEMD}.Manager`, "LoadUnit")]);
			expect(replies.get(2)?.type).toBe(2);
			expect(seen).toEqual(["Hello", "GetNameOwner", "LoadUnit"]);
		});
	});

	// fork: a bus that hangs up or stays silent while Prism negotiates its own
	// connection fails that connection, and a command that leaves first stops the negotiation.
	describe("a system bus that goes away during Prism's negotiation", () => {
		let sockets: Duplex[];
		/** A bus that answers the authentication with `authReply`, if any, then does `then`. */
		const bus = (authReply: string | undefined, then: (socket: Duplex) => void) => {
			sockets = [];
			vi.mocked(net.connect).mockImplementation(() => {
				const [client, socket] = duplexPair();
				sockets.push(client, socket);
				socket.on("data", (chunk: Buffer) => {
					if (!chunk.includes("AUTH EXTERNAL")) return;
					if (authReply) socket.write(authReply);
					queueMicrotask(() => then(socket));
				});
				queueMicrotask(() => client.emit("connect"));
				return client as net.Socket;
			});
		};
		/** Serves one command connection; resolves with how it ended, or "pending" after `wait` ms. */
		const serve = async (wait = 300, leave?: (relay: Duplex) => void) => {
			const [command, relay] = duplexPair();
			const served = serveDbus(relay, Buffer.alloc(0), { serviceState: true } as CommandNetwork, "/bus");
			command.write("\0AUTH EXTERNAL\r\nDATA\r\nBEGIN\r\n");
			await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(0));
			leave?.(command);
			const outcome = await Promise.race([
				served.then(() => "served"),
				new Promise((resolve) => setTimeout(() => resolve("pending"), wait)),
			]);
			return { outcome, relay };
		};
		let stderr: { mock: { calls: unknown[][] }; mockClear(): void };
		/** What Prism wrote to its own log. */
		const logged = () =>
			stderr.mock.calls.map(([text]) => String(text)).filter((text) => text.startsWith("prism sandbox:"));
		beforeEach(() => {
			stderr = vi.spyOn(process.stderr, "write");
			stderr.mockClear();
		});
		afterEach(() => {
			for (const socket of sockets) socket.destroy();
			vi.restoreAllMocks();
		});

		it("fails when the bus closes before answering the authentication", async () => {
			bus(undefined, (socket) => socket.end());
			const { outcome, relay } = await serve();
			expect(outcome).toBe("served");
			expect(relay.destroyed).toBe(true);
			expect(sockets[0]?.destroyed).toBe(true);
			expect(logged().join("")).toContain("the system bus closed");
		});

		it("fails when the bus closes after the authentication, before naming Prism", async () => {
			bus("OK 0123456789abcdef0123456789abcdef\r\n", (socket) => socket.end());
			const { outcome, relay } = await serve();
			expect(outcome).toBe("served");
			expect(relay.destroyed).toBe(true);
			expect(sockets[0]?.destroyed).toBe(true);
		});

		it("drops Prism's connection when the command leaves first, without logging it", async () => {
			bus("OK 0123456789abcdef0123456789abcdef\r\n", () => {});
			const { outcome } = await serve(300, (command) => command.end());
			expect(outcome).toBe("served");
			expect(sockets[0]?.destroyed).toBe(true);
			expect(logged()).toEqual([]);
		});

		it("gives up on a bus that stays silent", async () => {
			bus("OK 0123456789abcdef0123456789abcdef\r\n", () => {});
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			try {
				const [command, relay] = duplexPair();
				const served = serveDbus(relay, Buffer.alloc(0), { serviceState: true } as CommandNetwork, "/bus");
				command.write("\0AUTH EXTERNAL\r\nDATA\r\nBEGIN\r\n");
				await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(0));
				await vi.advanceTimersByTimeAsync(60_000);
				await served;
				expect(relay.destroyed).toBe(true);
				expect(sockets[0]?.destroyed).toBe(true);
				expect(logged().join("")).toContain("did not answer");
				command.destroy();
			} finally {
				vi.useRealTimers();
			}
		});
	});
});
