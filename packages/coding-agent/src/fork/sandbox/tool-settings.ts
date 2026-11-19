/**
 * fork: with reading limited, the sandbox shows the settings of npm, pip,
 * uv and Cargo rebuilt from an allowed list of fields, not the files themselves, which can hold registry tokens.
 * The list is strict: what is not listed is left out, and so is a listed field whose
 * value names credentials (a URL with a user or a password), or that this reader cannot follow (a multi-line value
 * where one line is expected).
 */
import { lstatSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/** A URL that carries a user, a password or a token before the host: https://user:secret@host. */
const CREDENTIALS_IN_URL = /[a-z][a-z0-9+.-]*:\/\/[^/\s"'@]+@/i;

const NPM_KEYS = new Set(["registry", "prefix", "cache", "strict-ssl", "cafile", "save-exact", "engine-strict"]);

/** ~/.npmrc: `key=value` lines; `@scope:registry` counts as registry. npm does not read a section's lines. */
export function rebuildNpmrc(text: string): string {
	const kept: string[] = [];
	for (const raw of text.split(/\r?\n/)) {
		if (/^\s*\[/.test(raw)) break;
		const match = /^\s*([^=;#\s][^=]*?)\s*=\s*(.*?)\s*$/.exec(raw);
		if (!match) continue;
		const key = match[1]!;
		const value = match[2]!;
		if (!NPM_KEYS.has(key) && !/^@[^:\s]+:registry$/.test(key)) continue;
		if (CREDENTIALS_IN_URL.test(value)) continue;
		kept.push(`${key}=${value}`);
	}
	return kept.length > 0 ? `${kept.join("\n")}\n` : "";
}

const PIP_KEYS = new Set(["index-url", "extra-index-url", "trusted-host", "timeout"]);

/** pip.conf: INI sections; a value continued on indented lines is kept whole, or dropped whole. */
export function rebuildPipConf(text: string): string {
	const out: string[] = [];
	let section: string | undefined;
	let sectionShown = false;
	let current: { key: string; lines: string[] } | undefined;
	const flush = () => {
		if (!current) return;
		const { key, lines } = current;
		current = undefined;
		if (!section || !PIP_KEYS.has(key) || lines.some((line) => CREDENTIALS_IN_URL.test(line))) return;
		if (!sectionShown) {
			out.push(`[${section}]`);
			sectionShown = true;
		}
		out.push(...lines);
	};
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.replace(/\s+$/, "");
		if (current && /^\s+\S/.test(line) && !/^\s*[#;]/.test(line)) {
			current.lines.push(line);
			continue;
		}
		flush();
		const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
		if (header) {
			section = header[1]!.trim();
			sectionShown = false;
			continue;
		}
		const entry = /^([A-Za-z0-9_.-]+)\s*[=:]\s*(.*)$/.exec(line);
		if (entry) current = { key: entry[1]!.toLowerCase().replaceAll("_", "-"), lines: [line] };
	}
	flush();
	return out.length > 0 ? `${out.join("\n")}\n` : "";
}

const TOML_ESCAPES: Record<string, string> = {
	b: "\b",
	t: "\t",
	n: "\n",
	f: "\f",
	r: "\r",
	e: "\x1b",
	'"': '"',
	"\\": "\\",
};

/**
 * fork: a value as TOML reads it, its escapes decoded, so that `user:secret\u0040host`
 * is seen as the URL with credentials it is. Undefined for an escape this reader does not know: in doubt, left out.
 */
function decodedTomlValue(value: string): string | undefined {
	let unknown = false;
	const decoded = value.replace(
		/\\(?:u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8})|x([0-9a-fA-F]{2})|(.)|$)/g,
		(_all, u, big, x, other) => {
			const code = u ?? big ?? x;
			if (code !== undefined) {
				const point = Number.parseInt(code, 16);
				if (point <= 0x10ffff) return String.fromCodePoint(point);
			} else if (other !== undefined && Object.hasOwn(TOML_ESCAPES, other)) return TOML_ESCAPES[other]!;
			unknown = true;
			return "";
		},
	);
	return unknown ? undefined : decoded;
}

/**
 * A TOML file read line by line: `[table]` headers and `key = value` lines; an array of tables (`[[index]]`) keeps
 * nothing. A value that does not end on its line (an array or a string over several lines) is dropped with the lines
 * up to its end: in doubt, left out.
 */
function rebuildToml(text: string, keep: (table: string, key: string) => boolean): string {
	const out: string[] = [];
	let table = "";
	let tableShown = true;
	// The end of a dropped value over several lines.
	let until: RegExp | undefined;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.replace(/\s+$/, "");
		if (until) {
			if (until.test(line)) until = undefined;
			continue;
		}
		const header = /^\s*(\[\[?)\s*([^[\]]+?)\s*\]\]?\s*(#.*)?$/.exec(line);
		if (header) {
			table = header[1] === "[[" ? `[[${header[2]}]]` : header[2]!;
			tableShown = false;
			continue;
		}
		const entry = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
		if (!entry) continue;
		const key = entry[1]!;
		const value = entry[2]!.replace(/\s+#[^"']*$/, "");
		const quote = /^("""|''')/.exec(value)?.[1];
		if (quote && !value.slice(3).includes(quote)) {
			until = new RegExp(quote);
			continue;
		}
		const open = value[0] === "[" ? "]" : value[0] === "{" ? "}" : undefined;
		if (open && !value.endsWith(open)) {
			until = open === "]" ? /\]\s*(#.*)?$/ : /\}\s*(#.*)?$/;
			continue;
		}
		const decoded = decodedTomlValue(value);
		if (!keep(table, key) || decoded === undefined || CREDENTIALS_IN_URL.test(decoded)) continue;
		if (!tableShown && table) out.push(`[${table}]`);
		tableShown = true;
		out.push(line.trim());
	}
	return out.length > 0 ? `${out.join("\n")}\n` : "";
}

const UV_KEYS = new Set(["index-url", "extra-index-url", "allow-insecure-host", "http-timeout"]);

/** ~/.config/uv/uv.toml: the pip fields, at the top level or in its [pip] table. */
export const rebuildUvToml = (text: string): string =>
	rebuildToml(text, (table, key) => (table === "" || table === "pip") && UV_KEYS.has(key));

/** Cargo's config.toml: [build], [target.*], [net], [source.*], and only the index of a registry. */
export const rebuildCargoConfig = (text: string): string =>
	rebuildToml(text, (table, key) => {
		if (table === "build" || table === "source" || table.startsWith("source.")) return true;
		if (table === "target" || table.startsWith("target.")) return true;
		if (table === "net") return true;
		return /^registries\.[^.]+$/.test(table) && key === "index";
	});

/** The settings files rebuilt this way, relative to the home folder, with their reader and their tool's row. */
export const REBUILT_SETTINGS: readonly { path: string; tool: string; rebuild: (text: string) => string }[] = [
	{ path: ".npmrc", tool: "npm, pnpm", rebuild: rebuildNpmrc },
	{ path: ".config/pip/pip.conf", tool: "Python", rebuild: rebuildPipConf },
	{ path: ".pip/pip.conf", tool: "Python", rebuild: rebuildPipConf },
	{ path: ".config/uv/uv.toml", tool: "Python", rebuild: rebuildUvToml },
	{ path: ".cargo/config.toml", tool: "Rust", rebuild: rebuildCargoConfig },
	{ path: ".cargo/config", tool: "Rust", rebuild: rebuildCargoConfig },
];

/**
 * fork: a variable that moves a tool's folder moves its credentials and
 * settings with it. Cargo keeps `credentials.toml` and `config.toml` in `$CARGO_HOME`, `~/.cargo` by default.
 */
const TOOL_HOMES: Readonly<Record<string, string>> = { ".cargo": "CARGO_HOME" };

/** `path` (relative to the home folder) in the home folder, then where a variable of TOOL_HOMES moves it. */
export function relocated(path: string, home: string, env: Record<string, string | undefined>): string[] {
	const paths = [join(home, path)];
	for (const [folder, name] of Object.entries(TOOL_HOMES)) {
		const value = env[name];
		if (value && isAbsolute(value) && path.startsWith(`${folder}/`))
			paths.push(join(value, path.slice(folder.length + 1)));
	}
	return paths;
}

/** The entry of REBUILT_SETTINGS for `original`, in the home folder or in a moved tool folder. */
const settingReader = (original: string) =>
	REBUILT_SETTINGS.find(({ path }) => {
		const folder = Object.keys(TOOL_HOMES).find((name) => path.startsWith(`${name}/`));
		return original.endsWith(`/${path}`) || (folder && original.endsWith(`/${path.slice(folder.length + 1)}`));
	});

/**
 * Pairs [copy, original] to bind in the sandbox: a rebuilt copy, written to `dir`, of each of `originals` (paths of
 * REBUILT_SETTINGS in the home folder) that is a regular file. A file that cannot be read gets an empty copy, not
 * the file; a link or a folder gets none, and stays hidden.
 */
export function rebuiltSettingsCopies(dir: string, originals: readonly string[]): Array<[string, string]> {
	const copies: Array<[string, string]> = [];
	for (const original of originals) {
		const reader = settingReader(original);
		try {
			if (!reader || !lstatSync(original).isFile()) continue;
			let content = "";
			try {
				content = reader.rebuild(readFileSync(original, "utf8"));
			} catch {}
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			// Encoded, not "/" to "_", as the SSH copies: two paths must not share a copy.
			const copy = join(dir, `settings-${encodeURIComponent(original)}`);
			let current: string | undefined;
			try {
				if (statSync(copy).uid === process.getuid?.()) current = readFileSync(copy, "utf8");
			} catch {}
			if (current !== content) {
				// Renamed into place: another session's command may be reading the copy.
				const next = `${copy}.${process.pid}`;
				writeFileSync(next, content, { mode: 0o600 });
				renameSync(next, copy);
			}
			copies.push([copy, original]);
		} catch {}
	}
	return copies;
}
