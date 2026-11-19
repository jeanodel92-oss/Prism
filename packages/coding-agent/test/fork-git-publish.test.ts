// fork: the Git changes of a sandboxed command are published with Git's own locks,
// compared file by file to what they were before the command, with a journal that finishes or undoes a publication
// cut by a crash. Throwaway repositories only; Git runs here to make and check them, never in the module.
import { execFileSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	captureGitStart,
	type GitChange,
	publishGitChanges,
	recoverGitPublications,
} from "../src/fork/sandbox/git-publish.ts";

const env = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@example.invalid",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@example.invalid",
};
const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** The regular files under `root` that `keep` keeps, relative to it. */
function walk(root: string, keep: (path: string) => boolean, prefix = ""): string[] {
	return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
		const path = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) return walk(root, keep, path);
		return entry.isFile() && keep(path) ? [path] : [];
	});
}
const files = (root: string) => walk(root, (path) => !path.endsWith(".lock"));
const locks = (gitDir: string) => walk(gitDir, (path) => path.endsWith(".lock"));

/** What a command changed in `after` compared to `before`, as the private layer would show it. */
function changes(before: string, after: string): GitChange[] {
	const read = (root: string, path: string) => (existsSync(join(root, path)) ? readFileSync(join(root, path)) : null);
	const paths = [...new Set([...files(before), ...files(after)])];
	return paths
		.map((path) => ({ path, before: read(before, path), after: read(after, path) }))
		.filter((change) => !(change.before && change.after && change.before.equals(change.after)));
}

