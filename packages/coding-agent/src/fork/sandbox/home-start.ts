/**
 * fork: Prism opened in the home folder, or above it, while reading is limited
 * has no project to show: the whole home folder would be one. Before the session starts, the user chooses a new
 * working folder in /tmp (the default, kept after the session), the whole home folder for this run, or neither.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Args } from "../../cli/args.ts";
import { readEverythingThisRun, readSandboxSettings, sandboxSettingsProblem } from "./layout.ts";
import { within } from "./path-within.ts";

export type HomeStartChoice = "tmp" | "home" | "none";

/** Whether `cwd` is the home folder or above it, with reading limited: then no folder is the project. */
export function opensWholeHome(cwd: string, agentDir?: string): boolean {
	// Settings that cannot be read block every tool call anyway (layout.ts); no question about the home folder.
	if (sandboxSettingsProblem(agentDir) || readSandboxSettings(agentDir).read.limit !== "project") return false;
	const real = (path: string) => {
		try {
			return realpathSync(path);
		} catch {
			return path;
		}
	};
	const folder = resolve(real(cwd));
	const home = resolve(real(homedir()));
	const up = relative(folder, home);
	// Keep the former '..' exclusion and cross-drive result (an absolute relative path without a leading '/').
	return !up.startsWith("..") && (within(home, folder) || (isAbsolute(up) && !up.startsWith("/")));
}

/**
 * Whether the command line starts a new session and names no path relative to the folder Prism was opened in,
 * which a new working folder would change: a resumed session has its own folder.
 */
export function startsFresh(args: Args): boolean {
	if (args.continue || args.resume || args.session || args.sessionId || args.fork || args.fileArgs.length > 0) {
		return false;
	}
	const paths = [args.extensions, args.skills, args.promptTemplates, args.themes].flatMap((list) => list ?? []);
	if (!paths.every((path) => isAbsolute(path) || path.startsWith("~") || /^[a-z]+:/.test(path))) return false;
	// fork: a relative session folder, or a system prompt read from a relative file (the
	// resource loader reads any existing path), is also relative to the folder Prism was opened in. A prompt given
	// as literal text is not a path and does not count.
	if (args.sessionDir && !isAbsolute(args.sessionDir) && !args.sessionDir.startsWith("~")) return false;
	const prompts = [args.systemPrompt, ...(args.appendSystemPrompt ?? [])];
	return prompts.every((prompt) => !prompt || isAbsolute(prompt) || !existsSync(prompt));
}

const TITLE = [
	"Prism is open in your home folder, and reading is limited to the project: here, the project would be the whole home folder.",
	"Commands do not run until you choose where to work.",
];

/**
 * Asks where to work, and applies the answer: a new folder becomes the working folder (the process moves there),
 * "home" lifts the limit until Prism exits. Returns the working folder; Escape keeps `cwd`, commands refused.
 */
export async function chooseHomeStart(
	cwd: string,
	choose: (
		title: string,
		options: { label: string; value: HomeStartChoice }[],
	) => Promise<HomeStartChoice | undefined>,
): Promise<string> {
	const choice = await choose(TITLE.join("\n"), [
		{ label: "Work in a new folder in /tmp (kept after the session)", value: "tmp" },
		{
			label: "Stay here and let the agent read the whole home folder until Prism exits (keys and credentials stay hidden)",
			value: "home",
		},
		{ label: "Stay here and read nothing: commands are refused", value: "none" },
	]);
	if (choice === "home") readEverythingThisRun();
	if (choice !== "tmp") return cwd;
	const folder = newWorkFolder();
	process.chdir(folder);
	return folder;
}

/** A new working folder in /tmp, kept after the session: the default answer above. */
export function newWorkFolder(): string {
	return mkdtempSync(join(tmpdir(), "prism-work-"));
}

/**
 * the window started in the home folder (the applications menu) works in `~/Prism`,
 * the same folder at each launch, so its conversations can be resumed; a new /tmp folder each time lost them.
 */
export function windowWorkFolder(home = homedir()): string {
	const folder = join(home, "Prism");
	mkdirSync(folder, { recursive: true });
	return folder;
}
