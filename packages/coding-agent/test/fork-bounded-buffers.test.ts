/**
 * fork: every buffer between a producer and a consumer has a bound;
 * above it the producer is paused, or the stream fails with a message.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Duplex, duplexPair, PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { serveContainers } from "../src/fork/sandbox/containers.ts";
import { buildMessage, serveDbus } from "../src/fork/sandbox/dbus.ts";
import { MAX_STREAMS, Mux, WINDOW } from "../src/fork/sandbox/mux.ts";
import type { CommandNetwork } from "../src/fork/sandbox/proxy.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Two muxes joined by pipes; `opened` gets the streams the relay side opens. */
function pair() {
	const relayToPrism = new PassThrough();
	const prismToRelay = new PassThrough();
	const opened: Duplex[] = [];
	new Mux(relayToPrism, prismToRelay, (stream) => opened.push(stream));
	const relay = new Mux(prismToRelay, relayToPrism);
	return { relay, opened, prismToRelay, relayToPrism };
}

describe("fork: bounded buffers", () => {
	it("a stream nobody reads holds at most its window while another keeps flowing", async () => {
		const { relay, opened } = pair();
		const stuck = relay.open();
		const flowing = relay.open();
		await tick();
		const [stuckFar, flowingFar] = opened;
		stuckFar.pause();
		let flowed = 0;
		flowingFar.on("data", (chunk: Buffer) => {
			flowed += chunk.length;
		});
		const piece = Buffer.alloc(64 * 1024, 1);
		let stuckWritten = 0;
		// Both write 8 MiB, interleaved: the stuck one's writes stop being accepted at its window.
		for (let round = 0; round < 128; round++) {
			stuck.write(piece);
			flowing.write(piece);
			stuckWritten += piece.length;
			await tick();
		}
		await tick();
		expect(stuckFar.readableLength).toBeLessThanOrEqual(WINDOW);
		expect(flowed).toBe(128 * piece.length);
		// The stuck writer waits: what it wrote beyond the window is held on its side, as backpressure.
		expect(stuck.writableNeedDrain).toBe(true);
		// Read again, the stuck stream gets everything, in order.
		let got = 0;
		stuckFar.on("data", (chunk: Buffer) => {
			got += chunk.length;
		});
		stuckFar.resume();
		for (let round = 0; round < 400 && got < stuckWritten; round++) await tick();
		expect(got).toBe(stuckWritten);
	});

	// fork: each open stream may hold a window; their number is bounded too.
	it("refuses a stream past the channel's limit, and keeps the channel and its other streams", async () => {
		const { relay, opened } = pair();
		const streams = Array.from({ length: MAX_STREAMS + 1 }, () => relay.open());
		await tick();
		await tick();
		expect(opened).toHaveLength(MAX_STREAMS);
		const refused = streams.at(-1)!;
		expect(refused.destroyed).toBe(true);
		expect(streams[0]!.destroyed).toBe(false);

		// The other streams still carry data, and a freed place takes a new stream.
		const got: Buffer[] = [];
		opened[0]!.on("data", (chunk: Buffer) => got.push(chunk));
		streams[0]!.write("still here");
		streams[1]!.destroy();
		await tick();
		await tick();
		expect(Buffer.concat(got).toString()).toBe("still here");
		const next = relay.open();
		await tick();
		await tick();
		expect(opened).toHaveLength(MAX_STREAMS + 1);
		expect(next.destroyed).toBe(false);
	});

	it("a peer that sends past its window closes the channel", async () => {
		const { relay, opened, relayToPrism } = pair();
		const stream = relay.open();
		await tick();
		const far = opened[0];
		far.pause();
		const closed = new Promise((resolve) => far.on("close", resolve));
		// Frames written by hand, ignoring the window: DATA on stream 1, 1 MiB at a time.
		const frame = Buffer.alloc(9 + 1024 * 1024);
		frame.writeUInt8(2, 0);
		frame.writeUInt32BE(1, 1);
		frame.writeUInt32BE(1024 * 1024, 5);
		relayToPrism.write(frame);
		await closed;
		expect(stream).toBeDefined();
	});

	it("a D-Bus command that never reads its replies is paused, not answered without bound", async () => {
		const [command, relay] = duplexPair();
		void serveDbus(relay, Buffer.alloc(0), {} as CommandNetwork);
		command.write("\0AUTH EXTERNAL\r\nDATA\r\nBEGIN\r\n");
		const refused = (serial: number) =>
			buildMessage(1, 0, serial, [
				[1, "o", "/org/freedesktop/systemd1"],
				[6, "s", "org.freedesktop.systemd1"],
				[2, "s", "org.freedesktop.systemd1.Manager"],
				[3, "s", "StartUnit"],
			]);
		// 20 000 calls, each refused with a reply the command never reads.
		let accepted = 0;
		for (let serial = 1; serial <= 20_000; serial++) {
			if (command.write(refused(serial))) accepted++;
			if (serial % 500 === 0) await tick();
		}
		await tick();
		// The replies waiting for the command, and the calls waiting for Prism, stay near one stream buffer each.
		expect(relay.writableLength).toBeLessThan(256 * 1024);
		expect(relay.readableLength).toBeLessThan(256 * 1024);
		expect(accepted).toBeLessThan(20_000);
		command.destroy();
	});

	it("a container request the service does not answer holds the next ones back, and ends with its connection", async () => {
		const root = mkdtempSync(join(tmpdir(), "prism-containers-"));
		let asked = 0;
		const ended = new Promise<void>((resolve) => {
			// A service that never answers.
			const docker = createServer((incoming) => {
				asked++;
				incoming.socket.once("close", () => {
					docker.close();
					resolve();
				});
			});
			docker.listen(join(root, "docker.sock"));
		});
		vi.stubEnv("DOCKER_HOST", `unix://${join(root, "docker.sock")}`);
		try {
			const [client, relay] = duplexPair();
			serveContainers(relay, Buffer.alloc(0), {
				containers: true,
				sandboxWrites: () => false,
			} as unknown as CommandNetwork);
			client.write("GET /v1.43/containers/json HTTP/1.1\r\nHost: d\r\n\r\n");
			for (let round = 0; round < 50 && asked === 0; round++)
				await new Promise((resolve) => setTimeout(resolve, 10));
			expect(asked).toBe(1);
			// 32 MiB more while the first waits: held at the writer, not gathered by Prism.
			const piece = Buffer.alloc(1024 * 1024, 0x61);
			for (let round = 0; round < 32; round++) {
				client.write(piece);
				await tick();
			}
			expect(client.writableLength).toBeGreaterThan(16 * 1024 * 1024);
			expect(relay.destroyed).toBe(false);
			// The connection closes: the service's request ends with it.
			client.destroy();
			relay.destroy();
			await ended;
		} finally {
			vi.unstubAllEnvs();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