describe("fork: publishing a sandboxed command's Git changes", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true });
	});

	/**
	 * A repository with one commit and a branch `topic` (packed if asked), and a copy of it standing for the
	 * command's view, taken when the command starts.
	 */
	function setup(packed = false) {
		const root = mkdtempSync(join(tmpdir(), "prism-git-publish-"));
		dirs.push(root);
		const repo = join(root, "repo");
		mkdirSync(repo);
		git(repo, "init", "-q", "-b", "main");
		writeFileSync(join(repo, "a"), "a\n");
		git(repo, "add", "a");
		git(repo, "commit", "-q", "-m", "first");
		git(repo, "branch", "topic");
		if (packed) git(repo, "pack-refs", "--all");
		const gitDir = join(repo, ".git");
		const copy = join(root, "copy");
		cpSync(repo, copy, { recursive: true });
		const snapshot = join(root, "snapshot");
		cpSync(gitDir, snapshot, { recursive: true });
		return { root, repo, gitDir, copy, snapshot, start: captureGitStart(gitDir), journal: join(root, "journal") };
	}

	/** In the copy: a commit of `b`, and `topic` deleted; `b` is also written in the repository's work tree. */
	function command(s: ReturnType<typeof setup>): GitChange[] {
		for (const tree of [s.copy, s.repo]) writeFileSync(join(tree, "b"), "b\n");
		git(s.copy, "add", "b");
		git(s.copy, "commit", "-q", "-m", "second");
		git(s.copy, "branch", "-q", "-D", "topic");
		return changes(s.snapshot, join(s.copy, ".git"));
	}

	it("publishes a commit and a branch deletion as Git itself would", async () => {
		const s = setup();
		const result = await publishGitChanges(s.gitDir, s.start, command(s), s.journal);
		expect(result.published).toBe(true);
		expect(git(s.repo, "log", "--format=%s", "main")).toBe("second\nfirst");
		expect(git(s.repo, "branch", "--list", "topic")).toBe("");
		expect(git(s.repo, "status", "--porcelain")).toBe("");
		git(s.repo, "fsck", "--strict", "--no-dangling");
		expect(locks(s.gitDir)).toEqual([]);
		expect(readdirSync(s.journal)).toEqual([]);
	});

	it("publishes the packs of a git gc, keeping the loose objects for the host's own gc", async () => {
		const s = setup();
		git(s.copy, "gc", "-q");
		const packed = changes(s.snapshot, join(s.copy, ".git")).filter(
			(change) => !change.path.startsWith("objects/info/") && !/\.(rev|bitmap)$/.test(change.path),
		);
		expect(packed.some((change) => change.path.endsWith(".pack"))).toBe(true);
		expect((await publishGitChanges(s.gitDir, s.start, packed, s.journal)).published).toBe(true);
		expect(git(s.repo, "log", "--format=%s", "main")).toBe("first");
		expect(git(s.repo, "rev-parse", "topic")).toBe(git(s.repo, "rev-parse", "main"));
		git(s.repo, "fsck", "--strict", "--no-dangling");
	});

	it("waits for a host Git's lock, then refuses without touching it", async () => {
		const s = setup();
		const head = git(s.repo, "rev-parse", "main");
		writeFileSync(join(s.gitDir, "index.lock"), "host");
		const result = await publishGitChanges(s.gitDir, s.start, command(s), s.journal, { lockAttempts: 3 });
		expect(result).toMatchObject({ published: false, conflicts: ["index"] });
		expect(readFileSync(join(s.gitDir, "index.lock"), "utf8")).toBe("host");
		expect(locks(s.gitDir)).toEqual(["index.lock"]);
		expect(git(s.repo, "rev-parse", "main")).toBe(head);
		expect(readdirSync(s.journal)).toEqual([]);
	});

	it("refuses everything when the host changed a file meanwhile, and names it", async () => {
		const s = setup();
		const ours = command(s);
		writeFileSync(join(s.repo, "c"), "c\n");
		git(s.repo, "add", "c");
		git(s.repo, "commit", "-q", "-m", "host");
		const result = await publishGitChanges(s.gitDir, s.start, ours, s.journal);
		expect(result.published).toBe(false);
		if (!result.published) expect(result.conflicts).toEqual(expect.arrayContaining(["index", "refs/heads/main"]));
		expect(git(s.repo, "log", "--format=%s", "main")).toBe("host\nfirst");
		expect(git(s.repo, "rev-parse", "topic")).toBe(git(s.repo, "rev-parse", "main~1"));
		git(s.repo, "fsck", "--strict");
		expect(locks(s.gitDir)).toEqual([]);
	});

	it("keeps the lines a host appended to a ref log, and holds the ref's lock meanwhile", async () => {
		const s = setup();
		const log = join(s.gitDir, "logs/refs/heads/topic");
		const before = readFileSync(log);
		const after = Buffer.concat([before, Buffer.from("ours\n")]);
		const change = { path: "logs/refs/heads/topic", before, after };
		writeFileSync(log, Buffer.concat([before, Buffer.from("host\n")]));
		expect((await publishGitChanges(s.gitDir, s.start, [change], s.journal)).published).toBe(true);
		expect(readFileSync(log, "utf8")).toBe(`${before}host\nours\n`);

		// Git appends to a ref's log under the ref's lock, not the log's: a Git updating `topic` stops us.
		writeFileSync(join(s.gitDir, "refs/heads/topic.lock"), "host");
		const held = {
			...change,
			before: readFileSync(log),
			after: Buffer.concat([readFileSync(log), Buffer.from("x\n")]),
		};
		const result = await publishGitChanges(s.gitDir, s.start, [held], s.journal, { lockAttempts: 2 });
		expect(result).toMatchObject({ published: false, conflicts: ["refs/heads/topic"] });
		expect(readFileSync(log, "utf8")).toBe(`${before}host\nours\n`);
	});

	it("refuses a ref made a file when the host packed a new value for it meanwhile", async () => {
		const s = setup(true);
		git(s.copy, "commit", "-q", "--allow-empty", "-m", "ours");
		git(s.copy, "update-ref", "refs/heads/topic", "HEAD");
		const ours = changes(s.snapshot, join(s.copy, ".git"));
		expect(ours.find((change) => change.path === "refs/heads/topic")?.before).toBeNull();

		const host = git(s.repo, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "host");
		git(s.repo, "update-ref", "refs/heads/topic", host);
		git(s.repo, "pack-refs", "--all");
		expect(existsSync(join(s.gitDir, "refs/heads/topic"))).toBe(false);
		const result = await publishGitChanges(s.gitDir, s.start, ours, s.journal);
		expect(result).toMatchObject({ published: false, conflicts: ["packed-refs"] });
		expect(git(s.repo, "rev-parse", "topic")).toBe(host);
		expect(locks(s.gitDir)).toEqual([]);
	});

	it("refuses a Git folder replaced during the command, and paths that leave it", async () => {
		const s = setup();
		const other = join(s.root, "other");
		mkdirSync(other);
		const ours = command(s);
		const replaced = { ...s.start, identity: captureGitStart(other).identity };
		expect(await publishGitChanges(s.gitDir, replaced, ours, s.journal)).toMatchObject({ published: false });
		for (const path of ["../outside", "refs/../../outside", "/etc/passwd", "refs//x", "index.lock"]) {
			const change = { path, before: null, after: Buffer.from("x") };
			expect(await publishGitChanges(s.gitDir, s.start, [change], s.journal)).toMatchObject({ published: false });
		}
		expect(existsSync(join(s.root, "outside"))).toBe(false);
	});

	it("does not follow a folder swapped for a link, before or after it is opened", async () => {
		const s = setup();
		const ours = command(s);
		const heads = join(s.gitDir, "refs/heads");
		const main = readFileSync(join(heads, "main"), "utf8");
		// The same contents as the real ref, so that only the anchoring, not the comparison, stops the write.
		const outside = () => {
			const path = mkdtempSync(join(s.root, "outside-"));
			writeFileSync(join(path, "main"), main);
			return path;
		};
		const swap = (to: string) => {
			renameSync(heads, `${heads}-real`);
			symlinkSync(to, heads);
		};

		const first = outside();
		const refused = await publishGitChanges(s.gitDir, s.start, ours, s.journal, {
			afterStep: (step) => step === "intent" && swap(first),
		});
		expect(refused.published).toBe(false);
		expect(readFileSync(join(first, "main"), "utf8")).toBe(main);
		expect(readdirSync(first)).toEqual(["main"]);
		rmSync(heads);
		renameSync(`${heads}-real`, heads);
		expect(locks(s.gitDir)).toEqual([]);

		const second = outside();
		const published = await publishGitChanges(s.gitDir, s.start, ours, s.journal, {
			afterStep: (step) => step === "commit" && swap(second),
		});
		expect(published.published).toBe(true);
		expect(readFileSync(join(second, "main"), "utf8")).toBe(main);
		expect(readFileSync(join(`${heads}-real`, "main"), "utf8").trim()).toBe(git(s.copy, "rev-parse", "main"));
	});

	it("keeps the journal and the remaining locks when an error interrupts the renames, for recovery to finish", async () => {
		// An ordinary error, not a crash: a rename that fails (a folder now where the ref was), or a failure once
		// every rename is done.
		const s = setup();
		const ours = command(s);
		const main = join(s.gitDir, "refs/heads/main");
		const result = await publishGitChanges(s.gitDir, s.start, ours, s.journal, {
			afterStep: (step) => {
				if (step !== "commit") return;
				rmSync(main);
				mkdirSync(join(main, "obstacle"), { recursive: true });
			},
		});
		expect(result).toMatchObject({ published: false });
		if (!result.published) expect(result.reason).toContain("the journal is kept");
		expect(readdirSync(s.journal)).toHaveLength(1);
		expect(locks(s.gitDir)).toEqual(["refs/heads/main.lock", "refs/heads/topic.lock"]);
		rmSync(main, { recursive: true });
		expect(recoverGitPublications(s.journal)).toEqual([`${s.gitDir}: publication finished`]);
		expect(git(s.repo, "log", "--format=%s", "main")).toBe("second\nfirst");
		expect(git(s.repo, "branch", "--list", "topic")).toBe("");
		git(s.repo, "fsck", "--strict");
		expect(locks(s.gitDir)).toEqual([]);

		const t = setup();
		const after = await publishGitChanges(t.gitDir, t.start, command(t), t.journal, {
			afterStep: (step) => {
				if (step === "renamed") throw new Error("sync failed");
			},
		});
		expect(after).toMatchObject({ published: false });
		expect(readdirSync(t.journal)).toHaveLength(1);
		expect(recoverGitPublications(t.journal)).toEqual([`${t.gitDir}: publication finished`]);
		expect(git(t.repo, "log", "--format=%s", "main")).toBe("second\nfirst");
		expect(locks(t.gitDir)).toEqual([]);
	});

	it("leaves alone the journal and locks of a publication still running", async () => {
		const s = setup();
		let meanwhile: { recovered: string[]; locks: string[] } | undefined;
		const result = await publishGitChanges(s.gitDir, s.start, command(s), s.journal, {
			afterStep: (step) => {
				// Another session starts its sandbox while this publication holds its locks.
				if (step === "locked") meanwhile = { recovered: recoverGitPublications(s.journal), locks: locks(s.gitDir) };
			},
		});
		expect(meanwhile?.recovered).toEqual([]);
		expect(meanwhile?.locks.length).toBeGreaterThan(0);
		expect(result).toMatchObject({ published: true });
		expect(git(s.repo, "log", "--format=%s", "main")).toBe("second\nfirst");
		expect(locks(s.gitDir)).toEqual([]);
	});

	it("after a crash, finishes a committed publication and undoes an earlier one, leaving a host's lock alone", async () => {
		const module = pathToFileURL(join(import.meta.dirname, "../src/fork/sandbox/git-publish.ts")).href;
		for (const step of ["intent", "locked", "commit", "renamed"] as const) {
			const s = setup();
			const head = git(s.repo, "rev-parse", "main");
			const ours = command(s);
			const input = join(s.root, "input.json");
			const encode = (bytes: GitChange["after"]) => (Buffer.isBuffer(bytes) ? bytes.toString("base64") : null);
			writeFileSync(
				input,
				JSON.stringify({
					start: { identity: s.start.identity, packedRefs: encode(s.start.packedRefs) },
					changes: ours.map((change) => ({
						...change,
						before: encode(change.before),
						after: encode(change.after),
					})),
				}),
			);
			const script = `import { readFileSync } from "node:fs";
import { publishGitChanges } from ${JSON.stringify(module)};
const decode = (text) => (text === null ? null : Buffer.from(text, "base64"));
const input = JSON.parse(readFileSync(${JSON.stringify(input)}, "utf8"));
const start = { identity: input.start.identity, packedRefs: decode(input.start.packedRefs) };
const changes = input.changes.map((change) => ({ ...change, before: decode(change.before), after: decode(change.after) }));
await publishGitChanges(${JSON.stringify(s.gitDir)}, start, changes, ${JSON.stringify(s.journal)}, {
	afterStep: (step) => { if (step === ${JSON.stringify(step)}) process.kill(process.pid, "SIGKILL"); },
});`;
			expect(() =>
				execFileSync(process.execPath, ["--input-type=module", "-e", script], { stdio: "pipe" }),
			).toThrow();
			expect(readdirSync(s.journal)).toHaveLength(1);
			// A host Git taking the lock Prism meant to take, with the very contents Prism would have written; or
			// taking it after someone removed Prism's stale lock, as Git advises.
			const index = ours.find((change) => change.path === "index")!.after!;
			const host = step === "intent" || step === "locked";
			if (host) {
				rmSync(join(s.gitDir, "index.lock"), { force: true });
				if (!Buffer.isBuffer(index)) throw new Error("Expected index bytes");
				writeFileSync(join(s.gitDir, "index.lock"), index);
			}

			const recovered = recoverGitPublications(s.journal);
			const committed = step === "commit" || step === "renamed";
			expect(recovered).toContain(`${s.gitDir}: ${committed ? "publication finished" : "publication undone"}`);
			expect(readdirSync(s.journal)).toEqual([]);
			if (step === "intent") expect(recovered).toContain(`${s.gitDir}: index.lock left in place, maybe Prism's`);
			expect(locks(s.gitDir)).toEqual(host ? ["index.lock"] : []);
			if (host) rmSync(join(s.gitDir, "index.lock"));
			if (committed) {
				expect(git(s.repo, "log", "--format=%s", "main")).toBe("second\nfirst");
				expect(git(s.repo, "branch", "--list", "topic")).toBe("");
				expect(git(s.repo, "status", "--porcelain")).toBe("");
			} else {
				expect(git(s.repo, "rev-parse", "main")).toBe(head);
				expect(git(s.repo, "rev-parse", "topic")).toBe(head);
			}
			git(s.repo, "fsck", "--strict");
		}
	});
});
