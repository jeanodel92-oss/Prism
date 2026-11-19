/**
 * the screen as the model sees it. Providers shrink a large picture on
 * their side without saying so, and a model then clicks in pixels it was never shown. Prism shrinks a large screen
 * itself, to a size providers leave alone, and the model's coordinates are pixels of that picture: Prism maps them
 * back to the screen, so the model never computes a scale. A screen capture leaves the cursor out, so the agent's
 * pointer is drawn on the picture, where the agent last put it.
 */
import { loadPhoton } from "../../utils/photon.ts";

/** The picture's longer and shorter sides at most: about one megapixel, a 16:9 screen at 1366x768. */
export const SHOT_MAX_LONG = 1366;
export const SHOT_MAX_SHORT = 768;

/** Screen pixels per picture pixel: 1 for a screen that already fits. */
export function shotScale(width: number, height: number): number {
	const long = Math.max(width, height);
	const short = Math.min(width, height);
	return Math.max(1, long / SHOT_MAX_LONG, short / SHOT_MAX_SHORT);
}

/** The picture's size for a screen. */
export function shotSize(width: number, height: number): { width: number; height: number } {
	const scale = shotScale(width, height);
	return { width: Math.max(1, Math.round(width / scale)), height: Math.max(1, Math.round(height / scale)) };
}

/** A point of the picture on the screen, inside it. */
export function toScreen(x: number, y: number, screen: { width: number; height: number }): { x: number; y: number } {
	const scale = shotScale(screen.width, screen.height);
	return {
		x: Math.min(Math.max(Math.round(x * scale), 0), Math.max(screen.width - 1, 0)),
		y: Math.min(Math.max(Math.round(y * scale), 0), Math.max(screen.height - 1, 0)),
	};
}

/** A point of the screen in the picture. */
export function toShot(x: number, y: number, screen: { width: number; height: number }): { x: number; y: number } {
	const size = shotSize(screen.width, screen.height);
	const scale = shotScale(screen.width, screen.height);
	return {
		x: Math.min(Math.round(x / scale), size.width - 1),
		y: Math.min(Math.round(y / scale), size.height - 1),
	};
}

/** An arrow pointer, its tip at the top left: O outline, F fill. */
const ARROW = [
	"O",
	"OO",
	"OFO",
	"OFFO",
	"OFFFO",
	"OFFFFO",
	"OFFFFFO",
	"OFFFFFFO",
	"OFFFFFFFO",
	"OFFFFFFFFO",
	"OFFFFFOOOOO",
	"OFFOFFO",
	"OFO OFFO",
	"OO  OFFO",
	"O    OFFO",
	"     OFFO",
	"      OO",
];
/** Prism's violet, as the browser's agent pointer, outlined in white: seen on dark and light screens alike. */
const FILL = [139, 92, 246];
const OUTLINE = [255, 255, 255];

/** Draws the agent's pointer, its tip at (x, y), into RGBA pixels. */
export function drawPointer(rgba: Uint8Array, width: number, height: number, x: number, y: number): void {
	ARROW.forEach((row, dy) => {
		for (let dx = 0; dx < row.length; dx++) {
			const mark = row[dx];
			if (mark !== "O" && mark !== "F") continue;
			const px = x + dx;
			const py = y + dy;
			if (px < 0 || py < 0 || px >= width || py >= height) continue;
			const color = mark === "O" ? OUTLINE : FILL;
			const at = (py * width + px) * 4;
			rgba[at] = color[0]!;
			rgba[at + 1] = color[1]!;
			rgba[at + 2] = color[2]!;
			rgba[at + 3] = 255;
		}
	});
}

/** The picture the model sees: shrunk to fit, with the agent's pointer when it has put one (screen pixels). */
export async function shotPng(
	capture: { width: number; height: number; rgba: Buffer },
	pointer?: { x: number; y: number },
): Promise<{ png: Buffer; width: number; height: number }> {
	const photon = await loadPhoton();
	if (!photon) throw new Error("Image support is not available in this installation.");
	const size = shotSize(capture.width, capture.height);
	const image = new photon.PhotonImage(new Uint8Array(capture.rgba), capture.width, capture.height);
	let shrunk: typeof image | undefined;
	let out: typeof image | undefined;
	try {
		shrunk =
			size.width === capture.width && size.height === capture.height
				? undefined
				: photon.resize(image, size.width, size.height, photon.SamplingFilter.Lanczos3);
		const pixels = (shrunk ?? image).get_raw_pixels();
		if (pointer) {
			const at = toShot(pointer.x, pointer.y, capture);
			drawPointer(pixels, size.width, size.height, at.x, at.y);
		}
		out = new photon.PhotonImage(pixels, size.width, size.height);
		return { png: Buffer.from(out.get_bytes()), ...size };
	} finally {
		out?.free();
		shrunk?.free();
		image.free();
	}
}
