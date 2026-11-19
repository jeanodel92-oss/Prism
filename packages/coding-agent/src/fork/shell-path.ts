/**
 * the PATH of the user's login shell for a window started from the desktop.
 *
 * The applications menu starts `prism --gui` with the compositor's environment: under Hyprland its PATH was
 * `/usr/local/bin:/usr/bin`, so the language servers in `~/.bun/bin`, `~/.cargo/bin` or `~/.local/bin` were "missing"
 * and every command of the window lacked the user's tools (npm global packages, cargo, bun). The window's engine
 * inherits the PATH computed here: the login shell's, read once with a time limit; when the shell fails or takes too
 * long, the usual user folders that exist are added to the PATH Prism received (both).
 * Only PATH is taken from the shell: its other variables can hold secrets and are not the window's business.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const MARK = "__PRISM_LOGIN_PATH__";
const TIMEOUT_MS = 5000;

/** Common per-user tool folders, relative to the home folder; added only when they exist. */
export const USER_BIN_FOLDERS: readonly string[] = [
	".local/bin",
	"bin",
	".cargo/bin",
	".bun/bin",
	"go/bin",
	".local/npm/bin",
	".npm-global/bin",
	".local/share/pnpm",
	".deno/bin",
];

/** Absolute entries of `path`, in order and without repeats. */
function entries(path: string | undefined): string[] {
	return [...new Set((path ?? "").split(":").filter((entry) => isAbsolute(entry)))];
}

/** The PATH printed by `shell -l -i -c`, between markers so that the shell's own messages do not count. */
export function loginShellPath(
	shell: string,
	env: NodeJS.ProcessEnv,
	timeoutMs = TIMEOUT_MS,
): Promise<string | undefined> {
	return new Promise((done) => {
		try {
			const child = execFile(
				shell,
				["-l", "-i", "-c", `printf '${MARK}%s${MARK}' "$PATH"`],
				{ env, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1 << 20, encoding: "utf8" },
				// An interactive shell may exit non-zero after printing (a failing rc line): the marked PATH counts.
				(_error, stdout) => {
					const found = new RegExp(`${MARK}(.*?)${MARK}`, "s").exec(stdout ?? "")?.[1];
					done(found && entries(found).length > 0 ? found : undefined);
				},
			);
			child.stdin?.end();
		} catch {
			done(undefined);
		}
	});
}

/**
 * The PATH for a window started without a terminal: the login shell's followed by what Prism received, or, when
 * the shell gives nothing, the user folders that exist followed by what Prism received.
 */
export async function windowPath(
	env: NodeJS.ProcessEnv,
	{
		home = env.HOME || homedir(),
		timeoutMs = TIMEOUT_MS,
		exists = existsSync,
	}: { home?: string; timeoutMs?: number; exists?: (path: string) => boolean } = {},
): Promise<string> {
	const shell = env.SHELL && isAbsolute(env.SHELL) ? env.SHELL : "/bin/sh";
	const login = await loginShellPath(shell, env, timeoutMs);
	const first = login
		? entries(login)
		: USER_BIN_FOLDERS.map((folder) => join(home, folder)).filter((folder) => exists(folder));
	return [...new Set([...first, ...entries(env.PATH)])].join(":");
}
