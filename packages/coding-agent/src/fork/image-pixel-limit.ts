/**
 * fork: the size an image declares in its header, read before a decoder sees it.
 *
 * A small file can declare a huge picture: a 48 KiB PNG of 20000 x 20000 one-bit pixels that Photon decodes whole
 * to RGBA, and the resize keeps several copies, so memory went over 4 GiB. Bounding the file size does not bound
 * the decoded size; the pixel count read from the header does.
 *
 * The format is taken from the content, not the declared MIME type, because Photon guesses it from the content
 * too. A content whose size cannot be read here is not decoded (fail closed).
 */

/**
 * 2^26 pixels (8192 x 8192). Covers an 8K screenshot (7680 x 4320, 33 MP), a 1920-wide full-page capture up to
 * about 35 000 px tall, and a 61 MP camera photo (9504 x 6336). Decoding peaked at about 12 bytes per pixel in the
 * audit (1.6 GiB over rest for 144 MP), so this bound keeps one decode near 800 MiB (estimate, not a measurement).
 */
export const MAX_DECODED_IMAGE_PIXELS = 2 ** 26;

export interface ImageHeaderSize {
	width: number;
	height: number;
}

function u16be(bytes: Uint8Array, offset: number): number {
	return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function u16le(bytes: Uint8Array, offset: number): number {
	return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function u24le(bytes: Uint8Array, offset: number): number {
	return u16le(bytes, offset) + (bytes[offset + 2] ?? 0) * 0x10000;
}

function u32le(bytes: Uint8Array, offset: number): number {
	return u24le(bytes, offset) + (bytes[offset + 3] ?? 0) * 0x1000000;
}

function u32be(bytes: Uint8Array, offset: number): number {
	return (bytes[offset] ?? 0) * 0x1000000 + ((bytes[offset + 1] ?? 0) << 16) + u16be(bytes, offset + 2);
}

function ascii(bytes: Uint8Array, offset: number, text: string): boolean {
	if (bytes.length < offset + text.length) return false;
	for (let index = 0; index < text.length; index++) {
		if (bytes[offset + index] !== text.charCodeAt(index)) return false;
	}
	return true;
}

/** The larger of two sizes by pixel count, so a frame larger than its canvas counts. */
function larger(a: ImageHeaderSize | undefined, b: ImageHeaderSize | undefined): ImageHeaderSize | undefined {
	if (!a) return b;
	if (!b) return a;
	return b.width * b.height > a.width * a.height ? b : a;
}

function pngSize(bytes: Uint8Array): ImageHeaderSize | undefined {
	if (bytes.length < 24 || !ascii(bytes, 12, "IHDR")) return undefined;
	return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
}

/**
 * Every frame header (SOF0 to SOF15, except DHT, JPG and DAC) before the first scan, walking the markers exactly as
 * the decoder (jpeg-decoder in Photon) does: bytes other than FF between segments are skipped, FF fill
 * bytes and FF 00 are not markers, and only a marker with a length is followed by a segment. Reading FF 00 as a
 * segment once skipped the real frame header and read a fake one the decoder never saw. A marker the decoder
 * refuses before the first scan (RSTn, SOI, TEM) or a frame of zero width or height makes the size unreadable.
 */
function jpegSize(bytes: Uint8Array): ImageHeaderSize | undefined {
	let size: ImageHeaderSize | undefined;
	let offset = 2;
	while (offset < bytes.length) {
		if (bytes[offset++] !== 0xff) continue;
		let marker = bytes[offset++];
		while (marker === 0xff) marker = bytes[offset++];
		if (marker === undefined) break;
		if (marker === 0x00) continue;
		if (marker === 0xda || marker === 0xd9) break;
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) return undefined;
		const length = u16be(bytes, offset);
		if (length < 2) return undefined;
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			if (offset + 7 > bytes.length) return undefined;
			const frame = { width: u16be(bytes, offset + 5), height: u16be(bytes, offset + 3) };
			if (frame.width === 0 || frame.height === 0) return undefined;
			size = larger(size, frame);
		}
		offset += length;
	}
	return size;
}

