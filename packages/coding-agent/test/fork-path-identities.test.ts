/**
 * fork: an identifier that becomes a path is checked when it
 * comes in, and two distinct objects never share a path.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { loadEntriesFromFile, SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import backgroundExtension, { backgroundTasks } from "../src/fork/background.ts";
import { checkpointDir } from "../src/fork/checkpoints.ts";
import { realPath } from "../src/fork/real-path.ts";
import { parseGitUrl } from "../src/utils/git.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

let root: string;
const saved = process.env[ENV_AGENT_DIR];

beforeEach(() => {
	root = realPath(mkdtempSync(join(tmpdir(), "prism-identities-")));
	process.env[ENV_AGENT_DIR] = join(root, "agent");
	mkdirSync(join(root, "agent"), { recursive: true });
});

afterEach(() => {
	vi.restoreAllMocks();
	if (saved === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = saved;
	rmSync(root, { recursive: true, force: true });
});

/** A session of `cwd` in its default folder, with one exchange so it is written. */
function session(cwd: string, id?: string): SessionManager {
	mkdirSync(cwd, { recursive: true });
	const manager = SessionManager.create(cwd, undefined, id ? { id } : undefined);
	manager.appendMessage({ role: "user", content: `in ${cwd}`, timestamp: Date.now() });
	manager.appendMessage(fauxAssistantMessage("ok"));
	return manager;
}

describe("fork: identifiers that become paths", () => {
	it("refuses a loaded session id that is not one a new session may have", () => {
		for (const id of ["../escape", "..", ".", "a/b"]) {
			const file = join(root, `crafted-${readdirSync(root).length}.jsonl`);
			const header = { type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: root };
			writeFileSync(file, `${JSON.stringify(header)}\n`);
			expect(loadEntriesFromFile(file), id).toEqual([]);
			// Opened as a file that is not a session, as one whose header has no id.
			expect(() => SessionManager.open(file, undefined, root), id).toThrow(/not a valid pi session/);
		}
	});

	it("keeps the sessions of two paths that encode to one folder name apart", async () => {
		const a = join(root, "a-b", "c");
		const b = join(root, "a", "b-c");
		const first = session(b);
		await new Promise((done) => setTimeout(done, 20));
		const second = session(a);
		await new Promise((done) => setTimeout(done, 20));
		const third = session(b);
		expect(first.getSessionDir()).toBe(second.getSessionDir());
		expect((await SessionManager.list(a)).map((info) => info.path)).toEqual([second.getSessionFile()]);
		expect(SessionManager.findById(a, first.getSessionId())).toBeUndefined();
		expect(SessionManager.findById(a, second.getSessionId())).toBe(second.getSessionFile());
		expect(SessionManager.continueRecent(a).getSessionFile()).toBe(second.getSessionFile());
		expect(SessionManager.continueRecent(b).getSessionFile()).toBe(third.getSessionFile());
	});

	it("gives two sessions with one chosen id, or with id and id.jsonl, their own checkpoints", () => {
		const one = session(join(root, "one"), "work");
		const two = session(join(root, "two"), "work");
		const three = session(join(root, "one"), "work.jsonl");
		const dirs = [one, two, three].map((manager) => checkpointDir(manager));
		expect(new Set(dirs).size).toBe(3);
		// The same session reopened finds its checkpoints again.
		expect(checkpointDir(SessionManager.open(one.getSessionFile()!))).toBe(dirs[0]);
	});

	it("keeps a Git port in a source's identity and install folder", () => {
		const host = (url: string) => parseGitUrl(url)?.host;
		expect(host("https://code.example.org:8443/team/tools.git")).toBe("code.example.org:8443");
		expect(host("https://code.example.org:9443/team/tools.git")).toBe("code.example.org:9443");
		expect(host("https://code.example.org:443/team/tools.git")).toBe("code.example.org");
		expect(host("ssh://git@code.example.org:22/team/tools.git")).toBe("code.example.org");
		expect(host("ssh://git@code.example.org:2222/team/tools.git")).toBe("code.example.org:2222");
		expect(host("git:git@github.com:team/tools.git")).toBe("github.com");
		const cwd = join(root, "project");
		mkdirSync(cwd);
		const manager = new DefaultPackageManager({
			cwd,
			agentDir: join(root, "agent"),
			settingsManager: SettingsManager.inMemory(),
		});
		// Only the 8443 repository is installed: the 9443 one does not reuse its copy.
		const installed = join(root, "agent", "git", "code.example.org+8443", "team", "tools");
		mkdirSync(installed, { recursive: true });
		const at = (port: string) => manager.getInstalledPath(`https://code.example.org:${port}/team/tools.git`, "user");
		expect(at("8443")).toBe(installed);
		expect(at("9443")).toBeUndefined();
	});
});

describe("fork: two sessions starting their first background task at once", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("write two logs, each with its own output", async () => {
		vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
		const outputs: string[] = [];
		for (const word of ["first-session", "second-session"]) {
			const harness = await createHarness({ extensionFactories: [{ name: "bg", factory: backgroundExtension }] });
			harnesses.push(harness);
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("background", { action: "run", command: `echo ${word}` }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("started"),
				fauxAssistantMessage("seen"),
			]);
			await harness.session.prompt("start");
			const task = backgroundTasks()?.[0];
			expect(task?.id).toBe("bg1");
			await vi.waitFor(() => expect(backgroundTasks()?.[0]?.status).toBe("done"), { timeout: 10_000 });
			outputs.push(task!.logPath);
		}
		expect(new Set(outputs).size).toBe(2);
		expect(readFileSync(outputs[0]!, "utf8").trim()).toBe("first-session");
		expect(readFileSync(outputs[1]!, "utf8").trim()).toBe("second-session");
	}, 30_000);
});
