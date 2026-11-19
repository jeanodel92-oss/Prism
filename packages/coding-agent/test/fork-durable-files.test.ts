/**
 * fork: a file Prism keeps is the
 * old one whole or the new one whole, whatever stops the write, and two writers through two names of it keep both
 * changes.
 *
 * The crash is the test hook of the atomic writer (`atomicWriteHooks.beforeRename`) throwing: the temporary file is
 * written, the rename never happens. Assertion: the file still holds its old bytes.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createEditTool } from "../src/core/tools/edit.ts";
import { createWriteTool } from "../src/core/tools/write.ts";
import { addMcpServerConfig } from "../src/extensions/mcp/config.ts";
import { recordDetection } from "../src/fork/capability-store.ts";
import checkpoints, { type CheckpointPlan } from "../src/fork/checkpoints.ts";
import { bindFileCall } from "../src/fork/file-binding.ts";
import { lockForkFile } from "../src/fork/file-lock.ts";
import { hostProgram } from "../src/fork/host-program.ts";
import { writeThinkingBudget } from "../src/fork/model-settings.ts";
import { handleInspectCommand } from "../src/fork/rpc-inspect.ts";
import { atomicWriteHooks, writeFileAtomicSync } from "../src/fork/secrets/atomic-write.ts";
import { migrateAuthToAuthJson } from "../src/migrations.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

const SRC = resolve(__dirname, "../src");
let root: string;

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "prism-durable-")));
});

afterEach(() => {
	atomicWriteHooks.beforeRename = undefined;
	atomicWriteHooks.afterRename = undefined;
	chmodSync(root, 0o700);
	rmSync(root, { recursive: true, force: true });
});

/** From now on, every atomic write stops before its rename, as a crash would. */
const crashBeforeRename = () => {
	atomicWriteHooks.beforeRename = () => {
		throw new Error("crash before rename");
	};
};

const temporaries = (folder: string) => readdirSync(folder).filter((name) => name.endsWith(".tmp"));

