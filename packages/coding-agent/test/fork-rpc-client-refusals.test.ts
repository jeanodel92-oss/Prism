// fork: an RPC method that returns nothing still rejects when the
// server refuses the command, as the methods that return data already did; promptAndWait waits for a turn only when
// one started.
import { describe, expect, it } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

type Private = { process: unknown; handleLine: (line: string) => void; eventListeners: unknown[] };

/** A client whose agent answers each command with `answer(type)`, as one JSON line. */
function clientAnswering(
	answer: (type: string) => { success: boolean; error?: string; data?: object },
	after?: (internals: Private) => void,
): RpcClient {
	const client = new RpcClient();
	const internals = client as unknown as Private;
	internals.process = {
		exitCode: null,
		signalCode: null,
		stdin: {
			destroyed: false,
			writable: true,
			write: (line: string) => {
				const command = JSON.parse(line) as { id: string; type: string };
				queueMicrotask(() => {
					internals.handleLine(
						JSON.stringify({ type: "response", id: command.id, command: command.type, ...answer(command.type) }),
					);
					after?.(internals);
				});
				return true;
			},
		},
	};
	return client;
}

describe("fork: RPC methods without a result", () => {
	it("rejects with the server's error when the command is refused", async () => {
		const client = clientAnswering(() => ({ success: false, error: "Session name cannot be empty" }));
		await expect(client.setSessionName("  ")).rejects.toThrow("Session name cannot be empty");
		await expect(client.setAutoRetry(true)).rejects.toThrow("Session name cannot be empty");
		await expect(client.abort()).rejects.toThrow("Session name cannot be empty");
	});

	it("resolves when the command is accepted", async () => {
		const client = clientAnswering(() => ({ success: true }));
		await expect(client.setSessionName("name")).resolves.toBeUndefined();
		await expect(client.abort()).resolves.toBeUndefined();
	});

	it("190: promptAndWait ends at once for a handled prompt and stops listening when the prompt is refused", async () => {
		const handled = clientAnswering(() => ({ success: true, data: { disposition: "handled" } }));
		const outcome = await Promise.race([
			handled.promptAndWait("/handled").then(() => "returned"),
			new Promise((resolve) => setTimeout(() => resolve("waiting"), 500)),
		]);
		expect(outcome).toBe("returned");
		expect((handled as unknown as Private).eventListeners).toHaveLength(0);

		const refused = clientAnswering(() => ({ success: false, error: "No API key" }));
		await expect(refused.promptAndWait("hello")).rejects.toThrow("No API key");
		expect((refused as unknown as Private).eventListeners).toHaveLength(0);

		const started = clientAnswering(
			() => ({ success: true, data: { disposition: "started" } }),
			(internals) => {
				internals.handleLine(JSON.stringify({ type: "agent_start" }));
				internals.handleLine(JSON.stringify({ type: "agent_settled" }));
			},
		);
		const events = await started.promptAndWait("hello");
		expect(events.map((event) => event.type)).toEqual(["agent_start", "agent_settled"]);
	});
});
