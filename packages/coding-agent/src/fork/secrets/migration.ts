/**
 * fork (R3.4 lot 3, F-H3 (b)): moving the credentials still in clear in auth.json to the Secret Service keyring,
 * only when the user asks, from /settings, with an explicit
 * confirmation (migration-page.ts).
 *
 * No secret may be lost: each credential is stored, then read back and compared, before
 * auth.json changes; auth.json is written once, under its lock, with a marker for each credential that read back.
 * A failure keeps that credential in clear and the others go on. A run that stops half way (Prism killed after a
 * store, before the write) leaves keyring items that the next run overwrites (same attributes), so running it
 * again resumes. References (`!command`, `$VAR`) are not secrets and stay.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Credential } from "@earendil-works/pi-ai";
import { getAgentDir } from "../../config.ts";
import { FileAuthStorageBackend } from "../../core/auth-storage.ts";
import { normalizePath } from "../../utils/paths.ts";
import { stripBom } from "../../utils/text.ts";
import { holdsSecret, isKeyringMarker, moveToKeyring, noteMoved } from "./keyring.ts";

export interface MigrationResult {
	/** Providers now in the keyring, with a marker in auth.json. */
	moved: string[];
	/** Providers kept in clear, with the reason. */
	kept: Map<string, string>;
}

export function defaultAuthPath(): string {
	return normalizePath(join(getAgentDir(), "auth.json"));
}

function parse(content: string | undefined): Record<string, unknown> {
	if (!content) return {};
	const data: unknown = JSON.parse(stripBom(content));
	return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
}

function inClear(value: unknown): value is Credential {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { type?: unknown }).type === "string" &&
		!isKeyringMarker(value) &&
		holdsSecret(value as Credential)
	);
}

/** The credentials the migration would move, with their type, in auth.json's order. */
export function credentialsInClear(authPath = defaultAuthPath()): Array<{ provider: string; type: string }> {
	let data: Record<string, unknown>;
	try {
		data = parse(readFileSync(authPath, "utf8"));
	} catch {
		// No auth.json, or not JSON (/doctor reports that): nothing to move.
		return [];
	}
	return Object.entries(data)
		.filter(([, value]) => inClear(value))
		.map(([provider, value]) => ({ provider, type: (value as Credential).type }));
}

/**
 * Moves every credential still in clear (or those of `providers`) to the keyring; see the top of this file. The
 * keyring is called without blocking; `signal` stops the run and writes nothing.
 */
export async function migrateToKeyring(
	authPath = defaultAuthPath(),
	providers?: string[],
	signal?: AbortSignal,
): Promise<MigrationResult> {
	const moved: Array<[string, Credential, string | undefined]> = [];
	const result = await new FileAuthStorageBackend(authPath).withLockAsync(
		async (current) => {
			const data = parse(current);
			const result: MigrationResult = { moved: [], kept: new Map() };
			for (const [provider, value] of Object.entries(data)) {
				if (!inClear(value) || (providers && !providers.includes(provider))) continue;
				try {
					const marker = await moveToKeyring(authPath, provider, value, signal);
					data[provider] = marker;
					result.moved.push(provider);
					moved.push([provider, value, marker.rev]);
				} catch (error) {
					signal?.throwIfAborted();
					result.kept.set(provider, (error as Error).message);
				}
			}
			return { result, next: result.moved.length ? JSON.stringify(data, null, 2) : undefined };
		},
		{ signal },
	);
	// Lot 4: only once auth.json holds the markers. A failed write leaves the credentials in clear, and the items
	// stored for them unused until the next run overwrites them.
	noteMoved(authPath, moved);
	return result;
}
