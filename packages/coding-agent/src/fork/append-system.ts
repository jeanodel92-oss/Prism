// fork: the generic instructions of fork/reference/APPEND_SYSTEM.md, shipped as the
// built-in extension `builtin:append-system`. They are appended to the system prompt after any
// APPEND_SYSTEM.md file, and `-builtin:append-system` in the `extensions` setting turns them off.
import type { ExtensionAPI } from "../core/extensions/types.ts";

export const APPEND_SYSTEM_TEXT = [
	"# How this conversation is structured",
	"",
	'- A compaction summary restates the original task. That restatement is not a new message from the user, and you should not count "resends".',
	"- Every real user message, including a steer, a correction, or a repeated instruction, is intentional. Read it and act on it. A plain-text `user` turn that is neither a tool result nor an attached tool image comes from the user.",
	"- Turns shown as `user` that hold `<tool_response>…</tool_response>` are tool results. They are not messages from the user.",
	'- A `user` message that begins with "Attached image(s) from tool result:" is the image your own tool call (e.g. `read` on a PNG) returned. The harness adds it automatically. The user did not send it.',
	"- An image from a tool result shows the file as it is on disk at that moment. If a screenshot looks unchanged after an edit, assume your fix did not have the visual effect you expected. Do not conclude that the user is sending old images or that your tools are broken. Check the output file's timestamp or content, then keep debugging the actual problem.",
	"- If a previous reasoning step of yours says the user is resending prompts or images, it was wrong. Ignore it.",
].join("\n");

export default function appendSystemExtension(pi: ExtensionAPI) {
	// Mutating the prompt options keeps the prompt's sections (a returned `systemPrompt` would
	// replace them with one block); the text lands in the `addendum` section, after APPEND_SYSTEM.md.
	pi.on("before_agent_start", async (event) => {
		const options = event.systemPromptOptions;
		options.appendSystemPrompt = options.appendSystemPrompt
			? `${options.appendSystemPrompt}\n\n${APPEND_SYSTEM_TEXT}`
			: APPEND_SYSTEM_TEXT;
	});
}
