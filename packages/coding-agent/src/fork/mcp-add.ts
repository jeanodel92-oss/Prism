/**
 * fork.10.5 ("MCP devrait être configurable comme LSP et skills … pas avoir à éditer des .json à la main")
 * `/mcp add` and the manager's "Add a server" ask for a server in a few questions and write it
 * to the global or the project `mcp.json` with the extension's own writer, then reload the session so it connects.
 * `/mcp`'s "Remove" takes one out the same way. The questions are the extension UI's dialogs, so they work in the
 * terminal and in the Prism window alike. Nothing here connects to a server: the MCP extension does, after reload.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.ts";
import type { ExtensionContext } from "../core/extensions/types.ts";
import { type McpServerConfig, validateMcpServerConfig } from "../core/mcp-servers.ts";
import { addMcpServerConfig, removeMcpServerConfig } from "../extensions/mcp/config.ts";
import { confirmCurrent } from "./confirm-current.ts";
import { fill, t } from "./i18n/index.ts";

/** The value of the manager's "Add a server" row; not a valid server name, so it never clashes with one. */
export const ADD_SERVER = "+add";

/**
 * Splits a command line as a shell would for one simple command: words separated by spaces, '…' and "…" kept
 * together, a backslash escaping the next character. Undefined when a quote is left open.
 */
export function splitCommandLine(line: string): string[] | undefined {
	const words: string[] = [];
	let word = "";
	let started = false;
	let quote: "'" | '"' | undefined;
	for (let i = 0; i < line.length; i++) {
		const char = line[i]!;
		if (quote) {
			if (char === quote) quote = undefined;
			else if (char === "\\" && quote === '"' && i + 1 < line.length) word += line[++i];
			else word += char;
		} else if (char === "'" || char === '"') {
			quote = char;
			started = true;
		} else if (char === "\\" && i + 1 < line.length) {
			word += line[++i];
			started = true;
		} else if (/\s/.test(char)) {
			if (started) words.push(word);
			word = "";
			started = false;
		} else {
			word += char;
			started = true;
		}
	}
	if (quote) return undefined;
	if (started) words.push(word);
	return words;
}

/** `NAME=value` pairs separated by spaces (quoted values may hold spaces); undefined when one has no `=`. */
export function parseEnvironment(line: string): Record<string, string> | undefined {
	const words = splitCommandLine(line);
	if (!words) return undefined;
	const env: Record<string, string> = {};
	for (const word of words) {
		const at = word.indexOf("=");
		if (at <= 0) return undefined;
		env[word.slice(0, at)] = word.slice(at + 1);
	}
	return env;
}

/** The entry `name` has in the `mcp.json` at `path`, as JSON, or undefined when that file does not define it. */
function mcpEntry(path: string, name: string): string | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
	const servers = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
	if (typeof servers !== "object" || servers === null || !Object.hasOwn(servers, name)) return undefined;
	return JSON.stringify((servers as Record<string, unknown>)[name]);
}

function mcpPath(ctx: ExtensionContext, scope: "global" | "project"): string {
	return scope === "global" ? join(getAgentDir(), "mcp.json") : join(ctx.cwd, CONFIG_DIR_NAME, "mcp.json");
}

/** Asks again until `check` accepts the answer (it returns the problem to show), or undefined when cancelled. */
async function ask(
	ctx: ExtensionContext,
	title: string,
	placeholder: string,
	check: (answer: string) => string | undefined,
): Promise<string | undefined> {
	for (;;) {
		const answer = await ctx.ui.input(title, placeholder);
		if (answer === undefined) return undefined;
		const problem = check(answer.trim());
		if (!problem) return answer.trim();
		ctx.ui.notify(problem, "warning");
	}
}

