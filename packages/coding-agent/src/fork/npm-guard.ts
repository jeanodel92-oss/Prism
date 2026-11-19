import { readFileSync, statSync } from "node:fs";
import type { LookupFunction } from "node:net";
import { dirname, join, resolve } from "node:path";
import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";
import type { ExtensionContext } from "../core/extensions/types.ts";
import { BodyTooLarge, readLimitedJson } from "./http-body-limit.ts";
import { t } from "./i18n/index.ts";
import { POPULAR_NPM_PACKAGES } from "./npm-popular.ts";

/** English, as the model reads it; `t()` translates a line for display. */
const en = (template: string, ...values: string[]) =>
	template.replace(/\{(\d)\}/g, (slot, n: string) => values[Number(n)] ?? slot);

const PUBLIC_REGISTRY = "https://registry.npmjs.org/";
const REQUEST_TIMEOUT_MS = 3_000;
const COMMAND_TIMEOUT_MS = 6_000;
// Keep the same segment boundaries as permissions.ts; this is not a general shell interpreter.
const SEGMENT_SPLIT_RE = /&&|\|\||\|&|(?<![<>&|])&(?![>&])|[;|\n]/;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
const VALUE_FLAGS = new Set([
	"--registry",
	"--userconfig",
	"--globalconfig",
	"--prefix",
	"--cwd",
	"--dir",
	"-C",
	"--cache",
	"--tag",
	"--workspace",
	"-w",
	"--filter",
	"--store-dir",
	"--modules-dir",
	"--network-timeout",
	"--mode",
	"--use-yarnrc",
	"--config",
]);
/** npm's names for `install` (its own aliases and typo forms) and `install-test`, which installs too. */
const NPM_INSTALLS = [
	"install",
	"i",
	"in",
	"ins",
	"inst",
	"insta",
	"instal",
	"isnt",
	"isnta",
	"isntal",
	"isntall",
	"add",
	"install-test",
	"it",
];
const WRAPPERS = new Set(["sudo", "doas", "time", "nice", "nohup", "command", "exec", "corepack"]);
const CONFIG_FLAGS = /^(?:--(?:registry|userconfig|globalconfig|prefix|cwd|dir|use-yarnrc|config)|-C)(?:=|$)/;

export interface NpmInstall {
	name: string;
	cwd: string;
	unverifiable: boolean;
	/** fork: `cwd` is a folder an earlier `mkdir` of the same command makes. */
	made?: boolean;
}

