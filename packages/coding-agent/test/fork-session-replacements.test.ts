/**
 * fork: one session replacement at a time. Two RPC new_session sent
 * together both tore the old session down; the slower one then applied its session over the other's, which kept
 * running unseen.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("fork: session replacements do not overlap", () => {
	const cleanups: Array<() => Promise<void> | void> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function start() {
		const tempDir = join(tmpdir(), `prism-replacements-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		const faux = registerFauxProvider({ models: [{ id: "faux-1" }] });
		const hold = { next: undefined as Promise<void> | undefined, created: 0, fail: undefined as Error | undefined };
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const waiting = hold.next;
			hold.next = undefined;
			if (waiting) await waiting;
			const fail = hold.fail;
			hold.fail = undefined;
			if (fail) throw fail;
			hold.created++;
			const services = await createAgentSessionServices({
				agentDir: tempDir,
				cwd,
				resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true, noExtensions: true },
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(tempDir),
		});
		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		});
		return { runtime, hold };
	}

	it("refuses a second replacement while the first is creating its session", async () => {
		const { runtime, hold } = await start();
		const held = deferred();
		hold.next = held.promise;
		const created = hold.created;
		const first = runtime.newSession();
		await expect(runtime.newSession()).rejects.toThrow("Another session change is in progress");
		held.resolve();
		await expect(first).resolves.toEqual({ cancelled: false });
		expect(hold.created).toBe(created + 1);
		// The session in place is the first one's, alive: it answers.
		expect(() => runtime.session.sessionManager.getSessionId()).not.toThrow();
		await expect(runtime.newSession()).resolves.toEqual({ cancelled: false });
	});

	// fork: a replacement that fails after the teardown leaves no live session. The host
	// is told, so it stops serving the disposed one; a failure before the teardown keeps the session and says nothing.
	it("tells the host when a replacement fails after the old session was torn down", async () => {
		const { runtime, hold } = await start();
		const lost: unknown[] = [];
		runtime.setOnSessionLost((error) => lost.push(error));
		await expect(runtime.fork("no-such-entry")).rejects.toThrow("Invalid entry ID");
		expect(lost).toEqual([]);
		const failure = new Error("package.json unreadable");
		hold.fail = failure;
		await expect(runtime.newSession()).rejects.toThrow("package.json unreadable");
		expect(lost).toEqual([failure]);
		// Disposing the host does not run the torn-down session's shutdown a second time.
		await expect(runtime.dispose()).resolves.toBeUndefined();
	});

	it("lets the new session's own work replace it again", async () => {
		const { runtime } = await start();
		let inner: { cancelled: boolean } | undefined;
		await runtime.newSession({
			withSession: async () => {
				inner = await runtime.newSession();
			},
		});
		expect(inner).toEqual({ cancelled: false });
	});
});
