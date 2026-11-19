import { describe, expect, it } from "vitest";
import { parseAuthCommand } from "../src/cli/auth-command.ts";
import { parseFrontmatter } from "../src/utils/frontmatter.ts";
import { resizeImageInProcess } from "../src/utils/image-resize-core.ts";
import { loadPhoton } from "../src/utils/photon.ts";
import { createZipArchive, ZIP_MAX_ENTRIES } from "../src/utils/zip.ts";

describe("auth --min-expiry units", () => {
	// the duration regex is case-insensitive, so uppercase units keep their meaning.
	it.each([
		["10MS", 10],
		["10ms", 10],
		["30S", 30_000],
		["30M", 30 * 60_000],
		["30m", 30 * 60_000],
		["2H", 2 * 3_600_000],
	])("reads %s as %d ms", (value, expected) => {
		expect(parseAuthCommand(["auth", "print-bearer-token", "--min-expiry", value])?.minExpiryMs).toBe(expected);
	});

	it("still rejects an unknown unit", () => {
		expect(() => parseAuthCommand(["auth", "print-bearer-token", "--min-expiry", "30d"])).toThrow(/duration/);
	});
});

describe("frontmatter delimiters", () => {
	// a Markdown rule of four dashes is content, not a frontmatter delimiter.
	it("keeps a document that starts with a four-dash rule intact", () => {
		const content = "----\nKeep existing files.\n----\nFix the bug.";
		expect(parseFrontmatter(content)).toEqual({ frontmatter: {}, body: content });
	});

	it("ignores a closing line with text after the dashes", () => {
		const content = "---\ndescription: x\n--- not a delimiter\nbody";
		expect(parseFrontmatter(content)).toEqual({ frontmatter: {}, body: content });
	});

	it("does not close on a longer dash run and closes on the next real delimiter", () => {
		const parsed = parseFrontmatter("---\ndescription: x\n---\n----\nbody");
		expect(parsed).toEqual({ frontmatter: { description: "x" }, body: "----\nbody" });
	});

	it("still parses ordinary frontmatter, trailing spaces and an empty body", () => {
		expect(parseFrontmatter("---\ndescription: x\n---\nbody")).toEqual({
			frontmatter: { description: "x" },
			body: "body",
		});
		expect(parseFrontmatter("---  \r\ndescription: x\r\n--- \r\nbody")).toEqual({
			frontmatter: { description: "x" },
			body: "body",
		});
		expect(parseFrontmatter("---\ndescription: x\n---")).toEqual({ frontmatter: { description: "x" }, body: "" });
		expect(parseFrontmatter("---\n---\nbody")).toEqual({ frontmatter: {}, body: "body" });
	});
});

describe("image resize of very thin images", () => {
	async function png(width: number, height: number): Promise<Uint8Array> {
		const photon = await loadPhoton();
		if (!photon) throw new Error("Photon is unavailable");
		const image = new photon.PhotonImage(new Uint8Array(width * height * 4).fill(200), width, height);
		try {
			return image.get_bytes();
		} finally {
			image.free();
		}
	}

	// the scaled short side must stay at least one pixel.
	it.each([
		[10_000, 1, 2000, 1, {}],
		[1, 10_000, 1, 2000, {}],
		[3_000, 1, 500, 1, { maxWidth: 500, maxHeight: 500 }],
	])("resizes %d by %d to %d by %d", async (width, height, expectedWidth, expectedHeight, options) => {
		const resized = await resizeImageInProcess(await png(width, height), "image/png", options);
		expect(resized).not.toBeNull();
		expect(resized?.width).toBe(expectedWidth);
		expect(resized?.height).toBe(expectedHeight);
		expect(resized?.wasResized).toBe(true);
	});
});

describe("classic ZIP entry limit", () => {
	// the end record stores the entry count in 16 bits.
	it("refuses one entry over the limit before compressing", () => {
		const entries = Array.from({ length: ZIP_MAX_ENTRIES + 1 }, (_, index) => ({ name: `${index}`, data: "" }));
		expect(() => createZipArchive(entries)).toThrow(`at most ${ZIP_MAX_ENTRIES} entries`);
	});

	it("writes exactly the limit", () => {
		const entries = Array.from({ length: ZIP_MAX_ENTRIES }, (_, index) => ({ name: `${index}`, data: "" }));
		const archive = createZipArchive(entries);
		expect(archive.readUInt16LE(archive.length - 22 + 10)).toBe(ZIP_MAX_ENTRIES);
	});
});
