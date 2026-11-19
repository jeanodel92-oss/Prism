/**
 * fork: a cancelled session_search reads no further file, and an answer to
 * its consent question given after the cancellation consents to nothing.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "../src/core/extensions/types.ts";
import sessionSearch, { searchSessions } from "../src/fork/session-search.ts";

describe("fork: a cancelled session search", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "prism-session-search-cancel-"));
		vi.stubEnv(ENV_AGENT_DIR, dir);
		const sessions = join(dir, "sessions", "project");
		mkdirSync(sessions, { recursive: true });
		for (const name of ["a", "b"])
			writeFileSync(
				join(sessions, `${name}.jsonl`),
				`${JSON.stringify({ type: "session", cwd: "/work", timestamp: "2026-01-01T00:00:00Z" })}\n${JSON.stringify({ type: "message", message: { role: "user", content: `needle ${name}` } })}\n`,
			);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(dir, { recursive: true, force: true });
	});

	it("reads nothing once cancelled", async () => {
		expect((await searchSessions("needle", "project", "/work", 8)).hits).toHaveLength(2);
		await expect(searchSessions("needle", "project", "/work", 8, undefined, AbortSignal.abort())).rejects.toThrow();
	});

	it("keeps no consent given after the call was cancelled", async () => {
		const tools = new Map<string, ToolDefinition>();
		sessionSearch({
			on: () => {},
			registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
			registerCommand: () => {},
		} as unknown as ExtensionAPI);
		let controller = new AbortController();
		const signals: Array<AbortSignal | undefined> = [];
		const select = vi.fn(async (_title: string, _choices: string[], options?: { signal?: AbortSignal }) => {
			signals.push(options?.signal);
			// The user cancels the turn, then the client still answers the question.
			controller.abort();
			return "Send them for the rest of this session";
		});
		const ctx = {
			cwd: "/work",
			hasUI: true,
			model: { provider: "cloud", id: "model", baseUrl: "https://api.example.com" },
			sessionManager: { getSessionFile: () => undefined },
			ui: { select },
		} as unknown as ExtensionToolContext;
		const search = () =>
			tools.get("session_search")!.execute("call", { query: "needle" }, controller.signal, undefined, ctx);
		await expect(search()).rejects.toThrow();
		expect(signals[0]).toBe(controller.signal);
		controller = new AbortController();
		await expect(search()).rejects.toThrow();
		// Asked again: the late answer was not kept for the session.
		expect(select).toHaveBeenCalledTimes(2);
	});
});
