// Positive compatibility probes: fixtures and HOME are disposable; commands use the real mount policy.
// fork: this matrix measures the layout's own protection of Git metadata, the fallback for a repository the
// private copy cannot cover (metadata over its limits, alternates, reftable...). The private copy, which every other
// repository gets, is measured through the real runtime in fork-sandbox-git-copy.test.ts and
// fork-sandbox-git-ordinary.test.ts.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, type TestContext, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { buildLayout, bwrapArgs, DEFAULT_SANDBOX_SETTINGS, prepareLayout } from "../src/fork/sandbox/layout.ts";

const bwrap = spawnSync("which", ["bwrap"], { encoding: "utf8" }).stdout.trim();
const python = spawnSync("which", ["python3"], { encoding: "utf8" }).stdout.trim();

interface Measurement {
	result: "works" | "refused" | "fails" | "not measured";
	error: string;
	command?: string;
	restrictions?: string[];
}

describe.skipIf(!bwrap)("fork: Git and toolchain compatibility (fallback protection, no private Git copy)", () => {
	let root: string;
	let repo: string;
	let home: string;
	let agent: string;
	let env: NodeJS.ProcessEnv;
	let measurement: Measurement;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "prism-compat-"));
		repo = join(root, "project");
		home = join(root, "home");
		agent = join(home, "agent");
		for (const path of [agent, join(home, "xdg"), join(home, ".npm"), join(home, ".cache")])
			mkdirSync(path, { recursive: true });
		writeFileSync(
			join(home, "gitconfig"),
			"[user]\nname = Compatibility Test\nemail = compat@example.invalid\n[commit]\ngpgSign = false\n",
		);
		env = {
			PATH: process.env.PATH,
			HOME: home,
			XDG_CONFIG_HOME: join(home, "xdg"),
			GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_TERMINAL_PROMPT: "0",
			GIT_EDITOR: "true",
			GIT_SEQUENCE_EDITOR: "true",
			LC_ALL: "C",
			npm_config_offline: "true",
			npm_config_update_notifier: "false",
			[ENV_AGENT_DIR]: agent,
		};
		// buildLayout's Git subprocesses inherit process.env, unlike the explicit command environment.
		for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) vi.stubEnv(key, undefined);
		for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
		measurement = { result: "not measured", error: "No sandbox command completed" };
		init(repo);
	});

	afterEach((context) => {
		// Direct output keeps measurements visible with Vitest's silent: passed-only setting, including it.fails.
		writeSync(1, `COMPAT ${JSON.stringify({ scenario: context.task.name, ...measurement })}\n`);
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	function git(cwd: string, ...args: string[]): string {
		return execFileSync("git", ["-C", cwd, ...args], {
			env,
			encoding: "utf8",
			timeout: 10_000,
			stdio: ["ignore", "pipe", "pipe"],
		});
	}

	function init(path: string): void {
		git(root, "init", "-q", "--initial-branch=main", path);
		git(path, "commit", "--allow-empty", "-qm", "initial");
	}

	function run(context: TestContext, command: string, cwd = repo): string {
		const plan = buildLayout({ cwd, home, agentDir: agent, settings: DEFAULT_SANDBOX_SETTINGS });
		const restrictions = plan.restrictions?.map(({ reason }) => reason);
		if (plan.blocked) {
			measurement = { result: "refused", error: plan.blocked.split("\n")[0]!, command, restrictions };
			throw new Error(measurement.error);
		}
		// Restrictions narrow writes; they do not refuse startup. Let the real command establish its outcome.
		prepareLayout(plan);
		const result = spawnSync(
			bwrap,
			[
				...bwrapArgs(plan, (path) => statSync(path).isDirectory(), join(agent, "unreadable")),
				"--",
				"sh",
				"-ec",
				command,
			],
			{ env, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] },
		);
		const lines = (result.stderr || result.stdout || result.error?.message || "").trim().split("\n");
		const error = lines.find((line) => /^(fatal:|error[:[]|npm (ERR!|error)|sh:|bwrap:)/.test(line)) ?? lines[0]!;
		if (result.status !== 0 && result.stderr.startsWith("bwrap:")) {
			measurement = { result: "not measured", error, command, restrictions };
			context.skip(`bubblewrap could not start: ${error}`);
		}
		measurement = {
			result: result.status === 0 && !result.error ? "works" : "fails",
			error: result.status === 0 && !result.error ? "" : error,
			command,
			restrictions,
		};
		expect(result.error, JSON.stringify(measurement)).toBeUndefined();
		expect(result.status, JSON.stringify(measurement)).toBe(0);
		return result.stdout;
	}

	/** A scenario broken today: the measured error is expected, so a fix shows up as a failing expectation. */
	function broken(context: TestContext, command: string, error: RegExp, cwd = repo): void {
		expect(() => run(context, command, cwd)).toThrow(error);
	}

	it("plain repository: add, commit, status, log, branch/switch, stash, rebase and merge", (context) => {
		run(
			context,
			`printf initial > tracked
git add tracked
git commit -qm base
test -z "$(git status --porcelain)"
test "$(git log -1 --format=%s)" = base
printf changed > tracked
git stash push -m compatibility
test "$(cat tracked)" = initial
git stash pop
test "$(cat tracked)" = changed
git add tracked
git commit -qm stashed-change
git branch topic
git switch topic
printf topic-one > topic-one
git add topic-one
git commit -qm topic-one
printf topic-two > topic-two
git add topic-two
git commit -qm topic-two
git switch main
printf upstream > upstream
git add upstream
git commit -qm upstream
git switch topic
git rebase main
test "$(git rev-list --count main..topic)" = 2
git switch main
git merge --no-ff topic -m merged
test "$(git log -1 --format=%s)" = merged
test "$(cat topic-two)" = topic-two
test "$(cat tracked)" = changed
test -z "$(git status --porcelain)"`,
		);
	});

	it("local-file fetch and pull from a repository outside the project", (context) => {
		const remote = join(root, "remote");
		init(remote);
		git(repo, "remote", "add", "local", `file://${remote}`);
		writeFileSync(join(remote, "incoming"), "first");
		git(remote, "add", "incoming");
		git(remote, "commit", "-qm", "first");
		run(context, 'git fetch local main\ntest "$(git log -1 --format=%s FETCH_HEAD)" = first');
		writeFileSync(join(remote, "incoming"), "second");
		git(remote, "commit", "-qam", "second");
		// Both repos have independent initial commits; start at the fetched commit before pulling its successor.
		run(context, 'git switch -c incoming FETCH_HEAD\ngit pull --ff-only local main\ntest "$(cat incoming)" = second');
	});

	it("linked worktree: add, commit in it and remove", (context) => {
		run(context, "git worktree add -b linked linked");
		// Rebuild between model commands so the new worktree's protected metadata is discovered.
		run(
			context,
			'printf linked > tracked\ngit add tracked\ngit commit -qm linked\ntest "$(git show HEAD:tracked)" = linked',
			join(repo, "linked"),
		);
		// Fallback protection: the linked worktree's .git file is bound read-only, so Git cannot delete the worktree.
		broken(
			context,
			"git worktree remove linked\ntest ! -e linked\ntest \"$(git worktree list --porcelain | grep -c '^worktree ')\" = 1",
			/failed to delete .*linked': Device or resource busy/,
		);
	});

	function submoduleFixture(nested: boolean, initialized: boolean): void {
		const source = join(root, "source");
		const library = join(root, "library");
		init(library);
		if (nested) {
			const inner = join(root, "inner");
			init(inner);
			git(library, "-c", "protocol.file.allow=always", "submodule", "add", "-q", `file://${inner}`, "inner");
			git(library, "commit", "-qm", "nested pointer");
		}
		init(source);
		git(source, "-c", "protocol.file.allow=always", "submodule", "add", "-q", `file://${library}`, "sub");
		git(source, "commit", "-qm", "submodule pointer");
		rmSync(repo, { recursive: true, force: true });
		git(root, "clone", "-q", source, repo);
		if (initialized) git(repo, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive");
	}

	function editSubmodule(context: TestContext, nested: boolean): void {
		const path = nested ? "sub/inner" : "sub";
		// Fallback protection: each submodule's Git directory is read-only in the sandbox.
		broken(
			context,
			`printf changed > ${path}/tracked
git -C ${path} add tracked
git -C ${path} commit -qm module-change
test "$(git -C ${path} show HEAD:tracked)" = changed
${nested ? "git -C sub add inner\ngit -C sub commit -qm inner-pointer" : ""}
git add sub
git commit -qm updated-pointer
test "$(git rev-parse HEAD:sub)" = "$(git -C sub rev-parse HEAD)"
${nested ? 'test "$(git -C sub rev-parse HEAD:inner)" = "$(git -C sub/inner rev-parse HEAD)"' : ""}
test -z "$(git status --porcelain)"`,
			new RegExp(
				`Unable to create '.*\\.git/modules/${nested ? "sub/modules/inner" : "sub"}/index\\.lock': Read-only file system`,
			),
		);
	}

	for (const nested of [false, true]) {
		const label = nested ? "nested submodule" : "submodule";
		it(`${label}: initialize after clone, edit, commit and update pointers`, (context) => {
			submoduleFixture(nested, false);
			// Fallback protection: initialising writes the superproject's .git/config, which is bound read-only.
			broken(
				context,
				"git -c protocol.file.allow=always submodule update --init --recursive",
				/could not write config file .*\.git\/config: Device or resource busy/,
			);
		});
		it(`${label}: edit an already initialized checkout, commit and update pointers`, (context) => {
			submoduleFixture(nested, true);
			editSubmodule(context, nested);
		});
	}

	describe("standard Husky 9 layout", () => {
		let observed: Measurement | undefined;
		afterEach(() => {
			observed = measurement;
		});
		afterAll(() => {
			if (!observed) return;
			// it.fails also accepts fixture errors; require the measured refusal outside that inversion.
			expect(observed.result, JSON.stringify(observed)).toBe("refused");
			expect(observed.error).toContain("core.hooksPath=.husky/_ in file:.git/config is relative");
		});
		beforeEach(() => {
			// Reproduce the installed, pinned Husky 9 init layout without installing packages or spawning its CLI.
			const husky = dirname(createRequire(import.meta.url).resolve("husky"));
			const version: { version: string } = JSON.parse(readFileSync(join(husky, "package.json"), "utf8"));
			expect(version.version).toMatch(/^9\./);
			writeFileSync(
				join(repo, "package.json"),
				JSON.stringify({
					name: "husky-compat",
					version: "1.0.0",
					scripts: {
						prepare: "husky",
						test: "node -e \"require('node:fs').writeFileSync('husky-marker', 'ran')\"",
					},
				}),
			);
			const hooks = join(repo, ".husky/_");
			mkdirSync(hooks, { recursive: true });
			writeFileSync(join(repo, ".husky/pre-commit"), "npm test\n");
			writeFileSync(join(hooks, "h"), readFileSync(join(husky, "husky")));
			writeFileSync(join(hooks, ".gitignore"), "*");
			for (const hook of [
				"pre-commit",
				"pre-merge-commit",
				"prepare-commit-msg",
				"commit-msg",
				"post-commit",
				"applypatch-msg",
				"pre-applypatch",
				"post-applypatch",
				"pre-rebase",
				"post-rewrite",
				"post-checkout",
				"post-merge",
				"pre-push",
				"pre-auto-gc",
			])
				writeFileSync(join(hooks, hook), '#!/usr/bin/env sh\n. "$(dirname "$0")/h"', { mode: 0o755 });
			git(repo, "config", "core.hooksPath", ".husky/_");
			expect(git(repo, "config", "core.hooksPath").trim()).toBe(".husky/_");
			expect(existsSync(join(repo, ".husky/_/h"))).toBe(true);
			expect(existsSync(join(repo, ".git/.husky"))).toBe(false);
		});

		// Fallback protection: measured refusal, "core.hooksPath=.husky/_ in file:.git/config is relative".
		it.fails("Husky 9: commit runs the standard pre-commit hook", (context) => {
			run(context, 'git add package.json .husky\ngit commit -qm husky\ntest "$(cat husky-marker)" = ran');
		});
	});

	it("core.hooksPath=.: commit with the project root as hooks folder", (context) => {
		git(repo, "config", "core.hooksPath", ".");
		// Fallback protection, as with the private copy: the hooks folder is the project, so both are read-only.
		broken(
			context,
			'git commit --allow-empty -qm root-hooks\ntest "$(git log -1 --format=%s)" = root-hooks',
			/Unable to create '.*\.git\/index\.lock': Read-only file system/,
		);
	});

	it("conditional gitdir include: commit reads the included identity", (context) => {
		const included = join(repo, "identity.inc");
		writeFileSync(included, "[user]\nname = Included Identity\n");
		// A trailing slash means "inside": gitdir:<project>/ matches <project>/.git.
		git(repo, "config", `includeIf.gitdir:${repo}/.path`, included);
		run(context, "git commit --allow-empty -qm included\ntest \"$(git log -1 --format=%an)\" = 'Included Identity'");
	});

	it("npm init and a local package script without installation", (context) => {
		run(
			context,
			`npm init -y
npm pkg set 'scripts.compat=printf ran > npm-marker'
npm run compat
test "$(cat npm-marker)" = ran`,
		);
	});

	it.skipIf(!python)("Python: create a venv and execute its interpreter", (context) => {
		run(context, "python3 -m venv .venv\ntest \"$(.venv/bin/python -c 'print(1)')\" = 1");
	});

	// Not measurable with a throwaway HOME: rustup's cargo wants to create ~/.rustup (a real installation has one).
	it.skip("Cargo: create a project and build offline", (context) => {
		run(
			context,
			"cargo new --vcs none demo\ncd demo\ncargo build --offline\ntest \"$(target/debug/demo)\" = 'Hello, world!'",
		);
	});
});
