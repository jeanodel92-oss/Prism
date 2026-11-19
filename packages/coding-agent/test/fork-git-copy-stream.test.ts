// Review L13: 100 MiB of generated data, even when a cgroup memory cap is unavailable.
import { execFileSync } from "node:child_process";
import { createHash, randomFillSync } from "node:crypto";
import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { deflateSync } from "node:zlib";
import { expect, it } from "vitest";
import { finishGitCopy, gitCopyChanges, prepareGitCopies } from "../src/fork/sandbox/git-copy.ts";
import { publishGitChanges } from "../src/fork/sandbox/git-publish.ts";
import { gitObjectStore, type HashFormat, validateGitChanges } from "../src/fork/sandbox/git-validate.ts";
import { gitFsckTransport } from "./fork-git-fsck-harness.ts";

// fork: run again once when it fails; its time bound is missed
// now and then on a slower machine under the full suite.
it(
	"publishes a 100 MiB fetch with a responsive event loop and bounded RSS",
	{ retry: 1, timeout: 180_000 },
	async () => {
		const root = mkdtempSync(join(tmpdir(), "prism-copy-stream-"));
		const env = {
			...process.env,
			HOME: root,
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
				timeout: 120_000,
				stdio: ["ignore", "pipe", "pipe"],
			}).trim();
		try {
			const remote = join(root, "remote");
			const real = join(root, "real");
			mkdirSync(remote);
			mkdirSync(real);
			git(remote, "init", "-q", "--template=", "-b", "main");
			const chunk = Buffer.alloc(1024 * 1024);
			for (let i = 0; i < 100; i++) appendFileSync(join(remote, "data"), randomFillSync(chunk));
			git(remote, "add", "data");
			git(remote, "commit", "-qm", "large fetch");
			const tip = git(remote, "rev-parse", "HEAD");
			rmSync(join(remote, "data"));
			git(real, "init", "-q", "--template=", "-b", "main");
			const copies = prepareGitCopies(join(real, ".git"), {
				folder: join(root, "copies"),
				tmp: join(root, "tmp"),
				origin: { command: "git fetch", cwd: real, task: false },
			});
			if ("reason" in copies) throw new Error(copies.reason);
			const copy = copies[0]!;
			const alternates = join(copy.metadata, "objects/info/alternates");
			writeFileSync(alternates, `${join(real, ".git/objects")}\n`);
			git(
				real,
				`--git-dir=${copy.metadata}`,
				"-c",
				"fetch.unpackLimit=1",
				"fetch",
				"--no-auto-maintenance",
				remote,
				"main:refs/heads/fetched",
			);
			writeFileSync(alternates, copy.alternates);
			const packDir = join(copy.metadata, "objects/pack");
			const packBytes = readdirSync(packDir)
				.filter((name) => name.endsWith(".pack"))
				.reduce((size, name) => size + statSync(join(packDir, name)).size, 0);
			expect(packBytes).toBeGreaterThan(99 * 1024 * 1024);
			const sandbox = gitFsckTransport(root);
			const rssBefore = process.memoryUsage().rss;
			let peakRss = rssBefore;
			let last = performance.now();
			let maxGap = 0;
			let stalled = 0;
			let ticks = 0;
			const sample = () => {
				const now = performance.now();
				maxGap = Math.max(maxGap, now - last);
				stalled += Math.max(0, now - last - 50);
				last = now;
				peakRss = Math.max(peakRss, process.memoryUsage().rss);
				ticks++;
			};
			const timer = setInterval(sample, 10);
			const started = performance.now();
			let note: string | undefined;
			try {
				note = await finishGitCopy(copy, { sandbox, journalDir: join(root, "journal"), writable: [root] });
				sample();
			} finally {
				clearInterval(timer);
			}
			const metrics = {
				packMiB: packBytes / 1024 / 1024,
				elapsedMs: performance.now() - started,
				maxGapMs: maxGap,
				stalledMs: stalled,
				ticks,
				peakRssMiB: peakRss / 1024 / 1024,
				rssGrowthMiB: (peakRss - rssBefore) / 1024 / 1024,
				processHighWaterMiB: process.resourceUsage().maxRSS / 1024,
			};
			console.log("L13 copy-back", JSON.stringify(metrics));
			expect(note).toBeUndefined();
			expect(git(real, "rev-parse", "fetched")).toBe(tip);
			git(real, "fsck", "--strict");
			expect(ticks).toBeGreaterThan(5);
			// The loop is free most of the time: publication's few synchronous fsyncs can
			// each stall it for 50 ms or more on a busy slow disk; reading or writing the
			// pack synchronously would stall the whole copy.
			expect(stalled).toBeLessThan(metrics.elapsedMs / 2);
			expect(metrics.rssGrowthMiB).toBeLessThan(80);
		} finally {
			// Successful copy-back removes its renamed folder in the background.
			await delay(50);
			rmSync(root, { recursive: true, force: true });
		}
	},
);

it.each<HashFormat>(["sha1", "sha256"])(
	"validates and publishes immutable streamed %s loose objects",
	async (format) => {
		const root = mkdtempSync(join(tmpdir(), "prism-copy-loose-stream-"));
		const gitDir = join(root, "real.git");
		mkdirSync(join(gitDir, "objects"), { recursive: true });
		writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
		writeFileSync(
			join(gitDir, "config"),
			format === "sha1"
				? "[core]\nrepositoryformatversion = 0\nbare = true\n"
				: "[core]\nrepositoryformatversion = 1\nbare = true\n[extensions]\nobjectformat = sha256\n",
		);
		try {
			const copies = prepareGitCopies(gitDir, {
				folder: join(root, "copies"),
				tmp: join(root, "tmp"),
				origin: { command: "git hash-object", cwd: root, task: false },
			});
			if ("reason" in copies) throw new Error(copies.reason);
			const copy = copies[0]!;
			const raw = Buffer.from("blob 7\0content");
			const oid = createHash(format).update(raw).digest("hex");
			const path = `objects/${oid.slice(0, 2)}/${oid.slice(2)}`;
			mkdirSync(join(copy.metadata, path, ".."), { recursive: true });
			writeFileSync(join(copy.metadata, path), deflateSync(raw));
			const collected = await gitCopyChanges(copy);
			if ("reason" in collected) throw new Error(collected.reason);
			expect(collected.changes).toHaveLength(1);
			expect(Buffer.isBuffer(collected.changes[0]!.after)).toBe(false);
			// A surviving process changes the sandbox's bytes after collection, before fsck and publication.
			writeFileSync(join(copy.metadata, path), "corrupt replacement");
			const existing = gitObjectStore(join(gitDir, "objects"), format);
			try {
				const result = await validateGitChanges({
					changes: collected.changes,
					format,
					existing,
					writable: [],
					loose: { sandbox: gitFsckTransport(root), stores: [join(gitDir, "objects")], scratch: root },
				});
				expect(result.refused).toEqual([]);
				expect(
					(await publishGitChanges(gitDir, copy.start, result.accepted, join(root, "journal"))).published,
				).toBe(true);
				expect(readFileSync(join(gitDir, path))).toEqual(deflateSync(raw));
			} finally {
				await existing.close();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
);
