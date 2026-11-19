// fork.10 (RT-001): without inotify (EMFILE), the settings are read at intervals. A settings file replaced with the
// same mtime used to go unseen: a host the user took back stayed open for a connection already made.
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { emitSessionShutdownEvent } from "../src/core/extensions/runner.ts";
import permissionsExtension from "../src/fork/permissions.ts";
import * as runtime from "../src/fork/sandbox/runtime.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

// Every watcher of this file's sessions fails as when the session's inotify instances are used up.
vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	const watch = () => {
		throw Object.assign(new Error("inotify_init: EMFILE"), { code: "EMFILE" });
	};
	return { ...fs, watch, default: { ...fs, watch } };
});

let agentDir: string;
const saved = process.env[ENV_AGENT_DIR];
const harnesses: Harness[] = [];

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "prism-rt001-"));
	process.env[ENV_AGENT_DIR] = agentDir;
	// Only namespace startup is replaced; decisions, settings and their polling are real.
	vi.spyOn(runtime, "startSandbox").mockImplementation(async (settings, _cwd, policy, tmp) => ({
		bwrap: "/unused",
		settings,
		agentDir,
		seccomp: "/unused",
		policy,
		tmp: tmp ?? agentDir,
	}));
});

afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await emitSessionShutdownEvent(harness.session.extensionRunner, { type: "session_shutdown", reason: "quit" });
		runtime.removeSessionTmpDir(harness.sessionManager.getSessionId());
		harness.cleanup();
	}
	vi.restoreAllMocks();
	if (saved === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = saved;
	rmSync(agentDir, { recursive: true, force: true });
});

it("closes a connection to a host taken back in a settings file replaced with the same mtime", async () => {
	const file = join(agentDir, "settings.json");
	writeFileSync(file, JSON.stringify({ sandbox: { network: { allow: ["example.test"] } } }));
	// A whole second: utimes keeps it exactly (a sub-millisecond mtime would not survive being set back).
	const second = 1_700_000_000;
	utimesSync(file, second, second);
	const harness = await createHarness({
		extensionFactories: [{ name: "permissions", factory: permissionsExtension }],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({
		uiContext: createTestUiContext({ select: async () => "Block for this command" }),
	});
	const sandbox = runtime.sessionSandbox(harness.sessionManager);
	if (!sandbox || "error" in sandbox) throw new Error("test sandbox missing");

	const network = sandbox.policy.open({ command: "curl" });
	expect(await network.allows("example.test")).toBe(true);
	let closed = false;
	network.track("example.test", () => {
		closed = true;
	});
	// The host taken back, the file's mtime set back as an editor or a sync tool may leave it.
	writeFileSync(file, JSON.stringify({ sandbox: { network: { allow: ["examplx.test"] } } }));
	utimesSync(file, second, second);
	expect(statSync(file).mtimeMs).toBe(second * 1000);

	await vi.waitFor(() => expect(closed).toBe(true), { timeout: 4000 });
	expect(await sandbox.policy.open({ command: "curl" }).allows("example.test")).toBe(false);
});
