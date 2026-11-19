// fork: one list for configuration paths and settings reserved to the user.
import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.ts";
import { within } from "./path-within.ts";
import { realPath } from "./real-path.ts";

export const SECURITY_CONFIG_NAMES = [
	"auth.json",
	"models.json",
	"permissions.json",
	"trust.json",
	"project-permissions.json",
	// fork: the key of /undo's backups when the keyring cannot keep it.
	"checkpoint.key",
	// fork: the MCP tool versions the user accepted; a change asks again.
	"mcp-tools.json",
] as const;

export const SECURITY_SETTING_KEYS = [
	"permissions",
	"permissionMode",
	"mode",
	"allow",
	"ask",
	"deny",
	"protectedPaths",
	"tools",
	"unrestrictedAccepted",
	"sandbox",
	"secrets",
	"defaultProjectTrust",
	"trustedFolders",
	"auth",
] as const;

const CONFIG_NAMES = [
	"settings.json",
	"keybindings.json",
	"mcp.json",
	"lsp.json",
	// fork: the LSP plugin's own name, read before lsp.json.
	"pi-lsp.json",
	"consult-models.json",
	"consult-budgets.json",
	"plan-mode.json",
	"pi-plan-mode.json",
	// fork: Goal's limits on automatic turns.
	"pi-goal.json",
];
const CONFIG_DIRS = ["agents", "extensions", "hooks", "skills", "prompts", "themes"];
/** fork.9 (CAP-01): scheduled task definitions hold the scope their unattended runs get. */
const SECURITY_CONFIG_DIRS = [
	"scheduled",
	// fork: the `remote` folder holds pairing keys and paired devices.
	"remote",
];

/**
 * fork: the phone link's folder, where `prism-remote` and the window keep the PC's
 * key and the paired phones. It is `~/.prism/remote` (or `PRISM_REMOTE_DIR`), beside the agent folder and not in
 * it, so the `remote` entry above never covered it. The server and the window name `.prism` themselves
 * (fork/android/server, fork/gui/src-tauri), whatever this build's configuration folder is called.
 */
export function phoneLinkDirs(home = homedir()): string[] {
	return [
		...new Set([join(home, ".prism", "remote"), join(home, CONFIG_DIR_NAME, "remote")]),
		...(process.env.PRISM_REMOTE_DIR ? [resolve(process.env.PRISM_REMOTE_DIR)] : []),
	];
}

/** Whether `abs` is the phone link's folder or in it. */
export function phoneLinkPath(abs: string, paths = [resolve(abs), realPath(abs)]): boolean {
	const dirs = phoneLinkDirs();
	return dirs.some((dir) => {
		// Only an existing folder can lead elsewhere (see `real` below).
		const bases = lstatSync(dir, { throwIfNoEntry: false }) ? [dir, realPath(dir)] : [dir];
		return paths.some((path) => bases.some((base) => path === base || within(path, base + sep)));
	});
}

export function configPathKind(abs: string, cwd: string): "security" | "configuration" | undefined {
	const paths = [resolve(abs), realPath(abs)];
	if (phoneLinkPath(abs, paths)) return "security";
	const skills = join(cwd, ".agents", "skills");
	// Preserve the previous equal-path and // root prefix semantics of configuration paths.
	if (paths.some((path) => [skills, realPath(skills)].some((base) => path === base || within(path, base + sep))))
		return "configuration";
	const roots = [getAgentDir(), join(cwd, CONFIG_DIR_NAME)];
	for (const root of roots) {
		const realRoot = realPath(root);
		// fork: every permission check runs this; only an existing entry can lead elsewhere, and resolving
		// the missing ones threw several exceptions each (fork-path-tools went from seconds to over 30 s).
		const real = (name: string) => {
			const file = join(root, name);
			return lstatSync(file, { throwIfNoEntry: false }) ? realPath(file) : join(realRoot, name);
		};
		for (const name of [...SECURITY_CONFIG_NAMES, ...CONFIG_NAMES]) {
			const file = join(root, name);
			if (paths.includes(file) || paths.includes(real(name))) {
				return (SECURITY_CONFIG_NAMES as readonly string[]).includes(name) ? "security" : "configuration";
			}
		}
		for (const name of [...SECURITY_CONFIG_DIRS, ...CONFIG_DIRS]) {
			const bases = [join(root, name), real(name)];
			if (paths.some((path) => bases.some((base) => path === base || within(path, base + sep))))
				return SECURITY_CONFIG_DIRS.includes(name) ? "security" : "configuration";
		}
	}
	return undefined;
}

