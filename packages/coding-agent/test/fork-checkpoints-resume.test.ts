// fork: resuming a session older than twenty others must not prune its own
// checkpoints. a resumed session still lists the files a turn could not snapshot.
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import checkpoints, { type CheckpointPlan, checkpointDir } from "../src/fork/checkpoints.ts";
import { handleInspectCommand } from "../src/fork/rpc-inspect.ts";
import { checkpointKey, openBackup, sealBackup } from "../src/fork/secrets/checkpoint-cipher.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

describe("checkpoints across a resume", () => {
	let home: string;
	const saved = {
		agent: process.env[ENV_AGENT_DIR],
		home: process.env.HOME,
		keyring: process.env.PRISM_SECRET_SERVICE,
	};
	const harnesses: Harness[] = [];
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "prism-checkpoints-resume-"));
		process.env.HOME = home;
		process.env[ENV_AGENT_DIR] = home;
		process.env.PRISM_SECRET_SERVICE = "off";
	});
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) {
			await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			harness.cleanup();
		}
		const restore = (name: string, value: string | undefined) => {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		};
		restore(ENV_AGENT_DIR, saved.agent);
		restore("HOME", saved.home);
		restore("PRISM_SECRET_SERVICE", saved.keyring);
		rmSync(home, { recursive: true, force: true });
	});

	async function engine(sessionManager?: SessionManager) {
		const harness = await createHarness({ extensionFactories: [checkpoints], sessionManager });
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });
		const call = (type: string, fields: Record<string, unknown> = {}) =>
			handleInspectCommand({ type, ...fields }, harness.session);
		const preview = async (turn: number) => (await call("checkpoints_preview", { turn })) as CheckpointPlan;
		const resume = () => harness.session.extensionRunner.emit({ type: "session_start", reason: "resume" });
		return { harness, call, preview, resume };
	}

	it("keeps the resumed session's checkpoints when twenty other sessions are newer", async () => {
		const { harness, call, preview, resume } = await engine();
		const path = join(harness.tempDir, "file.txt");
		writeFileSync(path, "original");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path, content: "changed" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("write");
		const own = checkpointDir(harness.sessionManager)!;
		const old = new Date(Date.now() - 3_600_000);
		utimesSync(own, old, old);
		for (let i = 0; i < 25; i++) mkdirSync(join(home, "checkpoints", `other-${i}`));
		await resume();
		expect(existsSync(own)).toBe(true);
		expect(readdirSync(own).some((name) => name.endsWith(".snap"))).toBe(true);
		// Twenty folders are kept in all, the open session's one among them.
		expect(readdirSync(join(home, "checkpoints"))).toHaveLength(20);
		const plan = await preview(1);
		await expect(call("checkpoints_restore", { turn: plan.turn, revision: plan.revision })).resolves.toMatchObject({
			restored: 1,
			failed: [],
		});
		expect(readFileSync(path, "utf8")).toBe("original");
	});

	it("still lists a file too large to snapshot after the session is resumed", async () => {
		const { harness, preview, resume } = await engine();
		const large = join(harness.tempDir, "large.txt");
		const small = join(harness.tempDir, "small.txt");
		writeFileSync(large, Buffer.alloc(8 * 1024 * 1024 + 1));
		writeFileSync(small, "before");
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("write", { path: small, content: "after" }),
					fauxToolCall("write", { path: large, content: "after" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("write both");
		expect((await preview(1)).skipped).toEqual([large]);
		await resume();
		expect((await preview(1)).skipped).toEqual([large]);
	});

	// /undo of a session saved renamed the folder.
	it("finds the checkpoints of a session saved before its folder took the session file's hash", async () => {
		const project = join(home, "project");
		mkdirSync(project);
		const { harness, call, preview, resume } = await engine(SessionManager.create(project, join(home, "sessions")));
		const path = join(harness.tempDir, "file.txt");
		writeFileSync(path, "original");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path, content: "changed" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("write");
		const own = checkpointDir(harness.sessionManager)!;
		const id = harness.sessionManager.getSessionId();
		expect(own).not.toBe(join(home, "checkpoints", id));
		// The folder as Prism wrote it: named by the id, its backups bound to that name.
		const legacy = join(home, "checkpoints", id);
		mkdirSync(legacy);
		const key = await checkpointKey(home);
		for (const name of readdirSync(own)) {
			let data: Buffer = readFileSync(join(own, name));
			if (name.endsWith(".snap"))
				data = sealBackup(key, `${id}/${name}`, openBackup(data, `${basename(own)}/${name}`, key));
			writeFileSync(join(legacy, name), data);
		}
		rmSync(own, { recursive: true });
		await resume();
		expect(checkpointDir(harness.sessionManager)).toBe(legacy);
		const plan = await preview(1);
		await expect(call("checkpoints_restore", { turn: plan.turn, revision: plan.revision })).resolves.toMatchObject({
			restored: 1,
			failed: [],
		});
		expect(readFileSync(path, "utf8")).toBe("original");
	});

	// a backup replaced by a file in clear was restored without the key.
	it("does not restore a backup replaced by a file in clear", async () => {
		const { harness, call, preview } = await engine();
		const path = join(harness.tempDir, "file.txt");
		writeFileSync(path, "original");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path, content: "changed" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("write");
		const own = checkpointDir(harness.sessionManager)!;
		const blob = readdirSync(own).find((name) => name.endsWith(".snap"))!;
		writeFileSync(join(own, blob), "planted");
		const plan = await preview(1);
		const result = (await call("checkpoints_restore", { turn: plan.turn, revision: plan.revision })) as {
			restored: number;
			failed: string[];
		};
		expect(result.restored).toBe(0);
		expect(result.failed.join("\n")).toContain("not encrypted");
		expect(readFileSync(path, "utf8")).toBe("changed");
	});
});
