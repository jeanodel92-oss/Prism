// fork: a nested repository made by one command, whose configuration runs a
// program, then added as a submodule by a later command. The AS-018 refusal covered only a repository the same
// command made; the host's `git status` at the project's root then ran the program. Real bubblewrap, real Git.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import permissionsExtension from "../src/fork/permissions.ts";
import { findBwrap, removeSessionTmpDir } from "../src/fork/sandbox/runtime.ts";
import { createHarness, createTestUiContext, getToolResult, type Harness } from "./suite/harness.ts";

const env = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
const IDENTITY = ["-c", "user.name=x", "-c", "user.email=x@x"];
const ID = IDENTITY.join(" ");

describe.skipIf(!findBwrap())("fork: a submodule added by a later command (AS-026)", () => {
	let agentDir: string;
	let repo: string;
	let marker: string;
	let harness: Harness;

	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", ["-C", cwd, ...IDENTITY, ...args], {
			env: { ...env, HOME: cwd },
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();

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

	beforeEach(async () => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-as026-agent-"));
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) vi.stubEnv(key, undefined);
		for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
		marker = join(agentDir, "ran-on-the-host");
		writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode: "broad" }));
		harness = await createHarness({ extensionFactories: [{ name: "permissions", factory: permissionsExtension }] });
		await harness.session.bindExtensions({ uiContext: createTestUiContext({}) });
		repo = harness.tempDir;
		git(repo, "init", "-q", "-b", "main");
		git(repo, "commit", "-q", "--allow-empty", "-m", "initial");
	});

	afterEach(() => {
		removeSessionTmpDir(harness.sessionManager.getSessionId());
		harness.cleanup();
		vi.unstubAllEnvs();
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("publishes no index or commit that adds a repository an earlier command made with a program", async () => {
		const first = await bash(
			[
				"git init -q -b main tools/evil",
				`git -C tools/evil ${ID} commit -q --allow-empty -m e`,
				`git -C tools/evil config core.fsmonitor 'touch ${marker}'`,
				"echo made",
			].join(" && "),
		);
		expect(first).toContain("made");
		expect(first).toContain("core.fsmonitor");

		const index = await bash("git add tools/evil && echo added");
		expect(index).toContain("added");
		expect(index).toContain("index adds tools/evil as a submodule, a repository whose hooks or configuration run");
		expect(git(repo, "-c", "core.fsmonitor=false", "ls-files", "--stage")).toBe("");

		// The index no longer lists it; the first commit still adds it.
		const commit = await bash(
			`git add tools/evil && git ${ID} commit -qm add && git rm -q --cached tools/evil && git ${ID} commit -qm gone && echo committed`,
		);
		expect(commit).toContain("committed");
		expect(commit).toContain(`this command's Git changes were not applied to ${join(repo, ".git")}`);
		expect(commit).toMatch(/adds tools\/evil \(commit [0-9a-f]{40}\) as a submodule, a repository whose hooks/);
		expect(git(repo, "-c", "core.fsmonitor=false", "log", "-1", "--format=%s")).toBe("initial");
		git(repo, "status", "--short");
		expect(existsSync(marker), "the host's git status ran the nested repository's program").toBe(false);
	}, 120_000);

	it("still publishes a clean repository added later, and commits beside a submodule the user set up", async () => {
		// The user's own nested repository, with a hook, already in the index: not added by the command.
		git(repo, "init", "-q", "-b", "main", "tools/own");
		git(join(repo, "tools/own"), "commit", "-q", "--allow-empty", "-m", "own");
		writeFileSync(join(repo, "tools/own/.git/hooks/pre-commit"), "#!/bin/sh\nexit 0\n");
		chmodSync(join(repo, "tools/own/.git/hooks/pre-commit"), 0o755);
		git(repo, "add", "tools/own");
		git(repo, "commit", "-q", "-m", "own");

		expect(
			await bash(`git init -q -b main tools/fine && git -C tools/fine ${ID} commit -q --allow-empty -m f`),
		).not.toContain("Prism:");
		const later = await bash(
			`git add tools/fine && git ${ID} commit -qm fine && echo x > f && git add f && git ${ID} commit -qm f && echo ok`,
		);
		expect(later).toContain("ok");
		expect(later).not.toContain("not applied");
		expect(git(repo, "log", "--format=%s")).toBe("f\nfine\nown\ninitial");
	}, 120_000);
});
