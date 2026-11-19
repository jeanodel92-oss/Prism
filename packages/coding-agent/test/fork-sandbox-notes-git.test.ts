// fork: descriptions use private Git copies, and result notes use the command's actual layout.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { ToolResultEvent } from "../src/core/extensions/types.ts";
import permissionsExtension from "../src/fork/permissions.ts";
import { gitCopyRefusal, prepareGitCopies } from "../src/fork/sandbox/git-copy.ts";
import { buildLayout, DEFAULT_SANDBOX_SETTINGS } from "../src/fork/sandbox/layout.ts";
import { describeSandbox, sandboxPromptSection, sandboxResultNote } from "../src/fork/sandbox/notes.ts";
import { HostPolicy } from "../src/fork/sandbox/proxy.ts";
import * as runtimeModule from "../src/fork/sandbox/runtime.ts";
import { settingsSections } from "../src/fork/settings-sections.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

describe("fork: private Git copy descriptions", () => {
	let folder: string;
	let repo: string;
	let agentDir: string;
	let harness: Harness | undefined;
	const settings = { ...DEFAULT_SANDBOX_SETTINGS, read: { limit: "all" as const, allow: [], toolsOff: [] } };
	const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
	const origin = { cwd: "/project", command: "true", task: false };

	beforeEach(() => {
		folder = mkdtempSync(join(tmpdir(), "prism-git-notes-"));
		const home = join(folder, "home");
		agentDir = join(folder, "agent");
		repo = join(folder, "repo");
		for (const path of [home, agentDir, repo, join(folder, "tmp")]) mkdirSync(path);
		vi.stubEnv("HOME", home);
		vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) vi.stubEnv(key, undefined);
		vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
		vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
		initTheme("dark");
		git(repo, "init", "-q");
		const library = join(folder, "library");
		mkdirSync(library);
		git(library, "init", "-q");
		git(library, "-c", "user.name=x", "-c", "user.email=x@x", "commit", "-q", "--allow-empty", "-m", "lib");
		git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", library, "lib");
	});

	afterEach(() => {
		if (harness) {
			runtimeModule.removeSessionTmpDir(harness.sessionManager.getSessionId());
			harness.cleanup();
			harness = undefined;
		}
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		rmSync(folder, { recursive: true, force: true });
	});

	const layout = (copy = true) =>
		buildLayout({
			cwd: repo,
			agentDir,
			settings,
			copyGitDir: copy ? (gitDir) => gitCopyRefusal(gitDir) === undefined : undefined,
		});

	it("tells the model how Git works and how refused changes are kept", () => {
		const plan = layout();
		const prompt = sandboxPromptSection(plan);
		expect(prompt).toContain(`Git works normally (commits, branches, fetch) in: ${repo}, ${join(repo, "lib")}`);
		expect(prompt).toContain("checked after each bash command");
		expect(prompt).toContain("outside the sandbox (hooks, configuration)");
		expect(prompt).toContain("refused with a note and kept, not lost");
		expect(prompt).toContain("and when a background command ends (not before: until then they are not applied)");
		expect(prompt).not.toContain("submodule Git metadata");
		expect(plan.readOnly).not.toContain(join(repo, ".git", "config"));
		expect(plan.readOnly).toContain(join(repo, "lib", ".git"));
		expect(
			sandboxResultNote("bash: .git/config: Read-only file system", { ...plan, restrictions: [] }),
		).toBeUndefined();
		expect(
			sandboxResultNote("bash: .git/config: Read-only file system", { ...plan, restrictions: [], readOnly: [repo] }),
		).toBeUndefined();
		expect(
			sandboxResultNote("bash: .pi/settings.json: Read-only file system", { ...plan, restrictions: [] }),
		).toContain("is protected");
	});

	it("shows copied repositories in /sandbox and keeps the remaining protections", () => {
		const lines = describeSandbox({
			mode: "broad",
			active: true,
			settings,
			layout: layout(),
			settingsPath: "/settings",
		});
		expect(lines).toContain(`Git in a private copy: ${repo}, ${join(repo, "lib")}`);
		expect(lines.find((line) => line.startsWith("Read-only inside them:"))).not.toContain(join(repo, ".git"));
		expect(lines.find((line) => line.startsWith("Read-only inside them:"))).toContain(join(repo, "lib", ".git"));
	});

	it.each([
		"alternates",
		"http-alternates",
		"link",
		"format",
		"config",
		"commondir",
		"objects",
		"size",
		"files",
		"depth",
	])("uses the same refusal for the predicate and the copy: %s", (kind) => {
		const gitDir = join(repo, ".git", "modules", "lib");
		if (kind === "alternates" || kind === "http-alternates")
			writeFileSync(join(gitDir, "objects", "info", kind), "/elsewhere\n");
		if (kind === "link") symlinkSync("HEAD", join(gitDir, "linked"));
		if (kind === "format") git(join(repo, "lib"), "config", "core.repositoryformatversion", "99");
		if (kind === "config") writeFileSync(join(gitDir, "config"), "[broken");
		if (kind === "commondir") writeFileSync(join(gitDir, "commondir"), "../..\n");
		if (kind === "objects") rmSync(join(gitDir, "objects"), { recursive: true });
		if (kind === "size") {
			writeFileSync(join(gitDir, "large"), "");
			truncateSync(join(gitDir, "large"), 64 * 1024 * 1024 + 1);
		}
		if (kind === "files") {
			mkdirSync(join(gitDir, "many"));
			for (let n = 0; n < 20_000; n++) writeFileSync(join(gitDir, "many", String(n)), "");
		}
		if (kind === "depth") mkdirSync(join(gitDir, ...Array<string>(66).fill("d")), { recursive: true });
		const reason = gitCopyRefusal(join(repo, ".git"));
		expect(reason).toContain("its submodule");
		expect(
			prepareGitCopies(join(repo, ".git"), { folder: join(folder, "copies"), tmp: join(folder, "tmp"), origin }),
		).toEqual({ reason });
		expect(layout().privateGit).toBeUndefined();
		expect(layout().readOnly).toContain(gitDir);
	});

	it("checks metadata without copying it or walking objects", () => {
		symlinkSync("/absent", join(repo, ".git", "objects", "not-metadata"));
		const before = readdirSync(folder);
		expect(gitCopyRefusal(join(repo, ".git"))).toBeUndefined();
		expect(readdirSync(folder)).toEqual(before);
		const copies = prepareGitCopies(join(repo, ".git"), {
			folder: join(folder, "copies"),
			tmp: join(folder, "tmp"),
			origin,
		});
		expect(Array.isArray(copies)).toBe(true);
		if (Array.isArray(copies)) expect(copies).toHaveLength(2);
	});

	async function start() {
		writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode: "broad" }));
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sandbox: settings }));
		writeFileSync(join(folder, "seccomp"), "");
		const runtime: runtimeModule.SandboxRuntime = {
			// The unit test assembles the real command and its copies; this executable performs no mounts.
			bwrap: "/bin/true",
			settings,
			agentDir,
			seccomp: join(folder, "seccomp"),
			policy: new HostPolicy(
				() => settings.network,
				async () => "deny",
			),
			tmp: join(folder, "tmp"),
		};
		vi.spyOn(runtimeModule, "startSandbox").mockResolvedValue(runtime);
		harness = await createHarness({ extensionFactories: [{ name: "permissions", factory: permissionsExtension }] });
		// Keep the harness's cwd, whose disposable repository has the same submodule layout.
		rmSync(harness.tempDir, { recursive: true });
		cpSync(repo, harness.tempDir, { recursive: true });
		repo = harness.tempDir;
		const select = vi.fn(async (_title: string, _options: string[]) => undefined);
		await harness.session.bindExtensions({ uiContext: createTestUiContext({ select }) });
		return { harness, runtime, select };
	}

	it("wires the predicate into the prompt, /sandbox and the settings page", async () => {
		const { harness, select } = await start();
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("go");
		expect(harness.session.agent.state.systemPrompt).toContain(
			`Git works normally (commits, branches, fetch) in: ${repo}`,
		);
		expect(harness.session.agent.state.systemPrompt).not.toContain("submodule Git metadata");
		await harness.session.prompt("/sandbox");
		expect(select.mock.calls.at(-1)?.[1]).toContain(`Git in a private copy: ${repo}, ${join(repo, "lib")}`);
		const section = settingsSections().find((item) => item.domain === "permissions")!;
		const item = section
			.items({ advanced: () => true, requestRender: () => {} })
			.find((item) => item.id === "sandbox-state")!;
		const page = item.submenu!(item.currentValue, () => {});
		expect(page.render(200).join("\n")).toContain("Git in a private copy:");
		expect(page.render(200).join("\n")).not.toContain(`${repo}/.git/config`);
	});

	it("uses each command's mounted layout once, then falls back; background keeps its layout", async () => {
		const { harness, runtime } = await start();
		const operations = runtimeModule.createSandboxableBashOperations(() => runtime);
		await operations.exec("true", repo, { onData: () => {}, toolCallId: "one" });
		await operations.exec("true", repo, { onData: () => {}, toolCallId: "two" });
		const event: ToolResultEvent = {
			type: "tool_result",
			toolName: "bash",
			toolCallId: "one",
			input: { command: "cat /unrelated" },
			content: [{ type: "text", text: "cat: /unrelated: Permission denied" }],
			isError: true,
			details: undefined,
		};
		expect(sandboxResultNote("Permission denied", layout(false))).toContain("submodule Git metadata");
		expect(JSON.stringify(await harness.session.extensionRunner!.emitToolResult(event)) ?? "").not.toContain(
			"submodule Git metadata",
		);
		expect(runtimeModule.takeSandboxLayout(runtime, "one")).toBeUndefined();
		const second = runtimeModule.takeSandboxLayout(runtime, "two")!;
		expect(second.privateGit).toHaveLength(2);
		expect(second.readOnly).not.toContain(join(repo, ".git", "config"));
		expect(second.writable).not.toContain(join(repo, ".git"));
		expect(await harness.session.extensionRunner!.emitToolResult(event)).toEqual(
			expect.objectContaining({
				content: expect.arrayContaining([
					expect.objectContaining({ text: expect.stringContaining("submodule Git metadata") }),
				]),
			}),
		);
		expect(await harness.session.extensionRunner!.emitToolResult({ ...event, toolName: "background" })).toEqual(
			expect.objectContaining({
				content: expect.arrayContaining([
					expect.objectContaining({ text: expect.stringContaining("submodule Git metadata") }),
				]),
			}),
		);
	});
});