describe("fork: a stopped write leaves the old file whole", () => {
	it("settings.json", async () => {
		const agentDir = join(root, "agent");
		mkdirSync(agentDir);
		const file = join(agentDir, "settings.json");
		writeFileSync(file, '{\n  "theme": "old"\n}');
		const settings = SettingsManager.create(root, agentDir);
		crashBeforeRename();
		settings.setTheme("new");
		await settings.flush();
		expect(readFileSync(file, "utf8")).toBe('{\n  "theme": "old"\n}');
		expect(temporaries(agentDir)).toEqual([]);
	});

	it("an MCP configuration", () => {
		const file = join(root, "mcp.json");
		const before = '{\n  "mcpServers": {}\n}\n';
		writeFileSync(file, before);
		crashBeforeRename();
		expect(() => addMcpServerConfig(file, "tools", { command: "tool-server" })).toThrow(/crash/);
		expect(readFileSync(file, "utf8")).toBe(before);
	});

	it("capabilities.json and models.json, written under the fork's lock", async () => {
		const capabilities = join(root, "capabilities.json");
		writeFileSync(capabilities, "{}\n");
		const models = join(root, "models.json");
		const modelsBefore = '{\n  "providers": {}\n}\n';
		writeFileSync(models, modelsBefore);
		crashBeforeRename();
		await expect(
			recordDetection(capabilities, "local", [{ id: "m", vision: "yes", tools: "yes", reasoning: "no" }]),
		).rejects.toThrow(/crash/);
		expect(readFileSync(capabilities, "utf8")).toBe("{}\n");
		// The budget and its request field are one change: nothing of it is written.
		await expect(writeThinkingBudget(models, "local", "m", 2048, "thinking_budget")).rejects.toThrow(/crash/);
		expect(readFileSync(models, "utf8")).toBe(modelsBefore);
	});

	it("a session file being migrated", () => {
		const sessions = join(root, "sessions");
		mkdirSync(sessions);
		const file = join(sessions, "old.jsonl");
		const before = [
			{ type: "session", version: 2, id: randomUUID(), timestamp: new Date().toISOString(), cwd: root },
			{
				type: "message",
				id: "a1b2c3d4",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "hello", timestamp: Date.now() },
			},
		]
			.map((entry) => `${JSON.stringify(entry)}\n`)
			.join("");
		writeFileSync(file, before);
		crashBeforeRename();
		expect(() => SessionManager.open(file, sessions)).toThrow(/crash/);
		expect(readFileSync(file, "utf8")).toBe(before);
	});

	it("the old keys stay in settings.json until auth.json holds them", () => {
		const saved = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = root;
		try {
			const settings = join(root, "settings.json");
			writeFileSync(settings, JSON.stringify({ apiKeys: { local: "key-value" } }));
			crashBeforeRename();
			expect(() => migrateAuthToAuthJson()).toThrow(/crash/);
			expect(JSON.parse(readFileSync(settings, "utf8")).apiKeys).toEqual({ local: "key-value" });
			expect(existsSync(join(root, "auth.json"))).toBe(false);
			atomicWriteHooks.beforeRename = undefined;
			expect(migrateAuthToAuthJson()).toEqual(["local"]);
			expect(JSON.parse(readFileSync(join(root, "auth.json"), "utf8")).local.key).toBe("key-value");
			expect(JSON.parse(readFileSync(settings, "utf8")).apiKeys).toBeUndefined();
		} finally {
			if (saved === undefined) delete process.env[ENV_AGENT_DIR];
			else process.env[ENV_AGENT_DIR] = saved;
		}
	});

	it("a file edit changes, judged or not", async () => {
		const file = join(root, "big.txt");
		writeFileSync(file, "alpha\nbeta\n");
		crashBeforeRename();
		await expect(
			createEditTool(root).execute("plain", { path: file, edits: [{ oldText: "alpha", newText: "ALPHA" }] }),
		).rejects.toThrow(/crash/);
		bindFileCall("judged", file);
		await expect(
			createEditTool(root).execute("judged", { path: file, edits: [{ oldText: "beta", newText: "BETA" }] }),
		).rejects.toThrow(/crash/);
		bindFileCall("whole", file);
		await expect(createWriteTool(root).execute("whole", { path: file, content: "replaced\n" })).rejects.toThrow(
			/crash/,
		);
		expect(readFileSync(file, "utf8")).toBe("alpha\nbeta\n");
		expect(temporaries(root)).toEqual([]);
	});
});

