// fork: session search.
// the window's search reads the session folder its list reads, a chosen one included.
// other projects' newer sessions do not push the current project's out of the search.
// the excerpt is cut where the match is in the original text, when lowering lengthened it.
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { handleBuiltinCommand } from "../src/fork/rpc-builtins.ts";
import { searchSessions } from "../src/fork/session-search.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const session = (cwd: string, text: string) =>
	`${JSON.stringify({ type: "session", cwd, timestamp: "2026-01-01T00:00:00Z" })}\n${JSON.stringify({
		type: "message",
		message: { role: "user", content: text },
	})}\n`;

describe("session search scope", () => {
	let tempDir: string;
	let agentDir: string;
	const saved = process.env[ENV_AGENT_DIR];
	const harnesses: Harness[] = [];
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "prism-session-search-scope-"));
		agentDir = join(tempDir, "agent");
		process.env[ENV_AGENT_DIR] = agentDir;
	});
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		if (saved === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = saved;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("finds a project's older session behind four hundred newer ones of other projects", async () => {
		const sessions = join(agentDir, "sessions");
		mkdirSync(join(sessions, "work"), { recursive: true });
		mkdirSync(join(sessions, "other"), { recursive: true });
		const old = join(sessions, "work", "old.jsonl");
		writeFileSync(old, session("/work", "the needle is here"));
		const past = new Date(Date.now() - 86_400_000);
		utimesSync(old, past, past);
		for (let i = 0; i < 401; i++) writeFileSync(join(sessions, "other", `${i}.jsonl`), session("/other", "hay"));
		const result = await searchSessions("needle", "project", "/work", 8);
		expect(result.scanned).toBe(1);
		expect(result.hits.map((hit) => hit.file.path)).toEqual([old]);
	});

	it("keeps the match in the excerpt when lowering lengthens the text before it", async () => {
		const dir = join(agentDir, "sessions", "work");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "s.jsonl"), session("/work", `${"İ".repeat(300)} needle`));
		const { hits } = await searchSessions("needle", "project", "/work", 8);
		expect(hits).toHaveLength(1);
		expect(hits[0]?.text).toContain("needle");
	});

	it("searches the chosen session folder the window lists, in both scopes", async () => {
		const cwd = join(tempDir, "project");
		const custom = join(tempDir, "custom-sessions");
		mkdirSync(cwd);
		mkdirSync(custom);
		const write = (manager: SessionManager, text: string) => {
			manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
			manager.appendMessage(fauxAssistantMessage("done"));
			return manager.getSessionFile() as string;
		};
		const inCustom = write(SessionManager.create(cwd, custom), "needle in the chosen folder");
		const inDefault = write(SessionManager.create(cwd), "needle in the default storage");
		const harness = await createHarness({ sessionManager: SessionManager.create(cwd, custom) });
		harnesses.push(harness);
		const call = async <T>(command: Record<string, unknown>): Promise<T> => {
			const reply = (await handleBuiltinCommand(
				{ ...command, id: "request-id" } as Parameters<typeof handleBuiltinCommand>[0],
				harness.session,
				{} as never,
				{} as never,
				async () => {},
			)) as { data: T };
			return reply.data;
		};
		const listed = await call<{ sessions: Array<{ path: string }> }>({ type: "sessions_list" });
		expect(listed.sessions.map((entry) => entry.path)).toEqual([inCustom]);
		for (const all of [false, true]) {
			const { hits } = await call<{ hits: Array<{ path: string }> }>({
				type: "sessions_search",
				query: "needle",
				all,
			});
			expect(hits.map((hit) => hit.path)).toEqual([inCustom]);
		}
		expect(inDefault).not.toBe(inCustom);
	});
});
