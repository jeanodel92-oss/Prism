/**
 * fork: the language of the model's replies. Prism's system prompt is in English, and
 * local models often answer a French message in English because of it
 * . This built-in extension adds a `<language>` section to the system prompt: by
 * default, reply in the language of the user's latest message; with the `replyLanguage` setting
 * (`/settings` > Conversation > Reply language), always in that language. Code, identifiers, tool
 * names and arguments, commands and paths are never translated, so tool calls are unchanged.
 *
 * When Prism's interface becomes bilingual, "auto" can also name the interface language.
 */
import type { ExtensionAPI } from "../core/extensions/types.ts";

export const REPLY_LANGUAGE_AUTO = "auto";

const KEEP =
	"Keep code, identifiers, tool names and their arguments, commands, file paths and quoted text exactly as they are; do not translate them.";

/** The `<language>` section for a `replyLanguage` setting. */
export function replyLanguageInstruction(setting: unknown): string {
	const language = typeof setting === "string" ? setting.trim() : undefined;
	if (!language || language.toLowerCase() === REPLY_LANGUAGE_AUTO) {
		return `Reply in the language of the user's latest message, even when these instructions, project files or tool results are in another language. ${KEEP}`;
	}
	return `Reply in ${language}, unless the user asks for another language. ${KEEP}`;
}

export default function replyLanguage(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		event.systemPromptOptions.sections.language = replyLanguageInstruction(pi.getSettings().replyLanguage);
	});
}
