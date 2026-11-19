/**
 * fork: the servers in `/settings` > Servers.
 *
 * - MCP: each server on or off, and how its tools reach the model. The MCP extension adds this section while its
 *   session runs and does the change as `/mcp` does: saved to the `mcp.json` that defines the server, connected or
 *   closed right away. Signing in and reconnecting stay in `/mcp`.
 * - Language servers: each pi-lsp server on or off. pi-lsp has no such switch, so the
 *   names turned off are kept in the global settings.json (`lsp.disabled`) and Prism's fork of pi-lsp leaves them
 *   out (vendor/forks/pi-lsp/FORK.md); its configuration file is not touched.
 */
import type { SettingItem } from "@earendil-works/pi-tui";
import type { McpExposure } from "../core/mcp-servers.ts";
import { readGlobalSetting, saveGlobalSetting } from "./global-settings.ts";
import { fill, t } from "./i18n/index.ts";
import { type SettingsSection, setSettingsSection, settingsSections } from "./settings-sections.ts";

export interface McpServerView {
	name: string;
	enabled: boolean;
	exposure: McpExposure;
	/** Its state as `/mcp` shows it: connected · 3 tools, needs sign-in, failed: … */
	state: string;
	/** global, project, or the extension that registered it (changes then last for this session only). */
	scope: string;
}

export interface McpSettingsDeps {
	servers(): McpServerView[];
	/** Saves and applies; resolves to an error message when the config could not be saved. */
	setEnabled(name: string, enabled: boolean): Promise<string | undefined>;
	setExposure(name: string, exposure: McpExposure): string | undefined;
	report(message: string): void;
}

const SETTINGS_OWNER = "mcp";

/** The exposures `/mcp` offers, in its order. */
const EXPOSURES: readonly McpExposure[] = ["codemode", "deferred", "direct"];

export function mcpServersSection(deps: McpSettingsDeps): SettingsSection {
	const reportFailure = (failed: string | undefined) => {
		if (failed) deps.report(failed);
	};
	return {
		domain: "servers",
		items: () =>
			deps.servers().flatMap((server): SettingItem[] => {
				const where = server.scope === "extension" ? "registered by an extension, for this session" : server.scope;
				return [
					{
						id: `mcp-enabled:${server.name}`,
						label: `MCP ${server.name}`,
						description: `MCP server ${server.name} (${where}): ${server.state}. Off, it is not started and its tools are gone.`,
						currentValue: server.enabled ? "on" : "off",
						values: ["on", "off"],
					},
					{
						id: `mcp-exposure:${server.name}`,
						label: `MCP ${server.name} · exposure`,
						description:
							"How its tools reach the model: codemode, called from scripts that find them with searchTools(); deferred, loaded by tool_search then called directly; direct, declared like built-in tools.",
						currentValue: server.exposure,
						values: EXPOSURES.includes(server.exposure) ? [...EXPOSURES] : [...EXPOSURES, server.exposure],
					},
				];
			}),
		onChange: (id, value) => {
			const [kind, ...rest] = id.split(":");
			const name = rest.join(":");
			if (kind === "mcp-enabled") {
				void deps
					.setEnabled(name, value === "on")
					.then(reportFailure, (error: unknown) =>
						deps.report(error instanceof Error ? error.message : String(error)),
					);
			} else if (kind === "mcp-exposure") {
				const exposure = EXPOSURES.find((candidate) => candidate === value);
				if (exposure) reportFailure(deps.setExposure(name, exposure));
			}
		},
		isAdvanced: (id) => id.startsWith("mcp-exposure:"),
	};
}

/**
 * Adds the section for this session; returns what removes it, which leaves a later session's section in place.
 * The one hook in the MCP extension.
 */
export function registerMcpSettings(deps: McpSettingsDeps): () => void {
	const section = mcpServersSection(deps);
	setSettingsSection(SETTINGS_OWNER, section);
	return () => {
		if (settingsSections().includes(section)) setSettingsSection(SETTINGS_OWNER, undefined);
	};
}

