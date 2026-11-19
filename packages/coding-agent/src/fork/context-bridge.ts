/**
 * the terminal's context gauge opens /context, which is the vendored
 * pi-context-inspector (vendor/forks/pi-context-inspector, FORK.md). Prism publishes here what that screen adds, as
 * the window's /context does: how auto-compaction runs in this session, and the two actions of the gauge's former
 * menu. The inspector reads it without importing Prism, as the plan mode module publishes its own (plan-bridge.ts).
 */

const CONTEXT_BRIDGE = Symbol.for("prism.context");

export interface ContextBridge {
	/** What auto-compaction does here: off, its mark, or "when nearly full"; undefined before the footer drew. */
	compaction: () => string | undefined;
	/**
	 * fork: where auto-compaction starts, in tokens, for /context's buffer;
	 * null when it is off, undefined before the footer drew or when the settings cannot be read.
	 */
	threshold: () => number | null | undefined;
	/** Runs /compact, as typed. */
	compact: () => void;
	/** Opens /settings on auto-compaction's settings. */
	settings: () => void;
}

export function publishContextBridge(bridge: ContextBridge | undefined): void {
	(globalThis as Record<symbol, ContextBridge | undefined>)[CONTEXT_BRIDGE] = bridge;
}
