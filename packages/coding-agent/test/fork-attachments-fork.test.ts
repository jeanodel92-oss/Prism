/**
 * fork: a duplicated or forked session keeps the attached files its
 * messages name, in its own store and private /tmp, also after it is resumed.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import fileAttachments, { attachFile, attachTarget, restoreAttachments } from "../src/fork/file-attachments.ts";
import { removeSessionTmpDir, sessionTmpDir } from "../src/fork/sandbox/runtime.ts";

const PDF = Buffer.from("%PDF-1.4\n\0\x01binary");

describe("attached files of a duplicated or forked session", () => {
	let root: string;
	const sessionIds: string[] = [];

	beforeEach(() => {
		root = join(tmpdir(), `prism-attach-fork-${process.pid}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(root, "project"), { recursive: true });
		mkdirSync(join(root, "outside"), { recursive: true });
		writeFileSync(join(root, "outside", "report.pdf"), PDF);
		writeFileSync(join(root, "outside", "other.pdf"), PDF);
	});
	afterEach(() => {
		for (const id of sessionIds.splice(0)) removeSessionTmpDir(id);
		rmSync(root, { recursive: true, force: true });
	});

	/** A saved session whose second user message attaches report.pdf; `other.pdf` is saved but never named. */
	function parentSession() {
		const manager = SessionManager.create(join(root, "project"), join(root, "sessions"));
		sessionIds.push(manager.getSessionId());
		const before = manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		const attached = attachFile(join(root, "outside", "report.pdf"), attachTarget(manager));
		if (attached.kind !== "file") throw new Error(`Expected a copied file, got ${attached.kind}`);
		attachFile(join(root, "outside", "other.pdf"), attachTarget(manager));
		const withFile = manager.appendMessage({ role: "user", content: `read ${attached.path}`, timestamp: 2 });
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "faux",
			provider: "faux",
			model: "faux",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 3,
		});
		return { manager, before, withFile, file: manager.getSessionFile()!, path: attached.path };
	}

	type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

	function handlers(): Map<string, Handler> {
		const found = new Map<string, Handler>();
		fileAttachments({ on: (name: string, fn: Handler) => found.set(name, fn) } as unknown as ExtensionAPI);
		return found;
	}

	async function startAfterFork(manager: SessionManager, previousSessionFile: string): Promise<void> {
		const notices: string[] = [];
		const event: SessionStartEvent = { type: "session_start", reason: "fork", previousSessionFile };
		await handlers().get("session_start")?.(event, {
			sessionManager: manager,
			ui: { notify: (message: string) => notices.push(message) },
		} as unknown as ExtensionContext);
		expect(notices).toEqual([]);
	}

	/** The messages the model is sent after the context handler, or undefined when it changes nothing. */
	async function sent(manager: SessionManager, messages: AgentMessage[]): Promise<AgentMessage[] | undefined> {
		const result = (await handlers().get("context")?.({ type: "context", messages }, {
			sessionManager: manager,
		} as unknown as ExtensionContext)) as { messages?: AgentMessage[] } | undefined;
		return result?.messages;
	}

	/** A user message naming `path`, and the agent's read of it. */
	const naming = (path: string): AgentMessage[] => [
		{ role: "user", content: [{ type: "text", text: `read ${path} please` }], timestamp: 1 },
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path } }],
			api: "faux",
			provider: "faux",
			model: "faux",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 2,
		},
	];

	const tmpCopy = (manager: SessionManager, name: string) =>
		join(sessionTmpDir(manager.getSessionId()), "attachments", name);

	it("copies the files a fork keeps into its store and /tmp, and back after a resume", async () => {
		const parent = parentSession();
		const forked = SessionManager.open(parent.file, join(root, "sessions"));
		forked.createBranchedSession(parent.withFile);
		sessionIds.push(forked.getSessionId());
		expect(forked.getSessionFile()).not.toBe(parent.file);

		await startAfterFork(forked, parent.file);
		expect(readFileSync(tmpCopy(forked, "report.pdf"))).toEqual(PDF);
		expect(existsSync(tmpCopy(forked, "other.pdf"))).toBe(false);

		// The parent's private /tmp ends with it; the fork's own ends too, then the fork is resumed.
		removeSessionTmpDir(parent.manager.getSessionId());
		removeSessionTmpDir(forked.getSessionId());
		restoreAttachments(attachTarget(SessionManager.open(forked.getSessionFile()!)));
		expect(readFileSync(tmpCopy(forked, "report.pdf"))).toEqual(PDF);
	});

	// without the sandbox, the path a message gives is the host path of the private
	// /tmp of the run that attached the file, a folder removed with that run.
	it("gives the fork's own /tmp to the paths the model is sent, without the sandbox", async () => {
		const parent = parentSession();
		expect(parent.path.startsWith(sessionTmpDir(parent.manager.getSessionId()))).toBe(true);
		const forked = SessionManager.open(parent.file, join(root, "sessions"));
		forked.createBranchedSession(parent.withFile);
		sessionIds.push(forked.getSessionId());
		await startAfterFork(forked, parent.file);
		removeSessionTmpDir(parent.manager.getSessionId());

		const messages = naming(parent.path);
		const result = await sent(forked, messages);
		const now = tmpCopy(forked, "report.pdf");
		expect(JSON.stringify(result)).toContain(`read ${now} please`);
		expect(JSON.stringify(result)).not.toContain(parent.path);
		expect((result?.[1] as unknown as { content: { arguments: { path: string } }[] }).content[0].arguments.path).toBe(
			now,
		);
		expect(readFileSync(now)).toEqual(PDF);
		// What was sent before is left as it was, and so is the session file.
		expect(JSON.stringify(messages)).toContain(parent.path);
		expect(readFileSync(forked.getSessionFile()!, "utf8")).toContain(parent.path);
	});

	it("gives a resumed session's paths its new /tmp, and leaves the current one alone", async () => {
		const parent = parentSession();
		expect(await sent(parent.manager, naming(parent.path))).toBeUndefined();

		removeSessionTmpDir(parent.manager.getSessionId());
		const resumed = SessionManager.open(parent.file);
		restoreAttachments(attachTarget(resumed));
		const now = tmpCopy(resumed, "report.pdf");
		expect(now).not.toBe(parent.path);
		expect(JSON.stringify(await sent(resumed, naming(parent.path)))).toContain(`read ${now} please`);
		expect(readFileSync(now)).toEqual(PDF);
		// A path outside a private /tmp of Prism is not touched.
		expect(await sent(resumed, naming(join(root, "outside", "attachments", "report.pdf")))).toBeUndefined();
	});

	it("does not copy files the fork's messages do not name", async () => {
		const parent = parentSession();
		const forked = SessionManager.open(parent.file, join(root, "sessions"));
		forked.createBranchedSession(parent.before);
		sessionIds.push(forked.getSessionId());
		await startAfterFork(forked, parent.file);
		expect(existsSync(tmpCopy(forked, "report.pdf"))).toBe(false);
	});
});
