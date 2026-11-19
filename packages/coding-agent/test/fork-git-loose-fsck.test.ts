// fork: use Git's fsck for loose bytes, including objects not reachable from a ref.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type PackSandbox, verifyPacks } from "../src/fork/sandbox/git-packs.ts";
import type { GitChange } from "../src/fork/sandbox/git-publish.ts";
import {
	gitObjectStore,
	type HashFormat,
	type ObjectType,
	type ValidationInput,
	validateGitChanges,
} from "../src/fork/sandbox/git-validate.ts";
import { findBwrap } from "../src/fork/sandbox/runtime.ts";
import { seccompArch, seccompFilter } from "../src/fork/sandbox/seccomp.ts";
import { gitFsckTransport } from "./fork-git-fsck-harness.ts";

const bwrap = findBwrap();
const arch = seccompArch();

for (const confined of [false, true]) {
	describe.skipIf(confined && (!bwrap || !arch))(
		`fork: loose fsck ${confined ? "with bubblewrap" : "with real Git and stubbed transport"}`,
		() => {
			let root: string;
			let storePath: string;
			let sandbox: PackSandbox;
			let format: HashFormat;

			beforeEach(() => {
				root = mkdtempSync(join(tmpdir(), "prism-loose-fsck-"));
				storePath = join(root, "existing");
				mkdirSync(storePath);
				format = "sha1";
				if (confined) {
					const seccomp = join(root, "seccomp.bpf");
					writeFileSync(seccomp, seccompFilter(arch!));
					sandbox = { bwrap: bwrap!, seccomp };
				} else sandbox = gitFsckTransport(root);
			});
			afterEach(() => rmSync(root, { recursive: true, force: true }));

			function object(type: ObjectType, body: Buffer | string) {
				const content = Buffer.from(body);
				const raw = Buffer.concat([Buffer.from(`${type} ${content.length}\0`), content]);
				const oid = createHash(format).update(raw).digest("hex");
				const change: GitChange = {
					path: `objects/${oid.slice(0, 2)}/${oid.slice(2)}`,
					before: null,
					after: deflateSync(raw),
				};
				return { oid, change, type, body: content };
			}
			function tree(entries: Array<[string, string, string]>) {
				return object(
					"tree",
					Buffer.concat(
						entries.map(([mode, name, oid]) =>
							Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(oid, "hex")]),
						),
					),
				);
			}
			async function validate(changes: GitChange[], extra: Partial<ValidationInput> = {}) {
				const existing = gitObjectStore(storePath, format);
				try {
					return await validateGitChanges({
						changes,
						format,
						existing,
						writable: [],
						loose: { sandbox, stores: [storePath], scratch: root },
						...extra,
					});
				} finally {
					await existing.close();
				}
			}
			function expectRefused(result: Awaited<ReturnType<typeof validate>>, path: string, reason: string) {
				expect(result.accepted).toEqual([]);
				expect(result.refused).toContainEqual({ path, reason: expect.stringContaining(reason) });
			}

			it.each(["git~1", ".git.", ".git ", ".git::$INDEX_ALLOCATION", ".g\u200cit", ".git\ufeff"])(
				"L11 refuses .git filesystem alias %j, accepts a normal name",
				async (name) => {
					const blob = object("blob", "content");
					const bad = tree([["100644", name, blob.oid]]);
					expectRefused(await validate([blob.change, bad.change]), bad.change.path, "hasDotgit");
					const good = tree([["100644", "git-not-metadata", blob.oid]]);
					expect((await validate([blob.change, good.change])).refused).toEqual([]);
				},
			);

			it.each([".gitmodules.", ".gitmodules ", ".gitmodules::$DATA", "gitmod~1", "gi7eba~1", ".git\u200cmodules"])(
				"L11 refuses .gitmodules symlink alias %j, accepts an ordinary symlink",
				async (name) => {
					const link = object("blob", "target");
					const bad = tree([["120000", name, link.oid]]);
					expectRefused(await validate([link.change, bad.change]), bad.change.path, "gitmodulesSymlink");
					const good = tree([["120000", "link", link.oid]]);
					expect((await validate([link.change, good.change])).refused).toEqual([]);
				},
			);

			it.each([
				['[submodule "../escape"]\npath = lib\nurl = https://example.invalid/lib\n', "gitmodulesName"],
				['[submodule "lib"]\npath = -option\nurl = https://example.invalid/lib\n', "gitmodulesPath"],
				['[submodule "lib"]\npath = lib\nurl = -option\n', "gitmodulesUrl"],
				[
					'[submodule "lib"]\npath = lib\nurl = https://example.invalid/lib\nupdate = !command\n',
					"gitmodulesUpdate",
				],
			])("L11 refuses unsafe .gitmodules (%s), accepts ordinary submodules", async (content, reason) => {
				const blob = object("blob", content);
				const bad = tree([["100644", ".gitmodules", blob.oid]]);
				expectRefused(await validate([bad.change, blob.change]), bad.change.path, reason);
				const normal = object("blob", '[submodule "lib"]\npath = lib\nurl = https://example.invalid/lib\n');
				const good = tree([["100644", ".gitmodules", normal.oid]]);
				expect((await validate([good.change, normal.change])).refused).toEqual([]);
			});

			it("L11 checks an existing blob newly named .gitmodules without fscking unrelated old trees", async () => {
				const blob = object("blob", '[submodule "lib"]\npath = -option\n');
				const oldTree = tree([["100644", "git~1", blob.oid]]);
				for (const { change } of [blob, oldTree]) {
					mkdirSync(join(root, "existing", change.path.slice(8), ".."), { recursive: true });
					if (!Buffer.isBuffer(change.after)) throw new Error("Expected loose bytes");
					writeFileSync(join(root, "existing", change.path.slice(8)), change.after);
				}
				const bad = tree([["100644", ".gitmodules", blob.oid]]);
				expectRefused(await validate([bad.change]), bad.change.path, "gitmodulesPath");
				const good = tree([["100644", "ordinary", blob.oid]]);
				expect((await validate([good.change])).refused).toEqual([]);
			});

			it("L11 refuses unsorted trees, accepts Git's ordering of directory prefixes and raw UTF-8 bytes", async () => {
				const blob = object("blob", "content");
				const dir = tree([]);
				const bad = tree([
					["40000", "a", dir.oid],
					["100644", "a.c", blob.oid],
				]);
				expectRefused(await validate([blob.change, dir.change, bad.change]), bad.change.path, "treeNotSorted");
				const good = tree([
					["100644", "a.c", blob.oid],
					["40000", "a", dir.oid],
					["100644", "a0", blob.oid],
					["100644", "é", blob.oid],
				]);
				expect((await validate([blob.change, dir.change, good.change])).refused).toEqual([]);
			});

			it("L11 checks SHA-256 loose trees and accepts normal commits and tags", async () => {
				format = "sha256";
				const blob = object("blob", "content");
				const bad = tree([["100644", ".git.", blob.oid]]);
				expectRefused(await validate([blob.change, bad.change]), bad.change.path, "hasDotgit");
				const good = tree([["100644", "file", blob.oid]]);
				const commit = object(
					"commit",
					`tree ${good.oid}\nauthor A <a@x> 1 +0000\ncommitter A <a@x> 1 +0000\n\ncommit\n`,
				);
				const tag = object("tag", `object ${commit.oid}\ntype commit\ntag v1\ntagger A <a@x> 1 +0000\n\ntag\n`);
				expect((await validate([blob.change, good.change, commit.change, tag.change])).refused).toEqual([]);
			});

			it("refuses loose objects without a confined checker", async () => {
				const blob = object("blob", "content");
				expectRefused(
					await validate([blob.change], { loose: undefined }),
					blob.change.path,
					"did not verify with Git",
				);
			});

			it("L11 checks .gitmodules blobs supplied in verified packs", async () => {
				const blob = object("blob", '[submodule "lib"]\npath = -option\n');
				const header = Buffer.alloc(12);
				header.write("PACK");
				header.writeUInt32BE(2, 4);
				header.writeUInt32BE(1, 8);
				const size = blob.body.length;
				const entry = [0xb0 | (size & 15), size >>> 4];
				const data = Buffer.concat([header, Buffer.from(entry), deflateSync(blob.body)]);
				const hash = createHash(format).update(data).digest();
				const path = `objects/pack/pack-${hash.toString("hex")}.pack`;
				const bytes = Buffer.concat([data, hash]);
				const packs = await verifyPacks({ sandbox, packs: [{ path, bytes }], stores: [], format, scratch: root });
				expect(packs.refused).toEqual([]);
				const bad = tree([["100644", ".gitmodules", blob.oid]]);
				const changes: GitChange[] = [
					bad.change,
					{ path, before: null, after: bytes },
					{ path: path.replace(/\.pack$/, ".idx"), before: null, after: packs.packs.get(path)!.idx },
				];
				expectRefused(await validate(changes, { packs: packs.packs }), bad.change.path, "gitmodulesPath");
				const good = tree([["100644", "ordinary", blob.oid]]);
				expect((await validate([good.change, ...changes.slice(1)], { packs: packs.packs })).refused).toEqual([]);
			});

			it("preserves deltas when checking mixed packs and loose objects", async () => {
				if (!confined) sandbox = gitFsckTransport(root, 16 * 1024);
				const base = object("blob", randomBytes(8192));
				const header = Buffer.alloc(12);
				header.write("PACK");
				header.writeUInt32BE(2, 4);
				header.writeUInt32BE(17, 8);
				const entries = [Buffer.from([0xb0, 0x80, 0x04]), deflateSync(base.body)];
				for (let value = 0; value < 16; value++) {
					// REF_DELTA: copy the 8192-byte base, append one byte; repeated full blobs exceed the test cap.
					const delta = Buffer.from([0x80, 0x40, 0x81, 0x40, 0xa0, 0x20, 1, value]);
					entries.push(Buffer.from([0x78]), Buffer.from(base.oid, "hex"), deflateSync(delta));
				}
				const data = Buffer.concat([header, ...entries]);
				const hash = createHash(format).update(data).digest();
				const bytes = Buffer.concat([data, hash]);
				expect(bytes.length).toBeLessThan(16 * 1024);
				const path = `objects/pack/pack-${hash.toString("hex")}.pack`;
				const packs = await verifyPacks({ sandbox, packs: [{ path, bytes }], stores: [], format, scratch: root });
				expect(packs.refused).toEqual([]);
				const loose = object("blob", "loose");
				const result = await validate(
					[
						loose.change,
						{ path, before: null, after: bytes },
						{ path: path.replace(/\.pack$/, ".idx"), before: null, after: packs.packs.get(path)!.idx },
					],
					{ packs: packs.packs },
				);
				expect(result.refused).toEqual([]);
			});
		},
	);
}
