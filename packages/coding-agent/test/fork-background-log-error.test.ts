// fork: a background task whose log fails (ENOSPC, I/O error) keeps being
// drained and ends, with the loss of its log said in its end report.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { Writable } from "node:stream";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import backgroundExtension, { backgroundTasks, END_MESSAGE } from "../src/fork/background.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		// Background logs (under the agent dir's bg/) fail on their first write, as on a full disk.
		createWriteStream: ((path: string, options?: unknown) => {
			if (!String(path).includes(`${sep}bg${sep}`)) return actual.createWriteStream(path, options as never);
			return new Writable({
				write(_chunk, _encoding, callback) {
					callback(Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" }));
				},
			});
		}) as typeof actual.createWriteStream,
	};
});

describe("fork: a background log that fails", () => {
	const savedAgentDir = process.env[ENV_AGENT_DIR];
	const harnesses: Harness[] = [];
	let agentDir: string | undefined;

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		if (savedAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = savedAgentDir;
		if (agentDir) rmSync(agentDir, { recursive: true, force: true });
	});

	it("drains a task that writes more than a pipe holds and reports it ended, log lost", async () => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-background-log-error-"));
		process.env[ENV_AGENT_DIR] = agentDir;
		const harness = await createHarness({
			extensionFactories: [{ name: "background", factory: backgroundExtension }],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("background", {
					action: "run",
					command: "head -c 1000000 /dev/zero; head -c 1000000 /dev/zero >&2; echo done",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("started"),
			fauxAssistantMessage("seen"),
		]);
		await harness.session.prompt("start a task");
		await vi.waitFor(() => expect(backgroundTasks()?.[0]?.status).toBe("done"), { timeout: 10_000 });
		const report = harness.session.messages.find(
			(message) => message.role === "custom" && message.customType === END_MESSAGE,
		);
		expect(JSON.stringify(report)).toContain("log was lost");
	}, 20_000);
});