/** The questions of `/mcp add`; true when a server was written (the caller reloads). */
export async function askMcpServer(ctx: ExtensionContext): Promise<boolean> {
	const local = t("A program on this computer (a command)");
	const remote = t("A web address (URL)");
	const kind = await ctx.ui.select(t("Add an MCP server: how is it reached?"), [local, remote]);
	if (kind !== local && kind !== remote) return false;

	const name = await ask(
		ctx,
		t("Server name (letters, digits, - and _)"),
		local === kind ? "filesystem" : "docs",
		(answer) => (/^[A-Za-z0-9_-]+$/.test(answer) ? undefined : t("Use only letters, digits, - and _ in the name.")),
	);
	if (!name) return false;

	let config: McpServerConfig;
	if (kind === local) {
		const line = await ask(
			ctx,
			t("Command that starts the server"),
			"npx -y @modelcontextprotocol/server-filesystem .",
			(answer) => (splitCommandLine(answer)?.length ? undefined : t("Type the command, with its arguments.")),
		);
		if (!line) return false;
		const [command, ...args] = splitCommandLine(line)!;
		const envLine = await ask(
			ctx,
			t("Environment variables it needs, as NAME=value (optional: leave empty for none)"),
			// biome-ignore lint/suspicious/noTemplateCurlyInString: an mcp.json value that reads an environment variable
			"GITHUB_TOKEN=${GITHUB_TOKEN}",
			(answer) => (!answer || parseEnvironment(answer) ? undefined : t("Write each variable as NAME=value.")),
		);
		if (envLine === undefined) return false;
		const env = envLine ? parseEnvironment(envLine) : undefined;
		config = { command: command!, ...(args.length ? { args } : {}), ...(env ? { env } : {}) };
	} else {
		const url = await ask(ctx, t("Server address"), "https://example.com/mcp", (answer) =>
			URL.canParse(answer) && /^https?:$/.test(new URL(answer).protocol)
				? undefined
				: t("Type an address that starts with https:// or http://."),
		);
		if (!url) return false;
		const signIn = t("No key: sign in in the browser if the server asks");
		const token = t("A key read from an environment variable");
		const auth = await ctx.ui.select(t("How does Prism prove who you are?"), [signIn, token]);
		if (auth !== signIn && auth !== token) return false;
		let headers: Record<string, string> | undefined;
		if (auth === token) {
			const variable = await ask(
				ctx,
				t("Name of the environment variable that holds the key"),
				"DOCS_TOKEN",
				(answer) =>
					/^[A-Za-z_][A-Za-z0-9_]*$/.test(answer) ? undefined : t("Use the variable's name, such as DOCS_TOKEN."),
			);
			if (!variable) return false;
			headers = { Authorization: `Bearer \${${variable}}` };
		}
		config = { url, ...(headers ? { headers } : {}) };
	}

	const everywhere = t("Every project");
	const here = t("This project only");
	const scopes = ctx.isProjectTrusted() ? [everywhere, here] : [everywhere];
	const where = scopes.length > 1 ? await ctx.ui.select(t("Use this server in"), scopes) : everywhere;
	if (where !== everywhere && where !== here) return false;
	const scope = where === here ? "project" : "global";

	const valid = validateMcpServerConfig(name, config);
	if (typeof valid === "string") {
		ctx.ui.notify(valid, "error");
		return false;
	}
	const path = mcpPath(ctx, scope);
	// fork: whether the chosen file already has the name is read in that
	// file, not in the merged configuration, where a project server hides a global one of the same name. The answer
	// applies to the entry it showed (confirmCurrent): an entry changed during the question is asked about again.
	const confirmed = await confirmCurrent(
		(entry) =>
			entry === undefined ||
			ctx.ui.confirm(t("Replace this server?"), fill('"{0}" is already configured there.', name)),
		() => {
			const entry = mcpEntry(path, name);
			return { value: entry, version: entry ?? "" };
		},
	).catch((error: Error) => {
		ctx.ui.notify(error.message, "warning");
		return undefined;
	});
	if (!confirmed) return false;
	try {
		addMcpServerConfig(path, name, valid);
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		return false;
	}
	ctx.ui.notify(fill('MCP server "{0}" added to {1}. Prism reloads to connect it.', name, path), "info");
	if (scope === "global" && ctx.isProjectTrusted() && mcpEntry(mcpPath(ctx, "project"), name) !== undefined)
		ctx.ui.notify(
			fill('This project\'s mcp.json also defines "{0}": that one is used in this project.', name),
			"warning",
		);
	return true;
}

/** Takes `name` out of the `mcp.json` at `source` after a confirmation; true when it was removed (the caller reloads). */
export async function removeMcpServer(ctx: ExtensionContext, name: string, source: string): Promise<boolean> {
	if (!(await ctx.ui.confirm(t("Remove this MCP server?"), fill('"{0}" is taken out of {1}.', name, source))))
		return false;
	try {
		if (!removeMcpServerConfig(source, name)) {
			ctx.ui.notify(fill('MCP server "{0}" is not configured.', name), "warning");
			return false;
		}
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		return false;
	}
	ctx.ui.notify(fill('MCP server "{0}" removed.', name), "info");
	return true;
}
