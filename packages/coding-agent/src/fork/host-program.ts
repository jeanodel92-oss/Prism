/**
 * fork: the programs Prism runs itself, outside the sandbox (Git to read a
 * repository, bubblewrap to make the sandbox, `which`), are never taken from a place the sandbox's commands can write.
 * A PATH that starts with the project's `.venv/bin` would otherwise run a `git` a command wrote there, on the host,
 * before bubblewrap even starts.
 *
 * One rule, no list of trusted folders (Nix, Homebrew and `~/.local/bin` keep working): the first executable on PATH
 * whose folder, entry and real file are all outside what the sandbox can write. Its real path is returned, so a link
 * changed later changes nothing. Without a sandbox, the agent's commands already run on the host and nothing is
 * excluded but relative PATH entries, which depend on the current folder.
 */

import { execFileSync } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { within } from "./path-within.ts";
import { realPath } from "./real-path.ts";

/** Real paths of the folders a sandbox of this process lets its commands write, read-only parts inside included. */
const writable = new Set<string>();

/** Adds folders the sandbox's commands can write: the session's at its start, then each command's layout. */
export function addSandboxWritable(paths: readonly string[]): void {
	for (const path of paths) writable.add(realPath(resolve(path)));
}

/** Whether a command of a sandbox of this process can create or change `path`, by its real location. */
export function sandboxMayWrite(path: string): boolean {
	if (writable.size === 0) return false;
	const real = realPath(resolve(path));
	for (const root of writable) if (within(real, root)) return true;
	return false;
}

/** Tests only. */
export function resetHostPrograms(): void {
	writable.clear();
}

/** The real path of the executable `name` that Prism may run on the host, or undefined when there is none. */
export function hostProgram(name: string, path = process.env.PATH ?? ""): string | undefined {
	// Looked up at each call, as the shell does: a program installed since is found, one removed is not run.
	for (const dir of path.split(delimiter)) {
		if (!isAbsolute(dir)) continue;
		const candidate = join(dir, name);
		let real: string;
		try {
			if (!statSync(candidate).isFile()) continue;
			accessSync(candidate, constants.X_OK);
			real = realpathSync(candidate);
		} catch {
			continue;
		}
		// The folder: the sandbox could put its own entry there. The real file and its folder: it could change them.
		if ([dir, candidate, real, dirname(real)].some(sandboxMayWrite)) continue;
		return real;
	}
	return undefined;
}

/**
 * fork: what Prism passes to `spawn` for a program it runs on the host by name
 * (`rg`, `notify-send`, `xdg-open`…): {@link hostProgram}'s path, or, when there is none, a path that does not exist,
 * so the program fails as a missing one (ENOENT) and each caller's handling of that case stays. A path is kept. Named alone, the
 * PATH chose it, and a PATH that starts with the project's `.venv/bin` ran there a program a sandboxed command wrote.
 * Windows keeps the name: its lookup adds extensions, and the sandbox is Linux only.
 */
export function hostCommand(name: string): string {
	// A path is run where it is, as spawn does.
	if (process.platform === "win32" || name.includes("/")) return name;
	return hostProgram(name) ?? join("/nonexistent", "prism-host-program", name);
}

/**
 * The PATH for a program Prism runs on the host that runs others by name (the installer's `curl`, `tar`,
 * `minisign`): PATH without its relative entries and the folders the sandbox's commands can write.
 */
export function hostPath(path = process.env.PATH ?? ""): string {
	return path
		.split(delimiter)
		.filter((dir) => isAbsolute(dir) && !sandboxMayWrite(dir))
		.join(delimiter);
}

/** {@link hostProgram}, or an error that says why the program cannot be run. */
export function requireHostProgram(name: string): string {
	const program = hostProgram(name);
	if (!program) throw new Error(`${name} is not on PATH outside the folders sandboxed commands can write`);
	return program;
}

/**
 * The options that keep Git, run by Prism on the host in `cwd`, from running a program the repository names:
 * no fsmonitor, no hooks, no optional locks, and each filter declared by the repository's own configuration emptied.
 * A filter of the user's or the system's configuration (git-lfs) is the user's choice and stays
 * . Reading the filters' names runs nothing: `git config` only parses.
 */
export function hostGitOptions(git: string, cwd: string): string[] {
	const options = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "--no-optional-locks"];
	let listed = "";
	try {
		listed = execFileSync(git, ["config", "--show-scope", "--null", "--get-regexp", "^filter\\."], {
			cwd,
			encoding: "utf8",
			timeout: 2000,
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		// No filter (exit 1), or no repository.
	}
	const names = new Set<string>();
	const records = listed.split("\0");
	for (let at = 0; at + 1 < records.length; at += 2) {
		const scope = records[at];
		const key = records[at + 1]!.split("\n", 1)[0]!;
		if (scope !== "local" && scope !== "worktree") continue;
		// `filter.<name>.<variable>`: the name may hold dots.
		names.add(key.slice("filter.".length, key.lastIndexOf(".")));
	}
	for (const name of names) {
		for (const variable of ["clean", "smudge", "process"]) options.push("-c", `filter.${name}.${variable}=`);
		options.push("-c", `filter.${name}.required=false`);
	}
	return options;
}

/** Git as Prism runs it on the host in `cwd`: the program and the options before the command, or undefined without Git. */
export function hostGit(cwd: string): { program: string; options: string[] } | undefined {
	const program = hostProgram("git");
	return program ? { program, options: hostGitOptions(program, cwd) } : undefined;
}
