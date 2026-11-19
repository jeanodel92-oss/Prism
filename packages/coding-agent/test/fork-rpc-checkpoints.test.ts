import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR, getAgentDir } from "../src/config.ts";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import checkpoints, { type CheckpointPlan, checkpointDir, checkpointPanel } from "../src/fork/checkpoints.ts";
import { handleInspectCommand } from "../src/fork/rpc-inspect.ts";
import { checkpointKey, sealBackup } from "../src/fork/secrets/checkpoint-cipher.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

describe("native checkpoint operations", () => {
	let home: string;
	const savedAgent = process.env[ENV_AGENT_DIR];
	const savedHome = process.env.HOME;
	const savedKeyring = process.env.PRISM_SECRET_SERVICE;
	const harnesses: Harness[] = [];
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "prism-checkpoints-"));
		process.env.HOME = home;
		process.env[ENV_AGENT_DIR] = home;
		process.env.PRISM_SECRET_SERVICE = "off";
	});
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) {
			await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			harness.cleanup();
		}
		if (savedAgent === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = savedAgent;
		if (savedHome === undefined) delete process.env.HOME;
		else process.env.HOME = savedHome;
		if (savedKeyring === undefined) delete process.env.PRISM_SECRET_SERVICE;
		else process.env.PRISM_SECRET_SERVICE = savedKeyring;
		rmSync(home, { recursive: true, force: true });
	});
	async function engine(extra: ExtensionFactory[] = []) {
		const harness = await createHarness({ extensionFactories: [checkpoints, ...extra] });
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });
		const call = (type: string, fields: Record<string, unknown> = {}) =>
			handleInspectCommand({ type, ...fields }, harness.session);
		const write = async (path: string, content: string) => {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("write", { path, content }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("write the fixture");
		};
		const preview = async (turn: number) => (await call("checkpoints_preview", { turn })) as CheckpointPlan;
		const restore = (plan: CheckpointPlan) =>
			call("checkpoints_restore", { turn: plan.turn, revision: plan.revision });
		return { harness, call, write, preview, restore };
	}

	it("lists an empty session, refuses invalid turns and removes the bridge at shutdown", async () => {
		const { harness, call } = await engine();
		await expect(call("checkpoints_get")).resolves.toEqual({ turns: [] });
		for (const turn of [0, -1, 1.5, 99, "1"]) await expect(call("checkpoints_preview", { turn })).rejects.toThrow();
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		expect(checkpointPanel(harness.session.extensionRunner.createContext())).toBeUndefined();
		await expect(call("checkpoints_get")).rejects.toThrow(/module off/);
	});

	it("previews every affected file without writing, then restores the earliest state across turns", async () => {
		const { harness, write, preview, restore, call } = await engine();
		const old = join(harness.tempDir, "old.txt");
		const added = join(harness.tempDir, "new.txt");
		writeFileSync(old, "original");
		await write(old, "first");
		await write(added, "new file");
		await write(old, "latest");
		const plan = await preview(1);
		expect(plan.files).toEqual([
			{ path: old, action: "restore" },
			{ path: added, action: "delete" },
		]);
		expect(readFileSync(old, "utf8")).toBe("latest");
		expect(existsSync(added)).toBe(true);
		await expect(restore(plan)).resolves.toMatchObject({ removed: 1, failed: [] });
		expect(readFileSync(old, "utf8")).toBe("original");
		expect(existsSync(added)).toBe(false);
		await expect(call("checkpoints_get")).resolves.toEqual({ turns: [] });
		await expect(restore(plan)).rejects.toThrow(/changed/);
	});

	it("refuses a review invalidated by a later write", async () => {
		const { harness, write, preview, restore, call } = await engine();
		const path = join(harness.tempDir, "file.txt");
		await write(path, "one");
		const plan = await preview(1);
		await write(path, "two");
		await expect(restore(plan)).rejects.toThrow(/changed/);
		expect(readFileSync(path, "utf8")).toBe("two");
		await expect(call("checkpoints_restore", { turn: 1 })).rejects.toThrow(/revision/);
	});

	it("refuses a restore while a real model turn is still working", async () => {
		let release = () => {};
		let ready = () => {};
		const started = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const waiting = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { harness, write, preview, restore } = await engine([
			(pi) =>
				pi.registerTool({
					name: "hold",
					label: "Hold",
					description: "Hold a fixture turn",
					parameters: Type.Object({}),
					async execute() {
						ready();
						await waiting;
						return { content: [{ type: "text", text: "done" }], details: {} };
					},
				}),
		]);
		const path = join(harness.tempDir, "keep.txt");
		await write(path, "keep");
		const plan = await preview(1);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const prompt = harness.session.prompt("wait");
		try {
			await started;
			await expect(restore(plan)).rejects.toThrow(/Stop the current turn/);
		} finally {
			release();
			await prompt;
		}
		expect(readFileSync(path, "utf8")).toBe("keep");
	});

	it("keeps restoration failures in the result", async () => {
		const { harness, write, preview, restore } = await engine();
		const path = join(harness.tempDir, "file.txt");
		writeFileSync(path, "original");
		await write(path, "changed");
		const directory = checkpointDir(harness.sessionManager)!;
		for (const name of readdirSync(directory)) if (name.endsWith(".snap")) rmSync(join(directory, name));
		const result = (await restore(await preview(1))) as { failed: string[] };
		expect(result.failed).toHaveLength(1);
		expect(result.failed[0]).toContain(path);
		expect(readFileSync(path, "utf8")).toBe("changed");
	});

	it("previews rewind's final action even when a stored index repeats a sequence number", async () => {
		const { harness, preview, restore } = await engine();
		const path = join(harness.tempDir, "file.txt");
		const directory = checkpointDir(harness.sessionManager)!;
		writeFileSync(path, "changed");
		const key = await checkpointKey(getAgentDir());
		writeFileSync(
			join(directory, "00001.snap"),
			sealBackup(key, `${basename(directory)}/00001.snap`, Buffer.from("snapshot")),
		);
		const entry = { seq: 1, turn: 1, path, tool: "write", ts: new Date().toISOString() };
		writeFileSync(
			join(directory, "index.json"),
			JSON.stringify([
				{ ...entry, blob: null },
				{ ...entry, blob: "00001.snap" },
			]),
		);
		await harness.session.extensionRunner.emit({ type: "session_start", reason: "resume" });
		const plan = await preview(1);
		expect(plan.files).toEqual([{ path, action: "restore" }]);
		await restore(plan);
		expect(readFileSync(path, "utf8")).toBe("snapshot");
	});

	it("includes files too large to snapshot in the review", async () => {
		const { harness, write, preview, restore } = await engine();
		const path = join(harness.tempDir, "large.txt");
		writeFileSync(path, Buffer.alloc(8 * 1024 * 1024 + 1));
		await write(join(harness.tempDir, "tracked.txt"), "tracked");
		const beforeLargeWrite = await preview(1);
		await write(path, "not restorable");
		await expect(restore(beforeLargeWrite)).rejects.toThrow(/changed/);
		expect((await preview(1)).skipped).toEqual([path]);
	});

	// fork: a snapshot that cannot be saved is listed as not restorable, as a
	// file too large to snapshot is, instead of leaving the write without checkpoint or warning.
	it("lists a file whose snapshot could not be saved as not restorable", async () => {
		const { harness, write, preview } = await engine();
		const path = join(harness.tempDir, "kept.txt");
		writeFileSync(path, "before");
		await write(join(harness.tempDir, "tracked.txt"), "tracked");
		const dir = checkpointDir(harness.session.sessionManager)!;
		chmodSync(dir, 0o500);
		try {
			await write(path, "after");
		} finally {
			chmodSync(dir, 0o700);
		}
		expect(readFileSync(path, "utf8")).toBe("after");
		expect((await preview(1)).skipped).toEqual([path]);
	});
});