describe("fork: edit and write keep what a rename would lose", () => {
	it("the file's mode is kept", async () => {
		const file = join(root, "run.sh");
		writeFileSync(file, "echo one\n");
		chmodSync(file, 0o751);
		await createEditTool(root).execute("e", { path: file, edits: [{ oldText: "one", newText: "two" }] });
		expect(readFileSync(file, "utf8")).toBe("echo two\n");
		expect(statSync(file).mode & 0o777).toBe(0o751);
	});

	it("a file with two names is written in place: both names see the change", async () => {
		const file = join(root, "a.txt");
		writeFileSync(file, "alpha\n");
		linkSync(file, join(root, "b.txt"));
		bindFileCall("e", file);
		await createEditTool(root).execute("e", { path: file, edits: [{ oldText: "alpha", newText: "ALPHA" }] });
		expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("ALPHA\n");
	});

	// fork: a rename over a file mounted on its own fails with EBUSY.
	it("a file mounted on its own is written in place", (context) => {
		const bwrap = hostProgram("bwrap");
		try {
			if (!bwrap) throw new Error("no bubblewrap");
			execFileSync(bwrap, ["--dev-bind", "/", "/", "true"], { stdio: "ignore", timeout: 5000 });
		} catch {
			return context.skip("bubblewrap is missing or cannot start here");
		}
		const file = join(root, "mounted.txt");
		writeFileSync(file, "old\n");
		const script = join(root, "publish.ts");
		writeFileSync(
			script,
			[
				`import { publishFile } from ${JSON.stringify(join(SRC, "fork/anchored-open.ts"))};`,
				"try { publishFile(process.argv[2]!, 'new\\n'); console.log('written'); }",
				"catch (error) { console.log((error as Error).message); }",
			].join("\n"),
		);
		const output = execFileSync(
			bwrap!,
			["--dev-bind", "/", "/", "--bind", file, file, "--", process.execPath, script, file],
			{ encoding: "utf8", timeout: 20_000 },
		);
		expect(output.trim()).toBe("written");
		expect(readFileSync(file, "utf8")).toBe("new\n");
		expect(temporaries(root)).toEqual([]);
	});

	// settings, auth.json and sessions go through the atomic writer, which renamed
	// without a fallback; a file mounted on its own refused every write (EBUSY).
	it("a settings or auth file mounted on its own is written in place", (context) => {
		const bwrap = hostProgram("bwrap");
		try {
			if (!bwrap) throw new Error("no bubblewrap");
			execFileSync(bwrap, ["--dev-bind", "/", "/", "true"], { stdio: "ignore", timeout: 5000 });
		} catch {
			return context.skip("bubblewrap is missing or cannot start here");
		}
		const file = join(root, "auth.json");
		writeFileSync(file, '{"old": "a longer content than the new one"}\n', { mode: 0o600 });
		const script = join(root, "atomic.ts");
		writeFileSync(
			script,
			[
				`import { writeFileAtomicSync } from ${JSON.stringify(join(SRC, "fork/secrets/atomic-write.ts"))};`,
				"try { writeFileAtomicSync(process.argv[2]!, '{}\\n'); console.log('written'); }",
				"catch (error) { console.log((error as Error).message); }",
			].join("\n"),
		);
		const output = execFileSync(
			bwrap!,
			["--dev-bind", "/", "/", "--bind", file, file, "--", process.execPath, script, file],
			{ encoding: "utf8", timeout: 20_000 },
		);
		expect(output.trim()).toBe("written");
		expect(readFileSync(file, "utf8")).toBe("{}\n");
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(temporaries(root)).toEqual([]);
	});
});

describe("fork: two writers keep both changes", () => {
	it("two edits through two hard links of one file", async () => {
		const a = join(root, "a.txt");
		writeFileSync(a, "alpha\nbeta\n");
		linkSync(a, join(root, "b.txt"));
		await Promise.all([
			createEditTool(root).execute("e1", { path: a, edits: [{ oldText: "alpha", newText: "ALPHA" }] }),
			createEditTool(root).execute("e2", {
				path: join(root, "b.txt"),
				edits: [{ oldText: "beta", newText: "BETA" }],
			}),
		]);
		expect(readFileSync(a, "utf8")).toBe("ALPHA\nBETA\n");
	});

	it("two settings managers: a later save of one field does not put back another's old value", async () => {
		const agentDir = join(root, "agent");
		mkdirSync(agentDir);
		const first = SettingsManager.create(root, agentDir);
		const second = SettingsManager.create(root, agentDir);
		first.setTheme("dark");
		second.setTheme("light");
		first.setDefaultThinkingLevel("high");
		await Promise.all([first.flush(), second.flush()]);
		const saved = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
		expect(saved.theme).toBe("light");
		expect(saved.defaultThinkingLevel).toBe("high");
	});

	it("two processes, one through a symbolic link, add 50 entries each to capabilities.json", async () => {
		const file = join(root, "capabilities.json");
		writeFileSync(file, "{}\n");
		symlinkSync(file, join(root, "linked.json"));
		const run = (path: string, tag: string) => {
			const script = join(root, `${tag}.ts`);
			writeFileSync(
				script,
				[
					`import { recordDetection } from ${JSON.stringify(join(SRC, "fork/capability-store.ts"))};`,
					`for (let i = 0; i < 50; i++)`,
					`	await recordDetection(${JSON.stringify(path)}, "p", [{ id: "${tag}" + i, vision: "yes", tools: "yes", reasoning: "no" }]);`,
				].join("\n"),
			);
			const child: ChildProcess = spawn(process.execPath, [script], { stdio: ["ignore", "ignore", "inherit"] });
			return new Promise<number | null>((done) => child.on("exit", done));
		};
		expect(await Promise.all([run(file, "real"), run(join(root, "linked.json"), "link")])).toEqual([0, 0]);
		expect(Object.keys(JSON.parse(readFileSync(file, "utf8")))).toHaveLength(100);
	}, 60_000);

	it("an invalid capabilities.json is left as it is, not replaced by the change alone", async () => {
		const file = join(root, "capabilities.json");
		writeFileSync(file, "{ broken");
		await expect(
			recordDetection(file, "p", [{ id: "m", vision: "yes", tools: "yes", reasoning: "no" }]),
		).rejects.toThrow();
		expect(readFileSync(file, "utf8")).toBe("{ broken");
	});

	it("a write under a lock that may have gone stale is refused", async () => {
		const file = join(root, "store.json");
		writeFileSync(file, "old\n");
		await expect(
			lockForkFile(file, () => {
				// The event loop blocked past half the stale time: no renewal, another writer may hold the lock now.
				const until = Date.now() + 5_000;
				while (Date.now() < until);
				writeFileAtomicSync(file, "new\n");
			}),
		).rejects.toThrow(/lock may have passed/);
		expect(readFileSync(file, "utf8")).toBe("old\n");
	}, 20_000);
});

