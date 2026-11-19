// A user extension deliberately replaces native modules; the window must run its commands as supplied.
import type { ExtensionAPI } from "../../../../../packages/coding-agent/src/core/extensions/types.ts";

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => ctx.ui.setStatus("permissions", "legacy perm: ask"));
	for (const name of ["perm", "bg", "sent", "state", "trace", "lsp"]) {
		pi.registerCommand(name, {
			description: `Personal ${name}`,
			handler: async (_args, ctx) => {
				await ctx.ui.select(`Personal ${name} screen`, ["Keep my extension", "Cancel"]);
			},
		});
	}
}
