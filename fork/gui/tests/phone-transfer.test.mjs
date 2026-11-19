// Files between the phone and the PC (fork/gui/ui/phone/transfer.js): in pieces over the link, refused above the bound,
// ended on both sides when a piece fails, and a download that changes on the PC meanwhile is refused.
// Run by hand: node --test fork/gui/tests/phone-transfer.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

const { uploadToPc, downloadFromPc, PIECE, MAX_FILE } = await import("../ui/phone/transfer.js");

const calls = (answers = {}) => {
	const log = [];
	const invoke = async (name, args) => {
		log.push([name, args]);
		const answer = answers[name];
		if (typeof answer === "function") return answer(args, log);
		return answer ?? {};
	};
	return { log, invoke };
};

test("a file goes to the PC in pieces of at most PIECE bytes, in order", async () => {
	const bytes = new Uint8Array(PIECE * 2 + 5).map((_, i) => i % 251);
	const file = new File([bytes], "archive.zip");
	const { log, invoke } = calls({ upload_start: { upload: "u1" }, upload_finish: { path: "/pc/uploads/u1/archive.zip" } });
	assert.equal(await uploadToPc(file, invoke), "/pc/uploads/u1/archive.zip");
	assert.deepEqual(log[0], ["upload_start", { name: "archive.zip", size: bytes.length }]);
	const pieces = log.filter(([name]) => name === "upload_chunk");
	assert.equal(pieces.length, 3);
	const sent = Buffer.concat(pieces.map(([, { data }]) => Buffer.from(data, "base64")));
	assert.deepEqual(new Uint8Array(sent), bytes);
	assert.ok(pieces.every(([, { upload, data }]) => upload === "u1" && Buffer.from(data, "base64").length <= PIECE));
	assert.equal(log.at(-1)[0], "upload_finish");
});

test("an empty file is still a file", async () => {
	const { log, invoke } = calls({ upload_start: { upload: "u1" }, upload_finish: { path: "/p" } });
	await uploadToPc(new File([], "empty"), invoke);
	assert.deepEqual(log.map(([name]) => name), ["upload_start", "upload_finish"]);
});

test("a file above the bound never leaves the phone", async () => {
	const { log, invoke } = calls();
	const huge = { name: "disk.img", size: MAX_FILE + 1, slice: () => assert.fail("read") };
	await assert.rejects(uploadToPc(huge, invoke), /disk\.img/);
	assert.deepEqual(log, []);
});

test("a refused piece cancels the upload on the PC and says why", async () => {
	const { log, invoke } = calls({
		upload_start: { upload: "u9" },
		upload_chunk: () => {
			throw new Error("more bytes than the size announced");
		},
	});
	await assert.rejects(uploadToPc(new File(["abc"], "a.bin"), invoke), /more bytes/);
	assert.deepEqual(log.at(-1), ["upload_cancel", { upload: "u9" }]);
});

const piece = (data, offset, size, mtimeMs = 1) => ({
	name: "report.pdf",
	size,
	mtimeMs,
	offset,
	length: data.length,
	data: Buffer.from(data).toString("base64"),
	eof: offset + data.length >= size,
});

const phone = (saved = []) => ({ saveDownload: (...args) => (saved.push(args), "") });

test("a file of the PC is assembled from the engine's pieces, then saved or opened by Android", async () => {
	const whole = Buffer.from("0123456789");
	const asked = [];
	const request = async (command) => {
		asked.push(command);
		const from = command.offset;
		return piece(whole.subarray(from, from + 4), from, whole.length);
	};
	const written = [];
	const { invoke } = calls({
		download_begin: { },
		download_append: ({ data }) => (written.push(Buffer.from(data, "base64").toString()), written.join("").length),
		download_finish: "/cache/d1/report.pdf",
	});
	const saved = [];
	assert.equal(await downloadFromPc({ request, path: "out/report.pdf", open: true, invoke, android: phone(saved) }), "report.pdf");
	assert.deepEqual(asked.map((c) => [c.type, c.path, c.offset]), [["files_read", "out/report.pdf", 0], ["files_read", "out/report.pdf", 4], ["files_read", "out/report.pdf", 8]]);
	assert.equal(written.join(""), "0123456789");
	assert.deepEqual(saved, [["/cache/d1/report.pdf", "report.pdf", true]]);
});

test("a file that changes while it is read is refused and nothing is kept", async () => {
	let n = 0;
	const request = async (command) => (n++ === 0 ? piece("abcd", 0, 8, 1) : piece("efgh", command.offset, 8, 2));
	const { log, invoke } = calls({ download_begin: { } });
	const saved = [];
	await assert.rejects(downloadFromPc({ request, path: "a", invoke, android: phone(saved) }), /changed on the PC/);
	assert.equal(log.at(-1)[0], "download_discard");
	assert.deepEqual(saved, []);
});

test("a PC that stops short, or an engine that refuses, ends the download without saving", async () => {
	const { log, invoke } = calls({ download_begin: {} });
	const stuck = async () => ({ ...piece("", 0, 8), eof: false });
	await assert.rejects(downloadFromPc({ request: stuck, path: "a", invoke, android: phone() }), /changed on the PC/);
	assert.equal(log.at(-1)[0], "download_discard");
	const refused = async () => {
		throw new Error("Only the project's files and the files Prism produced can be opened here.");
	};
	await assert.rejects(downloadFromPc({ request: refused, path: "/etc/shadow", invoke, android: phone() }), /Only the project's files/);
});

test("Android's refusal is the download's error, and the desktop window has no way to keep a file", async () => {
	const { log, invoke } = calls({ download_begin: {}, download_finish: "/c/x" });
	const request = async () => piece("ab", 0, 2);
	await assert.rejects(downloadFromPc({ request, path: "a", invoke, android: { saveDownload: () => "Downloads needs Android 10" } }), /Android 10/);
	assert.equal(log.at(-1)[0], "download_discard");
	await assert.rejects(downloadFromPc({ request, path: "a", invoke, android: undefined }), /phone/);
});