/** For the model, so in English whatever the interface language; the permission dialog translates it. */
export function configWriteRefusal(kind: "security" | "configuration"): string {
	return kind === "security"
		? "Only the user can change Prism's security settings."
		: "Use configure_prism to change Prism's configuration. Enable the config-tool module in /settings if needed.";
}

/**
 * fork: conservative detection of literal config paths, including output options, redirections,
 * in-place editors, cp/mv destinations and code strings. Read commands are still allowed by the gate.
 * shortcut: computed paths and arbitrary programs cannot be proved safe here; the sandbox remains necessary.
 */
export function shellConfigWrite(command: string, cwd: string): ReturnType<typeof configPathKind> {
	// fork: reads in a compound command must still reach the ordinary read/sandbox checks.
	const readOnly = /^(?:(?:cat|head|tail|ls|stat|wc|readlink|realpath)\s|true$)/;
	const inspected = command
		.split(/&&|\|\||[;|\n]/)
		.filter((part) => !readOnly.test(part.trim()) || /[>`]|\$\(/.test(part))
		.join("\n");
	// fork: preserve quoted paths with spaces, including paths in interpreter arguments.
	const wordsOf = (text: string) =>
		[...(text.match(/"[^"\n]*"|'[^'\n]*'/g) ?? []), ...text.split(/[\s"';&|<>]+/)].filter(Boolean);
	const words = wordsOf(inspected);
	// only the arguments of the removing or copying command can replace a configuration directory;
	// `cd <project> && python3 x.py; rm -f x.py` was refused because the cd target contains `.prism`.
	const segmentWords = (tool: RegExp) =>
		new Set(
			command
				.split(/&&|\|\||[;|\n]/)
				.filter((part) => tool.test(part))
				.flatMap(wordsOf),
		);
	const replacing = segmentWords(/\b(?:rm|mv|cp|install|rsync)\b/);
	const removing = segmentWords(/\b(?:rm|mv)\b/);
	const directories = [cwd];
	for (const match of command.matchAll(/\bcd\s+("[^"\n]+"|'[^'\n]+'|[^\s;&|]+)/g)) {
		const path = match[1].replace(/["'\\]/g, "").replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, homedir());
		if (!path.includes("$")) directories.push(resolve(directories.at(-1)!, path));
	}
	for (const word of words) {
		for (let path of [word, ...(word.match(/(?:\$\{HOME\}|\$HOME|~|\/|\.\/)[^\s"'`,;()<>]+/g) ?? [])]) {
			path = path.replace(/["'\\]/g, "").replace(/^(?:--?[\w-]+=|of=)/, "");
			path = path.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, homedir());
			if (path.includes("$")) continue;
			for (const directory of directories) {
				const abs = resolve(directory, path);
				const kind = configPathKind(abs, cwd);
				if (kind) return kind;
				// fork: replacing a configuration directory also replaces its files.
				if (
					replacing.has(word) &&
					[getAgentDir(), join(cwd, CONFIG_DIR_NAME), join(cwd, ".agents")].some(
						(root) =>
							root === abs ||
							realPath(root) === realPath(abs) ||
							(removing.has(word) && within(realPath(root), realPath(abs) + sep)),
					)
				)
					return "configuration";
			}
		}
	}
	return undefined;
}
