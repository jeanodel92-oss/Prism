import type { ExtensionContext } from "../core/extensions/types.ts";

const PLAN_BRIDGE = Symbol.for("prism.plan-mode");

/** What the plan mode module publishes (vendor/forks/pi-plan-mode, FORK.md). */
export interface PlanBridge {
	toggle: (ctx: ExtensionContext) => void;
	shortcut?: string;
	/** whether plan mode is on, for /init to offer it only when it is off. */
	enabled?: () => boolean;
}

/** What the composer's Plan switch runs, when the plan mode module has loaded (also for RPC clients). */
export function planBridge(): PlanBridge | undefined {
	return (globalThis as Record<symbol, PlanBridge | undefined>)[PLAN_BRIDGE];
}