/** Only registry package specs; aliases are checked under their real name. */
function packageName(spec: string): string | undefined {
	const alias = spec.indexOf("@npm:");
	if (alias >= 0) spec = spec.slice(alias + 5);
	const match = /^(@[^/]+\/[^@]+|[^@]+)(?:@(.+))?$/.exec(spec);
	if (!match || !PACKAGE_NAME.test(match[1])) return undefined;
	if (match[2] && /^(?:file:|link:|workspace:|https?:|git|github:|gitlab:|bitbucket:)|\//.test(match[2]))
		return undefined;
	if (/\.(?:tgz|tar\.gz)$/i.test(match[1])) return undefined;
	return match[1];
}

/** Named installs and, with `read`, bare npm installs' manifest specs. No script execution or expansion. */
export function parseInstalls(command: string, cwd = ".", read?: ReadText): NpmInstall[] {
	const installs: NpmInstall[] = [];
	let directory = resolve(cwd);
	let uncertain = false;
	const made = new Set<string>();
	const segments = command.split(new RegExp(`(${SEGMENT_SPLIT_RE.source})`));
	for (let part = 0; part < segments.length; part += 2) {
		const segment = segments[part];
		const words = (segment.match(/(?:[^\s"'\\]|\\.|"[^"]*"|'[^']*')+/g) ?? []).map((word) =>
			word.replace(/^["']|["']$/g, "").replace(/\\(.)/g, "$1"),
		);
		let unsupported = uncertain;
		while (words[0] === "env" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")) {
			if (words[0] !== "env") unsupported = true;
			words.shift();
		}
		// `mkdir a && cd a && npm install x`: the folder is not there when the guard runs, and has nothing of its own.
		if (words[0] === "mkdir") {
			for (const word of words.slice(1))
				if (!word.startsWith("-") && !/[~$`*?[]/.test(word)) made.add(resolve(directory, word));
			continue;
		}
		if (words[0] === "cd") {
			// A failed cd followed by ';' or '||' would install from the original directory.
			if (segments[part + 1] !== "&&") uncertain = true;
			if (words.length === 2 && !/[~$`]/.test(words[1]) && words[1] !== "-")
				directory = resolve(directory, words[1]);
			else uncertain = true;
			continue;
		}
		// prefixes that run the command after them. Their options are skipped; one that
		// may change the user or the environment (sudo -u, -E…) leaves the registry unknown.
		while (WRAPPERS.has(words[0] ?? "")) {
			const wrapper = words.shift();
			while (words[0]?.startsWith("-")) {
				const option = words.shift();
				if (wrapper === "nice" && option === "-n") words.shift();
				else {
					unsupported = true;
					if (/^-[ugCDhpRrtTU]$/.test(option ?? "") && wrapper !== "nice") words.shift();
				}
			}
		}
		if (
			words[0] === "export" &&
			words.some((word) => /^(?:npm_config_|NPM_CONFIG_|YARN_NPM_REGISTRY_SERVER)/.test(word))
		)
			uncertain = true;
		if (!/^(?:\/(?:usr\/(?:local\/)?)?bin\/)?(?:npm|pnpm|yarn|bun)$/.test(words[0] ?? "")) continue;
		const manager = words.shift()?.split("/").pop();
		const operands: string[] = [];
		let global = false;
		for (let i = 0; i < words.length; i++) {
			const word = words[i];
			if (word === "-g" || word === "--global" || word === "--location=global") global = true;
			else if (word === "--location") {
				if (words[++i] === "global") global = true;
				continue;
			}
			if (word === "--") {
				operands.push(...words.slice(i + 1));
				break;
			}
			if (word.startsWith("-")) {
				if (CONFIG_FLAGS.test(word)) unsupported = true;
				if (VALUE_FLAGS.has(word)) i++;
			} else if (/^\d*(?:>>?|<|&>)$/.test(word)) i++;
			else if (!/^(?:\d*[<>]|&>)/.test(word)) operands.push(word);
		}
		const subcommand = operands.shift();
		const allowed = manager === "npm" ? NPM_INSTALLS : manager === "yarn" ? ["add"] : ["add", "install", "i"];
		if (!subcommand || !allowed.includes(subcommand)) continue;
		if (manager === "npm" && operands.length === 0 && read) {
			try {
				const manifest: unknown = JSON.parse(read(join(projectDirectory(directory, read), "package.json")) ?? "{}");
				if (!record(manifest)) throw new Error("Invalid package configuration");
				for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
					const dependencies = manifest[field];
					if (record(dependencies)) {
						for (const [name, spec] of Object.entries(dependencies)) {
							if (typeof spec === "string") operands.push(`${name}@${spec}`);
						}
					}
				}
			} catch {
				installs.push({ name: "package.json", cwd: directory, unverifiable: true });
			}
		}
		for (const spec of operands) {
			const name = packageName(spec);
			// fork: a global install reads other configuration layers than the project's;
			// they are not reproduced, so its registry is not guessed and nothing is sent.
			if (name)
				installs.push({
					name,
					cwd: directory,
					unverifiable: unsupported || global,
					...(made.has(directory) ? { made: true } : {}),
				});
		}
	}
	return installs;
}

export type Registry = { url: string; public: boolean } | { error: string };

/** Parse only registry entries; authentication values are never interpreted or returned. */
/**
 * npm's layers, lowest first: global npmrc, user npmrc, project npmrc, then `envNpmrc`, the registry settings of
 * `npm_config_*` variables.
 */
export function resolveRegistry(
	name: string,
	projectNpmrc = "",
	userNpmrc = "",
	envNpmrc = "",
	globalNpmrc = "",
): Registry {
	const entries = new Map<string, string>();
	for (const text of [globalNpmrc, userNpmrc, projectNpmrc, envNpmrc]) {
		for (const raw of text.split(/\r?\n/)) {
			const line = raw.trim();
			if (!line || /^[#;]/.test(line)) continue;
			const equals = line.indexOf("=");
			if (equals < 1) return { error: "Registry configuration could not be parsed." };
			const key = line.slice(0, equals).trim();
			if (key.startsWith("//") || /^(?:_auth|_authToken|_password|username)$/.test(key)) continue;
			if (
				["userconfig", "globalconfig"].includes(key) ||
				(/registry/i.test(key) && key !== "registry" && !/^@[^\s:]+:registry$/.test(key))
			)
				return { error: "Registry configuration is unsupported or invalid." };
			if (key !== "registry" && !/^@[^\s:]+:registry$/.test(key)) continue;
			const value = line
				.slice(equals + 1)
				.trim()
				.replace(/^(["'])(.*)\1$/, "$2");
			entries.set(key, value);
		}
	}
	const scope = name.startsWith("@") ? name.split("/")[0] : undefined;
	const raw = (scope ? entries.get(`${scope}:registry`) : undefined) ?? entries.get("registry") ?? PUBLIC_REGISTRY;
	try {
		if (/[${}\s]/.test(raw)) throw new Error();
		const url = new URL(raw);
		if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
		if (!url.pathname.endsWith("/")) url.pathname += "/";
		return { url: url.href, public: url.href === PUBLIC_REGISTRY };
	} catch {
		return { error: "Registry configuration is unsupported or invalid." };
	}
}

type ReadText = (path: string) => string | undefined;
const readText: ReadText = (path) => {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error("Could not read package configuration");
	}
};

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Nearest project manifest, as used for installs from a project's subdirectories. */
function projectDirectory(cwd: string, read: ReadText): string {
	for (let dir = cwd; ; dir = dirname(dir)) {
		if (read(join(dir, "package.json")) !== undefined) return dir;
		if (dirname(dir) === dir) return cwd;
	}
}

export function lockedNames(cwd: string, read: ReadText = readText): Set<string> {
	const names = new Set<string>();
	for (const file of ["npm-shrinkwrap.json", "package-lock.json"]) {
		const text = read(join(cwd, file));
		if (text === undefined) continue;
		const json: unknown = JSON.parse(text);
		if (!record(json)) throw new Error("Invalid package configuration");
		if (record(json.packages)) {
			for (const path of Object.keys(json.packages)) {
				if (path.startsWith("node_modules/")) names.add(path.slice(13));
			}
		} else {
			for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
				if (record(json[field])) for (const name of Object.keys(json[field])) names.add(name);
			}
		}
	}
	return names;
}

/** Whether another package manager's lockfile names `name`; a text search, since these are not JSON. */
function otherLockNames(cwd: string, name: string, read: ReadText): boolean {
	const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
	const entry = new RegExp(`(?:^|[\\s"'/])${escaped}@`, "m");
	return ["pnpm-lock.yaml", "yarn.lock", "bun.lock"].some((file) => entry.test(read(join(cwd, file)) ?? ""));
}

/**
 * Registry settings this guard does not parse: Yarn and Bun. When one names a registry or scopes,
 * the real registry is unknown, so no request is made: guessing could send a private name to the public registry.
 */
/**
 * Whether the `.npmrc` of a folder above the project names a registry. npm may read it (a workspace root, or the
 * folder of a `node_modules` above the project); this guard does not reproduce that search, so it does not guess.
 */
function parentRegistryConfig(cwd: string, userNpmrc: string, read: ReadText): boolean {
	for (let dir = dirname(cwd); ; dir = dirname(dir)) {
		const file = join(dir, ".npmrc");
		if (file !== userNpmrc && /registry/i.test(read(file) ?? "")) return true;
		if (dirname(dir) === dir) return false;
	}
}

function foreignRegistryConfig(cwd: string, home: string, read: ReadText): boolean {
	const files = [
		join(cwd, ".yarnrc.yml"),
		join(cwd, ".yarnrc"),
		join(cwd, "bunfig.toml"),
		join(home, ".yarnrc.yml"),
		join(home, ".yarnrc"),
		join(home, ".bunfig.toml"),
	];
	return files.some((file) => /registry|npmScopes|scopes/i.test(read(file) ?? ""));
}

/** Bounded Damerau-Levenshtein (adjacent swaps included); package names are at most 214 characters. */
function similar(left: string, right: string): boolean {
	const limit = left.length >= 8 ? 2 : 1;
	if (Math.abs(left.length - right.length) > limit) return false;
	const rows = Array.from({ length: left.length + 1 }, () => new Array<number>(right.length + 1).fill(0));
	for (let i = 0; i <= left.length; i++) rows[i][0] = i;
	for (let j = 0; j <= right.length; j++) rows[0][j] = j;
	for (let i = 1; i <= left.length; i++) {
		for (let j = 1; j <= right.length; j++) {
			rows[i][j] = Math.min(
				rows[i - 1][j] + 1,
				rows[i][j - 1] + 1,
				rows[i - 1][j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
			);
			if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1])
				rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
		}
	}
	return rows[left.length][right.length] <= limit;
}

export function popularLookalike(name: string): string | undefined {
	if (POPULAR_NPM_PACKAGES.some((popular) => popular === name)) return undefined;
	const base = name.replace(/^@[^/]+\//, "");
	return POPULAR_NPM_PACKAGES.find((popular) => {
		const other = popular.replace(/^@[^/]+\//, "");
		return (
			(name !== popular && base === other && (name === base || popular === other)) ||
			name.replace(/[-_.]/g, "-") === popular.replace(/[-_.]/g, "-") ||
			similar(name, popular)
		);
	});
}

export type RegistryFetch = (
	url: string,
	init: { signal: AbortSignal; redirect: "error" },
) => Promise<Pick<Response, "status" | "body">>;
/**
 * fork: the most a registry answer may hold. The full metadata of `next`, the largest seen,
 * is about 30 MiB; a registry that answers without end is cut here instead of filling the engine.
 */
export const REGISTRY_MAX_BYTES = 64 * 1024 * 1024;
export interface PackageCheck {
	name: string;
	reasons: string[];
	details: string[];
}
interface CheckOptions {
	fetch: RegistryFetch;
	/**
	 * whether Prism may contact `url` now, without a question: undefined when it may,
	 * else the name the network permissions refuse. `fixed` marks Prism's own public endpoints; any other comes from a configuration.
	 * Without it, every destination is contacted.
	 */
	reach?: (url: URL, fixed: boolean) => Promise<string | undefined>;
	now: () => number;
	signal?: AbortSignal;
	env?: NodeJS.ProcessEnv;
}

async function requestJson(url: string, options: CheckOptions): Promise<{ status: number; data?: unknown }> {
	const controller = new AbortController();
	const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
	let abort: (() => void) | undefined;
	const expired = new Promise<never>((_resolve, reject) => {
		abort = () => reject(new Error("Request timed out or was cancelled."));
		signal.addEventListener("abort", abort, { once: true });
	});
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		signal.throwIfAborted();
		return await Promise.race([
			(async () => {
				const response = await options.fetch(url, { signal, redirect: "error" });
				return {
					status: response.status,
					data:
						response.status === 200 ? await readLimitedJson(response as Response, REGISTRY_MAX_BYTES) : undefined,
				};
			})(),
			expired,
		]);
	} finally {
		clearTimeout(timer);
		if (abort) signal.removeEventListener("abort", abort);
	}
}

export async function checkPackage(name: string, registry: Registry, options: CheckOptions): Promise<PackageCheck> {
	const result: PackageCheck = { name, reasons: [], details: [] };
	const lookalike = name.length <= 214 ? popularLookalike(name) : undefined;
	if (lookalike) result.reasons.push(en("Name resembles popular package {0}.", lookalike));
	if ("error" in registry) {
		result.reasons.push(en("Package could not be verified: {0}", registry.error));
		return result;
	}
	const escaped = name.replace("/", "%2F");
	const refused = await options.reach?.(new URL(`${registry.url}${escaped}`), registry.public);
	if (refused) {
		result.reasons.push(
			en(
				"Package could not be verified: Prism's network permissions do not allow {0}; it was not contacted.",
				refused,
			),
		);
		return result;
	}
	try {
		const response = await requestJson(`${registry.url}${escaped}`, options);
		if (response.status === 404) {
			result.reasons.push("Package does not exist in the configured registry (HTTP 404).");
			return result;
		}
		if (response.status !== 200) {
			result.reasons.push(en("Package could not be verified: registry returned HTTP {0}.", String(response.status)));
			return result;
		}
		const metadata = response.data;
		const created =
			record(metadata) && record(metadata.time) && typeof metadata.time.created === "string"
				? Date.parse(metadata.time.created)
				: Number.NaN;
		if (!Number.isFinite(created) || created > options.now()) {
			result.reasons.push("Package could not be verified: invalid registry metadata or creation date.");
			return result;
		}
		if (options.now() - created < 30 * 86_400_000) result.reasons.push("Package was created less than 30 days ago.");
	} catch (error) {
		result.reasons.push(
			error instanceof BodyTooLarge
				? "Package could not be verified: the registry's metadata is larger than 64 MiB."
				: "Package could not be verified: request failed, timed out or returned invalid JSON.",
		);
		return result;
	}
	const downloads = `https://api.npmjs.org/downloads/point/last-week/${escaped}`;
	if (registry.public && (await options.reach?.(new URL(downloads), true)))
		result.details.push("Weekly downloads unavailable; the download check was omitted.");
	else if (registry.public) {
		try {
			const response = await requestJson(downloads, options);
			if (
				response.status !== 200 ||
				!record(response.data) ||
				typeof response.data.downloads !== "number" ||
				!Number.isFinite(response.data.downloads) ||
				response.data.downloads < 0
			)
				throw new Error();
			if (response.data.downloads < 1_000)
				result.reasons.push(
					en("Only {0} downloads last week (fewer than 1,000).", String(response.data.downloads)),
				);
		} catch {
			result.details.push("Weekly downloads unavailable; the download check was omitted.");
		}
	} else result.details.push("Weekly downloads are not queried for private registries.");
	return result;
}

export async function checkInstalls(
	command: string,
	options: CheckOptions & { cwd: string; home: string; read?: ReadText },
): Promise<PackageCheck[]> {
	const read = options.read ?? readText;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), COMMAND_TIMEOUT_MS);
	const installs = parseInstalls(command, options.cwd, read);
	const results: PackageCheck[] = [];
	const seen = new Set<string>();
	let next = 0;
	try {
		// Four workers bound concurrent registry traffic; queued packages fail closed when the cap expires.
		await Promise.all(
			Array.from({ length: Math.min(4, installs.length) }, async () => {
				while (next < installs.length) {
					const install = installs[next++];
					let registry: Registry;
					try {
						// fork: a folder the command makes first (`mkdir p && cd p && npm install x`)
						// is not there yet; its configuration is that of the folders above it, read below as npm will. Any
						// other missing folder stays unknown.
						const folder = options.read ? undefined : statSync(install.cwd, { throwIfNoEntry: false });
						if (!options.read && !(folder ? folder.isDirectory() : install.made)) throw new Error();
						const cwd = projectDirectory(install.cwd, read);
						if (lockedNames(cwd, read).has(install.name) || otherLockNames(cwd, install.name, read)) continue;
						// npm runs scripts with npm_config_registry set, so registry variables are read, not refused.
						// npm runs scripts with its config in npm_config_* variables, so they are read like npm does.
						const env = Object.entries(options.env ?? {});
						const variable = (name: string) =>
							env.find(([key, value]) => key.toLowerCase() === name && value)?.[1];
						const environmentOverride = env.some(([key]) =>
							/^(?:YARN_NPM_(?:REGISTRY_SERVER|SCOPES)|BUN_CONFIG_REGISTRY)$/i.test(key),
						);
						const globalconfig = variable("npm_config_globalconfig");
						const prefix = variable("npm_config_prefix");
						const globalPaths = globalconfig
							? [globalconfig]
							: prefix
								? [join(prefix, "etc", "npmrc")]
								: ["/etc/npmrc", "/usr/etc/npmrc", "/usr/local/etc/npmrc"];
						const envNpmrc = env
							.filter(([key, value]) => /^npm_config_.*registry$/i.test(key) && value !== undefined)
							.map(([key, value]) => `${key.slice("npm_config_".length).toLowerCase()}=${value}`)
							.join("\n");
						const userNpmrc = variable("npm_config_userconfig") ?? join(options.home, ".npmrc");
						// fork: global mode set by the environment, as by `-g`.
						const global =
							!/^(?:|false)$/.test(variable("npm_config_global") ?? "") ||
							variable("npm_config_location") === "global";
						registry =
							install.unverifiable ||
							global ||
							environmentOverride ||
							foreignRegistryConfig(cwd, options.home, read)
								? { error: "Command changes the package configuration; registry could not be determined." }
								: parentRegistryConfig(cwd, userNpmrc, read)
									? { error: "A parent folder's .npmrc may choose the registry; it could not be determined." }
									: resolveRegistry(
											install.name,
											read(join(cwd, ".npmrc")),
											read(userNpmrc),
											envNpmrc,
											globalPaths.map((path) => read(path) ?? "").join("\n"),
										);
					} catch {
						registry = { error: "Project or registry configuration could not be read or parsed." };
					}
					const key = JSON.stringify([install.name, registry]);
					if (seen.has(key)) continue;
					seen.add(key);
					results.push(await checkPackage(install.name, registry, { ...options, signal: controller.signal }));
				}
			}),
		);
	} finally {
		clearTimeout(timer);
	}
	return results;
}

/**
 * Requests that connect only to the addresses the DNS guard checked, so a name cannot lead elsewhere between the
 * policy's check and the request (as `web_fetch` does).
 */
export function guardedFetch(lookup: LookupFunction): { fetch: RegistryFetch; close: () => Promise<void> } {
	const dispatcher = new EnvHttpProxyAgent({ connect: { lookup } });
	return { fetch: (url, init) => undiciFetch(url, { ...init, dispatcher }), close: () => dispatcher.destroy() };
}

/** One call-only question, also in broad mode. The caller preserves unrestricted mode's semantics. */
export async function npmInstallRefusal(
	command: string,
	options: CheckOptions & { cwd: string; home: string; ui?: Pick<ExtensionContext["ui"], "select"> },
): Promise<string | undefined> {
	const flagged = (await checkInstalls(command, options)).filter((result) => result.reasons.length > 0);
	if (flagged.length === 0) return undefined;
	const list = (show: (line: string) => string) =>
		flagged
			.map(
				({ name, reasons, details }) =>
					`${name}:\n${[...reasons, ...details].map((line) => `  - ${show(line)}`).join("\n")}`,
			)
			.join("\n\n");
	const warning =
		"These are heuristics, not proof of malice. You can confirm once. The sandbox remains the real boundary for install scripts.";
	const confirm = t("Confirm npm install once (this call only)");
	if (
		options.ui &&
		(await options.ui.select(
			[t("Review suspicious npm packages before installing?"), list(t), t(warning)].join("\n\n"),
			[confirm, t("Refuse npm install")],
			{ timeout: 180_000 },
		)) === confirm
	)
		return undefined;
	return [
		"npm install blocked: suspicious or unverifiable packages were refused or could not be confirmed. Do not retry through another command; ask the user to review this install.",
		list((line) => line),
		warning,
	].join("\n\n");
}
