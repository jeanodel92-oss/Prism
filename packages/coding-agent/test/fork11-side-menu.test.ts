// what the window's side menu reads from the engine.
// The memory view draws `memory_get`; the logs' icon shows in the Advanced interface only (`get_display`).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME, ENV_AGENT_DIR } from "../src/config.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { handleBuiltinCommand } from "../src/fork/rpc-builtins.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

interface MemoryFile {
	path: string;
	text: string;
}

describe("fork.11: the side menu's engine answers", () => {
	let agentDir: string;
	const saved = process.env[ENV_AGENT_DIR];
	const harnesses: Harness[] = [];

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-side-menu-"));
		process.env[ENV_AGENT_DIR] = agentDir;
	});
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		if (saved === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = saved;
		rmSync(agentDir, { recursive: true, force: true });
	});

	const call = async <T>(harness: Harness, type: string): Promise<T> => {
		const reply = (await handleBuiltinCommand(
			{ type, id: "request-id" } as Parameters<typeof handleBuiltinCommand>[0],
			harness.session,
			{} as never,
			{} as never,
			async () => {},
		)) as { data: T };
		return reply.data;
	};

	it("memory_get returns the global and the project memory", async () => {
		const cwd = join(agentDir, "project");
		mkdirSync(join(cwd, CONFIG_DIR_NAME), { recursive: true });
		const harness = await createHarness({ sessionManager: SessionManager.inMemory(cwd) });
		harnesses.push(harness);
		writeFileSync(join(agentDir, "MEMORY.md"), "Prefers short answers.\n");
		const project = join(cwd, CONFIG_DIR_NAME, "MEMORY.md");
		writeFileSync(project, "Uses tabs.\n");

		const memory = await call<{ global: MemoryFile; project: MemoryFile | null }>(harness, "memory_get");
		expect(memory.global).toEqual({ path: join(agentDir, "MEMORY.md"), text: "Prefers short answers." });
		expect(memory.project).toEqual({ path: project, text: "Uses tabs." });
	});

	it("memory_get gives no project memory in an untrusted project", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.settingsManager.setProjectTrusted(false);
		const memory = await call<{ global: MemoryFile; project: MemoryFile | null }>(harness, "memory_get");
		expect(memory.global.text).toBe("");
		expect(memory.project).toBeNull();
	});

	it("get_display tells the interface mode", async () => {
		const simple = await createHarness();
		harnesses.push(simple);
		expect((await call<{ interfaceMode: string }>(simple, "get_display")).interfaceMode).toBe("simple");
		const advanced = await createHarness({ settings: { interfaceMode: "advanced" } });
		harnesses.push(advanced);
		expect((await call<{ interfaceMode: string }>(advanced, "get_display")).interfaceMode).toBe("advanced");
	});
});
