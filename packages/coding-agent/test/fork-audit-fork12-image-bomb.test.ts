// fork.12 security audit, AS-024: a small image file whose header declares a huge picture made Prism decode it
// whole (a 17 KiB PNG of 12000 x 12000 pixels took memory to 1.9 GiB). The pixel count is now read from the header
// and an image over MAX_DECODED_IMAGE_PIXELS is refused before Photon decodes it.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createReadTool } from "../src/core/tools/read.ts";
import { MAX_DECODED_IMAGE_PIXELS, readImageHeaderSize } from "../src/fork/image-pixel-limit.ts";
import { convertToPng } from "../src/utils/image-convert.ts";
import { processImage } from "../src/utils/image-process.ts";
import { resizeImageInProcess } from "../src/utils/image-resize-core.ts";
import { loadPhoton } from "../src/utils/photon.ts";

/** A valid PNG, grayscale, one bit per pixel, black: a few KiB for tens of millions of pixels. */
function bitPng(width: number, height: number): Buffer {
	const chunk = (type: string, data: Buffer) => {
		const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
		const head = Buffer.alloc(4);
		head.writeUInt32BE(data.length);
		const tail = Buffer.alloc(4);
		tail.writeUInt32BE(crc32(body));
		return Buffer.concat([head, body, tail]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header.set([1, 0, 0, 0, 0], 8);
	const rows = Buffer.alloc(height * (1 + Math.ceil(width / 8)));
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(rows, { level: 9 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

/** A BMP header declaring `width` x `height`, 8 bits per pixel, RLE8: the conversion path of `read`. */
function bmpHeader(width: number, height: number): Buffer {
	const buffer = Buffer.alloc(1078 + 4);
	buffer.write("BM", 0, "ascii");
	buffer.writeUInt32LE(buffer.length, 2);
	buffer.writeUInt32LE(1078, 10);
	buffer.writeUInt32LE(40, 14);
	buffer.writeInt32LE(width, 18);
	buffer.writeInt32LE(-height, 22);
	buffer.writeUInt16LE(1, 26);
	buffer.writeUInt16LE(8, 28);
	buffer.writeUInt32LE(1, 30);
	return buffer;
}

function jpegWithFrame(marker: number, width: number, height: number): Buffer {
	const app = Buffer.from([0xff, 0xe1, 0x00, 0x06, 0xff, 0xc0, 0x00, 0x01]); // an APP1 that hides a fake SOF0
	const sof = Buffer.from([0xff, marker, 0x00, 0x0b, 0x08, 0, 0, 0, 0, 0x01, 0x01, 0x11, 0x00]);
	sof.writeUInt16BE(height, 5);
	sof.writeUInt16BE(width, 7);
	return Buffer.concat([Buffer.from([0xff, 0xd8]), app, sof, Buffer.from([0xff, 0xda, 0x00, 0x02, 0xff, 0xd9])]);
}

// Just over the bound: 67 117 056 pixels. Without the bound, Photon decodes it (about 800 MiB at its peak).
const OVER = { width: 8193, height: 8192 };

describe("AS-024: an image header declaring a huge picture is refused before it is decoded", () => {
	let dir: string;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "fork-image-bomb-"));
	});

	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("the read tool refuses a small PNG over the pixel bound and says why", async () => {
		const file = join(dir, "bomb.png");
		writeFileSync(file, bitPng(OVER.width, OVER.height));
		const result = await createReadTool(dir).execute("read-bomb", { path: file });
		expect(result.content).toHaveLength(1);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("Read image file [image/png]");
		expect(text).toContain(`Image omitted: ${OVER.width}x${OVER.height} pixels is over the decoding limit`);
	});

	it("processImage refuses it with or without auto-resize when a decode would follow", async () => {
		const result = await processImage(bitPng(OVER.width, OVER.height), "image/png");
		expect(result.ok).toBe(false);
		// A BMP is converted (decoded) even when auto-resize is off.
		const bmp = await processImage(bmpHeader(OVER.width, OVER.height), "image/bmp", { autoResizeImages: false });
		expect(bmp).toMatchObject({ ok: false, message: expect.stringContaining("over the decoding limit") });
	});

	it("the format is taken from the content, not the declared MIME type", async () => {
		const result = await processImage(jpegWithFrame(0xc2, 65535, 65535), "image/png");
		expect(result).toMatchObject({ ok: false, message: expect.stringContaining("65535x65535") });
		const unknown = await processImage(Buffer.from("not an image at all"), "image/png");
		expect(unknown).toMatchObject({ ok: false, message: expect.stringContaining("could not be read") });
	});

	it("resizeImageInProcess, behind the public resizeImage, does not decode it", async () => {
		expect(await resizeImageInProcess(bitPng(OVER.width, OVER.height), "image/png")).toBeNull();
	});

	it("the terminal display's conversion to PNG does not decode it", async () => {
		const bmp = Buffer.from(bmpHeader(OVER.width, OVER.height)).toString("base64");
		expect(await convertToPng(bmp, "image/bmp")).toBeNull();
	});

	it("an ordinary large picture is still decoded and resized", async () => {
		const result = await processImage(bitPng(3840, 2160), "image/png");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.hints.join("\n")).toContain("original 3840x2160");
	});

	it("reads the size every supported format declares", async () => {
		expect(MAX_DECODED_IMAGE_PIXELS).toBe(8192 * 8192);
		expect(readImageHeaderSize(bitPng(8192, 8192))).toEqual({ width: 8192, height: 8192 });
		// JPEG: the real frame header, past an APP segment that contains SOF-like bytes; any SOF kind counts.
		expect(readImageHeaderSize(jpegWithFrame(0xc0, 640, 480))).toEqual({ width: 640, height: 480 });
		expect(readImageHeaderSize(jpegWithFrame(0xc3, 40000, 30000))).toEqual({ width: 40000, height: 30000 });
		// GIF: a first frame larger than its logical screen.
		const gif = Buffer.concat([
			Buffer.from("GIF89a", "ascii"),
			Buffer.from("01000100000000" + "21f9040000000000" + "2c00000000ffffffff00", "hex"),
		]);
		expect(readImageHeaderSize(gif)).toEqual({ width: 65535, height: 65535 });
		// WebP: extended canvas, lossless bitstream, lossy bitstream.
		const riff = (chunk: Buffer) =>
			Buffer.concat([Buffer.from("RIFF\0\0\0\0WEBP", "latin1"), chunk, Buffer.alloc(16)]);
		const vp8x = Buffer.from("VP8X\x0a\0\0\0\0\0\0\0", "latin1");
		const vp8xSize = Buffer.alloc(6);
		vp8xSize.writeUIntLE(20000 - 1, 0, 3);
		vp8xSize.writeUIntLE(20000 - 1, 3, 3);
		expect(readImageHeaderSize(riff(Buffer.concat([vp8x, vp8xSize])))).toEqual({ width: 20000, height: 20000 });
		const vp8l = Buffer.from("VP8L\x05\0\0\0\x2f\0\0\0\0", "latin1");
		vp8l.writeUInt32LE(0x10000000 + (16383 << 14) + 16383, 9); // alpha bit set
		expect(readImageHeaderSize(riff(vp8l))).toEqual({ width: 16384, height: 16384 });
		const vp8 = Buffer.from("VP8 \x0a\0\0\0\0\0\0\x9d\x01\x2a\0\0\0\0", "latin1");
		vp8.writeUInt16LE(16383, 14);
		vp8.writeUInt16LE(1000, 16);
		expect(readImageHeaderSize(riff(vp8))).toEqual({ width: 16383, height: 1000 });
		// BMP, top-down (negative height).
		expect(readImageHeaderSize(bmpHeader(30000, 30000))).toEqual({ width: 30000, height: 30000 });
		expect(readImageHeaderSize(Buffer.from("plain text"))).toBeUndefined();
	});

	it("matches the size of a JPEG and a PNG Photon itself encodes", async () => {
		const photon = await loadPhoton();
		expect(photon).not.toBeNull();
		if (!photon) return;
		const image = new photon.PhotonImage(new Uint8Array(321 * 123 * 4), 321, 123);
		try {
			expect(readImageHeaderSize(image.get_bytes_jpeg(80))).toEqual({ width: 321, height: 123 });
			expect(readImageHeaderSize(image.get_bytes())).toEqual({ width: 321, height: 123 });
		} finally {
			image.free();
		}
	});
});
