/**
 * fork: a stdio server that stops reading its input does not get every
 * message queued for it: past twice the message limit in bytes, or 10 000 writes, the transport fails and closes.
 */
import { describe, expect, it } from "vitest";
import type { JsonRpcMessage } from "../src/index.ts";
import { StdioTransport } from "../src/index.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Sends `count` messages of `size` bytes without waiting, and returns the first refusal. */
async function flood(transport: StdioTransport, count: number, size: number): Promise<unknown> {
	const text = "x".repeat(size);
	let refused: unknown;
	for (let index = 0; index < count && refused === undefined; index++) {
		transport.send({ jsonrpc: "2.0", method: "notifications/message", params: { text } }).catch((error: unknown) => {
			refused ??= error;
		});
		if (index % 100 === 0) await tick();
	}
	await tick();
	return refused;
}

describe.skipIf(process.platform === "win32")("fork: bounded MCP stdio output", () => {
	// A server that never reads stdin and never exits on its own.
	const deaf = (maxMessageBytes: number) =>
		new StdioTransport({
			command: process.execPath,
			args: ["-e", "setInterval(() => {}, 1000)"],
			maxMessageBytes,
			closeTimeoutMs: 100,
		});

	for (const [name, maxMessageBytes, count, size] of [
		["large messages, past twice the message limit", 1024 * 1024, 400, 256 * 1024],
		["small messages, past 10 000 writes", 64 * 1024 * 1024, 20_000, 64],
	] as const) {
		it(`closes a server that never reads (${name}), instead of queueing without bound`, async () => {
			const transport = deaf(maxMessageBytes);
			const errors: unknown[] = [];
			let closed = false;
			transport.onError((error) => errors.push(error));
			transport.onClose(() => {
				closed = true;
			});
			await transport.start();
			const refused = await flood(transport, count, size);
			expect(String(refused)).toMatch(/not reading its input/);
			expect(errors.some((error) => /not reading its input/.test(String(error)))).toBe(true);
			for (let round = 0; round < 200 && !closed; round++) await new Promise((resolve) => setTimeout(resolve, 10));
			expect(closed).toBe(true);
		});
	}
});

/** The transport's reader, fed directly: chunks arrive as the pipe would hand them. */
const feed = (transport: StdioTransport, chunk: Buffer) =>
	(transport as unknown as { handleStdout(chunk: Buffer): void }).handleStdout(chunk);

describe.skipIf(process.platform === "win32")("fork: MCP stdio reader", () => {
	it("reads messages split anywhere and several per piece, as before", () => {
		const transport = new StdioTransport({ command: "unused" });
		const received: JsonRpcMessage[] = [];
		transport.onMessage((message) => received.push(message));
		const messages = [1, 2, 3].map((id) => ({ jsonrpc: "2.0" as const, id, result: { text: "é".repeat(id * 3) } }));
		const wire = Buffer.from(`${messages.map((message) => JSON.stringify(message)).join("\r\n")}\n\n`);
		for (let index = 0; index < wire.length; index++) feed(transport, wire.subarray(index, index + 1));
		feed(transport, wire);
		expect(received).toEqual([...messages, ...messages]);
	});

	it("gathers a 15 MiB message in 4 KiB pieces without copying the whole of it each time", () => {
		const transport = new StdioTransport({ command: "unused" });
		const received: JsonRpcMessage[] = [];
		transport.onMessage((message) => received.push(message));
		const wire = Buffer.from(
			`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: "x".repeat(15 * 1024 * 1024) } })}\n`,
		);
		const started = performance.now();
		for (let offset = 0; offset < wire.length; offset += 4096) feed(transport, wire.subarray(offset, offset + 4096));
		const elapsed = performance.now() - started;
		expect(received).toHaveLength(1);
		// Copying the gathered bytes on every piece made about 28 GiB of copies here: 3.8 s before, measured.
		expect(elapsed).toBeLessThan(1000);
	});

	it("closes a server that writes without end at the first message past the limit", async () => {
		const transport = new StdioTransport({
			command: process.execPath,
			args: [
				"-e",
				"const chunk = 'x'.repeat(65536); const write = () => process.stdout.write(chunk, write); write();",
			],
			maxMessageBytes: 1024 * 1024,
			closeTimeoutMs: 100,
		});
		const errors: unknown[] = [];
		let closed = false;
		transport.onError((error) => errors.push(error));
		transport.onClose(() => {
			closed = true;
		});
		await transport.start();
		for (let round = 0; round < 500 && !closed; round++) await new Promise((resolve) => setTimeout(resolve, 10));
		expect(closed).toBe(true);
		expect(errors.filter((error) => /exceeds 1048576 bytes/.test(String(error)))).toHaveLength(1);
	});
});
