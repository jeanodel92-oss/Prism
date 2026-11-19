import { existsSync } from "node:fs";
import { basename } from "node:path";
import { APP_NAME } from "../config.ts";

/** Build a child CLI invocation that works for installed and source executions. */
export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && !currentScript.startsWith("/$bunfs/root/") && existsSync(currentScript)) {
		return { command: process.execPath, args: [...process.execArgv, currentScript, ...args] };
	}
	const execName = basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
	return { command: APP_NAME, args };
}

/** The extensions given with `-e` at launch, as main parsed and resolved them. */
let cliExtensions: readonly string[] = [];

/** Called by main once it has parsed and resolved the launch's `-e` paths. */
export function setCliExtensions(paths: readonly string[]): void {
	cliExtensions = [...paths];
}

/**
 * The parent's `-e` extensions for a child process, so it loads the same providers. fork
 * from what main parsed, never from the raw argv, where `-- --extension=x.ts` is the prompt's text; and by
 * the paths main resolved from the launch folder, which a child started in another folder would read otherwise.
 */
export function getExtensionArgs(): string[] {
	return cliExtensions.flatMap((path) => ["--extension", path]);
}
