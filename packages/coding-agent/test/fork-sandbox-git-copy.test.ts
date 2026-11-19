// fork: sandboxed commands work in a private copy of the Git metadata, whose
// changes are validated and published after the command. Real bubblewrap, real Git, disposable repositories.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import backgroundExtension from "../src/fork/background.ts";
import permissionsExtension from "../src/fork/permissions.ts";
import { findBwrap, removeSessionTmpDir } from "../src/fork/sandbox/runtime.ts";
import { createHarness, createTestUiContext, getToolResult, type Harness } from "./suite/harness.ts";

const bwrap = findBwrap();

describe.skipIf(!bwrap)("fork: Git in a private copy of its metadata", () => {
	let agentDir: string;
	let home: string;
	let harness: Harness;
	let repo: string;
	/** The answer to the question about remotes and identity (H4), and the questions asked. */
	let gitAnswer: string | undefined;
	let questions: string[];
	const env = {
		PATH: process.env.PATH,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
	};

	const git = (...args: string[]) =>
		execFileSync("git", ["-C", repo, ...args], { env: { ...env, HOME: repo }, encoding: "utf8" }).trim();

	beforeEach(async () => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-git-copy-agent-"));
		home = mkdtempSync(join(tmpdir(), "prism-git-copy-home-"));
		vi.stubEnv("HOME", home);
		vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) vi.stubEnv(key, undefined);
		for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
		writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode: "broad" }));
		harness = await createHarness({
			extensionFactories: [
				{ name: "permissions", factory: permissionsExtension },
				{ name: "background", factory: backgroundExtension },
			],
		});
		gitAnswer = "Apply these Git changes";
		questions = [];
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				select: async (title, options) => {
					questions.push(title);
					return options.find((option) => option.startsWith("Allow") || option === gitAnswer);
				},
			}),
		});
		repo = harness.tempDir;
		git("init", "-q", "-b", "main");
		git("config", "user.name", "Sandbox Test");
		git("config", "user.email", "sandbox@example.invalid");
		writeFileSync(join(repo, "a.txt"), "a\n");
		git("add", "a.txt");
		git("commit", "-qm", "initial");
	});

	afterEach(() => {
		removeSessionTmpDir(harness.sessionManager.getSessionId());
		harness.cleanup();
		vi.unstubAllEnvs();
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
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
	async function background(command: string): Promise<void> {
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("background", { action: "run", command }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
	}
	async function waitFor(condition: () => boolean) {
		const deadline = Date.now() + 10_000;
		while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
		expect(condition()).toBe(true);
	}
	const taskLog = () => {
		const folder = join(agentDir, "bg");
		const name = readdirSync(folder).find((entry) => entry.endsWith(".log"));
		return name ? readFileSync(join(folder, name), "utf8") : "";
	};
	const copies = () => {
		const folder = join(agentDir, "sandbox", "git-copies");
		// A published copy is renamed `.old`, then removed after the command's result.
		return existsSync(folder) ? readdirSync(folder).filter((name) => !name.endsWith(".old")) : [];
	};
	const locks = () =>
		execFileSync("find", [join(repo, ".git"), "-name", "*.lock"], { encoding: "utf8" })
			.trim()
			.split("\n")
			.filter(Boolean);

	// fork: a remote redirected in the sandbox would send the code elsewhere at the
	// user's next push, outside Prism; refused, the real configuration stays as it was.
	it("does not publish a redirected remote or a forced push refspec the user did not allow", async () => {
		git("remote", "add", "origin", "https://example.invalid/repo.git");
		gitAnswer = "Do not apply them";
		const output = await bash(
			"git remote set-url origin https://attacker.invalid/x.git && git config --add remote.origin.push '+refs/heads/*:refs/heads/*' && echo b > b.txt && git add b.txt && git commit -qm second",
		);
		const question = questions.find((title) => title.includes("Git configuration"));
		expect(question).toContain(
			"remote.origin.url: https://example.invalid/repo.git → https://attacker.invalid/x.git",
		);
		expect(question).toContain("remote.origin.push: (unset) → +refs/heads/*:refs/heads/*");
		expect(output).toContain("the user did not allow these Git configuration changes");
		expect(git("config", "remote.origin.url")).toBe("https://example.invalid/repo.git");
		expect(() => git("config", "remote.origin.push")).toThrow();
		// Nothing of that command is published: its commit waits with the kept copy.
		expect(git("log", "--format=%s")).toBe("initial");
	});

	it("publishes commits, branches, tags, the index and ordinary configuration", async () => {
		const output = await bash(
			[
				"echo b > b.txt && git add b.txt && git commit -qm second",
				"git branch -q feature && git tag -a v1 -m v1",
				"git remote add origin https://example.invalid/repo.git && git config branch.main.remote origin",
				"git config branch.main.merge refs/heads/main && echo b2 >> b.txt && git add b.txt",
				"git status --short",
			].join(" && "),
		);
		expect(output).toContain("M  b.txt");
		expect(output).not.toContain("Prism:");
		expect(git("log", "--format=%s")).toBe("second\ninitial");
		expect(git("rev-parse", "feature")).toBe(git("rev-parse", "main"));
		expect(git("cat-file", "-t", "v1")).toBe("tag");
		expect(git("config", "remote.origin.url")).toBe("https://example.invalid/repo.git");
		// fork: applied once the user allowed it, with the exact change shown.
		expect(questions.join("\n")).toContain("remote.origin.url: (unset) → https://example.invalid/repo.git");
		expect(git("status", "--short")).toBe("M  b.txt");
		git("fsck", "--strict", "--no-progress");
		expect(copies()).toEqual([]);
		expect(locks()).toEqual([]);
	});

	it("publishes a background task's Git changes when it ends, not before", async () => {
		await background(
			"git commit -q --allow-empty -m background && touch committed && while [ ! -e go ]; do sleep 0.05; done",
		);
		await waitFor(() => existsSync(join(repo, "committed")));
		expect(git("log", "-1", "--format=%s")).toBe("initial");
		writeFileSync(join(repo, "go"), "");
		await waitFor(() => git("log", "-1", "--format=%s") === "background");
		await waitFor(() => copies().length === 0);
		expect(taskLog()).not.toContain("Prism:");
		expect(locks()).toEqual([]);
	});

	it("keeps a background task's Git changes when the host moved its branch meanwhile, and says so in its log", async () => {
		await background(
			"git commit -q --allow-empty -m background && touch committed && while [ ! -e go ]; do sleep 0.05; done",
		);
		await waitFor(() => existsSync(join(repo, "committed")));
		expect(await bash("git commit -q --allow-empty -m foreground")).not.toContain("Prism:");
		// Only once the foreground commit is published: a task that ended sooner would publish first, under load.
		writeFileSync(join(repo, "go"), "");
		await waitFor(() => taskLog().includes("Prism:"));
		expect(taskLog()).toContain(`this command's Git changes were not applied to ${join(repo, ".git")}`);
		expect(git("log", "--format=%s")).toBe("foreground\ninitial");
		const [kept] = copies();
		expect(
			execFileSync(
				"git",
				["--git-dir", join(agentDir, "sandbox", "git-copies", kept!, "metadata"), "log", "-1", "--format=%s"],
				{
					env: { ...env, HOME: repo },
					encoding: "utf8",
				},
			).trim(),
		).toBe("background");
		expect(locks()).toEqual([]);
	});

	it("refuses a background task's hook when it ends, and says so in its log", async () => {
		await background("printf '#!/bin/sh\\n' > .git/hooks/pre-commit");
		await waitFor(() => taskLog().includes("Prism:"));
		expect(taskLog()).toContain(`this command's Git changes were not applied to ${join(repo, ".git")}`);
		expect(existsSync(join(repo, ".git", "hooks", "pre-commit"))).toBe(false);
	});

	it("copies a repository Prism protected before, and still refuses a linked worktree's commondir", async () => {
		// The reserve `prepareLayout` writes in a repository the earlier protection covered: at the session's first
		// probe when the repository existed, and at each background command.
		writeFileSync(join(repo, ".git", "commondir"), ".\n");
		const output = await bash(
			"git commit -q --allow-empty -m second && printf '#!/bin/sh\\n' > .git/hooks/pre-commit && echo written",
		);
		expect(output).toContain("written");
		expect(output).toContain(`this command's Git changes were not applied to ${join(repo, ".git")}`);
		expect(existsSync(join(repo, ".git", "hooks", "pre-commit"))).toBe(false);
		expect(await bash("git commit -q --allow-empty -m third")).not.toContain("Prism:");
		expect(git("log", "-1", "--format=%s")).toBe("third");
		expect(readFileSync(join(repo, ".git", "commondir"), "utf8")).toBe(".\n");
		// Any other content, as a linked worktree's, keeps the earlier protection.
		writeFileSync(join(repo, ".git", "commondir"), "./\n");
		expect(await bash("git status >/dev/null; printf '#!/bin/sh\\n' > .git/hooks/pre-commit")).toContain(
			"Read-only file system",
		);
	});

	it("resolves a rebase conflict over two commands, and carries a stash from one to the next", async () => {
		git("checkout", "-qb", "topic");
		writeFileSync(join(repo, "a.txt"), "topic\n");
		git("commit", "-qam", "topic");
		git("checkout", "-q", "main");
		writeFileSync(join(repo, "a.txt"), "main\n");
		git("commit", "-qam", "main");
		git("checkout", "-q", "topic");

		expect(await bash("git rebase main; git status --short")).toContain("UU a.txt");
		expect(existsSync(join(repo, ".git", "rebase-merge"))).toBe(true);
		const resolved = await bash("echo both > a.txt && git add a.txt && GIT_EDITOR=true git rebase --continue");
		expect(resolved).not.toContain("Prism:");
		expect(git("log", "--format=%s")).toBe("topic\nmain\ninitial");
		expect(existsSync(join(repo, ".git", "rebase-merge"))).toBe(false);

		await bash("echo wip > wip.txt && git stash push -qu -m wip");
		expect(existsSync(join(repo, "wip.txt"))).toBe(false);
		expect(git("stash", "list")).toContain("wip");
		await bash("git stash pop -q");
		expect(readFileSync(join(repo, "wip.txt"), "utf8")).toBe("wip\n");
		expect(git("stash", "list")).toBe("");
		git("fsck", "--strict", "--no-progress");
	});

	it("publishes a fetched pack once Git checked it in a sandbox of its own", async () => {
		const remote = join(repo, "remote.git");
		execFileSync("git", ["clone", "-q", "--bare", repo, remote], { env });
		const work = mkdtempSync(join(tmpdir(), "prism-git-copy-work-"));
		try {
			execFileSync("git", ["clone", "-q", remote, work], { env });
			for (const n of [1, 2, 3]) {
				writeFileSync(join(work, `f${n}`), `${n}\n`);
				execFileSync("git", ["-C", work, "add", "."], { env });
				execFileSync("git", ["-C", work, "-c", "user.name=x", "-c", "user.email=x@x", "commit", "-qm", `f${n}`], {
					env,
				});
			}
			execFileSync("git", ["-C", work, "push", "-q", "origin", "main"], { env });
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
		const output = await bash(
			`git remote add up ${remote} && git -c fetch.unpackLimit=1 fetch -q up && ls .git/objects/pack | grep -c '\\.pack$'`,
		);
		expect(output).not.toContain("Prism:");
		expect(git("log", "--format=%s", "up/main")).toBe("f3\nf2\nf1\ninitial");
		expect(readdirSync(join(repo, ".git", "objects", "pack")).filter((name) => name.endsWith(".pack"))).toHaveLength(
			1,
		);
		git("fsck", "--strict", "--no-progress");
	});

	it("keeps the private state when a change is refused, and leaves the real repository as it was", async () => {
		const head = git("rev-parse", "HEAD");
		const marker = join(agentDir, "fsmonitor-ran");
		const output = await bash(
			`git config core.fsmonitor 'touch ${marker}; false' && git commit -q --allow-empty -m kept && echo DONE`,
		);
		expect(output).toContain("DONE");
		expect(output).toContain("Git changes were not applied");
		expect(output).toContain("core.fsmonitor");
		expect(git("rev-parse", "HEAD")).toBe(head);
		expect(readFileSync(join(repo, ".git", "config"), "utf8")).not.toContain("fsmonitor");
		git("status", "--short");
		expect(existsSync(marker)).toBe(false);
		// The commit is not lost: it is in the kept copy, with the objects it borrows from the real folder.
		const [kept] = copies();
		const metadata = join(agentDir, "sandbox", "git-copies", kept!, "metadata");
		expect(
			execFileSync("git", ["--git-dir", metadata, "log", "-1", "--format=%s"], { env, encoding: "utf8" }).trim(),
		).toBe("kept");
	});

	it("keeps a copy whose alternates the command replaced by a link without writing through it", async () => {
		const victim = join(agentDir, "victim");
		writeFileSync(victim, "untouched\n");
		const output = await bash(`rm .git/objects/info/alternates && ln -s ${victim} .git/objects/info/alternates`);
		expect(output).toContain("Git changes were not applied");
		expect(readFileSync(victim, "utf8")).toBe("untouched\n");
		// The same through a folder: Prism would have made `alternates` in the folder the link names.
		const folder = join(agentDir, "victim-folder");
		mkdirSync(folder);
		const linked = await bash(`rm -r .git/objects/info && ln -s ${folder} .git/objects/info`);
		expect(linked).toContain("Git changes were not applied");
		expect(readdirSync(folder)).toEqual([]);
	});

	it("says that explicit Git maintenance must run outside Prism, and publishes none of it", async () => {
		git("branch", "-q", "other");
		const refs = () => readdirSync(join(repo, ".git", "refs", "heads")).sort();
		const packs = () => readdirSync(join(repo, ".git", "objects", "pack"));
		for (const command of ["git gc -q", "git maintenance run", "git repack -a -d -q -n"]) {
			const output = await bash(`${command} && echo DONE`);
			expect(output).toContain("DONE");
			expect(output).toContain("Git changes were not applied");
			expect(output).toContain("is Git maintenance");
			expect(output).toContain("run it outside Prism");
			expect(refs()).toEqual(["main", "other"]);
			expect(packs()).toEqual([]);
		}
		// Ordinary work afterwards is published as usual.
		expect(await bash("git commit -q --allow-empty -m after")).not.toContain("Prism:");
		expect(git("log", "-1", "--format=%s")).toBe("after");
	});

	it("refuses to publish over a branch the host moved during the command", async () => {
		const host = setTimeout(() => git("commit", "-q", "--allow-empty", "-m", "host"), 600);
		const output = await bash("git commit -q --allow-empty -m sandbox && sleep 2");
		clearTimeout(host);
		expect(output).toContain("Git changes were not applied");
		expect(git("log", "-1", "--format=%s")).toBe("host");
		expect(copies()).toHaveLength(1);
		expect(locks()).toEqual([]);
	});

	it("adds a linked worktree and commits in it and in the main one", async () => {
		const output = await bash(
			"git worktree add -q -b side side && cd side && echo s > s.txt && git add s.txt && git commit -qm side",
		);
		expect(output).not.toContain("Prism:");
		expect(git("log", "-1", "--format=%s", "refs/heads/side")).toBe("side");
		expect(git("worktree", "list", "--porcelain")).toContain(`worktree ${join(repo, "side")}`);
		// From inside the worktree, next command: its .git file names the registration, now in the copy.
		const inside = await bash("cd side && echo t >> s.txt && git commit -qam more && git status --short");
		expect(inside).not.toContain("Prism:");
		expect(git("log", "-1", "--format=%s", "refs/heads/side")).toBe("more");
		expect(await bash("git commit -q --allow-empty -m main-again")).not.toContain("Prism:");
		expect(git("log", "-1", "--format=%s", "refs/heads/main")).toBe("main-again");
		execFileSync("git", ["-C", join(repo, "side"), "status", "--short"], { env });
		git("fsck", "--strict", "--no-progress");
		expect(copies()).toEqual([]);
	});

	it("refuses a worktree registration that names a .git file of another repository", async () => {
		const output = await bash(
			[
				"mkdir -p fake/.git-real && git init -q --bare fake/.git-real",
				"mkdir -p .git/worktrees/evil && echo ../.. > .git/worktrees/evil/commondir",
				"echo ref: refs/heads/main > .git/worktrees/evil/HEAD",
				`echo ${join(repo, "fake", ".git")} > .git/worktrees/evil/gitdir`,
				`echo gitdir: ${join(repo, "fake", ".git-real")} > fake/.git`,
				"echo '[core]' > .git/worktrees/evil/config.worktree",
			].join(" && "),
		);
		expect(output).toContain("Git changes were not applied");
		expect(output).toContain("worktrees/evil/gitdir names");
		expect(output).toContain("worktrees/evil/config.worktree is a worktree's own configuration");
		expect(existsSync(join(repo, ".git", "worktrees"))).toBe(false);
	});

	describe("core.hooksPath in the working tree (Q-G2)", () => {
		const hook = "#!/bin/sh\necho ran > hook-marker\n";
		beforeEach(() => {
			// Husky 9's layout: its install sets a relative hooks folder, which a push would look for in .git too.
			mkdirSync(join(repo, ".husky", "_"), { recursive: true });
			writeFileSync(join(repo, ".husky", "_", "pre-commit"), hook, { mode: 0o755 });
			git("config", "core.hooksPath", ".husky/_");
		});

		it("runs the hooks, and keeps what the command writes to them private", async () => {
			const output = await bash(
				[
					"git commit -q --allow-empty -m hooked && cat hook-marker",
					"echo 'exit 1' > .husky/_/pre-commit && echo x > .husky/_/added && echo rewritten",
				].join(" && "),
			);
			expect(output).toContain("ran");
			expect(output).toContain("rewritten");
			expect(output).not.toContain("Prism:");
			expect(git("log", "-1", "--format=%s")).toBe("hooked");
			expect(readFileSync(join(repo, ".husky", "_", "pre-commit"), "utf8")).toBe(hook);
			expect(existsSync(join(repo, ".husky", "_", "added"))).toBe(false);
			// The next command starts from the real hooks again.
			rmSync(join(repo, "hook-marker"));
			expect(await bash("git commit -q --allow-empty -m again && cat hook-marker")).toContain("ran");
			expect(copies()).toEqual([]);
		});

		it("publishes no hook planted where a push would look for them", async () => {
			const output = await bash("mkdir -p .git/.husky/_ && echo x > .git/.husky/_/pre-receive && echo planted");
			expect(output).toContain("planted");
			expect(output).toContain(`this command's Git changes were not applied to ${join(repo, ".git")}`);
			expect(output).toContain(".husky/_/pre-receive");
			expect(existsSync(join(repo, ".git", ".husky"))).toBe(false);
		});
	});

	it("keeps a hooks folder that holds the project read-only (core.hooksPath=.)", async () => {
		git("config", "core.hooksPath", ".");
		const output = await bash("git commit -q --allow-empty -m root-hooks");
		expect(output).toContain("Read-only file system");
		expect(git("log", "-1", "--format=%s")).toBe("initial");
	});

	describe("submodules", () => {
		// A submodule `lib` whose own submodule is `deep`, added from throwaway repositories.
		beforeEach(() => {
			const made = (name: string) => {
				const path = mkdtempSync(join(tmpdir(), `prism-git-copy-${name}-`));
				execFileSync("git", ["init", "-q", "-b", "main", path], { env });
				execFileSync(
					"git",
					["-C", path, "-c", "user.name=x", "-c", "user.email=x@x", "commit", "-q", "--allow-empty", "-m", name],
					{ env },
				);
				return path;
			};
			const deep = made("deep");
			const library = made("lib");
			try {
				const add = (cwd: string, url: string, path: string) =>
					execFileSync(
						"git",
						["-C", cwd, "-c", "protocol.file.allow=always", "submodule", "add", "-q", url, path],
						{ env: { ...env, HOME: repo } },
					);
				add(library, deep, "deep");
				execFileSync("git", ["-C", library, "-c", "user.name=x", "-c", "user.email=x@x", "commit", "-qm", "deep"], {
					env,
				});
				git("-c", "protocol.file.allow=always", "submodule", "add", "-q", library, "lib");
				git("-c", "protocol.file.allow=always", "submodule", "update", "-q", "--init", "--recursive");
				git("commit", "-qm", "lib");
			} finally {
				rmSync(library, { recursive: true, force: true });
				rmSync(deep, { recursive: true, force: true });
			}
		});
		const sub = (path: string, ...args: string[]) =>
			execFileSync("git", ["-C", join(repo, path), ...args], {
				env: { ...env, HOME: repo },
				encoding: "utf8",
			}).trim();

		it("does not blame submodule metadata for an unrelated permission denial", async () => {
			const output = await bash(`echo written > .git/description; cat ${agentDir}/permissions.json`);
			expect(output).toContain("Permission denied");
			expect(output).not.toContain("submodule Git metadata");
		});

		it("commits in a submodule and in its own, and records them in the repository", async () => {
			const output = await bash(
				[
					// The identity is in the repository's configuration, not in its submodules'.
					"export GIT_AUTHOR_NAME=x GIT_AUTHOR_EMAIL=x@x GIT_COMMITTER_NAME=x GIT_COMMITTER_EMAIL=x@x",
					"cd lib/deep && echo d > d.txt && git add d.txt && git commit -qm in-deep && cd ..",
					"git add deep && git commit -qm in-lib && cd ..",
					"git add lib && git commit -qm in-repo && git status --short",
				].join(" && "),
			);
			expect(output).not.toContain("Prism:");
			expect(output).not.toContain("Read-only");
			expect(output).not.toContain("submodule Git metadata");
			expect(sub("lib/deep", "log", "-1", "--format=%s")).toBe("in-deep");
			expect(sub("lib", "log", "-1", "--format=%s")).toBe("in-lib");
			expect(git("log", "-1", "--format=%s")).toBe("in-repo");
			expect(git("status", "--short")).toBe("");
			for (const path of [".", "lib", "lib/deep"]) sub(path, "fsck", "--strict", "--no-progress");
			expect(copies()).toEqual([]);
		});

		it("publishes no hook or configuration a command writes in a submodule's Git folder", async () => {
			const output = await bash(
				"echo x > .git/modules/lib/hooks/post-commit && git -C lib config core.fsmonitor 'touch /x' && echo written",
			);
			expect(output).toContain("written");
			expect(output).toContain(
				`this command's Git changes were not applied to ${join(repo, ".git", "modules", "lib")}`,
			);
			expect(existsSync(join(repo, ".git", "modules", "lib", "hooks", "post-commit"))).toBe(false);
			expect(() => sub("lib", "config", "core.fsmonitor")).toThrow();
		});

		it("keeps the earlier protection when a submodule cannot be copied", async () => {
			const objects = join(repo, ".git", "modules", "lib", "objects");
			writeFileSync(join(objects, "info", "alternates"), `${objects}\n`);
			const output = await bash("echo x > .git/hooks/pre-commit");
			expect(output).toContain("Read-only file system");
			expect(output).toContain("submodule Git metadata");
			expect(existsSync(join(repo, ".git", "hooks", "pre-commit"))).toBe(false);
			expect(copies()).toEqual([]);
		});
	});
});
