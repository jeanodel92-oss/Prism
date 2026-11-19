// fork: the validation of what a sandboxed command changed in a Git folder. Each case
// runs real Git in a disposable repository, takes what changed in its Git folder, and validates it.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hooksQuestion } from "../src/fork/sandbox/git-hooks.ts";
import type { GitChange } from "../src/fork/sandbox/git-publish.ts";
import {
	gitObjectFormat,
	gitObjectStore,
	type HashFormat,
	parseGitConfig,
	sanitizedIndex,
	unsupportedGitFormat,
	type ValidationInput,
	validateGitChanges,
	validRefName,
} from "../src/fork/sandbox/git-validate.ts";
import { gitFsckTransport } from "./fork-git-fsck-harness.ts";

describe("fork: validation of a sandboxed command's Git changes", () => {
	let root: string;
	let repo: string;
	let env: NodeJS.ProcessEnv;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "prism-git-validate-"));
		repo = join(root, "project");
		writeFileSync(join(root, "gitconfig"), "[user]\n\tname = Test\n\temail = test@example.invalid\n");
		env = {
			PATH: process.env.PATH,
			HOME: root,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
			GIT_EDITOR: "true",
			GIT_SEQUENCE_EDITOR: "true",
			LC_ALL: "C",
		};
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	function git(...args: string[]): string {
		return execFileSync("git", ["-C", repo, "-c", "gc.auto=0", "-c", "maintenance.auto=false", ...args], {
			env,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	}
	/** Like git, for commands expected to stop on a conflict. */
	function gitMayFail(...args: string[]): void {
		try {
			git(...args);
		} catch {}
	}
	function init(format: HashFormat = "sha1"): void {
		execFileSync("git", ["init", "-q", "--initial-branch=main", `--object-format=${format}`, repo], { env });
		writeFileSync(join(repo, "f"), "1\n");
		git("add", "f");
		git("commit", "-qm", "one");
	}
	function files(gitDir: string): Map<string, Buffer> {
		const found = new Map<string, Buffer>();
		const walk = (folder: string) => {
			for (const name of readdirSync(folder)) {
				const path = join(folder, name);
				if (statSync(path).isDirectory()) walk(path);
				else found.set(relative(gitDir, path), readFileSync(path));
			}
		};
		walk(gitDir);
		return found;
	}
	/** Copies the Git folder, runs `operation` on the repository, and returns what changed and the copy. */
	function changes(operation: () => void): { changes: GitChange[]; before: string } {
		const before = join(root, `before-${Math.random().toString(16).slice(2)}`);
		cpSync(join(repo, ".git"), before, { recursive: true });
		const old = files(before);
		operation();
		const now = files(join(repo, ".git"));
		const result: GitChange[] = [];
		for (const path of new Set([...old.keys(), ...now.keys()])) {
			const a = old.get(path) ?? null;
			const b = now.get(path) ?? null;
			if (a && b && a.equals(b)) continue;
			result.push({ path, before: a, after: b });
		}
		return { changes: result, before };
	}
	async function validate(
		operation: () => void,
		extra: Partial<ValidationInput> & { edit?: (changes: GitChange[]) => GitChange[] } = {},
	) {
		const { changes: found, before } = changes(operation);
		const config = parseGitConfig(readFileSync(join(before, "config")))!;
		const format = gitObjectFormat(config);
		const store = gitObjectStore(join(before, "objects"), format);
		try {
			return await validateGitChanges({
				changes: extra.edit ? extra.edit(found) : found,
				format,
				existing: store,
				loose: { sandbox: gitFsckTransport(root), stores: [join(before, "objects")], scratch: root },
				writable: [root],
				...extra,
			});
		} finally {
			await store.close();
		}
	}
	const reasons = (result: { refused: { path: string; reason: string }[] }) =>
		result.refused.map(({ path, reason }) => `${path}: ${reason}`).join("\n");

	// fork: `git status` enters a submodule with its own configuration; one the
	// command made, whose configuration names programs, ran them on the host.
	it("refuses an index that adds as a submodule a repository the command made and the check reported", async () => {
		init();
		const nested = join(repo, "vendor", "lib");
		const operation = () => {
			execFileSync("git", ["init", "-q", nested], { env });
			execFileSync("git", ["-C", nested, "commit", "-q", "--allow-empty", "-m", "lib"], { env });
			git("add", "vendor/lib");
			git("commit", "-qm", "vendor");
		};
		const refused = await validate(operation, { gitDir: join(repo, ".git"), newRepositories: [nested] });
		expect(reasons(refused)).toContain("index: adds vendor/lib as a submodule, a repository this command made");
		expect(refused.accepted).toEqual([]);
		rmSync(repo, { recursive: true, force: true });
		init();
		const ordinary = await validate(operation, { gitDir: join(repo, ".git"), newRepositories: [] });
		expect(reasons(ordinary)).toBe("");
	});

	it("accepts a commit, and publishes an index Git reads without its caches", async () => {
		init();
		const result = await validate(() => {
			writeFileSync(join(repo, "g"), "2\n");
			git("add", "g");
			git("commit", "-qm", "two");
		});
		expect(reasons(result)).toBe("");
		expect(result.accepted.map(({ path }) => path)).toEqual(
			expect.arrayContaining(["index", "refs/heads/main", "logs/HEAD", "COMMIT_EDITMSG"]),
		);
		const index = result.accepted.find(({ path }) => path === "index")!.after!;
		if (!Buffer.isBuffer(index)) throw new Error("Expected index bytes");
		writeFileSync(join(repo, ".git", "index"), index);
		expect(git("ls-files")).toBe("f\ng\n");
		expect(git("status", "--porcelain")).toBe("");
		writeFileSync(join(repo, "h"), "3\n");
		git("add", "h");
		git("commit", "-qm", "three");
		expect(git("fsck", "--strict", "--no-progress")).toBe("");
	});

	it("accepts ordinary branch names and an upstream, and returns a remote and an identity for the question", async () => {
		init();
		const operation = () => {
			git("branch", "release/v1.2/fix");
			git("remote", "add", "origin", "https://example.invalid/project.git");
			git("config", "branch.main.remote", "origin");
			git("config", "branch.main.merge", "refs/heads/main");
			git("config", "user.name", "Someone Else");
		};
		const result = await validate(operation, { askConfigChanges: true });
		expect(reasons(result)).toBe("");
		expect(result.configChanges).toEqual([
			{ key: "remote.origin.url", before: [], after: ["https://example.invalid/project.git"] },
			{ key: "user.name", before: [], after: ["Someone Else"] },
		]);
		// fork: without a question, never published.
		const unasked = await validate(() => git("remote", "add", "other", "https://example.invalid/other.git"));
		expect(reasons(unasked)).toContain("config: remote.other.url");
		expect(unasked.accepted).toEqual([]);
		expect(validRefName("refs/heads/release/v1.2/fix")).toBe(true);
		for (const name of [
			"refs/heads/a..b",
			"refs/heads/.x",
			"refs/heads/x.lock",
			"refs/heads/a b",
			"refs/heads/a@{1}",
			"refs/heads/x/",
		])
			expect(validRefName(name), name).toBe(false);
	});

	it("accepts a configuration change when keys outside the list stay as they were", async () => {
		init();
		git("config", "core.editor", "vim");
		const result = await validate(() => git("config", "user.email", "other@example.invalid"), {
			askConfigChanges: true,
		});
		expect(reasons(result)).toBe("");
		expect(result.configChanges).toEqual([{ key: "user.email", before: [], after: ["other@example.invalid"] }]);
	});

	it("refuses hooks, executable configuration and unlisted files, naming each", async () => {
		init();
		const result = await validate(() => {
			writeFileSync(join(repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\ntouch /tmp/ran\n", { mode: 0o755 });
			writeFileSync(join(repo, ".git", "info", "attributes"), "* filter=x\n");
		});
		expect(reasons(result)).toContain("hooks/pre-commit: is a Git hook");
		expect(reasons(result)).toContain("info/attributes: is not a Git file the sandbox publishes");
		expect(result.accepted).toEqual([]);
		for (const [key, value] of [
			["core.hooksPath", "/tmp/hooks"],
			["core.fsmonitor", "/tmp/x"],
			["include.path", "/tmp/included"],
			["filter.x.clean", "sh -c id"],
			["core.sshCommand", "sh"],
			["alias.st", "!sh"],
		]) {
			const refused = await validate(() => git("config", key, value));
			expect(reasons(refused), key).toContain(
				key === "core.hooksPath"
					? "config: core.hooksPath: a hooks folder set in the sandbox is not applied"
					: `config: ${key.toLowerCase()}: not a key the sandbox may change`,
			);
		}
	});

	// fork: asked about instead of refused, when the caller can ask.
	it("returns a change to core.hooksPath alone for the question, and refuses it with anything else unlisted", async () => {
		init();
		const set = await validate(() => git("config", "core.hooksPath", ".husky/_"), { askHooksPath: true });
		expect(reasons(set)).toBe("");
		expect(set.hooksPath).toEqual({ before: undefined, after: ".husky/_" });
		expect(set.accepted.map((change) => change.path)).toContain("config");

		git("config", "core.hooksPath", ".husky/_");
		const changed = await validate(() => git("config", "core.hooksPath", "/opt/hooks"), { askHooksPath: true });
		expect(changed.hooksPath).toEqual({ before: ".husky/_", after: "/opt/hooks" });
		const unset = await validate(() => git("config", "--unset", "core.hooksPath"), { askHooksPath: true });
		expect(unset.hooksPath).toEqual({ before: "/opt/hooks", after: undefined });
		const same = await validate(() => git("config", "user.name", "Other"), {
			askHooksPath: true,
			askConfigChanges: true,
		});
		expect(same.hooksPath).toBeUndefined();
		expect(reasons(same)).toBe("");

		const mixed = await validate(
			() => {
				git("config", "core.hooksPath", "/opt/other");
				git("config", "core.fsmonitor", "/tmp/x");
			},
			{ askHooksPath: true },
		);
		expect(reasons(mixed)).toContain("config: core.fsmonitor: not a key the sandbox may change");
		expect(mixed.hooksPath).toBeUndefined();
		expect(mixed.accepted).toEqual([]);
		const config = readFileSync(join(repo, ".git", "config"));
		for (const value of ["~other/hooks", "%(prefix)/hooks"]) {
			const odd = await validate(() => git("config", "core.hooksPath", value), { askHooksPath: true });
			expect(reasons(odd), value).toContain(`config: core.hooksPath=${value} is not a path the sandbox can check`);
			expect(odd.hooksPath).toBeUndefined();
			// Git no longer reads such a configuration to change it.
			writeFileSync(join(repo, ".git", "config"), config);
		}
		// Without a question, still refused.
		const refused = await validate(() => git("config", "core.hooksPath", "/opt/third"));
		expect(reasons(refused)).toContain("config: core.hooksPath: a hooks folder set in the sandbox is not applied");
	});

	it("asks with the folder Git would run hooks from, or refuses without asking", () => {
		const gitDir = join(root, ".git");
		mkdirSync(join(root, ".husky", "_"), { recursive: true });
		for (const name of ["h", "pre-commit", "commit-msg", "husky.sh"])
			writeFileSync(join(root, ".husky", "_", name), "#!/bin/sh\n", { mode: 0o755 });
		expect(hooksQuestion(gitDir, { before: undefined, after: ".husky/_" }, [root], false)).toEqual({
			repository: root,
			change: { before: undefined, after: ".husky/_" },
			folder: join(root, ".husky", "_"),
			hooks: ["commit-msg", "pre-commit"],
			scripts: join(root, ".husky"),
		});
		expect(hooksQuestion(gitDir, { before: ".husky/_", after: undefined }, [root], false)).toMatchObject({
			folder: join(gitDir, "hooks"),
		});
		expect(hooksQuestion(gitDir, { before: undefined, after: "." }, [root], false)).toContain(
			"holds folders sandboxed commands write, so any file there named like a Git hook would run outside the sandbox",
		);
		expect(hooksQuestion(gitDir, { before: undefined, after: ".husky/_" }, [root], true)).toContain(
			"a relative path names a different folder in each linked worktree",
		);
		expect(hooksQuestion(join(root, "bare.git"), { before: undefined, after: "/opt/h" }, [root], false)).toContain(
			"without a working tree Prism can tell",
		);
	});

	it("refuses a remote URL that is a transport helper or another local repository", async () => {
		init();
		const inside = join(root, "inside.git");
		mkdirSync(inside);
		const outside = mkdtempSync(join(tmpdir(), "prism-git-validate-outside-"));
		try {
			for (const [url, reason] of [
				["ext::sh -c id", "is not an allowed remote URL"],
				["fd::3", "is not an allowed remote URL"],
				[outside, "is a local repository outside the folders the sandbox may write"],
				[`file://${outside}`, "is a local repository outside the folders the sandbox may write"],
				["ssh://-oProxyCommand=id/x", "names a host that starts with -"],
				["http://example.invalid/x", "uses the http:// transport"],
			]) {
				const result = await validate(() => git("remote", "add", "x", url));
				git("remote", "remove", "x");
				expect(reasons(result), url).toContain(`remote.x.url ${reason}`);
			}
			for (const url of [
				inside,
				`file://${inside}`,
				"git@example.invalid:me/x.git",
				"ssh://git@example.invalid/x",
			]) {
				const result = await validate(() => git("remote", "add", "x", url), { askConfigChanges: true });
				git("remote", "remove", "x");
				expect(reasons(result), url).toBe("");
			}
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("keeps a conflicted rebase, merge, cherry-pick and stash for a later command", async () => {
		init();
		git("checkout", "-qb", "topic");
		writeFileSync(join(repo, "f"), "topic\n");
		git("commit", "-qam", "topic");
		writeFileSync(join(repo, "g"), "topic\n");
		git("add", "g");
		git("commit", "-qm", "topic two");
		git("checkout", "-q", "main");
		writeFileSync(join(repo, "f"), "main\n");
		git("commit", "-qam", "main");
		git("checkout", "-q", "topic");
		const rebase = await validate(() => gitMayFail("rebase", "main"));
		expect(rebase.accepted.some(({ path }) => path === "rebase-merge/git-rebase-todo")).toBe(true);
		expect(reasons(rebase)).toBe("");
		git("rebase", "--abort");
		git("checkout", "-q", "main");
		const merge = await validate(() => gitMayFail("merge", "topic"));
		expect(merge.accepted.some(({ path }) => path === "MERGE_HEAD")).toBe(true);
		expect(reasons(merge)).toBe("");
		git("merge", "--abort");
		const pick = await validate(() => gitMayFail("cherry-pick", "topic~1", "topic"));
		expect(pick.accepted.some(({ path }) => path === "sequencer/todo")).toBe(true);
		expect(reasons(pick)).toBe("");
		git("cherry-pick", "--abort");
		const stash = await validate(() => {
			writeFileSync(join(repo, "f"), "changed\n");
			git("stash", "-q");
		});
		expect(stash.accepted.some(({ path }) => path === "refs/stash")).toBe(true);
		expect(reasons(stash)).toBe("");
	});

	it("refuses a rebase whose to-do list would run a command, or a strategy that is not Git's", async () => {
		init();
		git("checkout", "-qb", "topic");
		writeFileSync(join(repo, "f"), "topic\n");
		git("commit", "-qam", "topic");
		git("checkout", "-q", "main");
		writeFileSync(join(repo, "f"), "main\n");
		git("commit", "-qam", "main");
		git("checkout", "-q", "topic");
		const exec = await validate(() => gitMayFail("rebase", "--exec", "true", "main"));
		expect(reasons(exec)).toContain("rebase-merge/git-rebase-todo: holds an exec line");
		git("rebase", "--abort");
		const planted = await validate(() => gitMayFail("rebase", "main"), {
			edit: (found) => [
				...found,
				{ path: "rebase-merge/strategy", before: null, after: Buffer.from("evil\n") },
				{
					path: "rebase-merge/author-script",
					before: null,
					after: Buffer.from("GIT_AUTHOR_NAME='a'; touch /tmp/x\n"),
				},
			],
		});
		expect(reasons(planted)).toContain("rebase-merge/strategy: names a merge strategy that is not Git's own");
		expect(reasons(planted)).toContain("rebase-merge/author-script: is not an author script Git writes");
	});

	it("leaves for a later git am only the options that choose how a patch applies", async () => {
		init();
		const applyOpt = (text: string) => async () =>
			reasons(
				await validate(() => writeFileSync(join(repo, "g"), "2\n"), {
					edit: (found) => [...found, { path: "rebase-apply/apply-opt", before: null, after: Buffer.from(text) }],
				}),
			);
		// What `git am --whitespace=fix -p1 -C3 --exclude='x y' --include="it's" --reject` writes (git 2.55).
		expect(
			await applyOpt(
				" '--whitespace=fix' '-p1' '-C3' '--exclude=x y' '--include=it'\\''s' '--reject' '--directory=sub'\n",
			)(),
		).not.toContain("rebase-apply/apply-opt");
		for (const hostile of [
			" '--build-fake-ancestor=/home/u/.bashrc'\n",
			" '--directory=../../elsewhere'\n",
			" '--whitespace=fix' --unsafe\n",
		])
			expect(await applyOpt(hostile)()).toContain("rebase-apply/apply-opt");
	});

	it("refuses refs and objects that would leave the repository unusable", async () => {
		init();
		const head = git("rev-parse", "HEAD").trim();
		const blob = git("rev-parse", "HEAD:f").trim();
		const tree = git("rev-parse", "HEAD^{tree}").trim();
		const missing = "1".repeat(40);
		for (const [path, value, reason] of [
			["refs/heads/x", `${missing}\n`, `names ${missing}, which does not exist`],
			["refs/heads/x", `${blob}\n`, `names ${blob}, a blob where Git expects a commit`],
			["refs/heads/x", `${"0".repeat(40)}\n`, "names the null object"],
			["refs/heads/a..b", `${head}\n`, "is not a valid ref name"],
			["HEAD", "ref: refs/tags/v1\n", "HEAD must name a branch"],
		]) {
			const result = await validate(() => {
				mkdirSync(join(repo, ".git", path, ".."), { recursive: true });
				writeFileSync(join(repo, ".git", path), value);
			});
			expect(reasons(result), path).toContain(`${path}: ${reason}`);
		}
		// A commit naming a parent that does not exist, and a tree with a .git entry.
		const commit = Buffer.from(
			`tree ${tree}\nparent ${missing}\nauthor A <a@x> 1 +0000\ncommitter A <a@x> 1 +0000\n\nx\n`,
		);
		const badTree = Buffer.concat([Buffer.from("100644 .GIT\0"), Buffer.from(blob, "hex")]);
		for (const [type, body, reason] of [
			["commit", commit, `names ${missing}, which does not exist`],
			["tree", badTree, 'Unsafe tree entry name ".GIT"'],
		] as const) {
			const raw = Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body]);
			const name = execFileSync("git", ["hash-object", "-t", type, "--literally", "--stdin"], { env, input: body })
				.toString()
				.trim();
			const result = await validate(() => {}, {
				edit: () => [
					{ path: `objects/${name.slice(0, 2)}/${name.slice(2)}`, before: null, after: deflateSync(raw) },
				],
			});
			expect(reasons(result), type).toContain(reason);
		}
		const raw = Buffer.from("blob 2\0hi");
		const wrong = await validate(() => {}, {
			edit: () => [{ path: `objects/ab/${"c".repeat(38)}`, before: null, after: deflateSync(raw) }],
		});
		expect(reasons(wrong)).toContain("Object hash does not match its name");
	});

	it("refuses removed objects, as Git maintenance would, and drops lock files and rebuilt files", async () => {
		init();
		const blob = git("rev-parse", "HEAD:f").trim();
		const removed = await validate(() => rmSync(join(repo, ".git", "objects", blob.slice(0, 2), blob.slice(2))));
		expect(reasons(removed)).toContain("Git maintenance");
		const locks = await validate(() => {
			writeFileSync(join(repo, ".git", "index.lock"), "");
			writeFileSync(join(repo, ".git", "objects", "info", "commit-graph"), "x");
		});
		expect(reasons(locks)).toBe("");
		expect(locks.dropped.sort()).toEqual(["index.lock", "objects/info/commit-graph"]);
	});

	it("reads the types of packed objects, deltas included", async () => {
		init();
		for (let version = 0; version < 30; version++) {
			writeFileSync(join(repo, "f"), `${"line\n".repeat(200)}${version}\n`);
			git("commit", "-qam", `v${version}`);
		}
		git("tag", "-a", "-m", "tag", "v1");
		git("gc", "-q", "--aggressive");
		const store = gitObjectStore(join(repo, ".git", "objects"), "sha1");
		try {
			const listed = git("cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)")
				.trim()
				.split("\n");
			expect(listed.length).toBeGreaterThan(60);
			for (const line of listed) {
				const [name, type] = line.split(" ");
				expect(await store.type(name!), name).toBe(type);
			}
			expect(
				git(
					"verify-pack",
					"-v",
					...readdirSync(join(repo, ".git", "objects", "pack"))
						.filter((name) => name.endsWith(".idx"))
						.map((name) => join(repo, ".git", "objects", "pack", name)),
				),
			).toMatch(/chain length = [1-9]/);
		} finally {
			await store.close();
		}
		const branch = await validate(() => git("branch", "old", "HEAD~5"));
		expect(reasons(branch)).toBe("");
	});

	it("accepts SHA-256 repositories and index version 4", async () => {
		init("sha256");
		const sha256 = await validate(() => {
			writeFileSync(join(repo, "g"), "2\n");
			git("add", "g");
			git("commit", "-qm", "two");
		});
		expect(reasons(sha256)).toBe("");
		rmSync(repo, { recursive: true, force: true });
		init();
		git("update-index", "--index-version", "4");
		const v4 = await validate(() => {
			for (const name of ["dir/a", "dir/b", "dir/sub/c", "e"]) {
				mkdirSync(join(repo, name, ".."), { recursive: true });
				writeFileSync(join(repo, name), name);
			}
			git("add", ".");
		});
		expect(reasons(v4)).toBe("");
		const index = v4.accepted.find(({ path }) => path === "index")!.after!;
		if (!Buffer.isBuffer(index)) throw new Error("Expected index bytes");
		expect(index.readUInt32BE(4)).toBe(4);
		if (!Buffer.isBuffer(index)) throw new Error("Expected index bytes");
		writeFileSync(join(repo, ".git", "index"), index);
		expect(git("ls-files")).toBe("dir/a\ndir/b\ndir/sub/c\ne\nf\n");
	});

	// fork: file names are bytes. Two names that are not UTF-8 are two names, and a
	// v4 index removes bytes from the previous name, as Git does, not characters of its decoded text.
	it("tells file names apart by their bytes, in a tree and in a v4 index", async () => {
		init();
		const named = (...bytes: number[]) => Buffer.concat([Buffer.from(`${repo}/`), Buffer.from(bytes)]);
		writeFileSync(named(0xfe), "fe\n");
		writeFileSync(named(0xff), "ff\n");
		git("add", "-A");
		git("commit", "-qm", "bytes");
		const added = await validate(() => {
			writeFileSync(join(repo, "g"), "g\n");
			git("add", "g");
			git("commit", "-qm", "g");
		});
		expect(reasons(added)).toBe("");

		const entry = (strip: number, name: string | Buffer) => {
			const stat = Buffer.alloc(40);
			stat.writeUInt32BE(0o100644, 24);
			const bytes = Buffer.isBuffer(name) ? name : Buffer.from(name);
			const flags = Buffer.alloc(2);
			flags.writeUInt16BE(Math.min(bytes.length, 0xfff));
			return Buffer.concat([stat, Buffer.alloc(20, 1), flags, Buffer.from([strip]), bytes, Buffer.from([0])]);
		};
		const header = Buffer.alloc(12);
		header.write("DIRC", 0, "latin1");
		header.writeUInt32BE(4, 4);
		header.writeUInt32BE(2, 8);
		const body = Buffer.concat([header, entry(0, Buffer.from([0x2e, 0x61, 0xff])), entry(3, ".git/config")]);
		const index = Buffer.concat([body, createHash("sha1").update(body).digest()]);
		expect(sanitizedIndex(index, "sha1").reason).toContain("Unsafe index path");
	});

	it("refuses a split index and unsupported repository formats", async () => {
		init();
		const split = await validate(() => git("update-index", "--split-index"));
		expect(reasons(split)).toMatch(/Split index|sharedindex/);
		const index = readFileSync(join(repo, ".git", "index"));
		expect(sanitizedIndex(index, "sha1").reason).toContain("Split index");
		expect(unsupportedGitFormat([{ key: "extensions.refstorage", value: "reftable" }])).toContain("reftable");
		expect(unsupportedGitFormat([{ key: "extensions.partialclone", value: "origin" }])).toContain("partial clone");
		expect(unsupportedGitFormat([{ key: "extensions.unknown", value: "x" }])).toContain("extensions.unknown");
		expect(
			unsupportedGitFormat([
				{ key: "core.repositoryformatversion", value: "1" },
				{ key: "extensions.objectformat", value: "sha256" },
			]),
		).toBeUndefined();
		expect(existsSync(join(repo, ".git"))).toBe(true);
	});

	// fork: what acts later, outside Prism, is returned for the question.
	it("returns a redirected remote, a forced push refspec and a new remote for the question", async () => {
		init();
		git("remote", "add", "origin", "https://example.invalid/project.git");
		const result = await validate(
			() => {
				git("remote", "set-url", "origin", "https://attacker.invalid/x.git");
				git("config", "--add", "remote.origin.push", "+refs/heads/*:refs/heads/*");
				git("remote", "add", "other", "ssh://git@attacker.invalid/y");
			},
			{ askConfigChanges: true },
		);
		expect(reasons(result)).toBe("");
		expect(result.configChanges).toEqual(
			expect.arrayContaining([
				{
					key: "remote.origin.url",
					before: ["https://example.invalid/project.git"],
					after: ["https://attacker.invalid/x.git"],
				},
				{ key: "remote.origin.push", before: [], after: ["+refs/heads/*:refs/heads/*"] },
				{ key: "remote.other.url", before: [], after: ["ssh://git@attacker.invalid/y"] },
			]),
		);
		// A fetch, a commit and an upstream change no remote: nothing to ask.
		const ordinary = await validate(
			() => {
				writeFileSync(join(repo, "g"), "2\n");
				git("add", "g");
				git("commit", "-qm", "two");
				git("config", "branch.main.remote", "origin");
			},
			{ askConfigChanges: true },
		);
		expect(reasons(ordinary)).toBe("");
		expect(ordinary.configChanges).toBeUndefined();
	});
});
