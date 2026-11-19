/**
 * a screenshot pasted in the terminal goes to the model as an image. The paste key used
 * to put the path of a temporary PNG in the editor, which the model then had to find and read. It now puts a
 * placeholder ("[Image #1]") there and keeps the image here; a message that still holds the placeholder when it is
 * sent carries the image, whichever way it is sent (Enter, steer, follow-up, queued during a compaction): the
 * `input` event sees all of them. Deleting the placeholder from the draft leaves the image out.
 */
import type { ImageContent, UserMessage } from "@earendil-works/pi-ai/compat";
import { type Component, getCapabilities, Image, Spacer } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "../core/extensions/types.ts";

const pasted = new Map<string, ImageContent>();
let next = 1;

/** Keeps a pasted image for the message being written; the placeholder to put in the editor. */
export function attachPastedImage(bytes: Uint8Array, mimeType: string): string {
	const label = `[Image #${next++}]`;
	pasted.set(label, { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType });
	return label;
}

/** The images whose placeholders the text holds, each once, in the order they appear. */
export function pastedImagesIn(text: string): ImageContent[] {
	const labels = new Set((text.match(/\[Image #\d+\]/g) ?? []).filter((label) => pasted.has(label)));
	return [...labels].map((label) => pasted.get(label) as ImageContent);
}

export default function imageAttachments(pi: ExtensionAPI): void {
	pi.on("input", (event) => {
		const images = pastedImagesIn(event.text);
		if (!images.length) return;
		// fork: sent, the images are in the message; the copies kept here are released.
		for (const label of event.text.match(/\[Image #\d+\]/g) ?? []) pasted.delete(label);
		return { action: "transform", text: event.text, images: [...(event.images ?? []), ...images] };
	});
	// fork: the images pasted for a draft go with its session. A reload keeps both.
	pi.on("session_shutdown", (event) => {
		if (event.reason !== "reload") pasted.clear();
	});
}

/**
 * The images of a user message, shown under it as the terminal shows a tool's images (pi only showed its text). A
 * terminal without inline images shows none: the placeholder in the text says one was sent.
 */
export function userMessageImages(
	message: UserMessage,
	options: { show: boolean; widthCells: number; fallbackColor: (text: string) => string },
): Component[] {
	const caps = getCapabilities();
	if (!options.show || !caps.images || typeof message.content === "string") return [];
	return message.content.flatMap((part) => {
		if (part.type !== "image" || (caps.images === "kitty" && part.mimeType !== "image/png")) return [];
		return [
			new Spacer(1),
			new Image(
				part.data,
				part.mimeType,
				{ fallbackColor: options.fallbackColor },
				{ maxWidthCells: options.widthCells },
			),
		];
	});
}
