/**
 * fork: closing a stdio transport stops the server's whole process
 * group, also when the server itself has already exited or exits on stdin closing, leaving a descendant.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { McpClient, StdioTransport } from "../src/index.ts";

const fixture = fileURLToPath(new URL("./fixtures/quitting-server.mjs", import.meta.url));

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitFor(check: () => boolean): Promise<void> {
	for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
}

async function connect(mode: "early" | "eof" | "setsid") {
	const transport = new StdioTransport({ command: process.execPath, args: [fixture, mode], closeTimeoutMs: 200 });
	const client = new McpClient({ name: "fork-group-close", version: "1.0.0" });
	await client.connect(transport);
	let grandchild: number | undefined;
	await waitFor(() => {
		const match = /grandchild (\d+)/.exec(transport.stderr);
		if (match) grandchild = Number(match[1]);
		return grandchild !== undefined;
	});
	expect(grandchild).toBeTypeOf("number");
	return { transport, client, grandchild: grandchild as number };
}

describe.skipIf(process.platform === "win32")("fork: closing a stdio server stops its group", () => {
	it("stops what a server that already exited left running, its pipes held", async () => {
		const { transport, client, grandchild } = await connect("early");
		const server = transport.pid as number;
		await waitFor(() => !alive(server));
		expect(alive(server)).toBe(false);
		expect(alive(grandchild)).toBe(true);
		const startedAt = Date.now();
		await client.close();
		expect(Date.now() - startedAt).toBeLessThan(5_000);
		await waitFor(() => !alive(grandchild));
		expect(alive(grandchild)).toBe(false);
	}, 15_000);

	it("stops what a server that exits on stdin closing leaves running", async () => {
		const { client, grandchild } = await connect("eof");
		await client.close();
		await waitFor(() => !alive(grandchild));
		expect(alive(grandchild)).toBe(false);
	}, 15_000);

	// the group of a server whose pipes a descendant that left it
	// still holds was kept as live, and signalled on close once its number could be another group's.
	it("never signals the empty group of a server whose pipes a descendant in its own group holds", async () => {
		const { transport, client, grandchild } = await connect("setsid");
		const server = transport.pid as number;
		try {
			await waitFor(() => !alive(server));
			expect(alive(server)).toBe(false);
			// Time for the group to be seen empty, then its number taken by another group.
			await new Promise((resolve) => setTimeout(resolve, 300));
			const sent: (string | number | undefined)[] = [];
			const realKill = process.kill.bind(process);
			const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
				if (pid !== -server) return realKill(pid, signal);
				sent.push(signal);
				return true;
			});
			try {
				await client.close();
			} finally {
				kill.mockRestore();
			}
			expect(sent.filter((signal) => signal !== 0)).toEqual([]);
		} finally {
			process.kill(grandchild, "SIGKILL");
		}
	}, 15_000);
});
