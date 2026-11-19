/**
 * fork: a search returns no line of a file that `read` would ask for.
 *
 * The permission gate judges the folder a `grep` searches, not each file rg opens below it: a `.env` or a key in the
 * project came back in the results without its question. The permission extension registers here what it protects;
 * grep drops the matches of those files and says how many it left out, so the model reads one by name and is asked.
 */

/** Why `file` is protected, or undefined. */
export type ProtectedFile = (file: string) => string | undefined;

let judgeFor: ((root: string, cwd: string) => ProtectedFile | undefined) | undefined;

/** Registered by the permission extension; undefined when nothing is filtered (no gate, unrestricted mode). */
export function setProtectedSearch(judge: typeof judgeFor): void {
	judgeFor = judge;
}

/** The judge for one search of `root`, cached per file. */
export function protectedSearch(root: string, cwd: string): ProtectedFile | undefined {
	const judge = judgeFor?.(root, cwd);
	if (!judge) return undefined;
	const seen = new Map<string, string | undefined>();
	return (file) => {
		if (!seen.has(file)) seen.set(file, judge(file));
		return seen.get(file);
	};
}

export const protectedSearchNotice = (files: number) =>
	`${files} protected file${files === 1 ? "" : "s"} (such as .env or keys) not shown; read one by its path to ask the user`;
