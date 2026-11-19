import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitObjectStore, sanitizedIndex } from "../src/fork/sandbox/git-validate.ts";

function checksummed(body: Buffer): Buffer {
	return Buffer.concat([body, createHash("sha1").update(body).digest()]);
}

function indexHeader(version: number, count: number): Buffer {
	const header = Buffer.alloc(12);
	header.write("DIRC", 0, "latin1");
	header.writeUInt32BE(version, 4);
	header.writeUInt32BE(count, 8);
	return header;
}

/** A v3 entry with extended flags, padded to 8 bytes as Git writes v2/v3 entries. */
function v3Entry(name: string, extended: number): Buffer {
	const stat = Buffer.alloc(40);
	stat.writeUInt32BE(0o100644, 24);
	const flags = Buffer.alloc(4);
	flags.writeUInt16BE(0x4000 | name.length, 0);
	flags.writeUInt16BE(extended, 2);
	const unpadded = Buffer.concat([stat, Buffer.alloc(20, 1), flags, Buffer.from(name)]);
	const length = Math.ceil((unpadded.length + 1) / 8) * 8;
	return Buffer.concat([unpadded, Buffer.alloc(length - unpadded.length)]);
}

describe("index entries Git can read", () => {
	// Git stops on any extended flag other than intent-to-add and skip-worktree.
	it("refuses reserved extended flags and keeps intent-to-add and skip-worktree", () => {
		const index = (extended: number) => checksummed(Buffer.concat([indexHeader(3, 1), v3Entry("a", extended)]));
		expect(sanitizedIndex(index(0x8000), "sha1").reason).toBe("Unsupported extended index flags");
		expect(sanitizedIndex(index(0x0001), "sha1").reason).toBe("Unsupported extended index flags");
		expect(sanitizedIndex(index(0x4000), "sha1")).toMatchObject({ blobs: ["01".repeat(20)] });
		expect(sanitizedIndex(index(0x2000), "sha1")).toMatchObject({ blobs: [] });
		expect(sanitizedIndex(index(0x6000), "sha1").reason).toBeUndefined();
	});

	// a five-byte v4 prefix length overflowed 32 bits and kept the whole previous path.
	it("refuses a v4 prefix length longer than the previous path, however it is encoded", () => {
		const v4Entry = (strip: number[], name: string) => {
			const stat = Buffer.alloc(40);
			stat.writeUInt32BE(0o100644, 24);
			const flags = Buffer.alloc(2);
			flags.writeUInt16BE(name.length);
			return Buffer.concat([
				stat,
				Buffer.alloc(20, 1),
				flags,
				Buffer.from(strip),
				Buffer.from(name),
				Buffer.from([0]),
			]);
		};
		const index = checksummed(
			Buffer.concat([indexHeader(4, 2), v4Entry([0], "dir/a"), v4Entry([0x86, 0xff, 0xff, 0xff, 0x7f], "b")]),
		);
		expect(sanitizedIndex(index, "sha1").reason).toBe("Invalid index path");
	});
});

