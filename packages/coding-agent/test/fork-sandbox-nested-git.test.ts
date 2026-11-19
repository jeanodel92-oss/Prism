// fork: Git repositories nested in the project or
// in allowWrite. Each gets the project's treatment during a command; after it, a repository that did not have it for
// the whole command is checked and reported. Adversarial cases the maintainer asked for: a `.git` made or replaced, links,
// submodules, an interrupted command, the window between the layout and the command. Real bubblewrap, real Git,
// disposable repositories.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import backgroundExtension from "../src/fork/background.ts";
import fileBrowser from "../src/fork/file-browser.ts";
import permissionsExtension from "../src/fork/permissions.ts";
import {
	buildLayout,
	bwrapArgs,
	DEFAULT_SANDBOX_SETTINGS,
	prepareLayout,
	type SandboxLayout,
	type SandboxSettings,
} from "../src/fork/sandbox/layout.ts";
import { checkNewRepositories, reportedRepositories, takeUnseenRepositories } from "../src/fork/sandbox/nested-git.ts";
import { describeSandbox } from "../src/fork/sandbox/notes.ts";
import { findBwrap, removeSessionTmpDir } from "../src/fork/sandbox/runtime.ts";
import { createHarness, createTestUiContext, getToolResult, type Harness } from "./suite/harness.ts";

const bwrap = findBwrap();
const env = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
const IDENTITY = ["-c", "user.name=x", "-c", "user.email=x@x"];
const SETTINGS: SandboxSettings = {
	...DEFAULT_SANDBOX_SETTINGS,
	read: { ...DEFAULT_SANDBOX_SETTINGS.read, limit: "all" },
};

