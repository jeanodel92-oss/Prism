/** The loaded pi-lsp fork supplies its own status calculation, without starting a server. */
import type { ExtensionContext } from "../core/extensions/types.ts";

export interface LspReport {
	servers: { name: string; command?: string; state: "ready" | "missing" | "off" }[];
	notice?: string;
}

const readers = new WeakMap<ExtensionContext["sessionManager"], () => LspReport>();

export function lspSnapshot(ctx: ExtensionContext): LspReport | undefined {
	return readers.get(ctx.sessionManager)?.();
}

(globalThis as Record<symbol, unknown>)[Symbol.for("prism.registerLspInspector")] = (
	manager: ExtensionContext["sessionManager"],
	read: () => LspReport,
) => {
	readers.set(manager, read);
	return () => {
		if (readers.get(manager) === read) readers.delete(manager);
	};
};
