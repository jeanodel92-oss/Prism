/**
 * fork: the life of an extension instance's session.
 *
 * Replacing the session (`/new`, `/resume`, `/fork`) or `/reload` creates new extension instances; the old `pi` and
 * `ctx` throw ("stale") from then on. Work an old instance started (a process, a fetch, a timer) still ends later, and
 * an effect it then has (a message, a status, a write) either throws from a callback, which can stop the engine, or
 * lands in the wrong session. The signal is aborted at `session_shutdown`, whatever the reason: work checks `alive()`
 * after each wait that precedes an effect, and passes `signal` to what it starts.
 */
import type { ExtensionAPI } from "../core/extensions/types.ts";

export interface SessionLifetime {
	/** Aborted when the instance's session ends. */
	readonly signal: AbortSignal;
	/** Whether the session is still the one this instance serves. */
	alive(): boolean;
}

export function sessionLifetime(pi: Pick<ExtensionAPI, "on">): SessionLifetime {
	const controller = new AbortController();
	pi.on("session_shutdown", () => controller.abort());
	return { signal: controller.signal, alive: () => !controller.signal.aborted };
}
