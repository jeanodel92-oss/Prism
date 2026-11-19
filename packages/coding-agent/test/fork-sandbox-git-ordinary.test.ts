// fork: ordinary Git workflows through the real sandbox and the private copy of the Git metadata, as a model
// runs them, one bash call each. Real bubblewrap, real Git, disposable repositories and home.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import permissionsExtension from "../src/fork/permissions.ts";
import { findBwrap, removeSessionTmpDir } from "../src/fork/sandbox/runtime.ts";
import { createHarness, createTestUiContext, getToolResult, type Harness } from "./suite/harness.ts";

const bwrap = findBwrap();

describe.skipIf(!bwrap)("fork: ordinary Git workflows in the sandbox", () => {
	let agentDir: string;
	let home: string;
	let outside: string;
	let harness: Harness;
	let repo: string;
	/** fork (SEC-08): the questions asked, and how the hooks folder question is answered. */
	let questions: string[];
	let hooksAnswer: ((options: string[]) => string | undefined) | undefined;
	const env = {
		PATH: process.env.PATH,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_AUTHOR_NAME: "Sandbox Test",
		GIT_AUTHOR_EMAIL: "sandbox@example.invalid",
		GIT_COMMITTER_NAME: "Sandbox Test",
		GIT_COMMITTER_EMAIL: "sandbox@example.invalid",
	};

	const run = (cwd: string, ...args: string[]) =>
		execFileSync("git", ["-C", cwd, ...args], { env: { ...env, HOME: home }, encoding: "utf8" }).trim();
	const git = (...args: string[]) => run(repo, ...args);
	/** A throwaway repository outside the project, with one commit. */
	const made = (name: string) => {
		const path = join(outside, name);
		run(outside, "init", "-q", "-b", "main", path);
		writeFileSync(join(path, `${name}.txt`), `${name}\n`);
		run(path, "add", ".");
		run(path, "commit", "-qm", name);
		return path;
	};

	beforeEach(async () => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-git-ordinary-agent-"));
		home = mkdtempSync(join(tmpdir(), "prism-git-ordinary-home-"));
		outside = mkdtempSync(join(tmpdir(), "prism-git-ordinary-outside-"));
		vi.stubEnv("HOME", home);
		vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) vi.stubEnv(key, undefined);
		for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
		writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode: "broad" }));
		questions = [];
		hooksAnswer = undefined;
		harness = await createHarness({ extensionFactories: [{ name: "permissions", factory: permissionsExtension }] });
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				select: async (title, options) => {
					questions.push(title);
					return hooksAnswer ? hooksAnswer(options) : options.find((option) => option.startsWith("Allow"));
				},
			}),
		});
		repo = harness.tempDir;
		git("init", "-q", "-b", "main");
		writeFileSync(join(repo, "a.txt"), "a\n");
		git("add", "a.txt");
		git("commit", "-qm", "initial");
	});

	afterEach(() => {
		removeSessionTmpDir(harness.sessionManager.getSessionId());
		harness.cleanup();
		vi.unstubAllEnvs();
		for (const path of [agentDir, home, outside]) rmSync(path, { recursive: true, force: true });
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
	const copies = () => {
		const folder = join(agentDir, "sandbox", "git-copies");
		return existsSync(folder) ? readdirSync(folder).filter((name) => !name.endsWith(".old")) : [];
	};

	/** Two bash calls of one model message, which run at the same time; their outputs in order. */
	async function parallel(first: string, second: string): Promise<string[]> {
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: first }), fauxToolCall("bash", { command: second })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		return harness.session.messages
			.filter((message): message is ToolResultMessage => message.role === "toolResult")
			.slice(-2)
			.map((message) => message.content.map((part) => (part.type === "text" ? part.text : "")).join(""));
	}

	/** Sources in the project: the sandbox reads the project, not the rest of /tmp. */
	const sources = () => {
		outside = join(repo, "upstream");
		mkdirSync(outside, { recursive: true });
		writeFileSync(join(repo, ".git", "info", "exclude"), "upstream/\n");
	};
	const file = "-c protocol.file.allow=always";

	it("adds a submodule, commits it, then commits inside it", async () => {
		sources();
		const lib = made("lib");
		const added = await bash(`git ${file} submodule add -q file://${lib} lib && git commit -qm lib && echo OK`);
		expect(added).toContain("OK");
		expect(added).not.toContain("Prism:");
		expect(git("log", "--format=%s")).toBe("lib\ninitial");
		expect(git("submodule", "status")).toMatch(/^[0-9a-f]{40} lib /);
		expect(run(join(repo, "lib"), "rev-parse", "--git-dir")).toBe(join(repo, ".git", "modules", "lib"));
		expect(existsSync(join(repo, ".git", "modules", "lib", "hooks"))).toBe(false);
		expect(copies()).toEqual([]);

		const inside = await bash("cd lib && echo b > b && git add b && git commit -qm in-lib && echo OK");
		expect(inside).not.toContain("Prism:");
		expect(run(join(repo, "lib"), "log", "--format=%s")).toBe("in-lib\nlib");
		run(join(repo, "lib"), "fsck", "--strict", "--no-progress");
		git("fsck", "--strict", "--no-progress");
	});

	it("initialises a declared submodule, and clones a repository with submodules into the project", async () => {
		sources();
		const lib = made("lib");
		git("-c", "protocol.file.allow=always", "submodule", "add", "-q", `file://${lib}`, "lib");
		git("commit", "-qm", "lib");
		git("submodule", "--quiet", "deinit", "-f", "lib");
		rmSync(join(repo, ".git", "modules"), { recursive: true });
		const init = await bash(`git ${file} submodule update --init -q && git -C lib log --format=%s`);
		expect(init).not.toContain("Prism:");
		expect(init).toContain("lib");
		expect(git("submodule", "status")).toMatch(/^[0-9a-f]{40} lib /);
		expect(copies()).toEqual([]);

		const sup = made("sup");
		run(sup, "-c", "protocol.file.allow=always", "submodule", "add", "-q", `file://${lib}`, "lib");
		run(sup, "commit", "-qm", "with lib");
		const cloned = await bash(`git clone -q file://${sup} work && cd work && git ${file} submodule update --init -q`);
		// A new repository's submodule names its working tree: no false report on `core.worktree`.
		expect(cloned).not.toContain("Prism:");
		expect(run(join(repo, "work", "lib"), "log", "--format=%s")).toBe("lib");
	});

	it("refuses a new submodule's hook, and a working tree it names outside the project", async () => {
		sources();
		const lib = made("lib");
		const hooked = await bash(
			`git ${file} submodule add -q file://${lib} lib && printf '#!/bin/sh\\ntouch ran\\n' > .git/modules/lib/hooks/post-checkout && chmod +x .git/modules/lib/hooks/post-checkout`,
		);
		expect(hooked).toContain("modules/lib/hooks/post-checkout is a Git hook");
		expect(existsSync(join(repo, ".git", "modules", "lib"))).toBe(false);
		expect(copies()).toHaveLength(1);

		rmSync(join(repo, "lib"), { recursive: true, force: true });
		git("rm", "-q", "--cached", "-f", "--ignore-unmatch", "lib");
		rmSync(join(repo, ".gitmodules"), { force: true });
		const away = await bash(
			`git ${file} submodule add -q file://${lib} lib2 && git -C lib2 config core.worktree /etc`,
		);
		expect(away).toContain(
			"modules/lib2/config core.worktree names a working tree outside the folders the sandbox may write",
		);
		expect(existsSync(join(repo, ".git", "modules", "lib2"))).toBe(false);
	});

	it("removes a linked worktree, finishing what the read-only .git file stopped", async () => {
		const added = await bash("git worktree add -q side -b side && echo OK");
		expect(added).toContain("OK");
		expect(added).not.toContain("Prism:");
		expect(git("worktree", "list")).toContain(join(repo, "side"));
		const removed = await bash("git worktree remove side; git worktree list");
		expect(removed).toContain(`Prism: finished removing the linked worktree ${join(repo, "side")}`);
		if (existsSync(join(repo, "side"))) {
			// Git 2.43 (Ubuntu 24.04) stops at the .git file, before the worktree's own files: they are left, and said.
			expect(existsSync(join(repo, "side", ".git"))).toBe(false);
			expect(removed).toContain(`which are still there: rm -r ${join(repo, "side")} removes them.`);
			await bash(`rm -r ${join(repo, "side")}`);
		} else expect(removed).not.toContain("still there");
		expect(existsSync(join(repo, "side"))).toBe(false);
		expect(git("worktree", "list")).not.toContain(join(repo, "side"));
		expect(copies()).toEqual([]);
	});

	it("leaves a worktree's .git file that does not name the removed registration as Git writes it", async () => {
		git("worktree", "add", "-q", "side", "-b", "side");
		// Git reads a relative pointer too; Prism removes only the exact file `git worktree add` wrote.
		writeFileSync(join(repo, "side", ".git"), "gitdir: ../.git/worktrees/side\n");
		const removed = await bash("git worktree remove side; true");
		expect(removed).not.toContain("finished removing");
		expect(existsSync(join(repo, "side", ".git"))).toBe(true);
		expect(git("worktree", "list")).not.toContain(join(repo, "side"));
	});

	it("publishes two parallel Git commands that change different refs", async () => {
		const outputs = await parallel(
			"sleep 0.3; git commit -q --allow-empty -m parallel && echo A",
			"sleep 0.3; git tag t1 && git branch b1 && echo B",
		);
		for (const output of outputs) expect(output).not.toContain("Prism:");
		expect(git("log", "-1", "--format=%s")).toBe("parallel");
		expect(git("rev-parse", "t1")).toBe(git("rev-parse", "b1"));
		expect(copies()).toEqual([]);
		git("fsck", "--strict", "--no-progress");
	});

	it("keeps the second of two parallel commits to the same branch, and says so", async () => {
		const outputs = await parallel(
			"git commit -q --allow-empty -m one && sleep 0.5",
			"sleep 0.2; git commit -q --allow-empty -m two",
		);
		const subject = git("log", "-1", "--format=%s");
		expect(["one", "two"]).toContain(subject);
		expect(git("log", "--format=%s")).toBe(`${subject}\ninitial`);
		const refused = outputs.filter((output) => output.includes("Git changes were not applied"));
		expect(refused).toHaveLength(1);
		expect(refused[0]).toContain("changed on the host during the command");
		expect(copies()).toHaveLength(1);
		expect(readdirSync(join(repo, ".git")).filter((name) => name.endsWith(".lock"))).toEqual([]);
		git("fsck", "--strict", "--no-progress");
	});

	it("sees a same-size change made in the second of the last index write", async () => {
		// Git compares whole seconds: such a change shows only while the index keeps the time Git wrote it.
		writeFileSync(join(repo, "a.txt"), "b\n");
		git("add", "a.txt");
		writeFileSync(join(repo, "a.txt"), "c\n");
		await new Promise((resolve) => setTimeout(resolve, 1_100));
		expect(await bash("git status --short")).toContain("MM a.txt");
		// The same in the command, published a second later: at the start of a second, so all three share it.
		await bash(
			'while [ "$(date +%N)" -gt 300000000 ]; do :; done; echo d > a.txt && git add a.txt && echo e > a.txt; sleep 1.1',
		);
		expect(git("status", "--short")).toContain("MM a.txt");
	});

	it("fetches and pushes over SSH through Prism, and publishes the remote refs", async () => {
		// Prism runs ssh outside the sandbox; this one runs the Git command it is given on this machine, as sshd would.
		const bin = mkdtempSync(join(tmpdir(), "prism-git-ordinary-ssh-"));
		writeFileSync(join(bin, "ssh"), '#!/bin/sh\nfor last; do :; done\nexec sh -c "$last"\n', { mode: 0o755 });
		vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
		try {
			const remote = join(outside, "remote.git");
			run(outside, "init", "-q", "--bare", "-b", "main", remote);
			const upstream = made("upstream");
			run(upstream, "push", "-q", remote, "main");
			git("remote", "add", "origin", `git@example.test:${remote}`);
			const output = await bash(
				"git fetch -q origin && git commit -q --allow-empty -m pushed && git push -q origin HEAD:refs/heads/pushed && echo PUSHED",
			);
			expect(output).toContain("PUSHED");
			expect(output).not.toContain("Prism:");
			expect(git("rev-parse", "refs/remotes/origin/main")).toBe(run(upstream, "rev-parse", "HEAD"));
			expect(run(remote, "rev-parse", "refs/heads/pushed")).toBe(git("rev-parse", "HEAD"));
			expect(git("log", "-1", "--format=%s")).toBe("pushed");
			expect(copies()).toHaveLength(0);
		} finally {
			rmSync(bin, { recursive: true, force: true });
		}
	});

	// A real OpenSSH server and client, end to end. The host's ssh reads the ~/.ssh of the account (not $HOME), so
	// only on a disposable machine whose account has a key the server accepts for PRISM_TEST_REAL_SSHD (a host name,
	// such as localhost) and a known_hosts entry for it; the remote repository is made on this machine.
	it.skipIf(!process.env.PRISM_TEST_REAL_SSHD)(
		"fetches and pushes to a real OpenSSH server through Prism",
		async () => {
			const remote = join(outside, "remote.git");
			run(outside, "init", "-q", "--bare", "-b", "main", remote);
			const upstream = made("upstream");
			run(upstream, "push", "-q", remote, "main");
			git("remote", "add", "origin", `${process.env.PRISM_TEST_REAL_SSHD}:${remote}`);
			const output = await bash(
				"git fetch -q origin && git commit -q --allow-empty -m pushed && git push -q origin HEAD:refs/heads/pushed && echo PUSHED",
			);
			expect(output).toContain("PUSHED");
			expect(output).not.toContain("Prism:");
			expect(git("rev-parse", "refs/remotes/origin/main")).toBe(run(upstream, "rev-parse", "HEAD"));
			expect(run(remote, "rev-parse", "refs/heads/pushed")).toBe(git("rev-parse", "HEAD"));
			expect(copies()).toHaveLength(0);
		},
		60_000,
	);

	it("signs a commit of the copied repository with a key that stays outside the sandbox", async () => {
		const keys = mkdtempSync(join(tmpdir(), "prism-git-ordinary-keys-"));
		try {
			execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "t", "-f", join(keys, "id")]);
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ sandbox: { gitSigning: true, hide: [keys] } }),
			);
			writeFileSync(
				join(keys, "allowed"),
				`sandbox@example.invalid ${execFileSync("cat", [join(keys, "id.pub")], { encoding: "utf8" }).trim()}\n`,
			);
			writeFileSync(
				join(home, ".gitconfig"),
				`[user]\n\tsigningkey = ${join(keys, "id")}\n[gpg]\n\tformat = ssh\n[gpg "ssh"]\n\tallowedSignersFile = ${join(keys, "allowed")}\n`,
			);
			vi.stubEnv("GIT_CONFIG_GLOBAL", join(home, ".gitconfig"));
			const output = await bash(
				`git commit -q -S --allow-empty -m signed && echo SIGNED; test -e ${keys}/id || echo NO-KEY`,
			);
			expect(output).toContain("SIGNED");
			expect(output).toContain("NO-KEY");
			expect(git("log", "-1", "--format=%s")).toBe("signed");
			execFileSync("git", ["-C", repo, "verify-commit", "HEAD"], {
				env: { ...env, HOME: home, GIT_CONFIG_GLOBAL: join(home, ".gitconfig") },
				stdio: "pipe",
			});
			expect(copies()).toHaveLength(0);
		} finally {
			rmSync(keys, { recursive: true, force: true });
		}
	});

	it("reads a conditional include by the repository's real path, and keeps it as it was", async () => {
		writeFileSync(join(repo, "identity.inc"), "[user]\n\tname = Included Identity\n");
		git("config", `includeIf.gitdir:${repo}/.path`, join(repo, "identity.inc"));
		// The environment names an author, which would win over any configuration.
		const output = await bash(
			"env -u GIT_AUTHOR_NAME git commit -q --allow-empty -m included && git log -1 --format=%an",
		);
		expect(output).toContain("Included Identity");
		expect(output).not.toContain("Prism:");
		expect(git("log", "-1", "--format=%an")).toBe("Included Identity");
	});

	// fork: asked about instead of refused.
	const husky = () => `node ${dirname(createRequire(import.meta.url).resolve("husky"))}/bin.js`;

	it("asks before applying the hooks folder Husky sets, applies it once allowed, and keeps its scripts read-only", async () => {
		hooksAnswer = (options) => options.find((option) => option === "Apply this hooks folder");
		const output = await bash(`${husky()} && git commit -q --allow-empty -m with-husky && echo COMMITTED`);
		expect(output).toContain("COMMITTED");
		expect(output).not.toContain("Prism:");
		const question = questions.find((text) => text.includes("Git hooks folder"));
		expect(question).toContain(`A command changed the Git hooks folder of ${repo}:`);
		expect(question).toContain("core.hooksPath: (unset) → .husky/_");
		expect(question).toContain(`Git would run hooks from ${join(repo, ".husky", "_")}`);
		expect(question).toMatch(/Hooks there now: .*pre-commit/);
		expect(question).toContain(
			`These hooks run the scripts of ${join(repo, ".husky")}, with node_modules/.bin first`,
		);
		expect(question).toContain(
			"Risk: Git outside Prism (your terminal, your editor) runs these hooks without the sandbox",
		);
		expect(question).toContain("What the hooks call (npm scripts, node_modules, other project files) stays writable");
		expect(git("config", "core.hooksPath")).toBe(".husky/_");
		expect(git("log", "-1", "--format=%s")).toBe("with-husky");

		// Not a general allowance: the scripts Husky runs and its hooks folder stay out of the commands' reach.
		const later = await bash(
			"echo 'touch /tmp/ran' > .husky/pre-commit; echo script=$?; echo changed > .husky/_/pre-commit; echo hook=$?",
		);
		expect(later).toContain("script=1");
		expect(later).toContain("hook=0");
		expect(existsSync(join(repo, ".husky", "pre-commit"))).toBe(false);
		expect(readFileSync(join(repo, ".husky", "_", "pre-commit"), "utf8")).not.toContain("changed");
		expect(questions.filter((text) => text.includes("Git hooks folder"))).toHaveLength(1);
	});

	// fork: a value with terminal controls never reaches the hooks or Git
	// configuration question; it is refused first. The questions also show such controls as `<U+XXXX>`.
	it("refuses a hooks folder or an identity with terminal controls, without asking about it", async () => {
		const hooks = await bash(`git config core.hooksPath "$(printf 'hooks\\033[8m\\033[2J')"`);
		expect(hooks).toContain("config core.hooksPath has no single-line value");
		const name = await bash(`git config user.name "$(printf 'Ann\\033[8m Hidden')"`);
		expect(name).toContain("config user.name is not one line");
		expect(
			questions.filter((text) => text.includes("Git hooks folder") || text.includes("Git configuration")),
		).toEqual([]);
		for (const text of questions) expect(text).not.toContain("\x1b");
	});

	it("applies none of the command's Git changes when the hooks folder is refused or unanswered", async () => {
		for (const [answer, reason] of [
			["Do not apply it", "core.hooksPath=.husky/_: the user did not allow this hooks folder"],
			[undefined, "core.hooksPath=.husky/_: no answer to the question about this hooks folder"],
		] as const) {
			hooksAnswer = () => answer;
			const output = await bash(`git commit -q --allow-empty -m kept && ${husky()}`);
			expect(output).toContain("Prism: this command's Git changes were not applied");
			expect(output).toContain(reason);
			expect(() => git("config", "core.hooksPath")).toThrow();
			expect(git("log", "-1", "--format=%s")).toBe("initial");
		}
	});

	it("refuses core.hooksPath=. without asking, since every file named like a hook would run outside", async () => {
		const output = await bash("git config core.hooksPath .");
		expect(output).toContain(
			`core.hooksPath=.: ${repo} holds folders sandboxed commands write, so any file there named like a Git hook would run outside the sandbox`,
		);
		expect(questions.filter((text) => text.includes("Git hooks folder"))).toEqual([]);
		expect(() => git("config", "core.hooksPath")).toThrow();
	});
});
