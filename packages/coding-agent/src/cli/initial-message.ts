import type { ImageContent } from "@earendil-works/pi-ai";
import type { Args } from "./args.ts";

export interface InitialMessageInput {
	parsed: Args;
	fileText?: string;
	fileImages?: ImageContent[];
	stdinContent?: string;
}

export interface InitialMessageResult {
	initialMessage?: string;
	initialImages?: ImageContent[];
}

/**
 * Combine stdin content, @file text, and the first CLI message into a single
 * initial prompt for non-interactive mode.
 */
export function buildInitialMessage({
	parsed,
	fileText,
	fileImages,
	stdinContent,
}: InitialMessageInput): InitialMessageResult {
	const parts: string[] = [];
	if (stdinContent !== undefined) {
		parts.push(stdinContent);
	}
	if (fileText) {
		parts.push(fileText);
	}

	if (parsed.messages.length > 0) {
		parts.push(parsed.messages[0]);
		parsed.messages.shift();
	}

	return {
		// fork: a part that does not end with a newline gets one, so piped text is
		// not glued to the prompt that follows it.
		initialMessage:
			parts.length > 0
				? parts.map((part, i) => (i < parts.length - 1 && !part.endsWith("\n") ? `${part}\n` : part)).join("")
				: undefined,
		initialImages: fileImages && fileImages.length > 0 ? fileImages : undefined,
	};
}
