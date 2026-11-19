/**
 * fork: what the simple interface leaves out: "fd not found. Downloading... / fd installed
 * to ..." does not show there. Downloads of helper
 * tools (fd, rg) are announced in the advanced interface only; their failures always show.
 */
import type { InterfaceMode } from "../core/settings-manager.ts";
import type { ToolStatus } from "../utils/tools-manager.ts";

export function interfaceWording(mode: InterfaceMode, simple: string, advanced: string): string {
	return mode === "advanced" ? advanced : simple;
}

export function showsToolStatus(status: ToolStatus, mode: InterfaceMode): boolean {
	return status.type === "warning" || mode === "advanced";
}
