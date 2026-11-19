/**
 * fork: suggest the language servers a coding project would use. pi-lsp starts servers
 * that are already on PATH and never installs them; its `/lsp` lists every server of its catalog
 * as "command missing", in a warning, which read as a bug. Here:
 *
 * - a project with source files gets one short notice, once per project, naming the servers of
 *   its languages that are not installed; a project without code (notes, documents) gets nothing;
 * - `/lsp-setup` lists those servers as "ready", "to install" or "turned off". Choosing one offers
 *   its install command, put in the editor as a `!` shell command: nothing is downloaded until the
 *   user presses Enter. Commands that need `sudo` are only shown, to run in a terminal. It also
 *   turns the server on or off, as its switch in /settings › Servers does.
 *
 * pi-lsp is not modified. Nothing happens when it is off. A pi-lsp configuration written by the
 * user replaces pi-lsp's catalog: there is no notice, and `/lsp-setup` marks the servers missing
 * from that configuration instead of calling them ready.
 */
import {
	accessSync,
	constants,
	type Dir,
	existsSync,
	mkdirSync,
	opendirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { basename, delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.ts";
import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";
import { fill, t } from "./i18n/index.ts";
import { disabledLspServers, setLspServerEnabled } from "./settings-servers.ts";

export interface LspServer {
	/** pi-lsp's name for the server. */
	name: string;
	language: string;
	/** Command pi-lsp starts. */
	command: string;
	extensions: string[];
	/** Install commands, best first; the first whose tool is on PATH is offered. */
	install: Array<{ tool: string; command: string }>;
}

const npm = (pkg: string) => ({ tool: "npm", command: `npm install -g ${pkg}` });

/** The common servers of pi-lsp's built-in catalog, with a Linux install command each. */
export const LSP_SERVERS: LspServer[] = [
	{
		name: "biome",
		language: "JavaScript / TypeScript",
		command: "biome",
		extensions: [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".vue", ".svelte", ".astro"],
		install: [npm("@biomejs/biome")],
	},
	{
		name: "ruff",
		language: "Python",
		command: "ruff",
		extensions: [".py", ".pyi"],
		install: [
			{ tool: "uv", command: "uv tool install ruff" },
			{ tool: "pipx", command: "pipx install ruff" },
		],
	},
	{
		name: "ty",
		language: "Python (types)",
		command: "ty",
		extensions: [".py", ".pyi"],
		install: [
			{ tool: "uv", command: "uv tool install ty" },
			{ tool: "pipx", command: "pipx install ty" },
		],
	},
	{
		name: "rust-analyzer",
		language: "Rust",
		command: "rust-analyzer",
		extensions: [".rs"],
		install: [{ tool: "rustup", command: "rustup component add rust-analyzer rust-src" }],
	},
	{
		name: "gopls",
		language: "Go",
		command: "gopls",
		extensions: [".go"],
		install: [{ tool: "go", command: "go install golang.org/x/tools/gopls@latest" }],
	},
	{
		name: "clangd",
		language: "C / C++",
		command: "clangd",
		extensions: [".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx"],
		install: [
			{ tool: "dnf", command: "sudo dnf install clang-tools-extra" },
			{ tool: "apt", command: "sudo apt install clangd" },
			{ tool: "pacman", command: "sudo pacman -S clang" },
		],
	},
	{
		name: "bash-language-server",
		language: "Shell",
		command: "bash-language-server",
		extensions: [".sh", ".bash"],
		install: [npm("bash-language-server")],
	},
	{
		name: "yaml-language-server",
		language: "YAML",
		command: "yaml-language-server",
		extensions: [".yaml", ".yml"],
		install: [npm("yaml-language-server")],
	},
	{
		name: "intelephense",
		language: "PHP",
		command: "intelephense",
		extensions: [".php"],
		install: [npm("intelephense")],
	},
];

/** Folders that hold dependencies or build output, not the project's own code. */
const SKIP = new Set(["node_modules", "vendor", "dist", "build", "target", "out", ".venv", "venv", "__pycache__"]);
const MAX_DEPTH = 4;
const MAX_ENTRIES = 5000;

/** File extensions found in the project, looking a few levels down and skipping dependencies. */
export function projectExtensions(root: string): Set<string> {
	const found = new Set<string>();
	let seen = 0;
	const walk = (dir: string, depth: number) => {
		if (depth > MAX_DEPTH || seen > MAX_ENTRIES) return;
		// fork: read entry by entry and closed at the budget, never a whole folder first.
		let folder: Dir;
		try {
			folder = opendirSync(dir);
		} catch {
			return;
		}
		try {
			for (let entry = folder.readSync(); entry; entry = folder.readSync()) {
				if (++seen > MAX_ENTRIES) return;
				if (entry.name.startsWith(".")) continue;
				if (entry.isDirectory()) {
					if (!SKIP.has(entry.name)) walk(join(dir, entry.name), depth + 1);
				} else if (entry.isFile()) {
					found.add(extname(entry.name).toLowerCase());
				}
			}
		} catch {
			// An entry that cannot be read ends this folder, as an unreadable folder does.
		} finally {
			folder.closeSync();
		}
	};
	walk(root, 0);
	return found;
}

export function onPath(command: string, path = process.env.PATH ?? ""): boolean {
	// fork: a command given as a path (from the user's pi-lsp.json) is checked
	// where it is, as pi-lsp starts it, not looked up in PATH.
	if (command.includes("/")) {
		try {
			accessSync(command, constants.X_OK);
			return true;
		} catch {
			return false;
		}
	}
	return path
		.split(delimiter)
		.filter(Boolean)
		.some((dir) => {
			try {
				accessSync(join(dir, command), constants.X_OK);
				return true;
			} catch {
				return false;
			}
		});
}

export interface ServerStatus {
	server: LspServer;
	ready: boolean;
	/** False when the user's own pi-lsp configuration does not list the server's command. */
	configured: boolean;
	/** The install command offered, if one of its tools is on PATH. */
	install?: { tool: string; command: string };
}

/**
 * The servers for the languages found in `extensions`, with whether each is installed and, when
 * the user has their own pi-lsp configuration (`ownCommands`), whether that configuration lists it.
 */
export function serversFor(
	extensions: Set<string>,
	has: (command: string) => boolean = onPath,
	ownCommands?: OwnLspServers,
): ServerStatus[] {
	return LSP_SERVERS.filter((server) => server.extensions.some((ext) => extensions.has(ext))).map((catalog) => {
		const own = ownCommands?.get(catalog.command);
		const configured = ownCommands === undefined || own !== undefined;
		// fork: pi-lsp knows a server of the user's configuration by its name
		// there and starts its command as written; turning it off must name that server, not the catalog's.
		const server = own ? { ...catalog, name: own.name, command: own.command } : catalog;
		return {
			server,
			ready: configured && has(server.command),
			configured,
			install: server.install.find((option) => has(option.tool)),
		};
	});
}

/** The configuration file pi-lsp reads instead of its catalog, in pi-lsp's order of precedence. */
function ownLspConfigPath(cwd: string, agentDir: string): string | undefined {
	for (const dir of [join(cwd, CONFIG_DIR_NAME), agentDir]) {
		for (const name of ["pi-lsp.json", "lsp.json"]) {
			if (existsSync(join(dir, name))) return join(dir, name);
		}
	}
	return undefined;
}

/** A pi-lsp configuration written by the user replaces its catalog. */
export function hasOwnLspConfig(cwd: string, agentDir = getAgentDir()): boolean {
	return ownLspConfigPath(cwd, agentDir) !== undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** The servers of the user's pi-lsp configuration, by executable name: their name there and the command as started. */
export type OwnLspServers = Map<string, { name: string; command: string }>;

/**
 * The servers in the user's pi-lsp configuration, by the executable name of their command, or undefined
 * without one. Both of pi-lsp's shapes: `{ "servers": { name: entry } }` and `{ name: entry }`.
 * An unreadable file lists nothing: pi-lsp reports its own error for it. A relative command path is resolved
 * from `cwd`, as pi-lsp does.
 */
export function ownLspCommands(cwd: string, agentDir = getAgentDir()): OwnLspServers | undefined {
	const path = ownLspConfigPath(cwd, agentDir);
	if (!path) return undefined;
	const commands: OwnLspServers = new Map();
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (!isRecord(value)) return commands;
		const servers = isRecord(value.servers) && !Array.isArray(value.servers.command) ? value.servers : value;
		for (const [name, entry] of Object.entries(servers)) {
			const command = isRecord(entry) && Array.isArray(entry.command) ? entry.command[0] : undefined;
			if (typeof command !== "string" || commands.has(basename(command))) continue;
			const started = command.includes("/") && !isAbsolute(command) ? resolve(cwd, command) : command;
			commands.set(basename(command), { name, command: started });
		}
	} catch {}
	return commands;
}

/** Projects already told about their missing servers. */
function noticesFile(agentDir = getAgentDir()): string {
	return join(agentDir, "lsp-setup.json");
}

export function wasNoticed(cwd: string, agentDir = getAgentDir()): boolean {
	try {
		const data = JSON.parse(readFileSync(noticesFile(agentDir), "utf-8")) as { noticed?: string[] };
		return data.noticed?.includes(cwd) ?? false;
	} catch {
		return false;
	}
}

export function markNoticed(cwd: string, agentDir = getAgentDir()): void {
	const file = noticesFile(agentDir);
	let noticed: string[] = [];
	try {
		noticed = (JSON.parse(readFileSync(file, "utf-8")) as { noticed?: string[] }).noticed ?? [];
	} catch {}
	if (noticed.includes(cwd)) return;
	try {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `${JSON.stringify({ noticed: [...noticed, cwd] }, null, 2)}\n`);
	} catch {}
}

/** The one-line notice for a coding project with servers to install, or nothing. */
export function suggestionNotice(statuses: ServerStatus[]): string | undefined {
	const missing = statuses.filter((status) => !status.ready);
	if (missing.length === 0) return undefined;
	const names = missing.map((status) => `${status.server.name} (${status.server.language})`).join(", ");
	return fill(
		"Language servers let the model check its code changes. To install for this project: {0}. /lsp-setup shows how.",
		names,
	);
}

/** A server's state in the manager; a server turned off in /settings is off whether installed or not. */
function stateOf(status: ServerStatus, off: Set<string>): string {
	if (!status.configured) return "not in your pi-lsp.json";
	if (off.has(status.server.name)) return "turned off";
	return status.ready ? "ready" : "to install";
}

function statusLine(status: ServerStatus, off: Set<string>): string {
	return `${status.server.name} — ${status.server.language} — ${t(stateOf(status, off))}`;
}

/** Every extension of the catalog, for the list of every server. */
const ALL_EXTENSIONS = new Set(LSP_SERVERS.flatMap((server) => server.extensions));

export interface LspSetupState {
	heading: string;
	notice?: string;
	all: boolean;
	servers: Array<{
		name: string;
		language: string;
		configured: boolean;
		enabled: boolean;
		ready: boolean;
		state: string;
		command?: string;
		sudo: boolean;
		install?: string;
	}>;
}

interface LspSetupPanel {
	snapshot(all: boolean): LspSetupState;
	setEnabled(name: string, enabled: boolean): void;
	installCommand(name: string): string;
}

const panels = new WeakMap<ExtensionContext["sessionManager"], LspSetupPanel>();

export function lspSetupPanel(ctx: ExtensionContext): LspSetupPanel | undefined {
	return panels.get(ctx.sessionManager);
}

function serverOptions(status: ServerStatus, off: Set<string>) {
	const isOff = off.has(status.server.name);
	const toggle = isOff ? t("Turn on") : t("Turn off");
	const tools = [...new Set(status.server.install.map((option) => option.tool))].join(t(" or "));
	const command = status.install?.command;
	const sudo = command?.startsWith("sudo ") === true;
	const install = status.ready
		? undefined
		: command === undefined
			? fill("How to install: {0} first", tools)
			: sudo
				? fill("Install in a terminal: {0}", command)
				: fill("Install: put {0} in the input box", command);
	const state = isOff
		? t("Turned off: lsp_diagnostics and lsp_fix do not start it.")
		: status.ready
			? t("Installed: the model checks its code with it through lsp_diagnostics and lsp_fix.")
			: t("Not installed: pi-lsp cannot start it.");
	return { isOff, toggle, tools, command, sudo, install, state };
}

/**
 * fork: what can be done with one server: install it, or turn it on or off. Resolves to true
 * when the manager closes, so that the user sees the install command put in the input box.
 */
async function manageServer(ctx: ExtensionContext, status: ServerStatus, off: Set<string>): Promise<boolean> {
	const { name, language } = status.server;
	if (!status.configured) {
		ctx.ui.notify(
			fill(
				'pi-lsp uses only the servers in your pi-lsp.json: add {0} there (command "{1}") to use it.',
				name,
				status.server.command,
			),
			"info",
		);
		return false;
	}
	const { isOff, toggle, tools, command, sudo, install, state } = serverOptions(status, off);
	const choice = await ctx.ui.select(`${name} — ${language}\n${state}`, install ? [install, toggle] : [toggle]);
	if (choice === toggle) {
		try {
			setLspServerEnabled(name, isOff);
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
		return false;
	}
	if (choice === undefined || choice !== install) return false;
	if (command === undefined) {
		ctx.ui.notify(fill("{0}: install {1} first, then run /lsp-setup again.", name, tools), "info");
		return false;
	}
	if (sudo) {
		ctx.ui.notify(fill("Run this in a terminal (it asks for your password): {0}", command), "info");
		return false;
	}
	ctx.ui.setEditorText(`!${command}`);
	ctx.ui.notify(t("The install command is in the input box: nothing runs until you press Enter."), "info");
	return true;
}

export default function lspSetup(pi: ExtensionAPI) {
	const available = () => pi.getCommands().some((command) => command.name === "lsp");

	pi.on("session_start", async (_event, ctx) => {
		const snapshot = (all: boolean): LspSetupState => {
			if (!ctx.isProjectTrusted())
				throw new Error(t("Project is not trusted — project language server settings are disabled."));
			if (!available())
				throw new Error(t("/lsp-setup: the pi-lsp module is off. Turn it on in /settings › Modules."));
			const own = ownLspCommands(ctx.cwd);
			const extensions = projectExtensions(ctx.cwd);
			const noCode = serversFor(extensions, onPath, own).length === 0;
			const off = disabledLspServers();
			return {
				all: all || noCode,
				heading: t(all || noCode ? "Language servers" : "Language servers for this project"),
				...(own ? { notice: t("You have your own pi-lsp.json: pi-lsp uses only the servers listed there.") } : {}),
				servers: serversFor(all || noCode ? ALL_EXTENSIONS : extensions, onPath, own).map((status) => {
					const options = serverOptions(status, off);
					return {
						name: status.server.name,
						language: status.server.language,
						configured: status.configured,
						enabled: !off.has(status.server.name),
						ready: status.ready,
						state: t(stateOf(status, off)),
						command: options.command,
						sudo: options.sudo,
						install: options.install,
					};
				}),
			};
		};
		const server = (name: string) => {
			const entry = snapshot(true).servers.find((item) => item.name === name);
			if (!entry) throw new Error("Unknown language server.");
			if (!entry.configured)
				throw new Error(t("You have your own pi-lsp.json: pi-lsp uses only the servers listed there."));
			return entry;
		};
		panels.set(ctx.sessionManager, {
			snapshot,
			setEnabled: (name, enabled) => {
				server(name);
				setLspServerEnabled(name, enabled);
			},
			installCommand: (name) => {
				const entry = server(name);
				if (!entry.install || !entry.command) throw new Error(entry.install ?? entry.state);
				if (entry.sudo)
					throw new Error(fill("Run this in a terminal (it asks for your password): {0}", entry.command));
				return `!${entry.command}`;
			},
		});
		if (!ctx.isProjectTrusted() || !ctx.hasUI || !available() || hasOwnLspConfig(ctx.cwd) || wasNoticed(ctx.cwd))
			return;
		const notice = suggestionNotice(serversFor(projectExtensions(ctx.cwd)));
		if (!notice) return;
		markNoticed(ctx.cwd);
		ctx.ui.notify(notice, "info");
	});
	pi.on("session_shutdown", (_event, ctx) => {
		panels.delete(ctx.sessionManager);
	});

	/**
	 * fork: the manager of /settings › Servers. It lists the servers with their state, until
	 * Esc; choosing one installs it or turns it on or off, and the list comes back with its new state.
	 */
	const setup = async (ctx: ExtensionContext, all: boolean) => {
		if (!ctx.isProjectTrusted()) {
			ctx.ui.notify(t("Project is not trusted — project language server settings are disabled."), "warning");
			return;
		}
		if (!available()) {
			// fork: the words of feature-state.ts for a module that is off.
			ctx.ui.notify(t("/lsp-setup: the pi-lsp module is off. Turn it on in /settings › Modules."), "info");
			return;
		}
		const ownCommands = ownLspCommands(ctx.cwd);
		if (ownCommands) {
			ctx.ui.notify(t("You have your own pi-lsp.json: pi-lsp uses only the servers listed there."), "info");
		}
		const extensions = projectExtensions(ctx.cwd);
		// A project without source code gets every server rather than an empty list.
		const noCode = serversFor(extensions, onPath, ownCommands).length === 0;
		let showAll = all || noCode;
		const more = t("Every language server…");
		for (;;) {
			const off = disabledLspServers();
			const statuses = serversFor(showAll ? ALL_EXTENSIONS : extensions, onPath, ownCommands);
			const lines = statuses.map((status) => statusLine(status, off));
			const heading = !showAll
				? t("Language servers for this project")
				: noCode && !all
					? t("No source code in this project: every language server")
					: t("Language servers");
			const choice = await ctx.ui.select(
				`${heading}\n${t("pi-lsp starts the ready ones. Choose one to install it or turn it off.")}`,
				showAll ? lines : [...lines, more],
			);
			if (choice === undefined) return;
			if (choice === more) {
				showAll = true;
				continue;
			}
			const status = statuses[lines.indexOf(choice)];
			if (!status || (await manageServer(ctx, status, off))) return;
		}
	};

	pi.registerCommand("lsp-setup", {
		description: "Install this project's language servers, turn them on or off; `all` lists every one",
		handler: async (args, ctx) => setup(ctx, args.trim() === "all"),
	});
}
