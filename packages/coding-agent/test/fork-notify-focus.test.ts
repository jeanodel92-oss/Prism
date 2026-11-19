// fork: no desktop notification while the Prism window is in front; the window reports
// it with the `window_focus` RPC command.
import type * as ChildProcess from "node:child_process";
import { basename } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const childProcessMocks = vi.hoisted(() => ({ execFile: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof ChildProcess>()),
	execFile: childProcessMocks.execFile,
}));

import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import notify, { setClientFocused } from "../src/fork/notify.ts";
import { handleBuiltinCommand } from "../src/fork/rpc-builtins.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakePi() {
	const handlers = new Map<string, Handler[]>();
	const pi = new Proxy(
		{},
		{
			get: (_target, key) =>
				key === "on"
					? (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler])
					: () => undefined,
		},
	) as ExtensionAPI;
	const emit = async (name: string) => {
		for (const handler of handlers.get(name) ?? []) await handler({ type: name }, {});
	};
	return { pi, emit };
}

/** A run of 30 s, then how many notifications it sent. */
async function longRun(emit: (name: string) => Promise<void>): Promise<number> {
	childProcessMocks.execFile.mockReset();
	const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
	await emit("agent_start");
	now.mockReturnValue(1_030_000);
	await emit("agent_settled");
	now.mockRestore();
	// fork: notify-send by the path the host-program rule finds.
	return childProcessMocks.execFile.mock.calls.filter((call) => basename(String(call[0])) === "notify-send").length;
}

describe("desktop notifications and the window's focus", () => {
	afterEach(() => setClientFocused(false));

	it("stays quiet while the window is in front, and notifies once it is not", async () => {
		const { pi, emit } = fakePi();
		notify(pi);
		expect(await longRun(emit)).toBe(1);

		const respond = (focused: boolean) =>
			handleBuiltinCommand(
				{ id: "f", type: "window_focus", focused },
				{} as never,
				{} as never,
				{} as never,
				async () => {},
			);
		expect(await respond(true)).toEqual({
			id: "f",
			type: "response",
			command: "window_focus",
			success: true,
			data: {},
		});
		expect(await longRun(emit)).toBe(0);

		await respond(false);
		expect(await longRun(emit)).toBe(1);
	});
});
