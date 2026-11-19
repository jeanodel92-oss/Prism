// The attach button on the phone: the page reads the chosen files itself, since the
// engine on the PC cannot. An image goes as an image, a short text as its content, anything else is sent to the PC
// (phone/transfer.js) unless it is above the bound.
// Run by hand: node --test fork/gui/tests/phone-attach.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

const { phoneAttachment } = await import("../ui/phone/pick.js");

test("an image is attached as an image", async () => {
	const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "shot.png", { type: "image/png" });
	assert.deepEqual(await phoneAttachment(png), { kind: "image", name: "shot.png", mimeType: "image/png", data: "iVBORw==" });
});

test("a short text is attached as its content", async () => {
	const note = new File(["héllo\n"], "note.md", { type: "text/markdown" });
	assert.deepEqual(await phoneAttachment(note), { kind: "text", name: "note.md", path: "note.md", text: "héllo\n" });
});

test("a binary file is sent to the PC, with its name", async () => {
	const pdf = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff])], "doc.pdf", { type: "application/pdf" });
	const item = await phoneAttachment(pdf);
	assert.deepEqual({ kind: item.kind, name: item.name }, { kind: "upload", name: "doc.pdf" });
	assert.equal(item.file, pdf);
});

test("a long text, and an image above the engine's bound, are sent to the PC too", async () => {
	const big = new File(["a".repeat(256 * 1024 + 1)], "big.txt", { type: "text/plain" });
	assert.equal((await phoneAttachment(big)).kind, "upload");
	const photo = new File([new Uint8Array(20 * 1024 * 1024 + 1)], "photo.png", { type: "image/png" });
	assert.equal((await phoneAttachment(photo)).kind, "upload");
});

test("a file above what the PC takes is refused with its name, before anything is read", async () => {
	const huge = { name: "disk.img", size: 100 * 1024 * 1024 + 1, type: "", arrayBuffer: () => assert.fail("read") };
	const item = await phoneAttachment(huge);
	assert.equal(item.kind, "error");
	assert.match(item.error, /^disk\.img/);
});
