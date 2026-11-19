// fork.12 security audit, lot 3, AS-027: the JPEG header reader read `FF 00` as a marker with a length and skipped
// the real frame header (12000 x 12000), landing on a 1 x 1 frame hidden in a comment that the decoder never sees.
// A 356-byte file passed the pixel bound and Photon decoded it at 12000 x 12000. The reader now walks the markers as
// jpeg-decoder does.
import { describe, expect, it } from "vitest";
import { imageDecodeRefusal, readImageHeaderSize } from "../src/fork/image-pixel-limit.ts";

/** An 8 x 8 grayscale baseline JPEG (PIL, quality 90): APP0, DQT, SOF0, DHT x2, SOS, scan, EOI. */
const BASE = Buffer.from(
	"/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/wAALCAAIAAgBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/APyqr//Z",
	"base64",
);
const SOS = BASE.indexOf(Buffer.from([0xff, 0xda]));

/** The segments between SOI and SOS, with the frame set to `width` x `height`. */
function segments(width: number, height: number): Buffer {
	const region = Buffer.from(BASE.subarray(2, SOS));
	const sof = region.indexOf(Buffer.from([0xff, 0xc0]));
	region.writeUInt16BE(height, sof + 5);
	region.writeUInt16BE(width, sof + 7);
	return region;
}

function jpeg(...parts: Buffer[]): Buffer {
	return Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.concat(parts), BASE.subarray(SOS)]);
}

/** The audit's file: `FF 00 <len>`, the real segments, then a comment holding a 1 x 1 frame and an EOI. */
function lyingJpeg(side: number): Buffer {
	const region = segments(side, side);
	const smallSof = Buffer.from([
		0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9,
	]);
	const comment = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 2 + smallSof.length]), smallSof]);
	const skip = Buffer.alloc(2);
	skip.writeUInt16BE(region.length + 6);
	return jpeg(Buffer.from([0xff, 0x00]), skip, region, comment);
}

describe("AS-027: the JPEG header reader walks markers as the decoder does", () => {
	it("reads the frame the decoder decodes behind FF 00, and refuses it", () => {
		const file = lyingJpeg(12000);
		expect(file.length).toBe(356);
		expect(readImageHeaderSize(file)).toEqual({ width: 12000, height: 12000 });
		expect(imageDecodeRefusal(file)).toContain("12000x12000");
	});

	it("skips fill bytes and stray bytes between segments, as the decoder does", () => {
		expect(readImageHeaderSize(jpeg(Buffer.from([0xff, 0xff, 0xff]), segments(640, 480)))).toEqual({
			width: 640,
			height: 480,
		});
		expect(
			readImageHeaderSize(jpeg(Buffer.from([0xff, 0xfe, 0x00, 0x02, 0x12, 0x34, 0x00]), segments(30000, 20000))),
		).toEqual({
			width: 30000,
			height: 20000,
		});
	});

	it("does not read a size when a frame has zero height or a marker the decoder refuses comes first", () => {
		expect(readImageHeaderSize(jpeg(segments(640, 0)))).toBeUndefined();
		expect(readImageHeaderSize(jpeg(Buffer.from([0xff, 0xd0]), segments(640, 480)))).toBeUndefined();
		expect(readImageHeaderSize(jpeg(Buffer.from([0xff, 0xd8]), segments(640, 480)))).toBeUndefined();
		expect(readImageHeaderSize(jpeg(Buffer.from([0xff, 0x01]), segments(640, 480)))).toBeUndefined();
	});

	it("still reads the plain file", () => {
		expect(readImageHeaderSize(BASE)).toEqual({ width: 8, height: 8 });
	});
});
