/**
 * fork: the permissions a session saves in its own file (`perm-state`: mode, rules
 * allowed "in this session", timed permissions) are given back when the session is resumed. The file is plain JSON
 * that anything able to write it could edit, and a session file can come from elsewhere: either way it would widen
 * the permissions of the session resumed from it. Each saved state therefore carries a seal, an HMAC under a key
 * derived from this installation's `checkpoint.key` (reserved as auth.json is), and a state whose seal does not
 * match gives back nothing that widens: see `session_start` in permissions.ts.
 *
 * Not covered: a state this installation sealed, copied into another of its session files; a program of the same
 * account that reads the key.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { loadKeySync } from "./secrets/checkpoint-cipher.ts";

const keys = new Map<string, Buffer>();

function sealKey(agentDir: string): Buffer | undefined {
	let key = keys.get(agentDir);
	if (!key) {
		try {
			// A key of its own, so the backups' key is never used for two things.
			key = createHmac("sha256", loadKeySync(agentDir)).update("prism perm-state seal key v1").digest();
		} catch {
			// An agent folder that cannot be read or written: nothing is sealed, so nothing is given back.
			return undefined;
		}
		keys.set(agentDir, key);
	}
	return key;
}

const payload = (state: { mode?: unknown; allow?: unknown; deny?: unknown; timed?: unknown }) =>
	JSON.stringify([state.mode ?? null, state.allow ?? null, state.deny ?? null, state.timed ?? null]);

/** The seal of a session's saved permissions; undefined when this installation's key cannot be read or created. */
export function sealPermState(
	agentDir: string,
	state: { mode: unknown; allow: unknown; deny: unknown; timed: unknown },
): string | undefined {
	const key = sealKey(agentDir);
	return key ? createHmac("sha256", key).update(payload(state)).digest("hex") : undefined;
}

/** Whether `saved` is a state this installation wrote, unchanged. */
export function permStateSealed(agentDir: string, saved: unknown): boolean {
	if (typeof saved !== "object" || saved === null) return false;
	const { seal } = saved as { seal?: unknown };
	if (typeof seal !== "string" || !/^[0-9a-f]{64}$/.test(seal)) return false;
	const expected = sealPermState(agentDir, saved as { mode: unknown; allow: unknown; deny: unknown; timed: unknown });
	return expected !== undefined && timingSafeEqual(Buffer.from(seal, "hex"), Buffer.from(expected, "hex"));
}
