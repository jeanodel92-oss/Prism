// The composer's attachments. A pasted screenshot and the
// files added with the attach button, a drop or a paste of copied files wait above the text as chips, then go with
// the next message. The engine decides what each file becomes (file-attachments.ts): an image as an image (a vision
// model sees it), a short text as its content, as `prism @file` sends one, any other file as a copy in the session's
// private /tmp that the agent reads with its tools, without access to the original's folder.

import { h } from "./dom.js";
import { t } from "./i18n.js";

function base64(bytes) {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

/** A pasted image (a File of the clipboard, or the engine's read of the system clipboard), as an attachment. */
export async function imageAttachment({ blob, data, mimeType }) {
	const bytes = blob ? new Uint8Array(await blob.arrayBuffer()) : undefined;
	return { kind: "image", name: t("attachScreenshot"), mimeType: mimeType ?? blob.type, data: data ?? base64(bytes) };
}

/** The prompt of a message with its attachments: the texts and the files' paths after the message, the images apart. */
export function promptWith(message, attachments) {
	const files = attachments
		.map((item) => (item.kind === "text" ? `<file name="${item.path}">\n${item.text}\n</file>\n` : item.kind === "file" ? item.note : ""))
		.join("");
	const images = attachments
		.filter((item) => item.kind === "image")
		.map(({ mimeType, data }) => ({ type: "image", mimeType, data }));
	return { message: files ? `${message}${message ? "\n\n" : ""}${files}` : message, images };
}

// A file a message carried, as promptWith (or `prism @file`) wrote it.
// The name keeps a quote that is not followed by ">": the path goes to the model as
// it is, so a file named quote"report.pdf is still a chip.
const FILE_BLOCK = /<file name="((?:[^"\n]|"(?!>))*)">\n?([\s\S]*?)\n?<\/file>\n?/g;

/**
 * A sent message's text without the files it carried, and those files' names. Only the blocks that end the message (as
 * promptWith appends them) or begin it (as `prism @file` puts them first) are files: a block quoted inside the text, an
 * example in a code block say, stays text.
 */
export function splitFiles(text) {
	const blocks = [...text.matchAll(FILE_BLOCK)].map((match) => ({ start: match.index, end: match.index + match[0].length, name: match[1] }));
	const tail = [];
	for (let i = blocks.length - 1; i >= 0; i--) {
		if (text.slice(blocks[i].end, tail[0]?.start ?? text.length).trim()) break;
		tail.unshift(blocks[i]);
	}
	const head = [];
	for (const block of blocks) {
		if (tail.includes(block) || text.slice(head.at(-1)?.end ?? 0, block.start).trim()) break;
		head.push(block);
	}
	if (!head.length && !tail.length) return { text, files: [] };
	const rest = text.slice(head.at(-1)?.end ?? 0, tail[0]?.start ?? text.length).trimEnd();
	return { text: head.length ? rest.trimStart() : rest, files: [...head, ...tail].map((block) => block.name) };
}

function chip(label, { image, onRemove, title } = {}) {
	return h(
		"span",
		{ class: "attachment", title: title ?? label },
		image && h("img", { class: "attachment-thumb", alt: "", src: `data:${image.mimeType};base64,${image.data}` }),
		!image && h("span", { class: "attachment-icon", "aria-hidden": "true", text: "≡" }),
		h("span", { class: "attachment-name", text: label }),
		onRemove &&
			h("button", {
				type: "button",
				class: "attachment-remove ghost small",
				title: t("attachRemove", label),
				"aria-label": t("attachRemove", label),
				text: "×",
				onclick: onRemove,
			}),
	);
}

/** The chips of the composer's attachments, each with its remove button. */
export function draftChips(attachments, remove) {
	return attachments.map((item, i) =>
		chip(item.name, {
			image: item.kind === "image" && item,
			title: item.path ?? item.name,
			onRemove: () => remove(i),
		}),
	);
}

/** The chips under a sent message: its images and the names of the files it carried. */
export function sentChips(images, files) {
	return [
		...images.map((image) => chip(t("attachImage"), { image })),
		...files.map((path) => chip(path.split("/").pop() || path, { title: path })),
	];
}