describe("fork: session and checkpoint state after a failure", () => {
	it("an entry the session file did not get is not in the session", () => {
		const sessions = join(root, "sessions");
		mkdirSync(sessions);
		const session = SessionManager.create(root, sessions);
		const count = session.getEntries().length;
		const hello = () => session.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		chmodSync(sessions, 0o500);
		try {
			expect(hello).toThrow();
		} finally {
			chmodSync(sessions, 0o700);
		}
		expect(session.getEntries()).toHaveLength(count);
		// The problem fixed, the next message creates the file.
		hello();
		expect(readFileSync(session.getSessionFile()!, "utf8").split("\n").filter(Boolean)).toHaveLength(2);
	});

	describe("checkpoints", () => {
		const savedAgent = process.env[ENV_AGENT_DIR];
		const savedHome = process.env.HOME;
		const savedKeyring = process.env.PRISM_SECRET_SERVICE;
		const harnesses: Harness[] = [];

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
		});

		async function writtenOnce(name: string, mode: number) {
			process.env.HOME = root;
			process.env[ENV_AGENT_DIR] = join(root, "agent");
			process.env.PRISM_SECRET_SERVICE = "off";
			const harness = await createHarness({ extensionFactories: [checkpoints] });
			harnesses.push(harness);
			await harness.session.bindExtensions({ uiContext: createTestUiContext() });
			const file = join(harness.tempDir, name);
			writeFileSync(file, "before\n");
			chmodSync(file, mode);
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("write", { path: file, content: "after\n" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("write the fixture");
			const call = (type: string, fields: Record<string, unknown> = {}) =>
				handleInspectCommand({ type, ...fields }, harness.session);
			return { harness, file, call };
		}

		it("a file /undo could not restore keeps its checkpoint, to try again", async () => {
			const { harness, file, call } = await writtenOnce("kept.txt", 0o644);
			let plan = (await call("checkpoints_preview", { turn: 1 })) as CheckpointPlan;
			chmodSync(file, 0o444);
			chmodSync(harness.tempDir, 0o555);
			const result = (await call("checkpoints_restore", { turn: plan.turn, revision: plan.revision })) as {
				failed: string[];
			};
			chmodSync(harness.tempDir, 0o755);
			chmodSync(file, 0o644);
			expect(result.failed).toHaveLength(1);
			plan = (await call("checkpoints_preview", { turn: 1 })) as CheckpointPlan;
			await call("checkpoints_restore", { turn: plan.turn, revision: plan.revision });
			expect(readFileSync(file, "utf8")).toBe("before\n");
		});

		it("a file /undo creates again gets its permissions back", async () => {
			const { file, call } = await writtenOnce("tool.sh", 0o750);
			rmSync(file);
			const plan = (await call("checkpoints_preview", { turn: 1 })) as CheckpointPlan;
			await call("checkpoints_restore", { turn: plan.turn, revision: plan.revision });
			expect(readFileSync(file, "utf8")).toBe("before\n");
			expect(statSync(file).mode & 0o777).toBe(0o750);
		});
	});
});
