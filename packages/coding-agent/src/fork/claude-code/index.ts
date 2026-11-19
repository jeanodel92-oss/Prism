/** the Claude Code provider (`claude -p` with Prism's tools); see provider.ts. */
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { closeClaudeCodeConversations, createClaudeCodeProvider } from "./provider.ts";

export default function claudeCodeExtension(pi: ExtensionAPI): void {
	pi.registerProvider(createClaudeCodeProvider().provider);
	pi.on("session_shutdown", async () => {
		await closeClaudeCodeConversations();
	});
}
