/**
 * fork: the folders that hold credentials, as one list for the gate of
 * the native file tools and for the sandbox, and the path test both use.
 *
 * The native tools (read, grep, find, ls) run in Prism's own process, outside the sandbox. They used to protect
 * only the agent dir, ~/.ssh and ~/.gnupg, while the sandbox hides more (~/.aws, ~/.kube, ~/.config/gh, browser
 * profiles, keyrings); and the test "this folder holds a credential folder" compared against `root + "/"`, so
 * `/` became `//` and a search from the root folder read every key.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "../config.ts";
import { within } from "./path-within.ts";
import { realPath } from "./real-path.ts";
import { DEFAULT_HIDDEN_HOME_PATHS } from "./sandbox/layout.ts";

/** The real paths of the folders and files that hold credentials: the agent dir and what the sandbox hides. */
export function credentialPaths(hidden: readonly string[] = []): string[] {
	const home = homedir();
	return [getAgentDir(), ...DEFAULT_HIDDEN_HOME_PATHS.map((path) => join(home, path)), ...hidden].map((path) =>
		realPath(path),
	);
}

/** The credential path a read of `path` reaches: `path` is one, or lies inside one. */
export function insideCredentials(path: string, credentials: readonly string[]): string | undefined {
	const real = realPath(path);
	return credentials.find((secret) => within(real, secret));
}

/** A recursive search from `dir` reads credentials: it is, holds, or lies inside a credential path. */
export function holdsCredentials(dir: string, credentials: readonly string[]): boolean {
	const real = realPath(dir);
	return credentials.some((secret) => within(real, secret) || within(secret, real));
}
