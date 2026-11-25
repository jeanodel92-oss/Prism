// fork: a /reload rebuilt the background extension with an empty task
// list, and the old instance, closed, dropped the end report. The session goes on after a reload: its running task
// stays listed and controllable, and its end reaches the model once.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import backgroundExtension, { backgroundTasks, END_MESSAGE, sessionBackgroundTasks } from "../src/fork/background.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

describe("fork: background tasks across a /reload", () => {
	const savedAgentDir = process.env[ENV_AGENT_DIR];
	const harnesses: Harness[] = [];
	let dir: string | undefined;

	afterEach(async () => {
		// A task left waiting by a failed run ends before its folder goes.
		if (dir) writeFileSync(join(dir, "go"), "");
		await new Promise((resolve) => setTimeout(resolve, 200));
		for (const harness of harnesses.splice(0)) harness.cleanup();
		if (savedAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = savedAgentDir;
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	it("keeps a running task listed after the reload and reports its end once", async () => {
		const root = mkdtempSync(join(tmpdir(), "prism-background-reload-"));
		dir = root;
		process.env[ENV_AGENT_DIR] = join(root, "agent");
		const flag = join(root, "go");
		// The harness, as the real loader does, runs the extension's factory again on reload: a new, empty instance.
		const harness = await createHarness({
			extensionFactories: [{ name: "background", factory: backgroundExtension }],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("background", {
					action: "run",
					command: `while [ ! -e '${flag}' ]; do sleep 0.05; done; echo finished`,
					timeout: 30,
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("started"),
			fauxAssistantMessage("seen"),
		]);
		await harness.session.prompt("start a task");
		expect(backgroundTasks()?.map((task) => task.status)).toEqual(["running"]);

		// the session's own tasks, by its id (the browser opens a task's server for that session only).
		const id = harness.session.sessionManager.getSessionId();
		expect(sessionBackgroundTasks(id).map((task) => task.status)).toEqual(["running"]);
		expect(sessionBackgroundTasks("another-session")).toEqual([]);

		await harness.session.reload();
		expect(backgroundTasks()?.map((task) => task.status)).toEqual(["running"]);
		expect(sessionBackgroundTasks(id).map((task) => task.status)).toEqual(["running"]);

		writeFileSync(flag, "");
		await vi.waitFor(() => expect(backgroundTasks()?.[0]?.status).toBe("done"), { timeout: 10_000 });
		await vi.waitFor(() =>
			expect(
				harness.session.messages.filter(
					(message) => message.role === "custom" && message.customType === END_MESSAGE,
				),
			).toHaveLength(1),
		);
	}, 30_000);
});
