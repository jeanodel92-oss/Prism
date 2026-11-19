// The attach button on the phone: the engine runs on the PC and cannot read the
// phone's files, so the page reads the files chosen in Android's picker itself and sends them as the engine would have
// made them (packages/coding-agent/src/fork/file-attachments.ts): an image as an image, a short text as its content.
// Any other file, and an image or a text above those limits, is copied to the PC first (transfer.js), which attaches it as
// the window attaches a file its picker returned.

import { t } from "../js/i18n.js";
import { base64, MAX_FILE } from "./transfer.js";

// The engine's own limits (file-attachments.ts MAX_IMAGE_BYTES, MAX_TEXT_BYTES).
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_BYTES = 256 * 1024;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** One chosen file as an attachment the page can build itself, as a file to send to the PC (`upload`), or why it cannot be one. */
export async function phoneAttachment(file) {
	const name = file.name || "file";
	if (IMAGE_TYPES.includes(file.type) && file.size <= MAX_IMAGE_BYTES)
		return { kind: "image", name, mimeType: file.type, data: base64(new Uint8Array(await file.arrayBuffer())) };
	if (file.size <= MAX_TEXT_BYTES) {
		const bytes = new Uint8Array(await file.arrayBuffer());
		if (!bytes.includes(0)) {
			try {
				return { kind: "text", name, path: name, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
			} catch {
				// Not text: refused below.
			}
		}
	}
	if (file.size > MAX_FILE) return { kind: "error", name, error: t("phoneAttachTooBig", name, MAX_FILE / 1024 / 1024) };
	return { kind: "upload", name, file };
}

/** Android's file picker; the files chosen, as `phoneAttachment` makes them. An empty list when the picker is closed. */
export function pickOnPhone() {
	return new Promise((resolve) => {
		const input = document.createElement("input");
		input.type = "file";
		input.multiple = true;
		input.addEventListener("change", async () => resolve(await Promise.all([...(input.files ?? [])].map(phoneAttachment))));
		input.addEventListener("cancel", () => resolve([]));
		input.click();
	});
}
