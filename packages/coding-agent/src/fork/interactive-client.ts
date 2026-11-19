/**
 * fork: whether a person can answer this session's views and dialogs.
 *
 * The interactive terminal can. In RPC mode `hasUI` is true even for a client that shows no dialog, so a
 * client counts only once it declared it shows views (`set_views`, see rpc-views.ts). Print mode and
 * scheduled runs cannot. One engine process serves one client, so the flag is process-wide.
 */

let viewsClient = false;
let nativeMenus = false;

export function setViewsClient(menus = false): void {
	viewsClient = true;
	nativeMenus = menus;
}

/** Whether this engine's client is the Prism window or the phone app (native menus), not the terminal. */
export function isNativeMenusClient(): boolean {
	return nativeMenus;
}

export function hasNativeMenus(ctx: { hasUI: boolean; mode: string }): boolean {
	return ctx.hasUI && ctx.mode === "rpc" && nativeMenus;
}

/**
 * fork: the client is the phone app, through the phone server (`prism-remote`, which sets
 * PRISM_REMOTE_CLIENT). What acts on the PC's own screen, such as the browser's setup assistant, is not offered there.
 */
export function isPhoneClient(): boolean {
	return process.env.PRISM_REMOTE_CLIENT === "phone";
}

export function hasInteractiveClient(ctx: { hasUI: boolean; mode: string }): boolean {
	return ctx.hasUI && (ctx.mode === "tui" || (ctx.mode === "rpc" && viewsClient));
}

// Vendored plug-ins (vendor/forks) reach it without importing Prism, like the other `prism.*` symbols.
(globalThis as Record<symbol, unknown>)[Symbol.for("prism.hasInteractiveClient")] = hasInteractiveClient;
(globalThis as Record<symbol, unknown>)[Symbol.for("prism.hasNativeMenus")] = () => nativeMenus;
