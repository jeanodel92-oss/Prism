// fork: permissions given "for this project", kept in Prism's folder per real project path.
import { execFile, execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	type watch,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { decidePermission } from "../src/fork/permissions.ts";
import {
	addProjectHost,
	addProjectRule,
	projectRoot,
	readProjectGrants,
	removeProjectRule,
	watchProjectGrants,
} from "../src/fork/project-permissions.ts";

const writer = resolve(__dirname, "fixtures/project-permissions-writer.ts");

describe("fork: permissions for this project", () => {
	let dir: string;
	let agentDir: string;
	const savedAgentDir = process.env[ENV_AGENT_DIR];

	beforeEach(() => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "prism-project-perms-")));
		agentDir = join(dir, "agent");
		process.env[ENV_AGENT_DIR] = agentDir;
	});

	afterEach(() => {
		if (savedAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = savedAgentDir;
		rmSync(dir, { recursive: true, force: true });
	});

	const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
	const stored = () => JSON.parse(readFileSync(join(agentDir, "project-permissions.json"), "utf8"));

	it("names a project by the real path of its Git root, each worktree its own, else of the folder", () => {
		const repo = join(dir, "repo");
		mkdirSync(join(repo, "src"), { recursive: true });
		git(repo, "init", "-q");
		git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
		git(repo, "worktree", "add", "-q", join(dir, "wt"));
		symlinkSync(repo, join(dir, "link"));
		const plain = join(dir, "plain");
		mkdirSync(plain);

		expect(projectRoot(join(repo, "src"))).toBe(repo);
		expect(projectRoot(join(dir, "link"))).toBe(repo);
		expect(projectRoot(join(dir, "wt"))).toBe(join(dir, "wt"));
		expect(projectRoot(plain)).toBe(plain);
	});

	// the project of a folder was kept for the process's life.
	it("finds the project again once a repository is created in a folder of another", async () => {
		const parent = join(dir, "parent");
		const child = join(parent, "child");
		mkdirSync(child, { recursive: true });
		git(parent, "init", "-q");
		expect(projectRoot(child)).toBe(parent);
		git(child, "init", "-q");
		expect(projectRoot(child)).toBe(child);
		await addProjectRule(child, "bash(make*)");
		expect(Object.keys(stored().projects)).toEqual([child]);
	});

	it("asks Git again after a lookup that did not finish", () => {
		const repo = join(dir, "repo");
		mkdirSync(join(repo, "src"), { recursive: true });
		git(repo, "init", "-q");
		const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
		const bin = join(dir, "bin");
		const ready = join(dir, "git-ready");
		mkdirSync(bin);
		// Killed by a signal until `ready` exists, as a lookup that times out ends.
		writeFileSync(join(bin, "git"), `#!/bin/sh\n[ -e '${ready}' ] && exec '${realGit}' "$@"\nkill -9 $$\n`, {
			mode: 0o755,
		});
		vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
		try {
			const folder = join(repo, "src");
			expect(projectRoot(folder)).toBe(folder);
			writeFileSync(ready, "");
			expect(projectRoot(folder)).toBe(repo);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("allows a rule given to a project in a later session on it, not in another folder", async () => {
		const project = join(dir, "a");
		const other = join(dir, "b");
		mkdirSync(join(project, "sub"), { recursive: true });
		mkdirSync(other);
		const ask = (cwd: string) => decidePermission("bash", { command: "npm install left-pad" }, cwd, { mode: "ask" });
		expect(ask(project).effect).toBe("prompt");

		await addProjectRule(project, "bash(npm install*)");
		// Nothing from the session: the decision reads the store kept in Prism's folder.
		expect(ask(project).effect).toBe("allow");
		// Outside Git, a project is the folder itself: a subfolder is another one.
		expect(ask(join(project, "sub")).effect).toBe("prompt");
		expect(ask(other).effect).toBe("prompt");
		expect(stored()).toEqual({ projects: { [project]: { allow: ["bash(npm install*)"], deny: [], hosts: [] } } });

		await removeProjectRule(project, "bash(npm install*)");
		expect(ask(project).effect).toBe("prompt");
		expect(stored()).toEqual({ projects: {} });
	});

	// "block in this project" is kept like "allow in this project", and taken back alike.
	it("blocks a rule refused for a project in a later session on it", async () => {
		const project = join(dir, "a");
		mkdirSync(project);
		const ask = () => decidePermission("bash", { command: "npm test" }, project, { mode: "broad" });
		expect(ask().effect).toBe("allow");
		await addProjectRule(project, "bash(npm test*)", "deny");
		expect(ask().effect).toBe("block");
		expect(readProjectGrants(project)).toEqual({ allow: [], deny: ["bash(npm test*)"], hosts: [] });
		await removeProjectRule(project, "bash(npm test*)", "deny");
		expect(ask().effect).toBe("allow");
		expect(stored()).toEqual({ projects: {} });
	});

	it("keeps hosts with the rule of their command, and a dangerous command still asks", async () => {
		const project = join(dir, "a");
		mkdirSync(project);
		const grant = { host: "registry.npmjs.org", rule: "bash(npm install*)" };
		await addProjectHost(project, grant);
		await addProjectHost(project, grant);
		await addProjectRule(project, "bash(*)");
		expect(readProjectGrants(project)).toEqual({ allow: ["bash(*)"], deny: [], hosts: [grant] });
		expect(decidePermission("bash", { command: "rm -rf ~/src" }, project, { mode: "ask" }).effect).toBe("prompt");
	});

	it("keeps every change when several Prism processes write at once", async () => {
		const project = join(dir, "a");
		mkdirSync(project);
		const run = promisify(execFile);
		const startAt = String(Date.now() + 1_500);
		// fork: 25 writes each, not 100. On a disk with slow fsync (the CI runner: 1.4 s
		// for 100 writes, 0.18 s on the maintainer's PC), 400 writes held the lock longer than a writer's 2 s budget; the
		// test is about losing no change, not about the disk's speed.
		await Promise.all(
			["p0", "p1", "p2", "p3"].map((prefix) =>
				run(process.execPath, [writer, agentDir, project, "add-rules", prefix, "25", startAt]),
			),
		);
		const rules = readProjectGrants(project).allow;
		expect(rules).toHaveLength(100);
		expect(rules).toContain("bash(p3-24*)");
	});

	it("still sees a grant change when no watcher can be had (EMFILE): the file is read at intervals", async () => {
		const project = join(dir, "a");
		mkdirSync(project);
		mkdirSync(agentDir, { recursive: true });
		const refused: typeof watch = () => {
			throw Object.assign(new Error("inotify_init: EMFILE"), { code: "EMFILE" });
		};
		let changes = 0;
		const stop = watchProjectGrants(() => changes++, agentDir, refused);
		await addProjectRule(project, "bash(make*)");
		await vi.waitFor(() => expect(changes).toBe(1), { timeout: 3000 });
		stop();
	});

	it("sees a file replaced with the same mtime while polling (RT-001)", async () => {
		// A revoked host in a file an editor replaced, mtime kept: the old poll compared the mtime only and missed it,
		// so a tunnel already open stayed usable until the next change.
		mkdirSync(agentDir, { recursive: true });
		const file = join(agentDir, "settings.json");
		writeFileSync(file, JSON.stringify({ hosts: ["a.example"] }));
		// A whole second: utimes keeps it exactly (a sub-millisecond mtime would not survive being set back).
		const atime = 1_700_000_000;
		const mtime = atime;
		utimesSync(file, atime, mtime);
		const refused: typeof watch = () => {
			throw Object.assign(new Error("inotify_init: EMFILE"), { code: "EMFILE" });
		};
		let changes = 0;
		const stop = watchProjectGrants(() => changes++, agentDir, refused, "settings.json");
		try {
			// Rewritten in place, same size, mtime set back: only the change time differs.
			writeFileSync(file, JSON.stringify({ hosts: ["b.example"] }));
			utimesSync(file, atime, mtime);
			expect(statSync(file).mtimeMs).toBe(mtime * 1000);
			await vi.waitFor(() => expect(changes).toBe(1), { timeout: 3000 });
			// Replaced by a rename (another inode), mtime set back as well.
			const next = join(agentDir, "settings.json.new");
			writeFileSync(next, JSON.stringify({ hosts: [] }));
			utimesSync(next, atime, mtime);
			renameSync(next, file);
			await vi.waitFor(() => expect(changes).toBe(2), { timeout: 3000 });
		} finally {
			stop();
		}
	});

	it("reads an unreadable file as nothing given, and refuses to write over it", async () => {
		const project = join(dir, "a");
		mkdirSync(project);
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "project-permissions.json"), "{ not json");
		expect(readProjectGrants(project)).toEqual({ allow: [], deny: [], hosts: [] });
		await expect(addProjectRule(project, "bash(make*)")).rejects.toThrow();
		expect(readFileSync(join(agentDir, "project-permissions.json"), "utf8")).toBe("{ not json");
	});
});
