/**
 * fork: the relay's Node startup snapshot (relay-snapshot.ts), in the real
 * sandbox. Made only for a Node without its own startup snapshot; elsewhere the relay starts as before.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { DEFAULT_SANDBOX_SETTINGS } from "../src/fork/sandbox/layout.ts";
import { HostPolicy } from "../src/fork/sandbox/proxy.ts";
import { relaySnapshot, relaySnapshotGains } from "../src/fork/sandbox/relay-snapshot.ts";
import {
	createSandboxableBashOperations,
	findBwrap,
	removeSessionTmpDir,
	type SandboxRuntime,
	sessionTmpDir,
	startSandbox,
} from "../src/fork/sandbox/runtime.ts";

const gains = relaySnapshotGains();

describe("fork: relay startup snapshot", () => {
	let scratch: string;
	let agentDir: string;
	let project: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "prism-relay-snapshot-"));
		agentDir = join(scratch, "agent");
		project = join(scratch, "project");
		mkdirSync(agentDir);
		mkdirSync(project);
		mkdirSync(join(scratch, "home"));
		vi.stubEnv("HOME", join(scratch, "home"));
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		vi.stubEnv("PRISM_SANDBOX_RELAY_SNAPSHOT", undefined);
	});

	afterEach(() => {
		removeSessionTmpDir("relay-snapshot");
		vi.unstubAllEnvs();
		rmSync(scratch, { recursive: true, force: true });
	});

	async function start(): Promise<SandboxRuntime> {
		const settings = DEFAULT_SANDBOX_SETTINGS;
		const sandbox = await startSandbox(
			settings,
			project,
			new HostPolicy(() => settings.network, undefined),
			sessionTmpDir("relay-snapshot"),
		);
		if ("error" in sandbox) throw new Error(sandbox.error);
		return sandbox;
	}

	async function run(runtime: SandboxRuntime, command: string): Promise<string> {
		let output = "";
		await createSandboxableBashOperations(() => runtime).exec(command, project, {
			onData: (data) => {
				output += String(data);
			},
		});
		return output;
	}

	it("is made only for a Node without its own startup snapshot, and can be turned off", () => {
		expect(relaySnapshot(agentDir) !== undefined).toBe(gains);
		vi.stubEnv("PRISM_SANDBOX_RELAY_SNAPSHOT", "0");
		rmSync(join(agentDir, "sandbox"), { recursive: true, force: true });
		expect(relaySnapshot(agentDir)).toBeUndefined();
	});

	it("holds nothing of Prism's environment", () => {
		if (!gains) return;
		vi.stubEnv("PRISM_RELAY_SNAPSHOT_CANARY", "canary-4f1d9a7c-not-in-the-snapshot");
		const blob = relaySnapshot(agentDir)!;
		expect(readFileSync(blob).includes("canary-4f1d9a7c")).toBe(false);
	});

	it.skipIf(!findBwrap() || !gains)(
		"starts the relay, which leaves the command neither its descriptor nor its file",
		async () => {
			const runtime = await start();
			const blob = runtime.relaySnapshot!;
			expect(blob).toMatch(/relay-[0-9a-f]{16}\.blob$/);
			const output = await run(
				runtime,
				[
					'echo "proxy=$HTTP_PROXY"',
					'tr "\\0" " " < /proc/$PPID/cmdline; echo',
					'test -e /proc/self/fd/6 && echo "own-$((5 + 1))"',
					'for fd in /proc/$PPID/fd/* /proc/self/fd/*; do echo "fd $fd $(readlink "$fd")"; done',
					`cat ${blob} > /dev/null 2>&1 && echo "blob-$((0))"`,
				].join("\n"),
			);
			expect(output).toMatch(/proxy=http:\/\/127\.0\.0\.1:\d+/);
			expect(output).toContain("--snapshot-blob /proc/self/fd/6");
			expect(output).not.toContain("own-6");
			expect(output).not.toMatch(/^fd .*relay-[0-9a-f]{16}\.blob/m);
			expect(output).not.toContain("blob-0");
		},
	);

	it.skipIf(!findBwrap() || !gains)("starts the relay as before from a snapshot Node cannot use", async () => {
		const blob = relaySnapshot(agentDir)!;
		writeFileSync(blob, "not a snapshot");
		const runtime = await start();
		expect(runtime.relaySnapshot).toBeUndefined();
		const output = await run(runtime, 'echo "proxy=$HTTP_PROXY"; tr "\\0" " " < /proc/$PPID/cmdline');
		expect(output).toMatch(/proxy=http:\/\/127\.0\.0\.1:\d+/);
		expect(output).not.toContain("--snapshot-blob");
		// The next start makes another.
		expect((await start()).relaySnapshot).toBe(blob);
	});
});