// fork: a command hid its change to a tracked file from the user's `git status`
// by flagging it "assume unchanged" or "skip worktree" in the index Prism published.
describe("index flags that hide a change from git status", () => {
	let repo: string;
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", repo, ...args], {
			encoding: "utf8",
			env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
		});
	const index = () => readFileSync(join(repo, ".git", "index"));
	const none = { assumeUnchanged: new Set<string>(), skipWorktree: new Set<string>() };

	beforeEach(() => {
		repo = mkdtempSync(join(tmpdir(), "prism-index-flags-"));
		git("init", "-q");
		for (const name of ["build.sh", "kept.sh", "other.sh"]) writeFileSync(join(repo, name), "echo ok\n");
		git("add", ".");
		git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
	});
	afterEach(() => rmSync(repo, { recursive: true, force: true }));

	it("clears the flags the command set, so git status shows the change again", () => {
		const before = sanitizedIndex(index(), "sha1");
		if (before.reason !== undefined) throw new Error(before.reason);
		writeFileSync(join(repo, "build.sh"), "echo ok\necho hostile\n");
		writeFileSync(join(repo, "other.sh"), "echo ok\necho hostile\n");
		git("update-index", "--assume-unchanged", "build.sh");
		git("update-index", "--skip-worktree", "other.sh");
		expect(git("status", "--short")).toBe("");
		const after = sanitizedIndex(index(), "sha1", { flags: before.flags, sparse: false });
		if (after.reason !== undefined) throw new Error(after.reason);
		expect(after.cleared.sort()).toEqual(["build.sh", "other.sh"]);
		writeFileSync(join(repo, ".git", "index"), after.index);
		expect(git("ls-files", "-v")).toBe("H build.sh\nH kept.sh\nH other.sh\n");
		expect(git("status", "--short")).toBe(" M build.sh\n M other.sh\n");
	});

	it("keeps the flags the user set before the command, and skip-worktree in a sparse checkout", () => {
		git("update-index", "--assume-unchanged", "kept.sh");
		git("update-index", "--skip-worktree", "build.sh");
		const before = sanitizedIndex(index(), "sha1");
		if (before.reason !== undefined) throw new Error(before.reason);
		git("update-index", "--skip-worktree", "other.sh");
		const after = sanitizedIndex(index(), "sha1", { flags: before.flags, sparse: false });
		if (after.reason !== undefined) throw new Error(after.reason);
		expect(after.cleared).toEqual(["other.sh"]);
		writeFileSync(join(repo, ".git", "index"), after.index);
		expect(git("ls-files", "-v")).toBe("S build.sh\nh kept.sh\nH other.sh\n");
		git("update-index", "--skip-worktree", "other.sh");
		const sparse = sanitizedIndex(index(), "sha1", { flags: none, sparse: true });
		expect(sparse).toMatchObject({ cleared: ["kept.sh"] });
	});
});

describe("pack deltas far from their base", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fork-git-pack-"));
		mkdirSync(join(dir, "pack"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	/** Git's OFS_DELTA offset encoding: big-endian 7-bit groups, each continuation adding one. */
	function ofsVarint(distance: number): number[] {
		let rest = distance;
		const bytes = [rest % 128];
		rest = Math.floor(rest / 128);
		while (rest > 0) {
			rest -= 1;
			bytes.unshift(128 | (rest % 128));
			rest = Math.floor(rest / 128);
		}
		return bytes;
	}

	/** A one-entry pack: a blob header at 12 and, at `deltaOffset`, an OFS_DELTA naming it `distance` back. */
	function writePack(deltaOffset: number, distance: number): string {
		const name = "ab".repeat(20);
		const idx = Buffer.alloc(8 + 1024 + 20 + 4 + 4 + 8);
		idx.writeUInt32BE(0xff744f63, 0);
		idx.writeUInt32BE(2, 4);
		for (let byte = 0xab; byte < 256; byte++) idx.writeUInt32BE(1, 8 + byte * 4);
		Buffer.from(name, "hex").copy(idx, 8 + 1024);
		const large = deltaOffset >= 0x80000000;
		idx.writeUInt32BE(large ? 0x80000000 : deltaOffset, 8 + 1024 + 20 + 4);
		if (large) idx.writeBigUInt64BE(BigInt(deltaOffset), 8 + 1024 + 20 + 8);
		writeFileSync(join(dir, "pack", "pack-1.idx"), idx);
		// Sparse: only the two headers are written, whatever the pack's apparent size.
		const fd = openSync(join(dir, "pack", "pack-1.pack"), "w");
		try {
			writeSync(fd, Buffer.from("PACK\0\0\0\x02\0\0\0\x02", "latin1"), 0, 12, 0);
			writeSync(fd, Buffer.from([0x35]), 0, 1, 12);
			const delta = Buffer.from([0x65, ...ofsVarint(distance), 0, 0, 0, 0]);
			writeSync(fd, delta, 0, delta.length, deltaOffset);
		} finally {
			closeSync(fd);
		}
		return name;
	}

	// a base more than 2 GiB back gave a negative 32-bit distance.
	it("finds the base of a delta 2.5 GiB away", async () => {
		const deltaOffset = 12 + 2.5 * 1024 ** 3;
		const name = writePack(deltaOffset, deltaOffset - 12);
		const store = gitObjectStore(dir, "sha1");
		try {
			expect(await store.type(name)).toBe("blob");
		} finally {
			await store.close();
		}
	});

	it("treats a distance past the start of the pack as no object", async () => {
		const name = writePack(100, 1000);
		const store = gitObjectStore(dir, "sha1");
		try {
			expect(await store.type(name)).toBeUndefined();
		} finally {
			await store.close();
		}
	});
});
