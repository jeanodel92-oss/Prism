// fork (SEC-08): a session opened in a repository whose `core.hooksPath` is Husky's relative `.husky/_`, as the
// question about hooks folders leaves it once allowed. The startup check must judge the layout the commands get, in
// a private copy of the Git metadata, and leave the real `.git` untouched. Real bubblewrap, real Git.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import permissionsExtension from "../src/fork/permissions.ts";
import { findBwrap, removeSessionTmpDir } from "../src/fork/sandbox/runtime.ts";
import { createHarness, createTestUiContext, getToolResult, type Harness } from "./suite/harness.ts";

const bwrap = findBwrap();

describe.skipIf(!bwrap)("fork: a session opened in a Husky repository (SEC-08)", () => {
	let agentDir: string;
	let home: string;
	let harness: Harness;
	let repo: string;
	const env = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", repo, ...args], { env: { ...env, HOME: repo }, encoding: "utf8" }).trim();

	beforeEach(async () => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-husky-agent-"));
		home = mkdtempSync(join(tmpdir(), "prism-husky-home-"));
		vi.stubEnv("HOME", home);
		vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) vi.stubEnv(key, undefined);
		for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
		writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode: "broad" }));
		harness = await createHarness({ extensionFactories: [{ name: "permissions", factory: permissionsExtension }] });
		repo = harness.tempDir;
		git("init", "-q", "-b", "main");
		git("config", "user.name", "Sandbox Test");
		git("config", "user.email", "sandbox@example.invalid");
		git("commit", "-q", "--allow-empty", "-m", "initial");
	});

	afterEach(() => {
		removeSessionTmpDir(harness.sessionManager.getSessionId());
		harness.cleanup();
		vi.unstubAllEnvs();
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	});

	async function start(): Promise<void> {
		await harness.session.bindExtensions({ uiContext: createTestUiContext({}) });
	}

	async function bash(command: string): Promise<string> {
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		return getToolResult(harness, "bash")
			.content.map((part) => (part.type === "text" ? part.text : ""))
			.join("");
	}

	it("starts the sandbox and runs the hook, without creating .git/.husky", async () => {
		mkdirSync(join(repo, ".husky", "_"), { recursive: true });
		writeFileSync(join(repo, ".husky", "_", "pre-commit"), "#!/bin/sh\necho ran > hook-marker\n", { mode: 0o755 });
		git("config", "core.hooksPath", ".husky/_");
		await start();
		const output = await bash("git commit -q --allow-empty -m hooked && cat hook-marker");
		expect(output).not.toContain("The sandbox does not work");
		expect(output).toContain("ran");
		expect(git("log", "-1", "--format=%s")).toBe("hooked");
		expect(existsSync(join(repo, ".git", ".husky"))).toBe(false);
		// The startup check wrote nothing in the real Git folder either.
		expect(readdirSync(join(repo, ".git")).filter((name) => name.startsWith("."))).toEqual([]);
	});

	it("keeps the refusal for a repository the private copy cannot cover", async () => {
		mkdirSync(join(repo, ".husky", "_"), { recursive: true });
		git("config", "core.hooksPath", ".husky/_");
		// Borrowed objects: the copy refuses this repository, which keeps the layout's own protection.
		const other = mkdtempSync(join(tmpdir(), "prism-husky-objects-"));
		try {
			writeFileSync(join(repo, ".git", "objects", "info", "alternates"), `${join(other, "objects")}\n`);
			await start();
			const output = await bash("echo should-not-run");
			expect(output).toContain("The sandbox does not work");
			expect(output).toContain("core.hooksPath=.husky/_ in file:.git/config is relative");
			expect(output).not.toContain("should-not-run\n");
			expect(existsSync(join(repo, ".git", ".husky"))).toBe(false);
		} finally {
			rmSync(other, { recursive: true, force: true });
		}
	});
});
