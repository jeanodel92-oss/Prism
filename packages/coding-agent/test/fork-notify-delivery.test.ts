// fork: the test notification (Settings › Notifications › Test notification) showed nothing on the desktop and said nothing either. With
// SwayNotificationCenter in do-not-disturb mode, a --transient notification is neither shown nor kept in its list,
// and the fixed --replace-id never matched an id the server had given, so it replaced nothing.
import type * as ChildProcess from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const childProcessMocks = vi.hoisted(() => ({ execFile: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof ChildProcess>()),
	execFile: childProcessMocks.execFile,
}));

import { ENV_AGENT_DIR } from "../src/config.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import notifyExtension from "../src/fork/notify.ts";
import { settingsSections } from "../src/fork/settings-sections.ts";

type Callback = (error: (Error & { code?: string }) | null, stdout: string, stderr: string) => void;

/** The extension started as a session would; `run` sends a test from its settings section and waits for the report. */
function setup() {
	type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
	const handlers = new Map<string, Handler[]>();
	const emit = async (type: string, ctx: ExtensionContext) => {
		for (const handler of handlers.get(type) ?? []) await handler({ type }, ctx);
	};
	const api = {
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		registerCommand: () => {},
	} as unknown as ExtensionAPI;
	notifyExtension(api);
	const messages: Array<{ message: string; level: string }> = [];
	let reported: (() => void) | undefined;
	const ctx = {
		hasUI: false,
		ui: {
			notify: (message: string, level: string) => {
				messages.push({ message, level });
				reported?.();
			},
		},
	} as unknown as ExtensionContext;
	void emit("session_start", ctx);
	const run = () =>
		new Promise<void>((resolve) => {
			reported = resolve;
			settingsSections().find((s) => s.domain === "notifications")!.onChange!("notify-test", "send");
		});
	return { messages, run, stop: () => emit("session_shutdown", ctx) };
}

/** notify-send answers the next call as the server would: its id, or a failure. */
function answer(result: { id: string } | { error: Error & { code?: string }; stderr?: string }) {
	childProcessMocks.execFile.mockImplementationOnce((_file: string, _args: string[], callback: Callback) => {
		if ("id" in result) callback(null, `${result.id}\n`, "");
		else callback(result.error, "", result.stderr ?? "");
	});
}

const args = (call: number) => childProcessMocks.execFile.mock.calls[call]![1] as string[];

describe("fork: delivery of desktop notifications", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-notify-"));
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		childProcessMocks.execFile.mockReset();
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("keeps the notification in the server's list, and replaces the one it sent before", async () => {
		const { run } = setup();
		answer({ id: "57" });
		await run();
		answer({ id: "57" });
		await run();
		expect(args(0)).not.toContain("--transient");
		expect(args(0)).toContain("--print-id");
		expect(args(0).some((arg) => arg.startsWith("--replace-id"))).toBe(false);
		expect(args(1)).toContain("--replace-id=57");
	});

	it("says where a test notification went", async () => {
		const { run, messages } = setup();
		answer({ id: "58" });
		await run();
		expect(messages[0]?.level).toBe("info");
		expect(messages[0]?.message).toContain("58");
		expect(messages[0]?.message).toContain("do-not-disturb");
	});

	it("says why a test notification failed", async () => {
		const { run, messages } = setup();
		answer({ error: Object.assign(new Error("spawn notify-send ENOENT"), { code: "ENOENT" }) });
		await run();
		expect(messages[0]).toEqual({
			level: "warning",
			message: expect.stringContaining("notify-send is not installed"),
		});

		answer({ error: new Error("Command failed"), stderr: "Unknown option --print-id\n" });
		await run();
		expect(messages.at(-1)).toEqual({
			level: "warning",
			message: expect.stringContaining("Unknown option --print-id"),
		});
	});

	// in a real session the old ctx throws once the session is replaced or reloaded.
	it("reports nothing when notify-send answers after the session ended", async () => {
		const { messages, stop } = setup();
		let answerLater: (() => void) | undefined;
		childProcessMocks.execFile.mockImplementationOnce((_file: string, _args: string[], callback: Callback) => {
			answerLater = () => callback(null, "58\n", "");
		});
		settingsSections().find((s) => s.domain === "notifications")!.onChange!("notify-test", "send");
		await stop();
		answerLater!();
		expect(messages).toEqual([]);
	});
});
