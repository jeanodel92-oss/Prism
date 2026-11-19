// fork: the RPC client gave every request 30 s. A shell command or a compaction
// that ran longer was rejected while it went on, and its answer then reached the event listeners as an event.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

type Private = { process: unknown; handleLine: (line: string) => void };

/** A client whose agent records the commands and answers only when `answer` is called. */
function silentClient() {
	const client = new RpcClient();
	const internals = client as unknown as Private;
	const sent: Array<{ id: string; type: string }> = [];
	internals.process = {
		exitCode: null,
		signalCode: null,
		stdin: {
			destroyed: false,
			writable: true,
			write: (line: string) => {
				sent.push(JSON.parse(line) as { id: string; type: string });
				return true;
			},
		},
	};
	const answer = (index: number, data: object) => {
		const command = sent[index]!;
		internals.handleLine(
			JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data }),
		);
	};
	return { client, sent, answer };
}

describe("fork: RPC operations longer than 30 s", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("waits for a shell command and a compaction that end after 45 s", async () => {
		const { client, answer } = silentClient();
		const bash = client.bash("sleep 45");
		const compact = client.compact();
		let settled = false;
		void Promise.allSettled([bash, compact]).then(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(45_000);
		expect(settled).toBe(false);
		answer(0, { output: "done", exitCode: 0 });
		answer(1, { summary: "short" });
		await expect(bash).resolves.toMatchObject({ output: "done" });
		await expect(compact).resolves.toMatchObject({ summary: "short" });
	});

	it("keeps the limit for a quick command, and its late answer is not an event", async () => {
		const { client, answer } = silentClient();
		const events: unknown[] = [];
		client.onEvent((event) => events.push(event));
		const state = client.getState();
		const rejected = expect(state).rejects.toThrow("Timeout waiting for response to get_state");
		await vi.advanceTimersByTimeAsync(30_000);
		await rejected;
		answer(0, { isStreaming: false });
		expect(events).toEqual([]);
	});
});