export interface LspServerView {
	name: string;
	/** The command pi-lsp starts, with its arguments. */
	command: string;
	/** Whether the command is on PATH. */
	installed: boolean;
}

const LSP_SETTINGS_OWNER = "pi-lsp";

/** The language servers turned off in /settings (global settings.json, `lsp.disabled`). */
export function disabledLspServers(agentDir?: string): Set<string> {
	const lsp = readGlobalSetting("lsp", agentDir);
	const names = typeof lsp === "object" && lsp !== null ? (lsp as Record<string, unknown>).disabled : undefined;
	return new Set(Array.isArray(names) ? names.filter((name): name is string => typeof name === "string") : []);
}

/** Turns a language server on or off for every session; throws when settings.json cannot be written. */
export function setLspServerEnabled(name: string, enabled: boolean, agentDir?: string): void {
	const disabled = disabledLspServers(agentDir);
	if (enabled) disabled.delete(name);
	else disabled.add(name);
	saveGlobalSetting(["lsp", "disabled"], disabled.size > 0 ? [...disabled].sort() : undefined, agentDir);
}

/**
 * fork: what `/lsp` says. It listed two lines for each of about forty servers, most of them
 * "command missing", in a warning; it names the servers that run and the ones turned off, and counts the others.
 */
export function lspStatusSummary(ready: string[], missing: string[], off: string[]): string {
	const lines = [
		ready.length > 0 ? fill("Language servers ready: {0}.", ready.join(", ")) : t("No language server is ready."),
	];
	if (off.length > 0) lines.push(fill("Turned off in /settings › Servers: {0}.", off.join(", ")));
	if (missing.length === 1)
		lines.push(fill("{0} is not installed: /lsp-setup lists this project's servers and installs them.", missing[0]!));
	else if (missing.length > 1)
		lines.push(
			fill(
				"{0} others are not installed: /lsp-setup lists this project's servers and installs them.",
				String(missing.length),
			),
		);
	lines.push(t("/lsp all lists each server's command."));
	return lines.join("\n");
}

export function lspServersSection(servers: () => LspServerView[], report: (message: string) => void): SettingsSection {
	// Read once per listing: whether each command is installed is a search of PATH.
	let listed: LspServerView[] = [];
	return {
		domain: "servers",
		items: () => {
			const disabled = disabledLspServers();
			listed = servers();
			return listed.map(
				(server): SettingItem => ({
					id: `lsp-enabled:${server.name}`,
					label: `LSP ${server.name}`,
					description: `Language server ${server.name} (${server.command}): ${server.installed ? "installed" : "not installed, /lsp-setup shows how"}. Off, lsp_diagnostics and lsp_fix do not start it.`,
					currentValue: disabled.has(server.name) ? "off" : "on",
					values: ["on", "off"],
				}),
			);
		},
		onChange: (id, value) => {
			if (!id.startsWith("lsp-enabled:")) return;
			try {
				setLspServerEnabled(id.slice("lsp-enabled:".length), value === "on");
			} catch (error) {
				report(error instanceof Error ? error.message : String(error));
			}
		},
		// each server's switch is for the advanced interface; the simple one keeps
		// the Language servers page, which turns them on or off too.
		isAdvanced: (id) => id.startsWith("lsp-enabled:"),
	};
}

/**
 * Adds the language servers to /settings for this session; returns what removes them, which leaves a later
 * session's section in place. Called by Prism's fork of pi-lsp.
 */
export function registerLspSettings(servers: () => LspServerView[], report: (message: string) => void): () => void {
	const section = lspServersSection(servers, report);
	setSettingsSection(LSP_SETTINGS_OWNER, section);
	return () => {
		if (settingsSections().includes(section)) setSettingsSection(LSP_SETTINGS_OWNER, undefined);
	};
}