describe.skipIf(!bwrap)("fork: Git repositories nested in the project", () => {
	let agentDir: string;
	let repo: string;
	let marker: string;

	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", ["-C", cwd, ...IDENTITY, ...args], {
			env: { ...env, HOME: cwd },
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	const plant = (gitdir: string) =>
		`printf '#!/bin/sh\\ntouch ${marker}\\n' > ${gitdir}/hooks/pre-commit && chmod +x ${gitdir}/hooks/pre-commit`;
	function hostCommitRunsHook(folder: string): boolean {
		try {
			git(folder, "commit", "--allow-empty", "-qm", "host");
		} catch {}
		return existsSync(marker);
	}

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-nested-agent-"));
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) vi.stubEnv(key, undefined);
		for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
		marker = join(agentDir, "hook-ran");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(agentDir, { recursive: true, force: true });
	});

	describe("through the bash tool", () => {
		let harness: Harness;

		beforeEach(async () => {
			writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode: "broad" }));
			harness = await createHarness({
				extensionFactories: [
					{ name: "permissions", factory: permissionsExtension },
					{ name: "background", factory: backgroundExtension },
				],
			});
			await harness.session.bindExtensions({
				uiContext: createTestUiContext({
					select: async (_title, options) => options.find((option) => option.startsWith("Allow")),
				}),
			});
			repo = harness.tempDir;
			git(repo, "init", "-q", "-b", "main");
			git(repo, "commit", "-q", "--allow-empty", "-m", "initial");
			git(repo, "init", "-q", "-b", "main", "vendor/lib");
			git(join(repo, "vendor/lib"), "commit", "-q", "--allow-empty", "-m", "lib");
		});

		afterEach(() => {
			removeSessionTmpDir(harness.sessionManager.getSessionId());
			harness.cleanup();
		});

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

		it("lets Git work in an existing nested repository and publishes no hook written there", async () => {
			const lib = join(repo, "vendor/lib");
			const output = await bash(
				`git -C vendor/lib ${IDENTITY.join(" ")} commit -q --allow-empty -m nested && ${plant("vendor/lib/.git")} && echo written`,
			);
			expect(output).toContain("written");
			expect(output).toContain(`this command's Git changes were not applied to ${join(lib, ".git")}`);
			expect(existsSync(join(lib, ".git/hooks/pre-commit"))).toBe(false);
			expect(hostCommitRunsHook(lib)).toBe(false);
			// Without the hook, the commit is published.
			expect(await bash(`git -C vendor/lib ${IDENTITY.join(" ")} commit -q --allow-empty -m again`)).not.toContain(
				"Prism:",
			);
			expect(git(lib, "log", "-1", "--format=%s")).toBe("again");
		});

		it("reports a repository the command made with a hook or configuration that runs programs", async () => {
			const output = await bash(
				`git init -q plain && git init -q planted && ${plant("planted/.git")} && git -C planted config core.fsmonitor ./x`,
			);
			expect(output).toContain(`${join(repo, "planted")}: `);
			expect(output).toContain("core.fsmonitor");
			expect(output).toContain(`hook ${join(repo, "planted/.git/hooks/pre-commit")}`);
			expect(output).not.toContain(join(repo, "plain"));
			// Reported, not changed (Q-G3); from the next command on it is in a private copy.
			expect(existsSync(join(repo, "planted/.git/hooks/pre-commit"))).toBe(true);
			expect(await bash("git -C planted status --short && echo ok")).not.toContain("planted: ");
		});

		// fork: the index no longer lists it, a commit still does.
		it("publishes no commit that holds as a submodule a repository the command made that runs programs", async () => {
			const id = IDENTITY.join(" ");
			const output = await bash(
				[
					"git init -q -b main tools/evil",
					`git -C tools/evil ${id} commit -q --allow-empty -m e`,
					"git add tools/evil",
					`git ${id} commit -qm add`,
					"git rm -q --cached tools/evil",
					`git ${id} commit -qm gone`,
					"git -C tools/evil config core.fsmonitor ./x",
					"echo made",
				].join(" && "),
			);
			expect(output).toContain("made");
			expect(output).toContain(`this command's Git changes were not applied to ${join(repo, ".git")}`);
			expect(output).toMatch(/adds tools\/evil \(commit [0-9a-f]{40}\) as a submodule/);
			expect(git(repo, "log", "-1", "--format=%s")).toBe("initial");
			// Without the planted configuration, the same commits are published.
			const clean = await bash(
				[
					"git init -q -b main tools/fine",
					`git -C tools/fine ${id} commit -q --allow-empty -m f`,
					"git add tools/fine",
					`git ${id} commit -qm add`,
					"git rm -q --cached tools/fine",
					`git ${id} commit -qm gone`,
				].join(" && "),
			);
			expect(clean).not.toContain("not applied");
			expect(git(repo, "log", "-1", "--format=%s")).toBe("gone");
		});

		it("stays silent for an ordinary clone and init made by the command", async () => {
			const output = await bash(
				`git clone -q "${join(repo, "vendor/lib")}" copy && git -C copy ${IDENTITY.join(" ")} commit -q --allow-empty -m next && git init -q fresh && echo done`,
			);
			expect(output).toContain("done");
			expect(output).not.toContain("Prism:");
		});

		it("still reports a hook in the Git folder of a new repository's submodule", async () => {
			const output = await bash(
				`git init -q outer && mkdir outer/sub outer/.git/modules && git init -q --separate-git-dir outer/.git/modules/sub outer/sub && ${plant("outer/.git/modules/sub")}`,
			);
			expect(output).toContain(`hook ${join(repo, "outer/.git/modules/sub/hooks/pre-commit")}`);
		});

		it("reports a nested repository whose .git the command replaced", async () => {
			// The private copy is mounted on vendor/lib/.git: the folder around it can still be moved away.
			const output = await bash(`mv vendor/lib vendor/old && git init -q vendor/lib && ${plant("vendor/lib/.git")}`);
			expect(output).toContain(`hook ${join(repo, "vendor/lib/.git/hooks/pre-commit")}`);
		});

		it("reports a .git link the command made", async () => {
			mkdirSync(join(repo, "store"));
			const output = await bash(
				`git init -q --bare store/x.git >/dev/null; mkdir evil && ln -s ../store/x.git evil/.git && ${plant("store/x.git")}`,
			);
			expect(output).toContain(`${join(repo, "evil/.git")} is a link`);
			expect(output).toContain(`hook ${join(repo, "store/x.git/hooks/pre-commit")}`);
		});

		it("reports, at the next command, a repository an interrupted command left", async () => {
			expect(await bash("true")).not.toContain("Prism:");
			// What a command killed before its check would leave: Prism saw no check of it.
			git(repo, "init", "-q", "left");
			execFileSync("sh", ["-c", plant(join(repo, "left/.git"))]);
			const output = await bash("true");
			expect(output).toContain(`hook ${join(repo, "left/.git/hooks/pre-commit")}`);
			// Reported once.
			expect(await bash("true")).not.toContain("Prism:");
		});

		it("reports at the next command a repository a background task made", async () => {
			expect(await bash("true")).not.toContain("Prism:");
			// A background task outlives the command that started it; nothing checks after it, Prism may be gone.
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("background", {
						action: "run",
						command: `git init -q late && ${plant("late/.git")} && touch late-done`,
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("go");
			const deadline = Date.now() + 8_000;
			while (!existsSync(join(repo, "late-done")) && Date.now() < deadline)
				await new Promise((resolve) => setTimeout(resolve, 50));
			expect(existsSync(join(repo, "late-done"))).toBe(true);
			expect(await bash("true")).toContain(`hook ${join(repo, "late/.git/hooks/pre-commit")}`);
			expect(await bash("true")).not.toContain("Prism:");
		});

		it("covers a nested repository's submodule with that repository's copy", async () => {
			const lib = join(repo, "vendor/lib");
			const deep = mkdtempSync(join(tmpdir(), "prism-nested-deep-"));
			try {
				git(deep, "init", "-q", "-b", "main");
				git(deep, "commit", "-q", "--allow-empty", "-m", "deep");
				git(lib, "-c", "protocol.file.allow=always", "submodule", "add", "-q", deep, "deep");
				git(lib, "commit", "-qm", "deep");
			} finally {
				rmSync(deep, { recursive: true, force: true });
			}
			const output = await bash(`git -C vendor/lib/deep ${IDENTITY.join(" ")} commit -q --allow-empty -m inner`);
			expect(output).not.toContain("Prism:");
			expect(git(join(lib, "deep"), "log", "-1", "--format=%s")).toBe("inner");
			expect(readdirSync(join(agentDir, "sandbox", "git-copies")).filter((name) => !name.endsWith(".old"))).toEqual(
				[],
			);
		});
	});

	// Review of the modules the Codex review did not read: after each command, the Produced tab of /files
	// runs `git status` on the host. Git checks a submodule's working tree with that submodule's own configuration,
	// which a command can write in a repository it makes; `.gitmodules` (`ignore = none`) overrides a configured
	// `diff.ignoreSubmodules`, so only the command-line option keeps Git out of it.
	it("runs no filter of a submodule the command made when Prism lists the files it produced", async () => {
		writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode: "broad" }));
		const harness = await createHarness({
			extensionFactories: [
				{ name: "permissions", factory: permissionsExtension },
				{ name: "files", factory: fileBrowser },
			],
		});
		try {
			const repo = harness.tempDir;
			// A repository before the session starts: the Produced tab watches it from then on.
			git(repo, "init", "-q", "-b", "main");
			git(repo, "commit", "-q", "--allow-empty", "-m", "initial");
			await harness.session.bindExtensions({
				uiContext: createTestUiContext({
					select: async (_title, options) => options.find((option) => option.startsWith("Allow")),
				}),
			});
			const filter = `printf '#!/bin/sh\\ntouch ${marker}\\ncat\\n' > filter.sh && chmod +x filter.sh`;
			const setup = [
				filter,
				`git init -q -b main nested`,
				`echo a > nested/f`,
				`git -C nested add f`,
				`git -C nested ${IDENTITY.join(" ")} commit -qm n`,
				`git -C nested config filter.x.clean "${join(repo, "filter.sh")}"`,
				`echo '* filter=x' > nested/.gitattributes`,
				`git add nested`,
				`printf '[submodule "nested"]\\n\\tpath = nested\\n\\turl = ./nested\\n\\tignore = none\\n' > .gitmodules`,
				`touch -d 2001-01-01 nested/f`,
				`echo made`,
			].join(" && ");
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("bash", { command: setup }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("go");
			const output = getToolResult(harness, "bash")
				.content.map((part) => (part.type === "text" ? part.text : ""))
				.join("");
			expect(output).toContain("made");
			// The marker is in the agent's folder, which the sandbox cannot write: only a program run on the host makes it.
			expect(existsSync(marker)).toBe(false);
		} finally {
			removeSessionTmpDir(harness.sessionManager.getSessionId());
			harness.cleanup();
		}
	});

	describe("layouts", () => {
		let root: string;

		beforeEach(() => {
			root = mkdtempSync(join(tmpdir(), "prism-nested-"));
			repo = join(root, "project");
			git(root, "init", "-q", "-b", "main", repo);
			git(repo, "commit", "-q", "--allow-empty", "-m", "initial");
		});

		afterEach(() => rmSync(root, { recursive: true, force: true }));

		const layout = (allowWrite: string[] = []): SandboxLayout =>
			buildLayout({ cwd: repo, home: root, agentDir, settings: { ...SETTINGS, allowWrite } });
		function run(plan: SandboxLayout, script: string) {
			prepareLayout(plan);
			const args = bwrapArgs(plan, (path) => statSync(path).isDirectory(), join(agentDir, "unreadable"));
			return spawnSync(bwrap!, [...args, "--", "/bin/sh", "-c", script], {
				cwd: repo,
				env: { ...env, HOME: root },
				encoding: "utf8",
				timeout: 15_000,
			});
		}

		it("protects a nested bare repository and a repository in allowWrite without a copy", () => {
			git(repo, "init", "-q", "--bare", "server.git");
			const shared = join(root, "shared");
			git(root, "init", "-q", join(shared, "deep/other"));
			const result = run(layout([shared]), `${plant("server.git")}; ${plant(`${shared}/deep/other/.git`)}`);
			expect(result.stderr.match(/Read-only file system/g)).toHaveLength(2);
			expect(hostCommitRunsHook(join(shared, "deep/other"))).toBe(false);
		});

		it("does not follow a link out of the searched folders", () => {
			const outside = join(root, "outside");
			git(root, "init", "-q", join(outside, "repo"));
			symlinkSync(outside, join(repo, "linked"));
			expect(Object.keys(layout().repositories!.known)).toEqual([repo]);
		});

		it("finds a repository made on the host between two layouts, also within the same second", () => {
			expect(Object.keys(layout().repositories!.known)).toEqual([repo]);
			git(repo, "init", "-q", "made/now");
			expect(Object.keys(layout().repositories!.known).sort()).toEqual([repo, join(repo, "made/now")]);
			expect(layout().readOnly).toContain(join(repo, "made/now/.git/hooks"));
		});

		it("stays silent for a linked worktree or a submodule of a covered repository", () => {
			const first = layout();
			const deep = join(root, "deep");
			git(root, "init", "-q", "-b", "main", deep);
			git(deep, "commit", "-q", "--allow-empty", "-m", "deep");
			// Both leave a `.git` file naming a folder in the project's Git folder.
			git(repo, "worktree", "add", "-q", join(repo, "wt"));
			git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", deep, "sub");
			expect(checkNewRepositories(first.repositories!)?.note).toBeUndefined();
		});

		it("does not look into a Git folder outside the project that a .git file names (owner's option 2)", () => {
			const outside = join(root, "outside");
			git(root, "init", "-q", outside);
			git(outside, "config", "core.fsmonitor", "/bin/secret-name");
			execFileSync("sh", ["-c", plant(join(outside, ".git"))]);
			symlinkSync(outside, join(repo, "linked"));
			const first = layout();
			for (const [folder, pointer] of [
				["direct", join(outside, ".git")],
				// By its real path: a link in the project does not bring the Git folder in.
				["through-link", join(repo, "linked", ".git")],
			]) {
				mkdirSync(join(repo, folder!));
				writeFileSync(join(repo, folder!, ".git"), `gitdir: ${pointer}\n`);
			}
			const report = checkNewRepositories(first.repositories!)?.note;
			for (const folder of ["direct", "through-link"])
				expect(report).toContain(
					`${join(repo, folder, ".git")} points outside the project and the writable folders; Prism did not look there`,
				);
			for (const leak of ["fsmonitor", "secret-name", "pre-commit", outside]) expect(report).not.toContain(leak);
		});

		it("still looks into a Git folder a .git file names in the project or a writable folder", () => {
			const shared = join(root, "shared");
			mkdirSync(shared);
			const first = layout([shared]);
			for (const [folder, store] of [
				[join(repo, "pointed"), join(repo, "store.git")],
				[join(repo, "shared-pointed"), join(shared, "store.git")],
			]) {
				git(root, "init", "-q", "--separate-git-dir", store!, folder!);
				execFileSync("sh", ["-c", plant(store!)]);
			}
			const report = checkNewRepositories(first.repositories!)?.note;
			expect(report).toContain(`hook ${join(repo, "store.git/hooks/pre-commit")}`);
			expect(report).toContain(`hook ${join(shared, "store.git/hooks/pre-commit")}`);
		});

		it("stays silent for a new worktree of a project that is itself a linked worktree of a repository outside it", () => {
			const main = join(root, "main");
			git(root, "init", "-q", "-b", "main", main);
			git(main, "commit", "-q", "--allow-empty", "-m", "main");
			git(main, "worktree", "add", "-q", "-b", "side", join(root, "side"));
			repo = join(root, "side");
			const first = layout();
			git(repo, "worktree", "add", "-q", "-b", "inner", join(repo, "inner"));
			expect(checkNewRepositories(first.repositories!)?.note).toBeUndefined();
		});

		// fork: the report reached only the command's output, which the model reads.
		it("keeps what it reported for the user's warning, once, and for /sandbox", () => {
			takeUnseenRepositories();
			const first = layout();
			git(repo, "init", "-q", "made");
			execFileSync("sh", ["-c", plant(join(repo, "made/.git"))]);
			expect(checkNewRepositories(first.repositories!)?.folders).toEqual([join(repo, "made")]);
			expect(takeUnseenRepositories()).toEqual([join(repo, "made")]);
			expect(takeUnseenRepositories()).toEqual([]);
			const reported = reportedRepositories().find(({ folder }) => folder === join(repo, "made"));
			expect(reported?.reasons).toContain("pre-commit");
			const lines = describeSandbox({
				mode: "ask",
				active: true,
				settings: DEFAULT_SANDBOX_SETTINGS,
				repositories: reportedRepositories(),
				settingsPath: "/settings.json",
			});
			expect(lines.join("\n")).toContain(`Git repositories that would run programs`);
			expect(lines.join("\n")).toMatch(/made \(hook .*pre-commit/);
		});

		it("checks a repository made after the layout, even when another check saw it first", () => {
			checkNewRepositories(layout().repositories!);
			// A command starts; meanwhile another one makes a repository and its check finds nothing to report.
			const first = layout();
			git(repo, "init", "-q", "late");
			expect(checkNewRepositories(layout().repositories!)?.note).toBeUndefined();
			// The first command, which the repository was not protected from, plants a hook there.
			execFileSync("sh", ["-c", plant(join(repo, "late/.git"))]);
			expect(checkNewRepositories(first.repositories!)?.note).toContain(
				`hook ${join(repo, "late/.git/hooks/pre-commit")}`,
			);
		});
	});
});
