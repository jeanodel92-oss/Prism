/**
 * fork: the Kitty image metadata table dropped its oldest ids past 1000
 * images, even for an image still in the transcript. That image's cached lines then lost the cropping at the edges
 * of the viewport and the upload cache. An image still shown now keeps its metadata.
 */
import assert from "node:assert";
import { after, describe, it } from "node:test";
import { Image } from "../src/components/image.ts";
import {
	getKittyImageMetadata,
	registerKittyImageMetadata,
	resetCapabilitiesCache,
	setCapabilities,
} from "../src/terminal-image.ts";

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("fork: Kitty image metadata of images still shown", () => {
	after(() => resetCapabilitiesCache());

	it("keeps an old image's metadata after more than 1000 newer images", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		const theme = { fallbackColor: (text: string) => text };
		const images = Array.from(
			{ length: 1100 },
			(_, index) =>
				new Image(PNG_1X1, "image/png", theme, { imageId: 900_000 + index }, { widthPx: 90, heightPx: 90 }),
		);
		const firstLines = images[0]!.render(40);
		for (const image of images.slice(1)) image.render(40);

		// The first image returns its cached lines; layout and the upload cache look its metadata up by id.
		assert.strictEqual(images[0]!.render(40), firstLines);
		assert.deepStrictEqual(getKittyImageMetadata(firstLines[0]!)?.imageId, 900_000);
		assert.ok(images.every((image) => getKittyImageMetadata(image.render(40)[0]!) !== undefined));
	});

	it("still bounds the metadata of images nobody shows", () => {
		for (let index = 0; index < 1100; index++) {
			registerKittyImageMetadata({ imageId: 800_000 + index, columns: 1, rows: 1, widthPx: 1, heightPx: 1 });
		}
		const line = (imageId: number) => `\x1b_Ga=T,i=${imageId};AAAA\x1b\\`;
		assert.strictEqual(getKittyImageMetadata(line(800_000)), undefined);
		assert.strictEqual(getKittyImageMetadata(line(801_099))?.imageId, 801_099);
	});
});
