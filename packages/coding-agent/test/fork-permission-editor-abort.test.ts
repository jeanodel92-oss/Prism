/**
 * fork: stopping the turn while a long command is shown in full, before
 * it is allowed, closes that editor and ends the turn; the command does not run. The editor had no signal: over RPC,
 * the abort waited for a client answer that never came.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { ExtensionUIDialogOptions } from "../src/core/extensions/types.ts";
import permissionsExtension from "../src/fork/permissions.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

describe("fork: an interruption while a long command is read", () => {
	let agentDir: string;
	const harnesses: Harness[] = [];
	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-permission-editor-"));
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
	});
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		vi.unstubAllEnvs();
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("closes the editor, ends the turn and runs nothing", async () => {
		writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode: "ask" }));
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ sandbox: { modes: { broad: false, ask: false, safe: false } } }),
		);
		const harness = await createHarness({
			extensionFactories: [{ name: "permissions", factory: permissionsExtension }],
		});
		harnesses.push(harness);
		let editing: ExtensionUIDialogOptions | undefined;
		let closed = false;
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				select: async (_title, options) => options.find((o) => o.startsWith("Show the whole")),
				// A client that never answers: only the signal closes the editor.
				editor: (_title, _text, opts) =>
					new Promise((resolve) => {
						editing = opts ?? {};
						opts?.signal?.addEventListener("abort", () => {
							closed = true;
							resolve(undefined);
						});
					}),
			}),
		});
		const witness = join(harness.tempDir, "w");
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("bash", { command: `echo ${"x".repeat(6000)} > /dev/null; touch ${witness}` }),
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage("done"),
		]);
		const prompt = harness.session.prompt("go");
		await vi.waitFor(() => expect(editing).toBeDefined());
		expect(editing?.toolCallId).toEqual(expect.any(String));

		const stopped = await Promise.race([
			harness.session.abort().then(() => "stopped"),
			new Promise((resolve) => setTimeout(() => resolve("still waiting"), 3000)),
		]);
		expect(stopped).toBe("stopped");
		await prompt.catch(() => {});
		expect(closed).toBe(true);
		expect(existsSync(witness)).toBe(false);
	});
});
