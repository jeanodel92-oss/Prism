// fork: Linux before 6.13 (Debian 13, Ubuntu 24.04) dates a change at the scheduler
// tick. Two changes in one tick, the second on the inode the first freed, keep the same stamp (measured on Linux
// 6.12: 485 times in 500), and the caches keyed by it served the older version. This test gives the files of one
// folder that coarse stamp on any kernel: the same inode and the same times for every version.
import * as NodeFs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { cacheFile, RACY_MS } from "../src/fork/file-cache.ts";
import { addProjectRule, projectRoot, readProjectGrants, watchProjectGrants } from "../src/fork/project-permissions.ts";
import { getFileRevision } from "../src/utils/paths.ts";

const coarse = vi.hoisted(() => ({ root: "", ms: 0 }));

vi.mock("node:fs", async (importOriginal) => {
	const real = await importOriginal<typeof NodeFs>();
	const statSync = ((path: NodeFs.PathLike, options?: NodeFs.StatSyncOptions) => {
		const stat = real.statSync(path, options);
		if (!stat || !coarse.root || !String(path).startsWith(coarse.root)) return stat;
		const copy = Object.assign(Object.create(Object.getPrototypeOf(stat)), stat);
		if (typeof stat.ino === "bigint") {
			Object.assign(copy, {
				ino: 1n,
				mtimeMs: BigInt(coarse.ms),
				ctimeMs: BigInt(coarse.ms),
				mtimeNs: BigInt(coarse.ms) * 1_000_000n,
				ctimeNs: BigInt(coarse.ms) * 1_000_000n,
			});
		} else Object.assign(copy, { ino: 1, mtimeMs: coarse.ms, ctimeMs: coarse.ms });
		return copy;
	}) as typeof real.statSync;
	return { ...real, statSync, default: { ...real, statSync } };
});

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "prism-racy-"));
	coarse.root = dir;
});
afterEach(() => {
	coarse.root = "";
	rmSync(dir, { recursive: true, force: true });
});

describe("fork: files changed within one timestamp tick", () => {
	it("reads a file changed in the last RACY_MS again rather than serve it from its stamp", () => {
		const file = join(dir, "data.json");
		const cached = cacheFile((path: string): { v: string } => JSON.parse(NodeFs.readFileSync(path, "utf8")));
		coarse.ms = Date.now();
		writeFileSync(file, '{"v":"aa"}');
		expect(cached(file)).toEqual({ v: "aa" });
		writeFileSync(file, '{"v":"bb"}');
		expect(cached(file)).toEqual({ v: "bb" });
	});

	it("still serves an older file from the cache", () => {
		const file = join(dir, "data.json");
		const read = vi.fn((path: string): { v: string } => JSON.parse(NodeFs.readFileSync(path, "utf8")));
		const cached = cacheFile(read);
		coarse.ms = Date.now() - RACY_MS - 1_000;
		writeFileSync(file, '{"v":"aa"}');
		cached(file);
		expect(cached(file)).toEqual({ v: "aa" });
		expect(read).toHaveBeenCalledTimes(1);
	});

	it("gives no revision to a file changed in the last RACY_MS", () => {
		const file = join(dir, "auth.json");
		writeFileSync(file, "{}");
		coarse.ms = Date.now();
		expect(getFileRevision(file)).toBeUndefined();
		coarse.ms = Date.now() - RACY_MS - 1_000;
		expect(getFileRevision(file)).toBeTypeOf("string");
	});

	it("reads auth.json again after a change in the same tick", async () => {
		const file = join(dir, "auth.json");
		coarse.ms = Date.now();
		writeFileSync(file, JSON.stringify({ anthropic: { type: "api_key", key: "old" } }));
		const storage = AuthStorage.create(file);
		writeFileSync(file, JSON.stringify({ anthropic: { type: "api_key", key: "new" } }));
		await expect(storage.read("anthropic")).resolves.toEqual({ type: "api_key", key: "new" });
	});

	it("keeps another writer's change made under the same stamp, reading the file under the lock", async () => {
		const agentDir = join(dir, "agent");
		const project = join(dir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(project);
		const file = join(agentDir, "project-permissions.json");
		const grants = (allow: string[]) =>
			`${JSON.stringify({ projects: { [projectRoot(project)]: { allow, deny: [], hosts: [] } } }, null, 2)}\n`;
		// An old stamp, so this process caches the file; then another process writes it, same stamp, same size.
		coarse.ms = Date.now() - RACY_MS - 1_000;
		writeFileSync(file, grants(["bash(aa*)"]));
		expect(readProjectGrants(project, agentDir).allow).toEqual(["bash(aa*)"]);
		writeFileSync(file, grants(["bash(bb*)"]));
		await addProjectRule(project, "bash(cc*)", "allow", agentDir);
		expect(readProjectGrants(project, agentDir).allow).toEqual(["bash(bb*)", "bash(cc*)"]);
	});

	it("sees a change in the same tick when it reads the grants at intervals", async () => {
		const agentDir = join(dir, "agent");
		mkdirSync(agentDir, { recursive: true });
		const file = join(agentDir, "project-permissions.json");
		coarse.ms = Date.now();
		writeFileSync(file, '{"projects":{"a":{"allow":["bash(aa*)"]}}}\n');
		const refused: typeof NodeFs.watch = () => {
			throw Object.assign(new Error("inotify_init: EMFILE"), { code: "EMFILE" });
		};
		let changes = 0;
		const stop = watchProjectGrants(() => changes++, agentDir, refused);
		try {
			writeFileSync(file, '{"projects":{"a":{"allow":["bash(bb*)"]}}}\n');
			await vi.waitFor(() => expect(changes).toBe(1), { timeout: 3_000 });
		} finally {
			stop();
		}
	});
});
