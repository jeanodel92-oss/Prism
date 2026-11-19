// opening many new conversations froze the whole desktop for ten minutes.
// Each open conversation keeps its own engine process (110 to 175 MB, gui-fork10.md § 11) until it is closed,
// so the memory only grew. The window now manages their lifecycle:
//   - "New conversation" reuses a conversation that is still empty instead of starting another engine;
//   - a conversation that is not on screen and has nothing in progress (no turn, question, view, ! command or
//     background task) goes to sleep after `lifecycle.idleMs`: its engine stops, its transcript stays shown, and the
//     engine starts again from the session file when it is opened;
//   - at most `lifecycle.maxAwake` engines run: beyond them, the least recently used idle conversations sleep;
//   - when the machine runs short of memory, idle conversations go to sleep at once, least recently used first;
//   - when it is still short, no new engine starts: the user is told why, instead of the system swapping.
// What sleeping keeps: the session's rules, in its file; the dangerous actions and hosts allowed "in this session",
// which are never saved, are taken from the engine before it stops and given back to the one that wakes
// (session.js). Only if that fails does the conversation say they ended.

const { invoke } = window.__TAURI__.core;

/**
 * How long a conversation off screen stays idle before it sleeps, and how many engines run at most (ten, the most recently used; one that is working stays awake beyond them)
 * . The test driver lowers both.
 */
export const lifecycle = { idleMs: 10 * 60_000, maxAwake: 10 };
const GIB = 1024 ** 3;

/** Short of memory: idle conversations go to sleep now. */
export const lowMemory = (memory) => memory.available < Math.max(1.5 * GIB, 0.15 * memory.total);

/** Too short for one more engine, even after putting the idle ones to sleep. */
export const criticalMemory = (memory) => memory.available < Math.max(0.75 * GIB, 0.07 * memory.total);

/** `{ available, total }` in bytes, or undefined when the host cannot tell (not Linux). */
export async function memoryInfo() {
	try {
		return (await invoke("memory_info")) ?? undefined;
	} catch {
		return undefined;
	}
}

/** Whether a conversation can sleep now: not on screen, engine idle, nothing the user could lose. */
export function canSleep(view, active, now, idleMs) {
	return (
		view !== active &&
		view.ready &&
		!view.suspended &&
		!view.closed &&
		view.engine.alive &&
		!view.streaming &&
		!view.bash &&
		view.dialogs.size === 0 &&
		view.views.size === 0 &&
		view.interactions.entries.length === 0 &&
		!view.statuses.has("background") &&
		now - view.lastActive >= idleMs
	);
}

/** A conversation nothing was written in yet, which "New conversation" can show again, still starting or not. */
export function isBlank(view) {
	return (
		!view.initialPath &&
		!view.suspended &&
		!view.closed &&
		!view.exit &&
		!view.error &&
		!view.streaming &&
		!view.firstMessage &&
		(view.state?.messageCount ?? 0) === 0 &&
		// Nothing sent (a command counts), nothing open, nothing shown: a used conversation is not shown again
		// in place of a new one, whatever its message count.
		view.sent.length === 0 &&
		view.views.size === 0 &&
		view.dialogs.size === 0 &&
		view.interactions.entries.length === 0 &&
		view.el.childElementCount === 0
	);
}
