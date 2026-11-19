/**
 * fork: fork settings kept in the global settings.json and changed from `/settings` (the sandbox,
 * desktop notifications, default budgets). They are read and written under the settings lock; SettingsManager
 * writes back only the fields it changed, so it keeps them.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../config.ts";
import { FileSettingsStorage } from "../core/settings-manager.ts";

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** The value at `key` of the global settings.json; undefined when missing or when the file does not parse. */
export function readGlobalSetting(key: string, agentDir = getAgentDir()): unknown {
	try {
		const settings: unknown = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
		return isObject(settings) ? settings[key] : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Sets the value at `path` of the global settings.json, creating the objects on the way; `undefined` removes
 * it. Throws when settings.json is not valid JSON, so a file being edited by hand is never replaced.
 */
export function saveGlobalSetting(path: readonly string[], value: unknown, agentDir = getAgentDir()): void {
	new FileSettingsStorage(agentDir, agentDir).withLock("global", (current) => {
		const settings: Record<string, unknown> = current ? JSON.parse(current) : {};
		let node = settings;
		for (const key of path.slice(0, -1)) {
			const next = node[key];
			node[key] = isObject(next) ? next : {};
			node = node[key] as Record<string, unknown>;
		}
		const last = path[path.length - 1]!;
		if (value === undefined) delete node[last];
		else node[last] = value;
		return `${JSON.stringify(settings, null, 2)}\n`;
	});
}

/**
 * Sets the top-level flag `key` to true and tells whether this call was the one that set it. Check and write happen
 * under one settings lock, so when several Prism processes start at once (two engines of the desktop window), exactly
 * one gets true. A separate read then save lets all of them read "unset" and all act.
 */
export function claimGlobalFlag(key: string, agentDir = getAgentDir()): boolean {
	let claimed = false;
	new FileSettingsStorage(agentDir, agentDir).withLock("global", (current) => {
		claimed = false;
		const settings: Record<string, unknown> = current ? JSON.parse(current) : {};
		if (settings[key] === true) return undefined;
		settings[key] = true;
		claimed = true;
		return `${JSON.stringify(settings, null, 2)}\n`;
	});
	return claimed;
}
