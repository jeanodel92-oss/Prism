/**
 * fork: what a tool call can do, by capability.
 * The permission gate (permissions.ts) decides per capability. A tool declares its capabilities when
 * it is registered (`permissions` in registerTool); the tools of the vendored modules, which cannot
 * carry the field, are declared here by name. An extension tool that declares nothing is refused in
 * the safe and ask modes.
 */

import { isAbsolute, join } from "node:path";

/** `computer` drives a browser or a desktop, as a person would; asked once even in broad mode. */
export type Capability =
	| "none"
	| "fs.read"
	| "fs.write"
	| "process"
	| "network"
	| "computer"
	| "privilege"
	| "security-config";

/** One effect of a call. A file write with its path is judged like the write tool (inside or outside the project). */
export type CapabilityEffect = Capability | { capability: Capability; path?: string };

/** A tool's declaration: its effects, fixed or computed from one call's input. */
export type ToolPermissions =
	| readonly CapabilityEffect[]
	| ((input: Record<string, unknown>) => readonly CapabilityEffect[]);

/**
 * The shipped tools whose code the fork does not edit, declared by name: the vendored modules (vendor/)
 * and upstream's codemode, tool_search and MCP resource tools. The tools codemode calls pass through the gate themselves.
 */
export const SHIPPED_TOOL_PERMISSIONS: Readonly<Record<string, ToolPermissions>> = {
	codemode: ["none"],
	tool_search: ["none"],
	// The MCP extension's resource tools read what the configured servers share.
	list_mcp_resources: ["network"],
	list_mcp_resource_templates: ["network"],
	read_mcp_resource: ["network"],
	// rpiv-ask-user-question, pi-plan-mode, pi-goal: they ask the user or report state.
	ask_user_question: ["none"],
	plan_mode_question: ["none"],
	plan_mode_complete: ["none"],
	goal_complete: ["none"],
	goal_blocked: ["none"],
	goal_wait: ["none"],
	// pi-lsp: diagnostics and fixes start a language server, which runs code the project controls (rust-analyzer runs
	// build.rs and procedural macros): a program, not a read. Fixes also rewrite a file.
	lsp_diagnostics: ["process"],
	// fork: the file it rewrites is `path` under `root`, which may be any folder; without the path the gate
	// judged a write outside the project as one inside (no question in broad mode).
	lsp_fix: (input) => ["process", { capability: "fs.write", path: lspFixTarget(input) }],
};

/** The file `lsp_fix` rewrites: pi-lsp resolves `path` against `root`, itself resolved against the cwd. */
function lspFixTarget(input: Record<string, unknown>): string {
	const path = typeof input.path === "string" ? input.path : "";
	const root = typeof input.root === "string" ? input.root.trim() : "";
	return root && !isAbsolute(path) ? join(root, path) : path;
}

/** The capabilities of a call, from a declaration (undefined when the tool declares nothing). */
export function declaredEffects(
	permissions: ToolPermissions | undefined,
	input: Record<string, unknown>,
): readonly CapabilityEffect[] | undefined {
	if (permissions === undefined) return undefined;
	return typeof permissions === "function" ? permissions(input) : permissions;
}
