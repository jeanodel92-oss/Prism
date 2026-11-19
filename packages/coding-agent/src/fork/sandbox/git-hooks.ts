/**
 * fork: a sandboxed command that changes `core.hooksPath` (Husky's install
 * does) is asked about rather than refused. The question names the folder Git will run hooks from, the hooks in it
 * and the risk: Git outside Prism runs them without the sandbox. Allowed, that one change is published; refused or
 * unanswered, none of the command's Git changes are (`git-copy.ts`).
 *
 * The allowance is not general: the hooks folder of a copied repository stays private to each command (`hooksLayer`),
 * and Husky's scripts, which its hooks run, stay read-only (`layout.ts`). What those scripts call (npm scripts,
 * `node_modules`) stays writable: a limit the question states.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { HooksPathChange } from "./git-validate.ts";
// Preserve the former prefix semantics: / matches itself, but its children require //.
import { within } from "./path-within.ts";

/** The hooks Git runs, as `githooks(5)` names them. */
export const GIT_HOOKS = new Set([
	"applypatch-msg",
	"pre-applypatch",
	"post-applypatch",
	"pre-commit",
	"pre-merge-commit",
	"prepare-commit-msg",
	"commit-msg",
	"post-commit",
	"pre-rebase",
	"post-checkout",
	"post-merge",
	"pre-push",
	"pre-receive",
	"update",
	"proc-receive",
	"post-receive",
	"post-update",
	"reference-transaction",
	"push-to-checkout",
	"pre-auto-gc",
	"post-rewrite",
	"sendemail-validate",
	"fsmonitor-watchman",
	"p4-changelist",
	"p4-prepare-changelist",
	"p4-post-changelist",
	"p4-pre-submit",
	"post-index-change",
]);

export interface HooksQuestion {
	/** The repository's working tree. */
	repository: string;
	change: HooksPathChange;
	/** The folder Git will run hooks from, absolute. */
	folder: string;
	/** The hooks in it now, by name. */
	hooks: string[];
	/** Husky's scripts folder, which its hooks run (`.husky`), when the folder is Husky's. */
	scripts?: string;
}

const isFile = (path: string) => {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
};

/** Husky's layout: a hooks folder `_` with its runner `h`, which runs the script of the same name one folder up. */
export function huskyScripts(folder: string, fileAt: (path: string) => boolean = isFile): string | undefined {
	return basename(folder) === "_" && fileAt(join(folder, "h")) ? dirname(folder) : undefined;
}

/**
 * The question for a change to `core.hooksPath` in the repository whose Git folder is `gitDir`, or why it is
 * refused without one: a folder holding writable folders (`core.hooksPath=.`) would turn any file there named like a
 * hook into one, and a relative path in a repository with linked worktrees names one folder per worktree.
 */
export function hooksQuestion(
	gitDir: string,
	change: HooksPathChange,
	writable: string[],
	linkedWorktrees: boolean,
): HooksQuestion | string {
	const shown = `core.hooksPath=${change.after ?? "(unset)"}`;
	if (basename(gitDir) !== ".git")
		return `${shown}: set in a repository without a working tree Prism can tell; set it outside Prism if you want it`;
	const repository = dirname(gitDir);
	const value = change.after;
	if (value !== undefined && !isAbsolute(value) && !value.startsWith("~/") && linkedWorktrees)
		return `${shown}: a relative path names a different folder in each linked worktree; set an absolute path outside Prism if you want it`;
	const home = process.env.HOME ?? "";
	const folder =
		value === undefined
			? join(gitDir, "hooks")
			: resolve(repository, value.startsWith("~/") ? join(home, value.slice(2)) : value);
	if (writable.some((root) => root === folder || within(root, `${folder}/`)))
		return `${shown}: ${folder} holds folders sandboxed commands write, so any file there named like a Git hook would run outside the sandbox; this is not asked, set it outside Prism if you accept that`;
	let hooks: string[] = [];
	try {
		hooks = readdirSync(folder)
			.filter((name) => GIT_HOOKS.has(name) && isFile(join(folder, name)))
			.sort();
	} catch {}
	const scripts = existsSync(folder) ? huskyScripts(folder) : undefined;
	return { repository, change, folder, hooks, ...(scripts ? { scripts } : {}) };
}
