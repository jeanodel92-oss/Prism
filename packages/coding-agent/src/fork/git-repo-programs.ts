/**
 * fork: Git's reading commands (`status`, `diff`, `log -p`…) run the programs the
 * repository's own configuration names: `core.fsmonitor` at each `git status`, `diff.external` and textconv drivers at
 * each `git diff`. A folder received as an archive brings its `.git/config`, so the permission gate lets such a
 * command run without a question only when that configuration names none.
 */

import { spawnSync } from "node:child_process";
import { hostProgram } from "./host-program.ts";

/**
 * Settings whose value is a program a reading Git command may run. Hooks, aliases and editors are left out: no
 * reading command runs them (Husky's `core.hooksPath` would otherwise ask at every `git status`).
 */
const RUNS_PROGRAM =
	/^(?:core\.(?:fsmonitor|pager|sshcommand|askpass|gitproxy)|diff\..*\.(?:textconv|command)|diff\.external|filter\..*\.(?:clean|smudge|process)|credential\..*|gpg\..*program|(?:remote\..*\.)?(?:uploadpack|receivepack))$/i;

/**
 * The first setting of the repository at `dir` (its local and worktree configuration, with the files they include) that
 * names a program, as `key=value`; undefined when none does or `dir` is in no repository. The user's own global and
 * system configuration are trusted and not read. Throws when Git cannot be run, or fails other than by finding none.
 */
export function repositoryProgramSetting(dir: string): string | undefined {
	const git = hostProgram("git");
	if (!git) throw new Error("git is not on PATH");
	const result = spawnSync(git, ["-C", dir, "config", "--includes", "--null", "--get-regexp", "."], {
		encoding: "utf8",
		timeout: 5000,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
	});
	// 1: no setting at all.
	if (result.status === 1) return undefined;
	if (result.status !== 0) throw new Error(result.stderr?.trim() || "git config failed");
	for (const record of result.stdout.split("\0")) {
		const newline = record.indexOf("\n");
		const key = newline < 0 ? record : record.slice(0, newline);
		const value = newline < 0 ? "" : record.slice(newline + 1);
		if (!RUNS_PROGRAM.test(key)) continue;
		// `core.fsmonitor = true` uses Git's own daemon, not a program.
		if (/^core\.fsmonitor$/i.test(key) && /^(?:true|false|yes|no|on|off|1|0|)$/i.test(value.trim())) continue;
		return `${key}=${value}`;
	}
	return undefined;
}
