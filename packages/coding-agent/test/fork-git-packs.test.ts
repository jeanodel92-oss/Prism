// fork: the confined check of the packs a sandboxed command wrote. Real Git makes the
// packs in disposable repositories; the check runs in a real bubblewrap sandbox.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyPacks } from "../src/fork/sandbox/git-packs.ts";
import { gitObjectStore, validateGitChanges } from "../src/fork/sandbox/git-validate.ts";
import { findBwrap } from "../src/fork/sandbox/runtime.ts";
import { seccompArch, seccompFilter } from "../src/fork/sandbox/seccomp.ts";

const bwrap = findBwrap();

describe.skipIf(!bwrap || !seccompArch())("fork: confined check of a sandboxed command's packs", () => {
	let root: string;
	let real: string;
	let other: string;
	let seccomp: string;
	let scratch: string;
	const env = {
		...process.env,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_AUTHOR_NAME: "Test",
		GIT_AUTHOR_EMAIL: "test@example.invalid",
		GIT_COMMITTER_NAME: "Test",
		GIT_COMMITTER_EMAIL: "test@example.invalid",
	};
	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", ["-c", "gc.auto=0", "-c", "maintenance.auto=false", ...args], {
			cwd,
			env,
			encoding: "utf8",
		}).trim();
	const commit = (cwd: string, file: string, text: string) => {
		writeFileSync(join(cwd, file), text);
		git(cwd, "add", file);
		git(cwd, "commit", "-qm", file);
		return git(cwd, "rev-parse", "HEAD");
	};
	/** A pack of `objects` (`git rev-list --objects` style lines on stdin), named and read as Git writes it. */
	const pack = (cwd: string, objects: string) => {
		const base = join(root, `p${Math.random().toString(36).slice(2)}`);
		const name = execFileSync("git", ["pack-objects", "-q", base], { cwd, env, input: objects, encoding: "utf8" });
		const hash = name.trim();
		return {
			path: `objects/pack/pack-${hash}.pack`,
			bytes: readFileSync(`${base}-${hash}.pack`),
			idx: readFileSync(`${base}-${hash}.idx`),
		};
	};
	const verify = (
		packs: Array<{ path: string; bytes: Buffer }>,
		stores = [join(real, ".git", "objects")],
		loose?: string,
	) => verifyPacks({ sandbox: { bwrap: bwrap!, seccomp }, packs, stores, loose, format: "sha1", scratch });

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "prism-git-packs-"));
		seccomp = join(root, "seccomp.bpf");
		writeFileSync(seccomp, seccompFilter(seccompArch()!));
		scratch = join(root, "scratch");
		mkdirSync(scratch);
		real = join(root, "real");
		mkdirSync(real);
		git(real, "init", "-q", "-b", "main");
		commit(real, "a", "a\n");
		other = join(root, "other");
		git(root, "clone", "-q", real, other);
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("accepts a fetched pack whose objects name the repository's, rebuilds its index and gives their types", async () => {
		const before = git(other, "rev-parse", "HEAD");
		commit(other, "b", "b\n");
		const tip = commit(other, "c", "c\n");
		const fetched = pack(other, git(other, "rev-list", "--objects", `${before}..${tip}`));

		const result = await verify([fetched]);
		expect(result.refused).toEqual([]);
		const verified = result.packs.get(fetched.path)!;
		expect(verified.idx.equals(fetched.idx)).toBe(true);
		const types = git(other, "cat-file", "--batch-check=%(objectname) %(objecttype)", "--batch-all-objects")
			.split("\n")
			.map((line) => line.split(" "));
		for (const [oid, type] of verified.objects) expect(types).toContainEqual([oid, type]);
		expect(verified.objects.size).toBe(git(other, "rev-list", "--objects", `${before}..${tip}`).split("\n").length);

		// The validation then accepts the pack and a branch on its commit.
		const store = gitObjectStore(join(real, ".git", "objects"), "sha1");
		const idxPath = fetched.path.replace(/\.pack$/, ".idx");
		const validation = await validateGitChanges({
			changes: [
				{ path: fetched.path, before: null, after: fetched.bytes },
				{ path: idxPath, before: null, after: Buffer.from("not the index Git wrote") },
				{ path: "refs/heads/fetched", before: null, after: Buffer.from(`${tip}\n`) },
			],
			format: "sha1",
			existing: store,
			packs: result.packs,
			writable: [],
		});
		await store.close();
		expect(validation.refused).toEqual([]);
		expect(validation.accepted.find((change) => change.path === idxPath)?.after).toEqual(fetched.idx);
	});

	it("refuses a pack whose objects name objects that exist nowhere, corrupt bytes and a wrong name", async () => {
		const before = git(other, "rev-parse", "HEAD");
		const tip = commit(other, "b", "b\n");
		const fetched = pack(other, git(other, "rev-list", "--objects", `${before}..${tip}`));
		// Without the repository's objects, the new commit's parent is missing.
		expect((await verify([fetched], [])).refused[0]?.reason).toMatch(/^is a pack Git refused: .*expected object/);

		const corrupt = Buffer.from(fetched.bytes);
		corrupt[corrupt.length - 30] ^= 0xff;
		rmSync(join(scratch, "work"), { recursive: true });
		expect((await verify([{ path: fetched.path, bytes: corrupt }])).refused[0]?.reason).toMatch(
			/^is a pack Git refused: /,
		);

		rmSync(join(scratch, "work"), { recursive: true });
		const misnamed = { path: `objects/pack/pack-${"1".repeat(40)}.pack`, bytes: fetched.bytes };
		expect((await verify([misnamed])).refused[0]?.reason).toMatch(/^is named after another pack than its content/);
	});

	it("refuses objects Git's own checks refuse: a tree with a .git entry", async () => {
		const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: other, env, input: "x" })
			.toString()
			.trim();
		const tree = execFileSync("git", ["mktree", "--missing"], {
			cwd: other,
			env,
			input: `100644 blob ${blob}\t.GIT\n`,
		})
			.toString()
			.trim();
		const result = await verify([pack(other, `${tree}\n${blob}\n`)]);
		expect(result.refused[0]?.reason).toMatch(/^is a pack Git refused: .*(\.git|dotgit)/i);
	});

	it("lets a pack name the command's new loose objects, never the packs it wrote beside them", async () => {
		const before = git(other, "rev-parse", "HEAD");
		const middle = commit(other, "b", "b\n");
		const tip = commit(other, "c", "c\n");
		// The command's folder: the middle commit's objects loose, the tip's in the pack to check.
		const loose = join(root, "loose");
		mkdirSync(loose);
		const middleObjects = git(other, "rev-list", "--objects", `${before}..${middle}`)
			.split("\n")
			.map((line) => line.split(" ")[0]!);
		for (const oid of middleObjects) {
			mkdirSync(join(loose, oid.slice(0, 2)), { recursive: true });
			cpSync(
				join(other, ".git", "objects", oid.slice(0, 2), oid.slice(2)),
				join(loose, oid.slice(0, 2), oid.slice(2)),
			);
		}
		const fetched = pack(other, git(other, "rev-list", "--objects", `${middle}..${tip}`));
		expect((await verify([fetched], [join(real, ".git", "objects")], loose)).refused).toEqual([]);

		// The same middle objects in a pack the command wrote: not something the check may rely on.
		rmSync(join(scratch, "work"), { recursive: true });
		for (const name of readdirSync(loose)) rmSync(join(loose, name), { recursive: true });
		const planted = pack(other, git(other, "rev-list", "--objects", `${before}..${middle}`));
		mkdirSync(join(loose, "pack"));
		writeFileSync(join(loose, planted.path.slice("objects/".length)), planted.bytes);
		writeFileSync(join(loose, planted.path.slice("objects/".length).replace(/\.pack$/, ".idx")), planted.idx);
		expect((await verify([fetched], [join(real, ".git", "objects")], loose)).refused[0]?.reason).toMatch(
			/^is a pack Git refused: .*expected object/,
		);
	});

	it("checks the packs of one command in order, so one may name the objects of an earlier one", async () => {
		const before = git(other, "rev-parse", "HEAD");
		const middle = commit(other, "b", "b\n");
		const tip = commit(other, "c", "c\n");
		const first = pack(other, git(other, "rev-list", "--objects", `${before}..${middle}`));
		const second = pack(other, git(other, "rev-list", "--objects", `${middle}..${tip}`));
		const result = await verify([first, second]);
		expect(result.refused).toEqual([]);
		expect([...result.packs.keys()]).toEqual([first.path, second.path]);
	});
});
