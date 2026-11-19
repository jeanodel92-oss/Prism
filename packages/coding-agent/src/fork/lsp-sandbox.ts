/**
 * fork: the language servers of pi-lsp run in the session's sandbox.
 *
 * A language server runs code the project controls: rust-analyzer builds the project's `build.rs` and procedural
 * macros when it loads it. pi-lsp started it in Prism's own process, outside the sandbox, with the whole home folder
 * and no network proxy, so a project (or a model in broad mode, which writes `build.rs` without a question) could run
 * anything there. pi-lsp starts one server per tool call and stops it at the end of the call, like a command: the
 * server now goes through the same layout, filter and network relay as the bash tool's commands, with the project as
 * its folder. Its network questions name the server.
 *
 * Without a sandbox for this mode, the server runs as before; the gate then asks first, as for a dangerous call
 * (permissions.ts). A sandbox that should run but does not refuses the server, as it refuses commands.
 */

import type { SessionManager } from "../core/session-manager.ts";
import { within } from "./path-within.ts";
import { realPath } from "./real-path.ts";
import { brokenSandboxReason, openSandboxNetwork, sandboxArgv, sessionSandbox } from "./sandbox/runtime.ts";

export interface LspSpawn {
	command: string;
	args: string[];
	/** Closes the server's network channel once it has exited. */
	close(): void;
}

/**
 * The command that starts a language server for the session whose folder is `project`, in `cwd` (the server's
 * workspace root, which must be in the project). Throws when the sandbox is broken, or when the root is outside the
 * project while the sandbox is on: the server would see the project only.
 */
export function lspSpawn(
	sessionManager: SessionManager,
	project: string,
	command: string,
	args: readonly string[],
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
): LspSpawn {
	const sandbox = sessionSandbox(sessionManager);
	if (!sandbox) return { command, args: [...args], close: () => {} };
	if ("error" in sandbox) throw new Error(brokenSandboxReason(sandbox));
	const root = realPath(cwd);
	const folder = realPath(project);
	// Preserve the former / boundary: equal roots pass, children require the // prefix.
	if (root !== folder && !within(root, `${folder}/`)) {
		throw new Error(
			`The language server's root ${cwd} is outside the project (${project}); in the sandbox it sees the project only.`,
		);
	}
	const channel = openSandboxNetwork(sandbox, { command: `${command} (language server)` });
	try {
		// The project's layout, the server started from its root: `cd` before exec, as the shell would.
		// The real Git folders stay read-only to it, as to the sandbox check: a server has nothing to publish there.
		const start = ["/bin/sh", "-c", 'cd "$1" && shift && exec "$@"', "sh", root, command, ...args];
		const argv = sandboxArgv(sandbox, project, channel, start, env);
		return { command: argv[0]!, args: argv.slice(1), close: () => channel.close() };
	} catch (error) {
		channel.close();
		throw error;
	}
}