/** The logical screen and the first frame, which is what gets decoded. */
function gifSize(bytes: Uint8Array): ImageHeaderSize | undefined {
	if (bytes.length < 13) return undefined;
	const screen = { width: u16le(bytes, 6), height: u16le(bytes, 8) };
	const flags = bytes[10] ?? 0;
	let offset = 13 + (flags & 0x80 ? 3 * 2 ** ((flags & 0x07) + 1) : 0);
	while (offset < bytes.length) {
		const block = bytes[offset];
		if (block === 0x2c) {
			if (offset + 9 > bytes.length) return screen;
			return larger(screen, { width: u16le(bytes, offset + 5), height: u16le(bytes, offset + 7) });
		}
		if (block !== 0x21) return screen;
		offset += 2;
		while (offset < bytes.length && bytes[offset] !== 0) offset += (bytes[offset] ?? 0) + 1;
		offset++;
	}
	return screen;
}

/** A VP8 or VP8L bitstream starting at `data`. */
function webpBitstreamSize(bytes: Uint8Array, type: string, data: number): ImageHeaderSize | undefined {
	if (type === "VP8 " && data + 10 <= bytes.length) {
		return { width: u16le(bytes, data + 6) & 0x3fff, height: u16le(bytes, data + 8) & 0x3fff };
	}
	if (type === "VP8L" && data + 5 <= bytes.length) {
		const bits = u32le(bytes, data + 1);
		return { width: (bits & 0x3fff) + 1, height: (Math.floor(bits / 0x4000) & 0x3fff) + 1 };
	}
	return undefined;
}

/** The canvas of an extended file and every frame in it; the bitstream of a simple one. Chunks in [start, end). */
function webpChunksSize(bytes: Uint8Array, start: number, end: number): ImageHeaderSize | undefined {
	let size: ImageHeaderSize | undefined;
	let offset = start;
	while (offset + 8 <= end) {
		const type = new TextDecoder("latin1").decode(bytes.subarray(offset, offset + 4));
		const length = u32le(bytes, offset + 4);
		const data = offset + 8;
		if (type === "VP8X" && data + 10 <= end) {
			size = larger(size, { width: u24le(bytes, data + 4) + 1, height: u24le(bytes, data + 7) + 1 });
		} else if (type === "ANMF" && data + 16 <= end) {
			size = larger(size, { width: u24le(bytes, data + 6) + 1, height: u24le(bytes, data + 9) + 1 });
			size = larger(size, webpChunksSize(bytes, data + 16, Math.min(end, data + length)));
		} else if (data <= end) {
			size = larger(size, webpBitstreamSize(bytes, type, data));
		}
		offset = data + length + (length % 2);
	}
	return size;
}

function bmpSize(bytes: Uint8Array): ImageHeaderSize | undefined {
	if (bytes.length < 26) return undefined;
	if (u32le(bytes, 14) === 12) return { width: u16le(bytes, 18), height: u16le(bytes, 20) };
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return { width: Math.abs(view.getInt32(18, true)), height: Math.abs(view.getInt32(22, true)) };
}

/** The size the image declares, or undefined when the content is not a PNG, JPEG, GIF, WebP or BMP that says it. */
export function readImageHeaderSize(bytes: Uint8Array): ImageHeaderSize | undefined {
	if (bytes[0] === 0x89 && ascii(bytes, 1, "PNG\r\n\x1a\n")) return pngSize(bytes);
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return jpegSize(bytes);
	if (ascii(bytes, 0, "GIF87a") || ascii(bytes, 0, "GIF89a")) return gifSize(bytes);
	if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) return webpChunksSize(bytes, 12, bytes.length);
	if (ascii(bytes, 0, "BM")) return bmpSize(bytes);
	return undefined;
}

/** Why these bytes must not be decoded, or undefined when their declared size is within the bound. */
export function imageDecodeRefusal(bytes: Uint8Array): string | undefined {
	const size = readImageHeaderSize(bytes);
	if (!size) return "[Image omitted: its pixel size could not be read from its header, so it was not decoded.]";
	if (size.width * size.height <= MAX_DECODED_IMAGE_PIXELS) return undefined;
	return `[Image omitted: ${size.width}x${size.height} pixels is over the decoding limit of ${MAX_DECODED_IMAGE_PIXELS} pixels (8192x8192).]`;
}
