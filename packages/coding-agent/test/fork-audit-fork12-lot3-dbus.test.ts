// fork: each D-Bus connection of the sandbox made Prism open its own connection
// to the system bus, as the user, without a bound; the bus limits each user's connections, so a command could take
// the bus from the user's other programs. A fake bus on an abstract socket counts the connections Prism opens.
import { createServer, type Server, type Socket } from "node:net";
import { type Duplex, duplexPair } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildMessage, MAX_BUS_CONNECTIONS, parseHeader, serveDbus } from "../src/fork/sandbox/dbus.ts";
import type { CommandNetwork } from "../src/fork/sandbox/proxy.ts";

const BUS = "org.freedesktop.DBus";
const busCall = (member: string, serial: number) =>
	buildMessage(1, 0, serial, [
		[1, "o", "/org/freedesktop/DBus"],
		[6, "s", BUS],
		[2, "s", BUS],
		[3, "s", member],
	]);

describe("fork: Prism's connections to the system bus for the sandbox are bounded (AS-030)", () => {
	let server: Server;
	let busPath: string;
	let open: Set<Socket>;
	let streams: Duplex[];

	beforeEach(async () => {
		open = new Set();
		streams = [];
		busPath = `\0prism-as030-${process.pid}-${Math.random()}`;
		// Answers the authentication, Hello and GetNameOwner, and any other call.
		server = createServer((socket) => {
			open.add(socket);
			socket.on("close", () => open.delete(socket));
			socket.on("error", () => {});
			let buffered = Buffer.alloc(0);
			let begun = false;
			let names = 0;
			socket.on("data", (chunk: Buffer) => {
				buffered = Buffer.concat([buffered, chunk]);
				if (!begun) {
					if (buffered.includes("AUTH EXTERNAL") && !buffered.includes("OK-SENT")) {
						socket.write("OK 0123456789abcdef0123456789abcdef\r\n");
						buffered = Buffer.concat([buffered, Buffer.from("OK-SENT")]);
					}
					const end = buffered.indexOf("BEGIN\r\n");
					if (end < 0) return;
					begun = true;
					buffered = buffered.subarray(end + 7);
				}
				for (;;) {
					const message = parseHeader(buffered);
					if (!message || typeof message === "string" || buffered.length < message.length) return;
					buffered = buffered.subarray(message.length);
					const value = message.member === "Hello" ? `:1.${++names + 100}` : ":1.1";
					socket.write(
						buildMessage(
							2,
							1,
							100 + names,
							[
								[5, "u", message.serial],
								[6, "s", ":1.101"],
								[7, "s", BUS],
							],
							value,
						),
					);
				}
			});
		});
		await new Promise<void>((done) => server.listen(busPath, () => done()));
	});

	afterEach(async () => {
		for (const stream of streams) stream.destroy();
		for (const socket of open) socket.destroy();
		await new Promise<void>((done) => server.close(() => done()));
	});

	/** One sandbox connection: authenticates, says Hello, calls GetId; resolves with GetId's reply text. */
	const connection = () =>
		new Promise<string>((done) => {
			const [command, relay] = duplexPair();
			streams.push(command, relay);
			void serveDbus(relay, Buffer.alloc(0), { serviceState: true } as CommandNetwork, busPath);
			let buffered = Buffer.alloc(0);
			command.on("close", () => done("closed"));
			command.on("data", (chunk: Buffer) => {
				buffered = Buffer.concat([buffered, chunk]);
				for (;;) {
					if (buffered.toString("latin1", 0, 3) === "OK ") {
						buffered = buffered.subarray(buffered.indexOf("\r\n") + 2);
						continue;
					}
					if (buffered.toString("latin1", 0, 6) === "DATA\r\n") {
						buffered = buffered.subarray(6);
						continue;
					}
					const message = parseHeader(buffered);
					if (!message || typeof message === "string" || buffered.length < message.length) return;
					if (message.replySerial === 2) done(buffered.toString("latin1", message.body, message.length));
					buffered = buffered.subarray(message.length);
				}
			});
			command.write("\0AUTH EXTERNAL\r\nDATA\r\nBEGIN\r\n");
			command.write(busCall("Hello", 1));
			command.write(busCall("GetId", 2));
		});

	it("opens at most the bound, answers the others with the reason, and frees a place when one closes", async () => {
		const replies: string[] = [];
		for (let n = 0; n < MAX_BUS_CONNECTIONS + 24; n++) replies.push(await connection());
		expect(open.size).toBe(MAX_BUS_CONNECTIONS);
		expect(replies.slice(0, MAX_BUS_CONNECTIONS).every((reply) => reply.includes(":1.1"))).toBe(true);
		const refused = replies.slice(MAX_BUS_CONNECTIONS);
		expect(refused.every((reply) => reply.includes("D-Bus connections of sandboxed commands are open at once"))).toBe(
			true,
		);
		// Closing the served ones frees their places.
		for (const stream of streams) stream.destroy();
		streams = [];
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(open.size).toBe(0);
		expect(await connection()).toContain(":1.1");
	});
});
